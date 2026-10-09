import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminAuditLog, sessions, studies } from "@dialect/db";
import { insertSessionWithUtterance, type CollectedSession } from "@dialect/db/testing-builders";
import { corpusSchemas } from "@dialect/domain";
import { createAdminSession } from "@/lib/server/admin-auth";
import { resetEnvCacheForTests } from "@/lib/server/env";
import { jsonRequest, noParams, setupServerTestHarness } from "@/lib/server/test/database";
import { applyTestEnv, TEST_ENV } from "@/lib/server/test/setup";
import { POST as providerTest } from "./provider-test/route";
import { POST as resetTestData } from "./reset-test-data/route";
import { GET as getSettings, PUT as putSettings } from "./route";

const harness = setupServerTestHarness();
const URL_BASE = "http://localhost:3000/api/admin/settings";

let research: CollectedSession;

const put = (body: unknown) => putSettings(jsonRequest(URL_BASE, { method: "PUT", body }), noParams);
const reset = (body: unknown) => resetTestData(jsonRequest(`${URL_BASE}/reset-test-data`, { body }), noParams);

async function addSession(mode: "demo" | "test"): Promise<CollectedSession> {
  return insertSessionWithUtterance(harness.database.db, {
    studyId: research.study.id,
    protocolVersionId: research.protocol.id,
    session: { mode },
    media: { storageDriver: "memory" },
  });
}

beforeAll(async () => {
  research = await insertSessionWithUtterance(harness.database.db, { session: { status: "completed" } });
});

describe("settings routes without an admin session", () => {
  it("reject every request with 401", async () => {
    const responses = await Promise.all([
      getSettings(new Request(URL_BASE), noParams),
      put({ allowNewSessions: false }),
      providerTest(jsonRequest(`${URL_BASE}/provider-test`, {}), noParams),
      reset({ modes: ["test"], confirmationPhrase: corpusSchemas.TEST_DATA_RESET_PHRASE }),
    ]);
    for (const response of responses) expect(response.status).toBe(401);
    const [study] = await harness.database.db.select().from(studies).where(eq(studies.id, research.study.id));
    expect(study?.settingsJson).toEqual({});
  });
});

describe("settings routes with an admin session", () => {
  beforeEach(async () => {
    await createAdminSession();
  });

  it("GET returns the settings without any secret", async () => {
    const response = await getSettings(new Request(URL_BASE), noParams);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    const text = await response.text();
    const body = JSON.parse(text);
    // Not set in the study settings means closed.
    expect(body.operational).toMatchObject({ status: "active", allowNewSessions: false });
    expect(body.database).toMatchObject({ connected: true, migrations: { status: "up_to_date" } });
    expect(body.storage).toMatchObject({ driver: "memory", location: "./data/media", connected: true });
    expect(body.provider.openaiConfigured).toBe(true);
    expect(body.application).toMatchObject({ appVersion: "test-version", environment: "test" });
    expect(body.testDataReset).toMatchObject({ allowed: true, phrase: corpusSchemas.TEST_DATA_RESET_PHRASE });
    for (const secret of [TEST_ENV.OPENAI_API_KEY, TEST_ENV.ADMIN_PASSWORD, TEST_ENV.ADMIN_SESSION_SECRET, "postgres:postgres"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("PUT validates, saves and audits", async () => {
    expect((await put({ maxUploadMb: -5 })).status).toBe(400);
    expect((await put({ somethingElse: 1 })).status).toBe(400);
    expect((await put({})).status).toBe(400);

    const response = await put({ allowNewSessions: false, maintenanceMessage: "Paused for the weekend", maxUtteranceSeconds: 240 });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.operational).toMatchObject({ allowNewSessions: false, maintenanceMessage: "Paused for the weekend" });
    expect(body.limits.maxUtteranceSeconds).toBe(240);

    const audit = await harness.database.db.select().from(adminAuditLog).where(eq(adminAuditLog.action, "settings.update"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorLabel: "admin",
      afterJson: { allowNewSessions: false, maintenanceMessage: "Paused for the weekend", maxUtteranceSeconds: 240 },
    });
  });

  it("the provider test answers 'not configured' without an API key and calls nothing", async () => {
    applyTestEnv({ OPENAI_API_KEY: undefined });
    resetEnvCacheForTests();
    const response = await providerTest(jsonRequest(`${URL_BASE}/provider-test`, {}), noParams);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ configured: false, ok: false, at: null });
  });

  it("the reset needs the phrase, is refused in production and removes only demo and test data", async () => {
    const demo = await addSession("demo");
    const test = await addSession("test");
    const body = { modes: ["demo", "test"], confirmationPhrase: corpusSchemas.TEST_DATA_RESET_PHRASE };

    expect((await reset({ ...body, confirmationPhrase: "DELETE" })).status).toBe(400);
    expect((await reset({ ...body, modes: ["research"] })).status).toBe(400);
    expect((await reset({ confirmationPhrase: body.confirmationPhrase })).status).toBe(400);

    applyTestEnv({ NODE_ENV: "production" });
    resetEnvCacheForTests();
    await createAdminSession();
    const refused = await reset(body);
    expect(refused.status).toBe(403);
    expect(await harness.database.db.select().from(sessions)).toHaveLength(3);

    process.env.ALLOW_TEST_DATA_RESET = "true";
    try {
      const allowed = await reset(body);
      expect(allowed.status).toBe(200);
      expect((await allowed.json()).deleted.sessions).toBe(2);
    } finally {
      delete process.env.ALLOW_TEST_DATA_RESET;
    }

    const remaining = await harness.database.db.select().from(sessions);
    expect(remaining.map((row) => row.id)).toEqual([research.session.id]);
    expect(remaining.map((row) => row.id)).not.toContain(demo.session.id);
    expect(remaining.map((row) => row.id)).not.toContain(test.session.id);
    const audit = await harness.database.db.select().from(adminAuditLog).where(eq(adminAuditLog.action, "test_data.reset"));
    expect(audit).toHaveLength(1);
  });
});

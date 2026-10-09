import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { adminAuditLog, aiPromptVersions, modelConfigs, studies } from "@dialect/db";
import { insertActiveAiConfigs, insertStudy, type ActiveAiConfigs } from "@dialect/db/testing-builders";
import { POST as login } from "@/app/api/admin/login/route";
import { jsonRequest, noParams, setupServerTestHarness } from "@/lib/server/test/database";
import { TEST_ENV } from "@/lib/server/test/setup";
import { GET as compare } from "./compare/route";
import { POST as activate } from "./[id]/activate/route";
import { POST as clone } from "./[id]/clone/route";
import { POST as retire } from "./[id]/retire/route";
import { DELETE as remove, GET as getOne, PUT as update } from "./[id]/route";
import { GET as list, POST as create } from "./route";

const harness = setupServerTestHarness();
const BASE = "http://localhost:3000/api/admin/ai/prompts";

let seeded: (ActiveAiConfigs & { studyId: string }) | null = null;

async function seed() {
  if (!seeded) {
    const study = await insertStudy(harness.database.db);
    seeded = { studyId: study.id, ...(await insertActiveAiConfigs(harness.database.db, { studyId: study.id })) };
  }
  return seeded;
}

async function signIn(): Promise<void> {
  const response = await login(
    jsonRequest("http://localhost:3000/api/admin/login", { body: { password: TEST_ENV.ADMIN_PASSWORD } }),
    noParams,
  );
  expect(response.status).toBe(200);
}

const withId = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(async () => {
  await seed();
});

describe("authentication and origin", () => {
  it("rejects every route without an admin session", async () => {
    const { prompts } = await seed();
    const id = prompts.translationDefault.id;
    const responses = await Promise.all([
      list(jsonRequest(BASE, { method: "GET" }), noParams),
      create(jsonRequest(BASE, { body: {} }), noParams),
      compare(jsonRequest(`${BASE}/compare?a=${id}&b=${id}`, { method: "GET" }), noParams),
      getOne(jsonRequest(`${BASE}/${id}`, { method: "GET" }), withId(id)),
      update(jsonRequest(`${BASE}/${id}`, { method: "PUT", body: { name: "x" } }), withId(id)),
      remove(jsonRequest(`${BASE}/${id}`, { method: "DELETE" }), withId(id)),
      activate(jsonRequest(`${BASE}/${id}/activate`), withId(id)),
      clone(jsonRequest(`${BASE}/${id}/clone`), withId(id)),
      retire(jsonRequest(`${BASE}/${id}/retire`), withId(id)),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("UNAUTHORIZED");
    }
    const rows = await harness.database.db.select().from(aiPromptVersions).where(eq(aiPromptVersions.id, id));
    expect(rows[0]?.status).toBe("active");
  });

  it("rejects a cross-origin state-changing request even with a session", async () => {
    await signIn();
    const response = await create(
      jsonRequest(BASE, { body: {}, headers: { origin: "https://evil.example" } }),
      noParams,
    );
    expect(response.status).toBe(403);
  });
});

describe("prompt routes", () => {
  it("lists the prompt versions of the study with private caching headers", async () => {
    await signIn();
    const response = await list(jsonRequest(BASE, { method: "GET" }), noParams);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    const body = await response.json();
    expect(body.prompts.map((p: { key: string }) => p.key)).toEqual(
      expect.arrayContaining(["asr_context", "translation_default", "translation_preserve", "tts_baseline"]),
    );
    const filtered = await list(jsonRequest(`${BASE}?stage=tts`, { method: "GET" }), noParams);
    expect((await filtered.json()).prompts.map((p: { key: string }) => p.key)).toEqual(["tts_baseline"]);
    const bad = await list(jsonRequest(`${BASE}?stage=video`, { method: "GET" }), noParams);
    expect(bad.status).toBe(400);
  });

  it("validates the create body", async () => {
    await signIn();
    const cases: unknown[] = [
      {},
      { key: "Not A Key", stage: "translation", name: "x", promptText: "x" },
      { key: "translation_x", stage: "video", name: "x", promptText: "x" },
      { key: "translation_x", stage: "translation", name: "", promptText: "x" },
      { key: "translation_x", stage: "translation", name: "x" },
    ];
    for (const body of cases) {
      const response = await create(jsonRequest(BASE, { body }), noParams);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
    }
    const malformed = await create(
      new Request(BASE, { method: "POST", body: "{not json", headers: { origin: "http://localhost:3000" } }),
      noParams,
    );
    expect(malformed.status).toBe(400);
    const placeholder = await create(
      jsonRequest(BASE, {
        body: { key: "translation_x", stage: "translation", name: "x", promptText: "Translate {{nope}}." },
      }),
      noParams,
    );
    expect(placeholder.status).toBe(400);
    expect((await placeholder.json()).error.message).toContain("{{nope}}");
    const invalidId = await getOne(jsonRequest(`${BASE}/not-a-uuid`, { method: "GET" }), withId("not-a-uuid"));
    expect(invalidId.status).toBe(400);
  });

  it("runs the draft, compare, activate and retire workflow and records the admin as the actor", async () => {
    await signIn();
    const { prompts, configs } = await seed();
    const active = prompts.translationPreserve;

    const cloned = await clone(jsonRequest(`${BASE}/${active.id}/clone`), withId(active.id));
    expect(cloned.status).toBe(200);
    const draft = (await cloned.json()).prompt;
    expect(draft).toMatchObject({ status: "draft", versionNumber: 2, key: "translation_preserve", createdByLabel: "admin" });

    // One draft per key.
    const second = await clone(jsonRequest(`${BASE}/${active.id}/clone`), withId(active.id));
    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatchObject({ code: "CONFLICT", details: { existingDraftId: draft.id } });

    const updated = await update(
      jsonRequest(`${BASE}/${draft.id}`, { method: "PUT", body: { promptText: "Translate and keep the register." } }),
      withId(draft.id),
    );
    expect(updated.status).toBe(200);
    expect((await updated.json()).prompt.promptText).toBe("Translate and keep the register.");

    const immutable = await update(
      jsonRequest(`${BASE}/${active.id}`, { method: "PUT", body: { promptText: "Changed." } }),
      withId(active.id),
    );
    expect(immutable.status).toBe(409);
    expect((await immutable.json()).error.code).toBe("IMMUTABLE_RECORD");
    const emptyUpdate = await update(jsonRequest(`${BASE}/${draft.id}`, { method: "PUT", body: {} }), withId(draft.id));
    expect(emptyUpdate.status).toBe(400);

    const compared = await compare(jsonRequest(`${BASE}/compare?a=${active.id}&b=${draft.id}`, { method: "GET" }), noParams);
    expect(compared.status).toBe(200);
    const { diff } = await compared.json();
    expect(diff.identical).toBe(false);
    expect(diff.lines.some((part: { type: string }) => part.type === "added")).toBe(true);
    const badCompare = await compare(jsonRequest(`${BASE}/compare?a=${active.id}`, { method: "GET" }), noParams);
    expect(badCompare.status).toBe(400);

    const activated = await activate(jsonRequest(`${BASE}/${draft.id}/activate`), withId(draft.id));
    expect(activated.status).toBe(200);
    const result = await activated.json();
    expect(result.prompt).toMatchObject({ id: draft.id, status: "active" });
    expect(result.retired).toMatchObject({ id: active.id, status: "retired" });
    // The active config still pins version 1 and is reported, not changed.
    expect(result.configsOnOtherVersions.map((c: { id: string }) => c.id)).toEqual([configs.translationPreserve.id]);
    const [config] = await harness.database.db
      .select()
      .from(modelConfigs)
      .where(eq(modelConfigs.id, configs.translationPreserve.id));
    expect(config).toMatchObject({ status: "active", promptVersionId: active.id });

    const again = await activate(jsonRequest(`${BASE}/${draft.id}/activate`), withId(draft.id));
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe("INVALID_STATE");

    const audit = await harness.database.db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, draft.id));
    expect(audit.map((row) => row.action).sort()).toEqual(["ai_prompt.activate", "ai_prompt.create", "ai_prompt.update_draft"]);
    expect(audit.every((row) => row.actorLabel === "admin")).toBe(true);
  });

  it("refuses to retire a prompt that an active config uses, and deletes only drafts", async () => {
    await signIn();
    const { prompts } = await seed();
    const refused = await retire(jsonRequest(`${BASE}/${prompts.asrContext.id}/retire`), withId(prompts.asrContext.id));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe("INVALID_STATE");

    const notDraft = await remove(
      jsonRequest(`${BASE}/${prompts.asrContext.id}`, { method: "DELETE" }),
      withId(prompts.asrContext.id),
    );
    expect(notDraft.status).toBe(409);
    expect((await notDraft.json()).error.code).toBe("IMMUTABLE_RECORD");

    const created = await create(
      jsonRequest(BASE, {
        body: { key: "translation_formal", stage: "translation", conditionKey: "formal", name: "Formal", promptText: "Translate formally." },
      }),
      noParams,
    );
    expect(created.status).toBe(200);
    const draft = (await created.json()).prompt;
    expect(draft).toMatchObject({ versionNumber: 1, status: "draft", conditionKey: "formal" });
    const deleted = await remove(jsonRequest(`${BASE}/${draft.id}`, { method: "DELETE" }), withId(draft.id));
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true, id: draft.id });
    const missing = await getOne(jsonRequest(`${BASE}/${draft.id}`, { method: "GET" }), withId(draft.id));
    expect(missing.status).toBe(404);
  });

  it("answers 404 when no study exists for the given id", async () => {
    await signIn();
    const unknown = "00000000-0000-4000-8000-000000000000";
    const response = await list(jsonRequest(`${BASE}?studyId=${unknown}`, { method: "GET" }), noParams);
    expect(response.status).toBe(404);
    expect(await harness.database.db.select({ id: studies.id }).from(studies)).not.toHaveLength(0);
  });
});

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { adminAuditLog, modelConfigs } from "@dialect/db";
import { insertActiveAiConfigs, insertStudy, type ActiveAiConfigs } from "@dialect/db/testing-builders";
import { POST as login } from "@/app/api/admin/login/route";
import { jsonRequest, noParams, setupServerTestHarness } from "@/lib/server/test/database";
import { TEST_ENV } from "@/lib/server/test/setup";
import { POST as activatePrompt } from "../prompts/[id]/activate/route";
import { POST as clonePrompt } from "../prompts/[id]/clone/route";
import { GET as compare } from "./compare/route";
import { POST as activate } from "./[id]/activate/route";
import { POST as clone } from "./[id]/clone/route";
import { POST as retire } from "./[id]/retire/route";
import { DELETE as remove, GET as getOne, PUT as update } from "./[id]/route";
import { GET as list, POST as create } from "./route";

const harness = setupServerTestHarness();
const BASE = "http://localhost:3000/api/admin/ai/configs";
const PROMPTS = "http://localhost:3000/api/admin/ai/prompts";

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

describe("authentication", () => {
  it("rejects every route without an admin session", async () => {
    const { configs } = await seed();
    const id = configs.ttsBaseline.id;
    const responses = await Promise.all([
      list(jsonRequest(BASE, { method: "GET" }), noParams),
      create(jsonRequest(BASE, { body: {} }), noParams),
      compare(jsonRequest(`${BASE}/compare?a=${id}&b=${id}`, { method: "GET" }), noParams),
      getOne(jsonRequest(`${BASE}/${id}`, { method: "GET" }), withId(id)),
      update(jsonRequest(`${BASE}/${id}`, { method: "PUT", body: { modelId: "x" } }), withId(id)),
      remove(jsonRequest(`${BASE}/${id}`, { method: "DELETE" }), withId(id)),
      activate(jsonRequest(`${BASE}/${id}/activate`), withId(id)),
      clone(jsonRequest(`${BASE}/${id}/clone`), withId(id)),
      retire(jsonRequest(`${BASE}/${id}/retire`), withId(id)),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(401);
    }
    const [row] = await harness.database.db.select().from(modelConfigs).where(eq(modelConfigs.id, id));
    expect(row?.status).toBe("active");
  });
});

describe("config routes", () => {
  it("lists configs with their prompt and reports providers without any key material", async () => {
    await signIn();
    const response = await list(jsonRequest(BASE, { method: "GET" }), noParams);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(TEST_ENV.OPENAI_API_KEY);
    const body = JSON.parse(text);
    expect(body.providers).toEqual([
      { name: "openai", configured: true, isMock: false },
      { name: "mock", configured: true, isMock: true },
    ]);
    const tts = body.configs.find((c: { key: string }) => c.key === "tts_baseline");
    expect(tts).toMatchObject({
      status: "active",
      parametersJson: { voice: "mock-voice", response_format: "wav" },
      prompt: { key: "tts_baseline", versionNumber: 1, status: "active" },
      activePrompt: { versionNumber: 1 },
    });
  });

  it("validates the body, the provider and the parameters when saving", async () => {
    await signIn();
    const { prompts } = await seed();
    const valid = {
      key: "translation_formal",
      stage: "translation",
      conditionKey: "formal",
      provider: "openai",
      modelId: "researcher-entered-model",
      parameters: {},
      promptVersionId: prompts.translationDefault.id,
    };
    const cases: unknown[] = [
      {},
      { ...valid, modelId: "" },
      { ...valid, parameters: "temperature=1" },
      { ...valid, parameters: [1] },
      { ...valid, promptVersionId: "nope" },
      { ...valid, provider: "acme" },
      { ...valid, parameters: { top_k: 3 } },
      { ...valid, parameters: { temperature: "hot" } },
    ];
    for (const body of cases) {
      const response = await create(jsonRequest(BASE, { body }), noParams);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
    }
    expect(
      await harness.database.db.select().from(modelConfigs).where(eq(modelConfigs.key, "translation_formal")),
    ).toHaveLength(0);

    const created = await create(jsonRequest(BASE, { body: { ...valid, parameters: { max_output_tokens: 300 } } }), noParams);
    expect(created.status).toBe(200);
    const { config } = await created.json();
    expect(config).toMatchObject({ status: "draft", versionNumber: 1, parametersJson: { max_output_tokens: 300 } });

    const badUpdate = await update(
      jsonRequest(`${BASE}/${config.id}`, { method: "PUT", body: { parameters: { user: "p1" } } }),
      withId(config.id),
    );
    expect(badUpdate.status).toBe(400);
    const deleted = await remove(jsonRequest(`${BASE}/${config.id}`, { method: "DELETE" }), withId(config.id));
    expect(deleted.status).toBe(200);
  });

  it("adopts a newly active prompt only through a new config version", async () => {
    await signIn();
    const { prompts, configs } = await seed();
    const promptId = prompts.translationDefault.id;
    const promptDraft = (await (await clonePrompt(jsonRequest(`${PROMPTS}/${promptId}/clone`), withId(promptId))).json()).prompt;

    // A config draft that links the prompt draft cannot be activated yet.
    const sourceId = configs.translationDefault.id;
    const cloned = await clone(jsonRequest(`${BASE}/${sourceId}/clone`), withId(sourceId));
    expect(cloned.status).toBe(200);
    const draft = (await cloned.json()).config;
    expect(draft).toMatchObject({ status: "draft", versionNumber: 2, promptVersionId: promptId });
    const linked = await update(
      jsonRequest(`${BASE}/${draft.id}`, { method: "PUT", body: { promptVersionId: promptDraft.id } }),
      withId(draft.id),
    );
    expect(linked.status).toBe(200);
    const early = await activate(jsonRequest(`${BASE}/${draft.id}/activate`), withId(draft.id));
    expect(early.status).toBe(409);
    expect((await early.json()).error.code).toBe("INVALID_STATE");
    expect((await remove(jsonRequest(`${BASE}/${draft.id}`, { method: "DELETE" }), withId(draft.id))).status).toBe(200);

    expect(
      (await activatePrompt(jsonRequest(`${PROMPTS}/${promptDraft.id}/activate`), withId(promptDraft.id))).status,
    ).toBe(200);
    const listed = await (await list(jsonRequest(`${BASE}?key=translation_default`, { method: "GET" }), noParams)).json();
    expect(listed.configs[0]).toMatchObject({
      id: sourceId,
      status: "active",
      prompt: { versionNumber: 1, status: "retired" },
      activePrompt: { versionNumber: 2 },
    });

    const adopt = await clone(
      jsonRequest(`${BASE}/${sourceId}/clone`, { body: { useActivePrompt: true } }),
      withId(sourceId),
    );
    expect(adopt.status).toBe(200);
    const next = (await adopt.json()).config;
    expect(next.promptVersionId).toBe(promptDraft.id);

    const compared = await compare(jsonRequest(`${BASE}/compare?a=${sourceId}&b=${next.id}`, { method: "GET" }), noParams);
    expect(compared.status).toBe(200);
    const { diff } = await compared.json();
    expect(diff.fields.filter((f: { changed: boolean }) => f.changed).map((f: { field: string }) => f.field)).toEqual([
      "promptVersion",
    ]);

    const activated = await activate(jsonRequest(`${BASE}/${next.id}/activate`), withId(next.id));
    expect(activated.status).toBe(200);
    const result = await activated.json();
    expect(result.config).toMatchObject({ id: next.id, status: "active" });
    expect(result.retired).toMatchObject({ id: sourceId, status: "retired" });

    const immutable = await update(
      jsonRequest(`${BASE}/${next.id}`, { method: "PUT", body: { modelId: "changed" } }),
      withId(next.id),
    );
    expect(immutable.status).toBe(409);
    expect((await immutable.json()).error.code).toBe("IMMUTABLE_RECORD");

    const audit = await harness.database.db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, next.id));
    expect(audit.map((row) => row.action).sort()).toEqual(["model_config.activate", "model_config.create"]);
    expect(audit.every((row) => row.actorLabel === "admin")).toBe(true);
  });

  it("retires an active config and rejects a bad clone body", async () => {
    await signIn();
    const { configs } = await seed();
    const id = configs.asrDefault.id;
    const badClone = await clone(jsonRequest(`${BASE}/${id}/clone`, { body: { useActivePrompt: "yes" } }), withId(id));
    expect(badClone.status).toBe(400);
    const retired = await retire(jsonRequest(`${BASE}/${id}/retire`), withId(id));
    expect(retired.status).toBe(200);
    expect((await retired.json()).config.status).toBe("retired");
    const again = await retire(jsonRequest(`${BASE}/${id}/retire`), withId(id));
    expect(again.status).toBe(409);
  });
});

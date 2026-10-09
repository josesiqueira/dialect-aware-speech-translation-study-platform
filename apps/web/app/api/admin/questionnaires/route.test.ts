import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { adminAuditLog } from "@dialect/db";
import { insertStudy } from "@dialect/db/testing-builders";
import { createAdminSession } from "@/lib/server/admin-auth";
import { jsonRequest, noParams, setupServerTestHarness } from "@/lib/server/test/database";
import { DELETE as deleteDraft, GET as getVersion, PUT as putVersion } from "./[id]/route";
import { POST as cloneVersion } from "./[id]/clone/route";
import { GET as getDiff } from "./[id]/diff/route";
import { DELETE as deleteItem, PUT as putItem } from "./[id]/items/[itemId]/route";
import { POST as moveItem } from "./[id]/items/[itemId]/move/route";
import { POST as postItem } from "./[id]/items/route";
import { POST as publishVersion } from "./[id]/publish/route";
import { POST as retireVersion } from "./[id]/retire/route";
import { GET as listAll, POST as createDraft } from "./route";

const harness = setupServerTestHarness();
const BASE = "http://localhost:3000/api/admin/questionnaires";
const MISSING = "00000000-0000-4000-8000-000000000000";

const withId = (id: string) => ({ params: Promise.resolve({ id }) });
const withItem = (id: string, itemId: string) => ({ params: Promise.resolve({ id, itemId }) });
const get = (path = "") => new Request(`${BASE}${path}`);
const send = (path: string, method: string, body?: unknown) => jsonRequest(`${BASE}${path}`, { method, body });

let studyReady = false;
beforeEach(async () => {
  if (!studyReady) {
    await insertStudy(harness.database.db, { settingsJson: { adminTimezone: "Europe/Helsinki" } });
    studyReady = true;
  }
});

let keyCounter = 0;
async function newDraft(): Promise<{ id: string; key: string }> {
  keyCounter += 1;
  const key = `route_test_${keyCounter}`;
  const response = await createDraft(send("", "POST", { key, name: "Route test" }), noParams);
  expect(response.status).toBe(200);
  return { id: (await response.json()).version.id, key };
}

describe("authentication", () => {
  it("rejects every route without an admin session", async () => {
    const responses = await Promise.all([
      listAll(get(), noParams),
      createDraft(send("", "POST", { key: "background", name: "Background" }), noParams),
      getVersion(get(`/${MISSING}`), withId(MISSING)),
      putVersion(send(`/${MISSING}`, "PUT", { name: "X" }), withId(MISSING)),
      deleteDraft(send(`/${MISSING}`, "DELETE"), withId(MISSING)),
      publishVersion(send(`/${MISSING}/publish`, "POST"), withId(MISSING)),
      cloneVersion(send(`/${MISSING}/clone`, "POST"), withId(MISSING)),
      retireVersion(send(`/${MISSING}/retire`, "POST"), withId(MISSING)),
      getDiff(get(`/${MISSING}/diff`), withId(MISSING)),
      postItem(send(`/${MISSING}/items`, "POST", { type: "boolean", prompt: "?" }), withId(MISSING)),
      putItem(send(`/${MISSING}/items/${MISSING}`, "PUT", { prompt: "?" }), withItem(MISSING, MISSING)),
      deleteItem(send(`/${MISSING}/items/${MISSING}`, "DELETE"), withItem(MISSING, MISSING)),
      moveItem(send(`/${MISSING}/items/${MISSING}/move`, "POST", { direction: "up" }), withItem(MISSING, MISSING)),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("UNAUTHORIZED");
    }
  });

  it("rejects a cross-origin write with a valid session", async () => {
    await createAdminSession();
    const request = jsonRequest(BASE, { body: { key: "background", name: "B" }, headers: { origin: "https://evil.example" } });
    const response = await createDraft(request, noParams);
    expect(response.status).toBe(403);
  });
});

describe("validation", () => {
  beforeEach(async () => {
    await createAdminSession();
  });

  it("rejects a malformed create body", async () => {
    for (const body of [{}, { key: "Bad Key", name: "X" }, { key: "ok", name: "" }, { key: "ok", name: "X", extra: true }]) {
      const response = await createDraft(send("", "POST", body), noParams);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("rejects an id that is not a UUID and an unknown id", async () => {
    const malformed = await getVersion(get("/not-a-uuid"), withId("not-a-uuid"));
    expect(malformed.status).toBe(400);
    const unknown = await getVersion(get(`/${MISSING}`), withId(MISSING));
    expect(unknown.status).toBe(404);
  });

  it("rejects a malformed item, move and diff request", async () => {
    const { id } = await newDraft();
    const badItem = await postItem(send(`/${id}/items`, "POST", { type: "slider", prompt: "?" }), withId(id));
    expect(badItem.status).toBe(400);
    const badSave = await putVersion(
      send(`/${id}`, "PUT", { items: [{ itemKey: "a", type: "likert", prompt: "?", required: true, config: { scale: 5 } }] }),
      withId(id),
    );
    expect(badSave.status).toBe(400);
    const added = await postItem(send(`/${id}/items`, "POST", { type: "boolean", prompt: "Yes?" }), withId(id));
    const itemId = (await added.json()).version.items[0].id;
    const badMove = await moveItem(send(`/${id}/items/${itemId}/move`, "POST", { direction: "sideways" }), withItem(id, itemId));
    expect(badMove.status).toBe(400);
    const badDiff = await getDiff(get(`/${id}/diff?against=nope`), withId(id));
    expect(badDiff.status).toBe(400);
    // An item addressed through another version is not found.
    const other = await newDraft();
    const wrongParent = await putItem(send(`/${other.id}/items/${itemId}`, "PUT", { prompt: "x" }), withItem(other.id, itemId));
    expect(wrongParent.status).toBe(404);
  });
});

describe("questionnaire routes", () => {
  beforeEach(async () => {
    await createAdminSession();
  });

  it("runs the life cycle: create, edit, save, publish, clone, diff, retire", async () => {
    const { id, key } = await newDraft();

    const second = await createDraft(send("", "POST", { key, name: "Second draft" }), noParams);
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe("CONFLICT");

    const emptyPublish = await publishVersion(send(`/${id}/publish`, "POST"), withId(id));
    expect(emptyPublish.status).toBe(400);
    expect((await emptyPublish.json()).error.details.problems).toEqual(["Add at least one item."]);

    // Member routes for items.
    let response = await postItem(send(`/${id}/items`, "POST", { type: "boolean", prompt: "Did you change how you speak?" }), withId(id));
    let version = (await response.json()).version;
    expect(version.items[0].itemKey).toBe("did_you_change_how_you_speak");
    response = await postItem(send(`/${id}/items`, "POST", { itemKey: "comment", type: "free_text", prompt: "Comment?" }), withId(id));
    version = (await response.json()).version;
    const [first, comment] = version.items;
    response = await moveItem(send(`/${id}/items/${comment.id}/move`, "POST", { direction: "up" }), withItem(id, comment.id));
    expect((await response.json()).version.items.map((item: { itemKey: string }) => item.itemKey)).toEqual([
      "comment",
      "did_you_change_how_you_speak",
    ]);
    response = await putItem(send(`/${id}/items/${first.id}`, "PUT", { required: true }), withItem(id, first.id));
    expect((await response.json()).version.items[1].required).toBe(true);
    response = await deleteItem(send(`/${id}/items/${comment.id}`, "DELETE"), withItem(id, comment.id));
    expect((await response.json()).version.items).toHaveLength(1);

    // The editor's Save: the whole draft in one request.
    response = await putVersion(
      send(`/${id}`, "PUT", {
        name: "Route test, saved",
        description: "Saved in one request.",
        items: [
          { id: first.id, itemKey: first.itemKey, type: "boolean", prompt: first.prompt, required: true, config: {} },
          {
            itemKey: "natural",
            type: "likert",
            prompt: "How natural?",
            required: true,
            config: { scaleMin: 1, scaleMax: 5, scaleMinLabel: "Not at all", scaleMaxLabel: "Completely" },
          },
        ],
      }),
      withId(id),
    );
    expect(response.status).toBe(200);
    version = (await response.json()).version;
    expect(version).toMatchObject({ name: "Route test, saved", status: "draft", itemCount: 2 });

    response = await publishVersion(send(`/${id}/publish`, "POST"), withId(id));
    expect(response.status).toBe(200);
    expect((await response.json()).version).toMatchObject({ status: "published", publishedAt: harness.now.toISOString() });

    // Immutable afterwards.
    response = await putVersion(send(`/${id}`, "PUT", { name: "Changed" }), withId(id));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("IMMUTABLE_RECORD");
    response = await deleteDraft(send(`/${id}`, "DELETE"), withId(id));
    expect(response.status).toBe(409);

    response = await cloneVersion(send(`/${id}/clone`, "POST"), withId(id));
    const clone = (await response.json()).version;
    expect(clone).toMatchObject({ key, versionNumber: 2, status: "draft" });
    expect(clone.items.map((item: { itemKey: string }) => item.itemKey)).toEqual(["did_you_change_how_you_speak", "natural"]);

    // Without `against` the clone is compared with the previous published version.
    response = await getDiff(get(`/${clone.id}/diff`), withId(clone.id));
    expect((await response.json()).diff).toMatchObject({ from: { id }, to: { id: clone.id }, identical: true });
    response = await getDiff(get(`/${id}/diff`), withId(id));
    expect((await response.json()).diff).toMatchObject({ from: null, identical: false });

    response = await listAll(get(), noParams);
    const list = await response.json();
    expect(list.adminTimezone).toBe("Europe/Helsinki");
    const group = list.questionnaires.find((entry: { key: string }) => entry.key === key);
    expect(group.versions.map((entry: { versionNumber: number; status: string }) => [entry.versionNumber, entry.status])).toEqual([
      [2, "draft"],
      [1, "published"],
    ]);
    expect(response.headers.get("cache-control")).toBe("no-store, private");

    response = await deleteDraft(send(`/${clone.id}`, "DELETE"), withId(clone.id));
    expect(await response.json()).toEqual({ deleted: true, id: clone.id });

    response = await retireVersion(send(`/${id}/retire`, "POST"), withId(id));
    expect((await response.json()).version.status).toBe("retired");

    const audit = await harness.database.db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, id));
    const actions = audit.map((row) => row.action);
    expect(actions).toContain("questionnaire.create");
    expect(actions).toContain("questionnaire.update_draft");
    expect(actions).toContain("questionnaire.publish");
    expect(actions).toContain("questionnaire.retire");
    expect(audit.every((row) => row.actorLabel === "admin")).toBe(true);
  });
});

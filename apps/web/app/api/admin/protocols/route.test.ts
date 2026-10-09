// Route tests for the protocol and consent API: sign-in, same-origin check,
// input validation and the mapping of service errors to HTTP responses.
// The rules themselves are tested in packages/research/src/protocols.
import { beforeAll, describe, expect, it } from "vitest";
import { insertPublishedProtocol, insertQuestionnaire, insertStudy } from "@dialect/db/testing-builders";
import { createAdminSession } from "@/lib/server/admin-auth";
import { jsonRequest, setupServerTestHarness } from "@/lib/server/test/database";
import { GET as listConsents, POST as createConsent } from "../consents/route";
import { PUT as updateConsent } from "../consents/[id]/route";
import { POST as publishConsent } from "../consents/[id]/publish/route";
import { POST as cloneProtocol } from "./[id]/clone/route";
import { GET as getDiff } from "./[id]/diff/route";
import { POST as publish } from "./[id]/publish/route";
import { POST as retire } from "./[id]/retire/route";
import { DELETE as deleteProtocol, GET as getProtocol, PUT as updateProtocol } from "./[id]/route";
import { POST as moveTask } from "./[id]/tasks/[taskId]/move/route";
import { DELETE as deleteTask, PUT as updateTask } from "./[id]/tasks/[taskId]/route";
import { POST as addFollowup } from "./[id]/tasks/[taskId]/followups/route";
import { POST as addTask } from "./[id]/tasks/route";
import { GET as validate } from "./[id]/validate/route";
import { GET as listProtocols, POST as createProtocol } from "./route";

const harness = setupServerTestHarness();
const BASE = "http://localhost:3000/api/admin";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

const none = { params: Promise.resolve({}) } as { params: Promise<Record<string, never>> };
const withParams = <P>(params: P) => ({ params: Promise.resolve(params) });
const get = (path: string) => jsonRequest(`${BASE}${path}`, { method: "GET" });
const send = (method: string, path: string, body?: unknown) => jsonRequest(`${BASE}${path}`, { method, body });

let publishedId: string;

beforeAll(async () => {
  const db = harness.database.db;
  const study = await insertStudy(db);
  const background = await insertQuestionnaire(db, { studyId: study.id, key: "background" });
  const published = await insertPublishedProtocol(db, {
    studyId: study.id,
    backgroundQuestionnaireVersionId: background.version.id,
  });
  publishedId = published.protocol.id;
});

describe("authentication and origin", () => {
  it("rejects every route without an admin session", async () => {
    const responses = await Promise.all([
      listProtocols(get("/protocols"), none),
      createProtocol(send("POST", "/protocols", { name: "X" }), none),
      getProtocol(get(`/protocols/${publishedId}`), withParams({ id: publishedId })),
      publish(send("POST", `/protocols/${publishedId}/publish`), withParams({ id: publishedId })),
      deleteProtocol(send("DELETE", `/protocols/${publishedId}`), withParams({ id: publishedId })),
      listConsents(get("/consents"), none),
      createConsent(send("POST", "/consents", { title: "X" }), none),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("UNAUTHORIZED");
      expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    }
  });

  it("rejects a state-changing request from another origin", async () => {
    await createAdminSession();
    const response = await createProtocol(
      jsonRequest(`${BASE}/protocols`, { body: { name: "X" }, headers: { origin: "https://evil.example" } }),
      none,
    );
    expect(response.status).toBe(403);
  });
});

describe("protocol routes", () => {
  it("lists versions with the selectable options", async () => {
    await createAdminSession();
    const response = await listProtocols(get("/protocols"), none);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.currentProtocolVersionId).toBe(publishedId);
    expect(body.draftProtocolVersionId).toBeNull();
    expect(body.protocols).toHaveLength(1);
    expect(body.protocols[0]).toMatchObject({ id: publishedId, status: "published", isCurrent: true, taskCount: 2 });
    expect(body.options.consentVersions).toHaveLength(1);
    expect(body.options.backgroundQuestionnaires).toHaveLength(1);
    expect(body.options.postQuestionnaires).toEqual([]);
  });

  it("validates ids and bodies", async () => {
    await createAdminSession();
    const badId = await getProtocol(get("/protocols/not-a-uuid"), withParams({ id: "not-a-uuid" }));
    expect(badId.status).toBe(400);
    expect((await badId.json()).error.code).toBe("VALIDATION_ERROR");

    const unknown = await getProtocol(get(`/protocols/${UNKNOWN_ID}`), withParams({ id: UNKNOWN_ID }));
    expect(unknown.status).toBe(404);

    const noName = await createProtocol(send("POST", "/protocols", { name: "   " }), none);
    expect(noName.status).toBe(400);
    expect((await noName.json()).error.details.issues[0].path).toBe("name");

    const notJson = await createProtocol(
      new Request(`${BASE}/protocols`, { method: "POST", body: "{", headers: { origin: "http://localhost:3000" } }),
      none,
    );
    expect(notJson.status).toBe(400);
  });

  it("refuses to change a published version", async () => {
    await createAdminSession();
    const current = await (await getProtocol(get(`/protocols/${publishedId}`), withParams({ id: publishedId }))).json();
    const taskId = current.tasks[0].id as string;

    const edit = await updateProtocol(
      send("PUT", `/protocols/${publishedId}`, { welcomeContent: "Changed", expectedUpdatedAt: current.protocol.updatedAt }),
      withParams({ id: publishedId }),
    );
    expect(edit.status).toBe(409);
    expect((await edit.json()).error.code).toBe("IMMUTABLE_RECORD");

    const taskEdit = await updateTask(
      send("PUT", `/protocols/${publishedId}/tasks/${taskId}`, { participantPrompt: "Changed" }),
      withParams({ id: publishedId, taskId }),
    );
    expect(taskEdit.status).toBe(409);
    expect((await taskEdit.json()).error.code).toBe("IMMUTABLE_RECORD");

    const removal = await deleteTask(
      send("DELETE", `/protocols/${publishedId}/tasks/${taskId}`),
      withParams({ id: publishedId, taskId }),
    );
    expect(removal.status).toBe(409);

    const deletion = await deleteProtocol(send("DELETE", `/protocols/${publishedId}`), withParams({ id: publishedId }));
    expect(deletion.status).toBe(409);

    const retirement = await retire(send("POST", `/protocols/${publishedId}/retire`), withParams({ id: publishedId }));
    expect(retirement.status).toBe(409);
    expect((await retirement.json()).error.code).toBe("INVALID_STATE");
  });

  it("runs the draft workflow: clone, edit, validate, compare, publish", async () => {
    await createAdminSession();
    const cloned = await cloneProtocol(send("POST", `/protocols/${publishedId}/clone`), withParams({ id: publishedId }));
    expect(cloned.status).toBe(200);
    let draft = await cloned.json();
    const id = draft.protocol.id as string;
    expect(draft.protocol).toMatchObject({ status: "draft", versionNumber: 2, clonedFromProtocolVersionId: publishedId });
    expect(typeof draft.protocol.updatedAt).toBe("string");

    // Only one draft at a time.
    const second = await createProtocol(send("POST", "/protocols", { name: "Another" }), none);
    expect(second.status).toBe(409);
    expect((await second.json()).error.details.draftProtocolVersionId).toBe(id);

    // The protocol update needs the updated_at that the editor loaded.
    const withoutStamp = await updateProtocol(send("PUT", `/protocols/${id}`, { debriefContent: "" }), withParams({ id }));
    expect(withoutStamp.status).toBe(400);
    const unknownField = await updateProtocol(
      send("PUT", `/protocols/${id}`, { orderConfig: { blocks: [{ key: "Not A Key", orderMode: "fixed" }] }, expectedUpdatedAt: draft.protocol.updatedAt }),
      withParams({ id }),
    );
    expect(unknownField.status).toBe(400);

    const staleStamp = draft.protocol.updatedAt as string;
    const saved = await updateProtocol(
      send("PUT", `/protocols/${id}`, { debriefContent: "", expectedUpdatedAt: staleStamp }),
      withParams({ id }),
    );
    expect(saved.status).toBe(200);
    draft = await saved.json();
    expect(draft.protocol.debriefContent).toBe("");

    const stale = await updateProtocol(
      send("PUT", `/protocols/${id}`, { debriefContent: "Lost update", expectedUpdatedAt: staleStamp }),
      withParams({ id }),
    );
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("CONFLICT");

    // Tasks: add, move, follow-up, with input validation.
    const badTask = await addTask(send("POST", `/protocols/${id}/tasks`, { taskType: "sung", blockKey: "controlled" }), withParams({ id }));
    expect(badTask.status).toBe(400);
    const added = await addTask(
      send("POST", `/protocols/${id}/tasks`, {
        taskType: "controlled",
        blockKey: "controlled",
        title: "Second controlled task",
        participantPrompt: "Describe a situation.",
        expectedUpdatedAt: draft.protocol.updatedAt,
      }),
      withParams({ id }),
    );
    expect(added.status).toBe(200);
    draft = await added.json();
    expect(draft.tasks.map((task: { taskKey: string }) => task.taskKey)).toEqual([
      "controlled_1",
      "second_controlled_task",
      "semi_1",
    ]);
    const newTaskId = draft.tasks[1].id as string;

    const moved = await moveTask(
      send("POST", `/protocols/${id}/tasks/${newTaskId}/move`, { direction: "up" }),
      withParams({ id, taskId: newTaskId }),
    );
    expect((await moved.json()).tasks.map((task: { orderIndex: number; taskKey: string }) => `${task.orderIndex}:${task.taskKey}`)).toEqual([
      "0:second_controlled_task",
      "1:controlled_1",
      "2:semi_1",
    ]);
    const badMove = await moveTask(
      send("POST", `/protocols/${id}/tasks/${newTaskId}/move`, { direction: "sideways" }),
      withParams({ id, taskId: newTaskId }),
    );
    expect(badMove.status).toBe(400);
    // A task addressed through another protocol version is not found.
    const wrongParent = await moveTask(
      send("POST", `/protocols/${publishedId}/tasks/${newTaskId}/move`, { direction: "down" }),
      withParams({ id: publishedId, taskId: newTaskId }),
    );
    expect(wrongParent.status).toBe(404);

    const followup = await addFollowup(
      send("POST", `/protocols/${id}/tasks/${newTaskId}/followups`, { promptText: "Can you give an example?" }),
      withParams({ id, taskId: newTaskId }),
    );
    expect(followup.status).toBe(200);

    // The check reports the empty debrief text, and publishing is refused with the same list.
    const check = await (await validate(get(`/protocols/${id}/validate`), withParams({ id }))).json();
    expect(check.canPublish).toBe(false);
    expect(check.errors).toMatchObject([{ code: "content_missing", field: "debriefContent" }]);
    const refused = await publish(send("POST", `/protocols/${id}/publish`), withParams({ id }));
    expect(refused.status).toBe(400);
    const refusedBody = await refused.json();
    expect(refusedBody.error.code).toBe("VALIDATION_ERROR");
    expect(refusedBody.error.details.problems).toHaveLength(1);
    expect((await (await listProtocols(get("/protocols"), none)).json()).currentProtocolVersionId).toBe(publishedId);

    draft = await (await getProtocol(get(`/protocols/${id}`), withParams({ id }))).json();
    await updateProtocol(
      send("PUT", `/protocols/${id}`, { debriefContent: "Thank you.", expectedUpdatedAt: draft.protocol.updatedAt }),
      withParams({ id }),
    );

    // Difference against the current version by default, or against a named version.
    const diff = await (await getDiff(get(`/protocols/${id}/diff`), withParams({ id }))).json();
    expect(diff.from.id).toBe(publishedId);
    expect(diff.tasksAdded.map((task: { taskKey: string }) => task.taskKey)).toEqual(["second_controlled_task"]);
    expect(diff.contentChanges.map((change: { field: string }) => change.field)).toEqual(["debriefContent"]);
    const badDiff = await getDiff(get(`/protocols/${id}/diff?against=nope`), withParams({ id }));
    expect(badDiff.status).toBe(400);
    const reverse = await (
      await getDiff(get(`/protocols/${publishedId}/diff?against=${id}`), withParams({ id: publishedId }))
    ).json();
    expect(reverse.tasksRemoved).toHaveLength(1);

    const published = await publish(send("POST", `/protocols/${id}/publish`), withParams({ id }));
    expect(published.status).toBe(200);
    const result = await published.json();
    expect(result.protocol.protocol).toMatchObject({ status: "published", isCurrent: true });
    expect(result.previousProtocolVersionId).toBe(publishedId);

    const list = await (await listProtocols(get("/protocols"), none)).json();
    expect(list.currentProtocolVersionId).toBe(id);
    expect(list.protocols.map((row: { status: string }) => row.status)).toEqual(["published", "published"]);

    // The previous version can now be retired, and stays readable.
    const retired = await retire(send("POST", `/protocols/${publishedId}/retire`), withParams({ id: publishedId }));
    expect(retired.status).toBe(200);
    expect((await retired.json()).protocol.status).toBe("retired");
  });
});

describe("consent routes", () => {
  it("creates, validates and publishes a consent version", async () => {
    await createAdminSession();
    const badUrl = await createConsent(send("POST", "/consents", { title: "Consent", privacyNoticeUrl: "javascript:alert(1)" }), none);
    expect(badUrl.status).toBe(400);
    const duplicateIds = await createConsent(
      send("POST", "/consents", {
        title: "Consent",
        items: [
          { id: "a", text: "One", required: true },
          { id: "a", text: "Two", required: true },
        ],
      }),
      none,
    );
    expect(duplicateIds.status).toBe(400);

    const created = await createConsent(send("POST", "/consents", { title: "Consent, second version" }), none);
    expect(created.status).toBe(200);
    const draft = await created.json();
    expect(draft).toMatchObject({ status: "draft", versionNumber: 2 });
    const id = draft.id as string;

    const incomplete = await publishConsent(send("POST", `/consents/${id}/publish`), withParams({ id }));
    expect(incomplete.status).toBe(400);
    expect((await incomplete.json()).error.details.problems.length).toBeGreaterThan(0);

    const updated = await updateConsent(
      send("PUT", `/consents/${id}`, {
        informationText: "About the study.",
        privacyNoticeUrl: "https://example.org/privacy",
        items: [{ id: "participation", text: "I agree to take part.", required: true, scope: "participation" }],
      }),
      withParams({ id }),
    );
    expect(updated.status).toBe(200);

    const published = await publishConsent(send("POST", `/consents/${id}/publish`), withParams({ id }));
    expect(published.status).toBe(200);
    expect((await published.json()).status).toBe("published");

    const afterPublish = await updateConsent(send("PUT", `/consents/${id}`, { title: "Changed" }), withParams({ id }));
    expect(afterPublish.status).toBe(409);
    expect((await afterPublish.json()).error.code).toBe("IMMUTABLE_RECORD");

    const list = await (await listConsents(get("/consents"), none)).json();
    expect(list.consents.map((row: { versionNumber: number; status: string }) => [row.versionNumber, row.status])).toEqual([
      [2, "published"],
      [1, "published"],
    ]);
  });
});

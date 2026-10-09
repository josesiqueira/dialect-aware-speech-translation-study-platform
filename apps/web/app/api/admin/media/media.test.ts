import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { adminAuditLog, mediaAssets, utterances } from "@dialect/db";
import { insertMediaAsset, insertSessionWithUtterance, type CollectedSession } from "@dialect/db/testing-builders";
import { corpusSchemas } from "@dialect/domain";
import { createAdminSession } from "@/lib/server/admin-auth";
import { jsonRequest, setupServerTestHarness } from "@/lib/server/test/database";
import { GET as download } from "./[id]/download/route";
import { DELETE as remove, GET as stream } from "./[id]/route";
import { parseRangeHeader } from "./_lib/stream";

const harness = setupServerTestHarness();
const BASE = "http://localhost:3000/api/admin/media";

// 1000 bytes whose value is their position modulo 251, so every slice is recognizable.
const FILE = Buffer.from(Array.from({ length: 1000 }, (_, index) => index % 251));

let counter = 0;
async function collect(overrides: { mimeType?: string; code?: string } = {}): Promise<CollectedSession> {
  counter += 1;
  const storageKey = `studies/test/sessions/file-${counter}.wav`;
  await harness.storage.put({ key: storageKey, body: FILE, contentType: "audio/wav" });
  return insertSessionWithUtterance(harness.database.db, {
    session: { participantCode: overrides.code ?? `P-MEDIA${String(counter).padStart(3, "0")}`, mode: "test" },
    media: {
      storageDriver: "memory",
      storageKey,
      sizeBytes: FILE.length,
      mimeType: overrides.mimeType ?? "audio/wav",
    },
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id: string, range?: string) =>
  stream(new Request(`${BASE}/${id}`, { headers: range ? { range } : {} }), params(id));

async function bytes(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

describe("parseRangeHeader", () => {
  it("reads single byte ranges", () => {
    expect(parseRangeHeader(null, 1000)).toBeNull();
    expect(parseRangeHeader("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRangeHeader("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRangeHeader("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRangeHeader("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRangeHeader("bytes=990-5000", 1000)).toEqual({ start: 990, end: 999 });
    expect(parseRangeHeader("BYTES=0-0", 1000)).toEqual({ start: 0, end: 0 });
  });

  it("reports ranges that cannot be served", () => {
    for (const header of ["bytes=1000-", "bytes=2000-3000", "bytes=50-10", "bytes=-0", "bytes=-", "bytes=abc", "bytes=1.5-2"]) {
      expect(parseRangeHeader(header, 1000), header).toBe("unsatisfiable");
    }
    expect(parseRangeHeader("bytes=0-", 0)).toBe("unsatisfiable");
  });

  it("ignores other units and multiple ranges, so the whole file is sent", () => {
    expect(parseRangeHeader("items=0-5", 1000)).toBeNull();
    expect(parseRangeHeader("bytes=0-10, 20-30", 1000)).toBeNull();
  });
});

describe("GET /api/admin/media/:id", () => {
  it("rejects a request without an admin session and sends no audio", async () => {
    const collected = await collect();
    const response = await get(collected.media.id);
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("UNAUTHORIZED");
    expect((await download(new Request(`${BASE}/${collected.media.id}/download`), params(collected.media.id))).status).toBe(401);
    const removal = await remove(
      jsonRequest(`${BASE}/${collected.media.id}`, { method: "DELETE", body: { reason: "x" } }),
      params(collected.media.id),
    );
    expect(removal.status).toBe(401);
    expect(await harness.storage.exists(collected.media.storageKey)).toBe(true);
  });

  describe("with an admin session", () => {
    beforeEach(async () => {
      await createAdminSession();
    });

    it("sends the whole file with the stored type, no-store and Accept-Ranges", async () => {
      const collected = await collect();
      const response = await get(collected.media.id);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("audio/wav");
      expect(response.headers.get("content-length")).toBe("1000");
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(response.headers.get("cache-control")).toBe("no-store, private");
      expect(response.headers.get("content-disposition")).toBe("inline");
      expect(response.headers.get("content-range")).toBeNull();
      expect(response.headers.get("x-request-id")).toBeTruthy();
      expect((await bytes(response)).equals(FILE)).toBe(true);
    });

    it("uses the content type of the asset row", async () => {
      const collected = await collect({ mimeType: "audio/webm;codecs=opus" });
      const response = await get(collected.media.id);
      expect(response.headers.get("content-type")).toBe("audio/webm;codecs=opus");
    });

    it("serves a partial range with 206 and Content-Range", async () => {
      const collected = await collect();
      const response = await get(collected.media.id, "bytes=100-199");
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe("bytes 100-199/1000");
      expect(response.headers.get("content-length")).toBe("100");
      expect(response.headers.get("cache-control")).toBe("no-store, private");
      expect((await bytes(response)).equals(FILE.subarray(100, 200))).toBe(true);
    });

    it("serves a suffix range and an open-ended range", async () => {
      const collected = await collect();
      const suffix = await get(collected.media.id, "bytes=-50");
      expect(suffix.status).toBe(206);
      expect(suffix.headers.get("content-range")).toBe("bytes 950-999/1000");
      expect((await bytes(suffix)).equals(FILE.subarray(950))).toBe(true);

      const open = await get(collected.media.id, "bytes=990-");
      expect(open.status).toBe(206);
      expect(open.headers.get("content-range")).toBe("bytes 990-999/1000");
      expect(open.headers.get("content-length")).toBe("10");
      expect((await bytes(open)).equals(FILE.subarray(990))).toBe(true);

      // The first request of a browser audio element.
      const whole = await get(collected.media.id, "bytes=0-");
      expect(whole.status).toBe(206);
      expect(whole.headers.get("content-range")).toBe("bytes 0-999/1000");
      expect((await bytes(whole)).length).toBe(1000);
    });

    it("answers 416 with the file size for a range that cannot be served", async () => {
      const collected = await collect();
      for (const range of ["bytes=1000-", "bytes=5000-6000", "bytes=20-10", "bytes=-0"]) {
        const response = await get(collected.media.id, range);
        expect(response.status, range).toBe(416);
        expect(response.headers.get("content-range")).toBe("bytes */1000");
        expect(response.headers.get("cache-control")).toBe("no-store, private");
        expect((await bytes(response)).length).toBeLessThan(200);
      }
    });

    it("answers 404 for an unknown id, a malformed id, a deleted asset and a missing file", async () => {
      expect((await get("00000000-0000-4000-8000-000000000000")).status).toBe(404);
      expect((await get("not-a-uuid")).status).toBe(404);

      const collected = await collect();
      await harness.storage.delete(collected.media.storageKey);
      const missingFile = await get(collected.media.id);
      expect(missingFile.status).toBe(404);
      expect((await missingFile.json()).error.code).toBe("MEDIA_NOT_FOUND");

      const deleted = await collect();
      await harness.database.db
        .update(mediaAssets)
        .set({ deletedAt: new Date() })
        .where(eq(mediaAssets.id, deleted.media.id));
      const response = await get(deleted.media.id);
      expect(response.status).toBe(404);
      const text = JSON.stringify(await response.json());
      expect(text).not.toContain(deleted.media.storageKey);
      expect((await download(new Request(`${BASE}/${deleted.media.id}/download`), params(deleted.media.id))).status).toBe(404);
    });
  });
});

describe("export archives on the media routes", () => {
  it("are never streamed or downloaded here, and no audit row is written", async () => {
    await createAdminSession();
    const collected = await collect();
    const key = "exports/test/archive-route.zip";
    await harness.storage.put({ key, body: Buffer.from("PK-archive-bytes"), contentType: "application/zip" });
    const archive = await insertMediaAsset(harness.database.db, {
      studyId: collected.study.id,
      kind: "export_archive",
      storageDriver: "memory",
      storageKey: key,
      mimeType: "application/zip",
      container: "zip",
      codec: null,
      sampleRateHz: null,
      channels: null,
      bitDepth: null,
      durationMs: null,
      captureMethod: null,
      captureQualityClass: null,
    });
    const inline = await get(archive.id);
    expect(inline.status).toBe(404);
    const body = JSON.stringify(await inline.json());
    expect(body).toContain("MEDIA_NOT_FOUND");
    expect(body).not.toContain("PK-archive-bytes");
    expect((await download(new Request(`${BASE}/${archive.id}/download`), params(archive.id))).status).toBe(404);
  });
});

describe("GET /api/admin/media/:id/download", () => {
  beforeEach(async () => {
    await createAdminSession();
  });

  it("sends an attachment with a pseudonymous file name", async () => {
    const collected = await collect({ code: "P-7K4M9Q" });
    const response = await download(new Request(`${BASE}/${collected.media.id}/download`), params(collected.media.id));
    expect(response.status).toBe(200);
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toBe('attachment; filename="P-7K4M9Q_U-01_source.wav"');
    // Neither the storage key nor a bare UUID is used as the name.
    expect(disposition).not.toContain("studies/");
    expect(disposition).not.toContain(collected.media.storageKey);
    expect(disposition).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect((await bytes(response)).equals(FILE)).toBe(true);
  });

  it("supports ranges as well", async () => {
    const collected = await collect();
    const response = await download(
      new Request(`${BASE}/${collected.media.id}/download`, { headers: { range: "bytes=0-9" } }),
      params(collected.media.id),
    );
    expect(response.status).toBe(206);
    expect((await bytes(response)).equals(FILE.subarray(0, 10))).toBe(true);
  });

  it("writes a media.download audit row, and inline streaming for the player writes none", async () => {
    const collected = await collect({ code: "P-AUD1T2" });
    const auditRows = () =>
      harness.database.db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, collected.media.id));

    // The audio player streams and seeks: nothing is recorded.
    await bytes(await get(collected.media.id));
    await bytes(await get(collected.media.id, "bytes=0-99"));
    expect(await auditRows()).toHaveLength(0);

    const response = await download(new Request(`${BASE}/${collected.media.id}/download`), params(collected.media.id));
    expect(response.status).toBe(200);
    await bytes(response);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "media.download",
      entityType: "media_asset",
      actorLabel: "admin",
      afterJson: {
        kind: collected.media.kind,
        fileName: "P-AUD1T2_U-01_source.wav",
        sha256: collected.media.sha256,
        utteranceId: collected.utterance.id,
      },
    });
    // The audit row holds the pseudonymous name, never the storage key.
    expect(JSON.stringify(rows[0])).not.toContain(collected.media.storageKey);

    // A range that cannot be served sends no file content and records nothing.
    const refused = await download(
      new Request(`${BASE}/${collected.media.id}/download`, { headers: { range: "bytes=5000-" } }),
      params(collected.media.id),
    );
    expect(refused.status).toBe(416);
    expect(await auditRows()).toHaveLength(1);
  });
});

describe("DELETE /api/admin/media/:id", () => {
  beforeEach(async () => {
    await createAdminSession();
  });

  const del = (id: string, body: unknown, options: { sameOrigin?: boolean } = {}) =>
    remove(jsonRequest(`${BASE}/${id}`, { method: "DELETE", body, ...options }), params(id));

  it("requires a reason and the typed phrase for an accepted recording", async () => {
    const collected = await collect();
    expect((await del(collected.media.id, {})).status).toBe(400);
    const response = await del(collected.media.id, { reason: "Removal request" });
    expect(response.status).toBe(400);
    expect((await response.json()).error.details).toMatchObject({ confirmationRequired: true });
    expect(await harness.storage.exists(collected.media.storageKey)).toBe(true);
  });

  it("rejects a cross-origin request", async () => {
    const collected = await collect();
    const response = await del(
      collected.media.id,
      { reason: "x", confirmationPhrase: corpusSchemas.MEDIA_DELETE_PHRASE },
      { sameOrigin: false },
    );
    expect(response.status).toBe(403);
    expect(await harness.storage.exists(collected.media.storageKey)).toBe(true);
  });

  it("marks the row deleted, removes the file, excludes the utterance and audits", async () => {
    const collected = await collect();
    const response = await del(collected.media.id, {
      reason: "Removal request",
      confirmationPhrase: corpusSchemas.MEDIA_DELETE_PHRASE,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      mediaAssetId: collected.media.id,
      storageObjectRemoved: true,
      utterance: { id: collected.utterance.id, status: "excluded" },
    });
    const db = harness.database.db;
    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, collected.media.id));
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.sha256).toBe(collected.media.sha256);
    expect(await harness.storage.exists(collected.media.storageKey)).toBe(false);
    const [utterance] = await db.select().from(utterances).where(eq(utterances.id, collected.utterance.id));
    expect(utterance?.status).toBe("excluded");
    const audit = await db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, collected.media.id));
    expect(audit.map((entry) => entry.action)).toEqual(["media.delete"]);
    expect((await get(collected.media.id)).status).toBe(404);
  });
});

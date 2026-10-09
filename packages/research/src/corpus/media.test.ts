import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminAuditLog, mediaAssets, utterances } from "@dialect/db";
import {
  insertMediaAsset,
  insertSessionWithUtterance,
  type CollectedSession,
} from "@dialect/db/testing-builders";
import { corpusSchemas } from "@dialect/domain";
import { generateSineWav } from "@dialect/storage";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import { includeUtterance } from "./curation";
import { deleteMedia, getMediaDownloadName, getMediaForStreaming } from "./media";
import { getSessionDetail } from "./session-detail";
import { processUtterance } from "./test-helpers";

let t: TestServiceContext;
let studyId: string;
let protocolVersionId: string;

const wav = generateSineWav({ durationMs: 200, sampleRateHz: 16000, frequencyHz: 440 });

// A session whose accepted recording exists as a file in the test storage.
async function collectWithFile(code: string, mode: "research" | "test" = "research"): Promise<CollectedSession> {
  const key = `studies/test/${code}.wav`;
  await t.storage.put({ key, body: wav, contentType: "audio/wav" });
  return insertSessionWithUtterance(t.ctx.db, {
    studyId,
    protocolVersionId,
    session: { participantCode: code, mode },
    media: { storageDriver: "memory", storageKey: key, sizeBytes: wav.length },
  });
}

async function auditOf(entityId: string) {
  return t.ctx.db
    .select()
    .from(adminAuditLog)
    .where(eq(adminAuditLog.entityId, entityId))
    .orderBy(asc(adminAuditLog.createdAt), asc(adminAuditLog.id));
}

beforeAll(async () => {
  t = await createTestServiceContext();
  const first = await insertSessionWithUtterance(t.ctx.db, {});
  studyId = first.study.id;
  protocolVersionId = first.protocol.id;
});

afterAll(async () => {
  await t.cleanup();
});

describe("getMediaForStreaming", () => {
  it("returns the row of an existing asset and 404 for a missing, malformed or deleted one", async () => {
    const collected = await collectWithFile("P-STREAM01");
    const asset = await getMediaForStreaming(t.adminCtx, collected.media.id);
    expect(asset).toMatchObject({ id: collected.media.id, mimeType: "audio/wav", sizeBytes: wav.length });

    await expect(getMediaForStreaming(t.adminCtx, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
      code: "MEDIA_NOT_FOUND",
      httpStatus: 404,
    });
    await expect(getMediaForStreaming(t.adminCtx, "not-a-uuid")).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND" });

    await deleteMedia(t.adminCtx, {
      mediaAssetId: collected.media.id,
      reason: "Test of deletion",
      confirmationPhrase: corpusSchemas.MEDIA_DELETE_PHRASE,
    });
    await expect(getMediaForStreaming(t.adminCtx, collected.media.id)).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND" });
  });
});

describe("getMediaForStreaming and export archives", () => {
  it("answers 404 for an export archive: it is served only by the audited export download route", async () => {
    const key = "exports/test/archive.zip";
    await t.storage.put({ key, body: Buffer.from("PK-archive-bytes"), contentType: "application/zip" });
    const archive = await insertMediaAsset(t.ctx.db, {
      studyId,
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
    await expect(getMediaForStreaming(t.adminCtx, archive.id)).rejects.toMatchObject({
      code: "MEDIA_NOT_FOUND",
      httpStatus: 404,
    });
  });
});

describe("getMediaDownloadName", () => {
  it("builds a pseudonymous file name without the storage key", async () => {
    const collected = await collectWithFile("P-7K4M9Q");
    const name = await getMediaDownloadName(t.adminCtx, collected.media);
    expect(name).toBe("P-7K4M9Q_U-01_source.wav");
    expect(name).not.toContain(collected.media.id);

    const processed = await processUtterance(t.ctx.db, {
      studyId,
      utteranceId: collected.utterance.id,
      batchNames: ["names-batch"],
    });
    const output = processed.batches[0]?.outputs.find(
      (entry) => entry.sourceType === "human_dialect" && entry.condition === "preservation",
    );
    if (!output) throw new Error("missing output");
    const ttsName = await getMediaDownloadName(t.adminCtx, output.synthesis.media);
    expect(ttsName).toBe(`P-7K4M9Q_U-01_B_preservation_tts-baseline_${output.synthesis.media.id.slice(0, 8)}.wav`);
    expect(ttsName).not.toContain("test/");

    const loose = await insertMediaAsset(t.ctx.db, { studyId, kind: "export_archive", mimeType: "application/zip", container: "zip" });
    expect(await getMediaDownloadName(t.adminCtx, loose)).toBe(`export-archive_${loose.id.slice(0, 8)}.zip`);
  });
});

describe("deleteMedia", () => {
  it("needs a reason, and the typed phrase for an accepted recording", async () => {
    const collected = await collectWithFile("P-PHRASE1");
    await expect(deleteMedia(t.adminCtx, { mediaAssetId: collected.media.id, reason: "" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      deleteMedia(t.adminCtx, { mediaAssetId: collected.media.id, reason: "Withdrawal request" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", details: { confirmationRequired: true } });
    await expect(
      deleteMedia(t.adminCtx, { mediaAssetId: collected.media.id, reason: "Withdrawal request", confirmationPhrase: "delete" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // Nothing changed.
    const [row] = await t.ctx.db.select().from(mediaAssets).where(eq(mediaAssets.id, collected.media.id));
    expect(row?.deletedAt).toBeNull();
    expect(await t.storage.exists(collected.media.storageKey)).toBe(true);
    expect(await auditOf(collected.media.id)).toEqual([]);
  });

  it("keeps the row, removes the file, excludes the utterance and audits", async () => {
    const collected = await collectWithFile("P-DELETE1");
    const result = await deleteMedia(t.adminCtx, {
      mediaAssetId: collected.media.id,
      reason: "Participant asked for removal",
      confirmationPhrase: corpusSchemas.MEDIA_DELETE_PHRASE,
    });
    expect(result).toMatchObject({
      mediaAssetId: collected.media.id,
      alreadyDeleted: false,
      storageObjectRemoved: true,
      derivedAssetIds: [],
      utterance: { id: collected.utterance.id, status: "excluded" },
    });

    // The row stays as provenance: hash, size and format are still known.
    const [row] = await t.ctx.db.select().from(mediaAssets).where(eq(mediaAssets.id, collected.media.id));
    expect(row).toMatchObject({
      sha256: collected.media.sha256,
      sizeBytes: wav.length,
      storageKey: collected.media.storageKey,
      metadataJson: { deletion: { reason: "Participant asked for removal", deletedByLabel: "admin" } },
    });
    expect(row?.deletedAt?.toISOString()).toBe(t.clock.now().toISOString());
    expect(await t.storage.exists(collected.media.storageKey)).toBe(false);

    // No utterance in the analysis set points at the missing recording.
    const [utterance] = await t.ctx.db.select().from(utterances).where(eq(utterances.id, collected.utterance.id));
    expect(utterance).toMatchObject({
      status: "excluded",
      exclusionReason: "Source recording deleted: Participant asked for removal",
      acceptedMediaAssetId: collected.media.id,
    });
    await expect(includeUtterance(t.adminCtx, { utteranceId: collected.utterance.id })).rejects.toMatchObject({
      code: "INVALID_STATE",
    });

    const mediaAudit = await auditOf(collected.media.id);
    expect(mediaAudit.map((entry) => entry.action)).toEqual(["media.delete"]);
    expect(mediaAudit[0]).toMatchObject({
      actorLabel: "admin",
      beforeJson: { deletedAt: null, sha256: collected.media.sha256 },
      afterJson: { reason: "Participant asked for removal", utteranceId: collected.utterance.id },
    });
    expect((await auditOf(collected.utterance.id)).map((entry) => entry.action)).toEqual(["utterance.exclude"]);

    const detail = await getSessionDetail(t.adminCtx, collected.session.id);
    expect(detail.utterances[0]?.sourceMedia).toMatchObject({
      deletionReason: "Participant asked for removal",
      sha256: collected.media.sha256,
    });
    expect(detail.utterances[0]?.qualityIndicators).toContain("missing_audio");
  });

  it("can be repeated without a second audit row", async () => {
    const collected = await collectWithFile("P-REPEAT1");
    const input = {
      mediaAssetId: collected.media.id,
      reason: "Duplicate",
      confirmationPhrase: corpusSchemas.MEDIA_DELETE_PHRASE,
    };
    await deleteMedia(t.adminCtx, input);
    const again = await deleteMedia(t.adminCtx, input);
    expect(again).toMatchObject({ alreadyDeleted: true, storageObjectRemoved: true });
    expect(await auditOf(collected.media.id)).toHaveLength(1);
  });

  it("deletes an asset that nothing refers to with only a reason, and deletes derived copies with their original", async () => {
    const collected = await collectWithFile("P-DERIVE1");
    const derivedKey = "studies/test/P-DERIVE1-derived.wav";
    await t.storage.put({ key: derivedKey, body: wav, contentType: "audio/wav" });
    const derived = await insertMediaAsset(t.ctx.db, {
      studyId,
      sessionId: collected.session.id,
      utteranceId: collected.utterance.id,
      kind: "source_audio_derived",
      derivedFromMediaAssetId: collected.media.id,
      storageDriver: "memory",
      storageKey: derivedKey,
    });

    // The derived copy alone: no phrase needed, the utterance is untouched.
    const spareKey = "studies/test/P-DERIVE1-spare.wav";
    await t.storage.put({ key: spareKey, body: wav, contentType: "audio/wav" });
    const spare = await insertMediaAsset(t.ctx.db, { studyId, kind: "other", storageDriver: "memory", storageKey: spareKey });
    const spareResult = await deleteMedia(t.adminCtx, { mediaAssetId: spare.id, reason: "Left over from a failed upload" });
    expect(spareResult).toMatchObject({ utterance: null, storageObjectRemoved: true });
    expect(await t.storage.exists(spareKey)).toBe(false);

    const result = await deleteMedia(t.adminCtx, {
      mediaAssetId: collected.media.id,
      reason: "Removal request",
      confirmationPhrase: corpusSchemas.MEDIA_DELETE_PHRASE,
    });
    expect(result.derivedAssetIds).toEqual([derived.id]);
    expect(await t.storage.exists(derivedKey)).toBe(false);
    const [derivedRow] = await t.ctx.db.select().from(mediaAssets).where(eq(mediaAssets.id, derived.id));
    expect(derivedRow?.deletedAt).not.toBeNull();
    expect((await auditOf(derived.id))[0]).toMatchObject({
      action: "media.delete",
      afterJson: { deletedWithMediaAssetId: collected.media.id },
    });
  });

  it("refuses a file that is stored with another driver", async () => {
    const collected = await insertSessionWithUtterance(t.ctx.db, { studyId, protocolVersionId });
    await expect(
      deleteMedia(t.adminCtx, {
        mediaAssetId: collected.media.id,
        reason: "x",
        confirmationPhrase: corpusSchemas.MEDIA_DELETE_PHRASE,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    const [row] = await t.ctx.db.select().from(mediaAssets).where(eq(mediaAssets.id, collected.media.id));
    expect(row?.deletedAt).toBeNull();
  });
});

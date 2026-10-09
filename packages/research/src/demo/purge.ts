// Removing the data of a demo session, and the audio a demo visitor may hear
// (spec 80, 116).
//
// purgeDemoSession deletes ONE demo session with everything below it. It uses
// the guarded delete of packages/db/src/test-data-reset.ts: the transaction
// turns on `dialect.allow_test_data_reset`, without which the immutability
// triggers refuse every delete, and the triggers still refuse a research row
// with the setting on. The service checks the mode first and never selects a
// research or test session.
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  allowTestDataReset,
  mediaAssets,
  sessions as sessionsTable,
  syntheses,
  transcriptRevisions,
  transcripts,
  translations,
  utterances,
  type Transaction,
} from "@dialect/db";
import { AppError, TERMINAL_SESSION_STATUSES, type demoSchemas } from "@dialect/domain";
import { recordAudit } from "../audit";
import type { ServiceContext } from "../context";
import { resolveStudy } from "../sessions/settings";
import { demoSettings } from "./session";

type PurgeResult = demoSchemas.PurgeDemoSessionResult;

async function deleteSessionRows(tx: Transaction, sessionId: string) {
  await allowTestDataReset(tx);

  // Collect the ids first: later statements cannot follow foreign keys of rows
  // that are already gone.
  await tx.execute(sql`DROP TABLE IF EXISTS _demo_purge_ids`);
  await tx.execute(sql`CREATE TEMP TABLE _demo_purge_ids (kind text NOT NULL, id uuid NOT NULL) ON COMMIT DROP`);
  const add = (kind: string, select: ReturnType<typeof sql>) =>
    tx.execute(sql`INSERT INTO _demo_purge_ids SELECT ${kind}::text, id FROM ${select}`);
  const ids = (kind: string) => sql`(SELECT id FROM _demo_purge_ids WHERE kind = ${kind})`;

  await tx.execute(sql`INSERT INTO _demo_purge_ids VALUES ('session', ${sessionId}::uuid)`);
  // The batches of this session: demo batches whose frozen selection names
  // exactly this session.
  await add(
    "batch",
    sql`processing_batches
        WHERE data_mode = 'demo'
          AND configuration_snapshot_json->'selection'->'sessionIds' = ${JSON.stringify([sessionId])}::jsonb`,
  );
  await add("task_presentation", sql`task_presentations WHERE session_id = ${sessionId}::uuid`);
  await add("utterance", sql`utterances WHERE session_id = ${sessionId}::uuid`);
  await add("transcript", sql`transcripts WHERE utterance_id IN ${ids("utterance")}`);
  await add("transcript_revision", sql`transcript_revisions WHERE transcript_id IN ${ids("transcript")}`);
  await add(
    "translation",
    sql`translations
        WHERE source_transcript_revision_id IN ${ids("transcript_revision")}
           OR processing_batch_id IN ${ids("batch")}`,
  );
  await add(
    "synthesis",
    sql`syntheses WHERE translation_id IN ${ids("translation")} OR processing_batch_id IN ${ids("batch")}`,
  );
  await add(
    "media_asset",
    sql`media_assets
        WHERE session_id = ${sessionId}::uuid
           OR id IN (SELECT media_asset_id FROM syntheses WHERE id IN ${ids("synthesis")})`,
  );
  await add(
    "model_run",
    sql`model_runs
        WHERE processing_batch_id IN ${ids("batch")}
           OR source_entity_id IN (SELECT id FROM _demo_purge_ids)`,
  );

  const storage = await tx.execute<{ storage_driver: string; storage_key: string }>(sql`
    SELECT storage_driver, storage_key FROM media_assets
    WHERE id IN ${ids("media_asset")} AND deleted_at IS NULL`);

  const deleted: Record<string, number> = {};
  const run = async (table: string, statement: ReturnType<typeof sql>) => {
    const result = await tx.execute(statement);
    deleted[table] = (deleted[table] ?? 0) + (result.rowCount ?? 0);
  };

  // Children first, in the order given in docs/DATA-MODEL.md.
  await run("syntheses", sql`DELETE FROM syntheses WHERE id IN ${ids("synthesis")}`);
  await run("translations", sql`DELETE FROM translations WHERE id IN ${ids("translation")}`);
  await run(
    "difference_annotations",
    sql`DELETE FROM difference_annotations
        WHERE utterance_id IN ${ids("utterance")}
           OR source_transcript_revision_id IN ${ids("transcript_revision")}
           OR target_transcript_revision_id IN ${ids("transcript_revision")}`,
  );
  await run("transcript_revisions", sql`DELETE FROM transcript_revisions WHERE id IN ${ids("transcript_revision")}`);
  await run("model_runs", sql`DELETE FROM model_runs WHERE id IN ${ids("model_run")}`);
  await run("transcripts", sql`DELETE FROM transcripts WHERE id IN ${ids("transcript")}`);
  await run(
    "questionnaire_answers",
    sql`DELETE FROM questionnaire_answers
        WHERE response_id IN (SELECT id FROM questionnaire_responses WHERE session_id = ${sessionId}::uuid)`,
  );
  await run("questionnaire_responses", sql`DELETE FROM questionnaire_responses WHERE session_id = ${sessionId}::uuid`);
  await run("session_consents", sql`DELETE FROM session_consents WHERE session_id = ${sessionId}::uuid`);
  // utterances and media_assets reference each other, so both go in one statement.
  const cycle = await tx.execute<{ media: string; utterances: string }>(sql`
    WITH deleted_media AS (
      DELETE FROM media_assets WHERE id IN ${ids("media_asset")} RETURNING id
    ), deleted_utterances AS (
      DELETE FROM utterances WHERE id IN ${ids("utterance")} RETURNING id
    )
    SELECT (SELECT count(*) FROM deleted_media) AS media,
           (SELECT count(*) FROM deleted_utterances) AS utterances`);
  deleted.media_assets = Number(cycle.rows[0]?.media ?? 0);
  deleted.utterances = Number(cycle.rows[0]?.utterances ?? 0);
  await run("task_presentations", sql`DELETE FROM task_presentations WHERE id IN ${ids("task_presentation")}`);
  await run("sessions", sql`DELETE FROM sessions WHERE id = ${sessionId}::uuid`);
  // Also the jobs without a batch whose payload names a deleted utterance or
  // media file (the WAV derivation after an upload). The ids are compared as
  // text, so a payload without these keys never matches. A job that removes a
  // stored file (delete_storage_object) stays: its file still has to go.
  await run(
    "jobs",
    sql`DELETE FROM jobs
        WHERE processing_batch_id IN ${ids("batch")}
           OR (processing_batch_id IS NULL AND (
                payload_json->>'utteranceId' IN (SELECT id::text FROM _demo_purge_ids WHERE kind = 'utterance')
             OR payload_json->>'mediaAssetId' IN (SELECT id::text FROM _demo_purge_ids WHERE kind = 'media_asset')))`,
  );
  await run("processing_batches", sql`DELETE FROM processing_batches WHERE id IN ${ids("batch")}`);
  await run("research_flags", sql`DELETE FROM research_flags WHERE entity_id IN (SELECT id FROM _demo_purge_ids)`);
  await run("research_notes", sql`DELETE FROM research_notes WHERE entity_id IN (SELECT id FROM _demo_purge_ids)`);
  await run("feature_annotations", sql`DELETE FROM feature_annotations WHERE target_id IN (SELECT id FROM _demo_purge_ids)`);
  await tx.execute(sql`DROP TABLE IF EXISTS _demo_purge_ids`);

  return {
    deleted,
    storageObjects: storage.rows.map((row) => ({ storageDriver: row.storage_driver, storageKey: row.storage_key })),
  };
}

// Deletes one demo session: its rows, the batches that processed it, and, after
// the commit, its stored audio (source recordings and synthesized audio).
// Refuses a session of any other mode. Writes an audit row. The audit log keeps
// the participant code and the row counts, never transcript text.
export async function purgeDemoSession(
  ctx: ServiceContext,
  sessionId: string,
  options: { reason?: string } = {},
): Promise<PurgeResult> {
  const result = await ctx.db.transaction(async (tx) => {
    const [session] = await tx.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId)).for("update");
    if (!session) throw new AppError("NOT_FOUND", "The demo session was not found.", { sessionId });
    if (session.mode !== "demo") {
      throw new AppError(
        "FORBIDDEN",
        `Only a demo session can be removed this way. This session has the mode "${session.mode}".`,
        { sessionId, mode: session.mode },
      );
    }
    const removed = await deleteSessionRows(tx, session.id);
    await recordAudit(tx, {
      // The audit action list has one entry for the guarded delete of TEST and DEMO data.
      action: "test_data.reset",
      entityType: "session",
      entityId: session.id,
      after: {
        scope: "demo_session",
        reason: options.reason ?? "demo_not_persisted",
        participantCode: session.participantCode,
        deleted: removed.deleted,
        storageObjects: removed.storageObjects.length,
      },
      actorLabel: ctx.actorLabel,
    });
    return removed;
  });

  // After the commit: remove the files of the deleted media rows.
  let storageObjectsRemoved = 0;
  let storageObjectsFailed = 0;
  for (const object of result.storageObjects) {
    if (object.storageDriver !== ctx.storage.driver) {
      storageObjectsFailed += 1;
      continue;
    }
    try {
      await ctx.storage.delete(object.storageKey);
      storageObjectsRemoved += 1;
    } catch (error) {
      storageObjectsFailed += 1;
      ctx.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "an audio file of a removed demo session could not be deleted from storage",
      );
    }
  }
  return { sessionId, deleted: result.deleted, storageObjectsRemoved, storageObjectsFailed };
}

// Default age after which a demo session without activity counts as left behind.
export const LEFTOVER_IDLE_MINUTES = 30;

// Demo sessions that were not removed when they ended (the browser was closed
// before the page could ask for it): ended sessions, and open sessions without
// activity for `idleMinutes`.
export async function listLeftoverDemoSessions(
  ctx: ServiceContext,
  input: { studySlug?: string; idleMinutes?: number } = {},
): Promise<Array<{ id: string; participantCode: string }>> {
  const study = await resolveStudy(ctx.db, input.studySlug);
  const cutoff = new Date(ctx.now().getTime() - (input.idleMinutes ?? LEFTOVER_IDLE_MINUTES) * 60 * 1000);
  return ctx.db
    .select({ id: sessionsTable.id, participantCode: sessionsTable.participantCode })
    .from(sessionsTable)
    .where(
      and(
        eq(sessionsTable.studyId, study.id),
        eq(sessionsTable.mode, "demo"),
        or(inArray(sessionsTable.status, [...TERMINAL_SESSION_STATUSES]), lt(sessionsTable.lastActivityAt, cutoff)),
      ),
    );
}

// The explicit admin action for leftovers. Only while demoPersist is false:
// when demo data is kept on purpose, it is removed with the TEST and DEMO data
// reset on the Settings page, which asks for a typed confirmation.
export async function purgeLeftoverDemoSessions(
  ctx: ServiceContext,
  input: { studySlug?: string; idleMinutes?: number } = {},
): Promise<demoSchemas.PurgeLeftoversResponse> {
  const study = await resolveStudy(ctx.db, input.studySlug);
  if (demoSettings(study).demoPersist) {
    throw new AppError(
      "INVALID_STATE",
      "Demo data is kept on this server (study setting demoPersist). To remove it, use the TEST and DEMO data reset on the Settings page.",
    );
  }
  const leftovers = await listLeftoverDemoSessions(ctx, input);
  const results: PurgeResult[] = [];
  for (const session of leftovers) {
    results.push(await purgeDemoSession(ctx, session.id, { reason: "leftover_demo_session" }));
  }
  return { sessions: results.length, results };
}

export type DemoMediaAsset = { id: string; storageKey: string; mimeType: string };

// The media asset a demo visitor may hear: a source recording of the caller's
// own demo session, or the synthesized audio of a translation of one of its
// recordings. Anything else, including every research asset, is reported as
// not found.
export async function getDemoMediaForStreaming(
  ctx: ServiceContext,
  input: { sessionId: string; mediaAssetId: string },
): Promise<DemoMediaAsset> {
  const notFound = () => new AppError("MEDIA_NOT_FOUND", "The audio was not found.");
  const [session] = await ctx.db
    .select({ id: sessionsTable.id, mode: sessionsTable.mode })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, input.sessionId))
    .limit(1);
  if (!session || session.mode !== "demo") throw notFound();

  const [asset] = await ctx.db
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.id, input.mediaAssetId), isNull(mediaAssets.deletedAt)))
    .limit(1);
  if (!asset) throw notFound();

  if (asset.kind === "source_audio" || asset.kind === "source_audio_raw" || asset.kind === "source_audio_derived") {
    if (asset.sessionId !== session.id) throw notFound();
    return { id: asset.id, storageKey: asset.storageKey, mimeType: asset.mimeType };
  }
  if (asset.kind !== "tts_audio") throw notFound();

  // Synthesized audio has no session column: follow synthesis, translation,
  // revision, transcript and utterance back to the session.
  const [owner] = await ctx.db
    .select({ sessionId: utterances.sessionId })
    .from(syntheses)
    .innerJoin(translations, eq(translations.id, syntheses.translationId))
    .innerJoin(transcriptRevisions, eq(transcriptRevisions.id, translations.sourceTranscriptRevisionId))
    .innerJoin(transcripts, eq(transcripts.id, transcriptRevisions.transcriptId))
    .innerJoin(utterances, eq(utterances.id, transcripts.utteranceId))
    .where(eq(syntheses.mediaAssetId, asset.id))
    .limit(1);
  if (!owner || owner.sessionId !== session.id) throw notFound();
  return { id: asset.id, storageKey: asset.storageKey, mimeType: asset.mimeType };
}

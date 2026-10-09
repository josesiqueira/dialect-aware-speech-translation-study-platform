// Removes DEMO and TEST rows (spec 38, 116). This is the only supported way to
// delete rows that the immutability triggers protect, and it never touches
// research data: the triggers refuse to delete a research row even with the
// reset setting on.
//
// The caller (the reset service) is responsible for:
//   1. the confirmation phrase and the production guard (spec 116);
//   2. calling this inside a transaction, together with recordAudit("test_data.reset");
//   3. deleting the returned storage keys from the storage layer AFTER the
//      transaction commits.
import { sql } from "drizzle-orm";
import type { Transaction } from "./client";

export type ResettableMode = "demo" | "test";

export type TestDataResetResult = {
  // Files to remove from storage after the transaction commits.
  storageObjects: Array<{ storageDriver: string; storageKey: string }>;
  // Storage keys of unfinished `delete_storage_object` queue jobs that belonged
  // to the deleted sessions. The jobs are removed, so the caller removes these
  // files too, after the transaction commits.
  pendingStorageDeletions: string[];
  // Number of deleted rows per table.
  deleted: Record<string, number>;
};

// Turns the trigger bypass on for the current transaction only. PostgreSQL
// resets the setting at commit or rollback.
export async function allowTestDataReset(tx: Transaction): Promise<void> {
  await tx.execute(sql`SET LOCAL dialect.allow_test_data_reset = 'on'`);
}

export async function deleteDemoAndTestData(
  tx: Transaction,
  options: { studyId: string; modes?: ResettableMode[] },
): Promise<TestDataResetResult> {
  const modes = [...new Set(options.modes ?? ["demo", "test"])];
  if (modes.length === 0 || modes.some((mode) => mode !== "demo" && mode !== "test")) {
    throw new Error("deleteDemoAndTestData only accepts the modes demo and test");
  }
  const modeList = sql.join(
    modes.map((mode) => sql`${mode}::study_mode`),
    sql`, `,
  );

  await allowTestDataReset(tx);

  // Collect the ids first: later steps cannot follow foreign keys of rows that
  // are already gone.
  await tx.execute(sql`DROP TABLE IF EXISTS _reset_ids`);
  await tx.execute(sql`CREATE TEMP TABLE _reset_ids (kind text NOT NULL, id uuid NOT NULL) ON COMMIT DROP`);
  await tx.execute(sql`
    INSERT INTO _reset_ids
    SELECT 'session', id FROM sessions
    WHERE study_id = ${options.studyId} AND mode IN (${modeList})`);
  await tx.execute(sql`
    INSERT INTO _reset_ids
    SELECT 'batch', id FROM processing_batches
    WHERE study_id = ${options.studyId} AND data_mode IN (${modeList})`);
  await tx.execute(sql`
    INSERT INTO _reset_ids
    SELECT 'task_presentation', id FROM task_presentations
    WHERE session_id IN (SELECT id FROM _reset_ids WHERE kind = 'session')`);
  await tx.execute(sql`
    INSERT INTO _reset_ids
    SELECT 'utterance', id FROM utterances
    WHERE session_id IN (SELECT id FROM _reset_ids WHERE kind = 'session')`);
  await tx.execute(sql`
    INSERT INTO _reset_ids
    SELECT 'transcript', id FROM transcripts
    WHERE utterance_id IN (SELECT id FROM _reset_ids WHERE kind = 'utterance')`);
  await tx.execute(sql`
    INSERT INTO _reset_ids
    SELECT 'transcript_revision', id FROM transcript_revisions
    WHERE transcript_id IN (SELECT id FROM _reset_ids WHERE kind = 'transcript')`);
  await tx.execute(sql`
    INSERT INTO _reset_ids
    SELECT 'translation', id FROM translations
    WHERE source_transcript_revision_id IN (SELECT id FROM _reset_ids WHERE kind = 'transcript_revision')
       OR processing_batch_id IN (SELECT id FROM _reset_ids WHERE kind = 'batch')`);
  await tx.execute(sql`
    INSERT INTO _reset_ids
    SELECT 'synthesis', id FROM syntheses
    WHERE translation_id IN (SELECT id FROM _reset_ids WHERE kind = 'translation')
       OR processing_batch_id IN (SELECT id FROM _reset_ids WHERE kind = 'batch')`);
  await tx.execute(sql`
    INSERT INTO _reset_ids
    SELECT 'media_asset', id FROM media_assets
    WHERE session_id IN (SELECT id FROM _reset_ids WHERE kind = 'session')
       OR id IN (SELECT media_asset_id FROM syntheses
                 WHERE id IN (SELECT id FROM _reset_ids WHERE kind = 'synthesis'))`);
  await tx.execute(sql`
    INSERT INTO _reset_ids
    SELECT 'model_run', id FROM model_runs
    WHERE processing_batch_id IN (SELECT id FROM _reset_ids WHERE kind = 'batch')
       OR source_entity_id IN (SELECT id FROM _reset_ids)`);
  await tx.execute(sql`
    INSERT INTO _reset_ids
    SELECT 'questionnaire_response', id FROM questionnaire_responses
    WHERE session_id IN (SELECT id FROM _reset_ids WHERE kind = 'session')`);

  // Queue jobs of the data being deleted (defect E2E-4). Jobs of a deleted
  // batch, and jobs without a batch whose payload names a deleted utterance or
  // media file: the automatic transcription after an upload (`asr`), the WAV
  // derivation (`derive_wav`) and the clean-up of a stored file
  // (`delete_storage_object`, whose storage key contains the session id). A job
  // left behind would stay in the queue or in the failed list forever, pointing
  // at rows that no longer exist. The ids are compared as text, so a payload
  // without these keys never matches. A job of a research batch is never
  // selected: only jobs without a batch are matched by payload.
  await tx.execute(sql`
    INSERT INTO _reset_ids
    SELECT 'job', j.id FROM jobs j
    WHERE j.processing_batch_id IN (SELECT id FROM _reset_ids WHERE kind = 'batch')
       OR (j.processing_batch_id IS NULL AND (
            j.payload_json->>'utteranceId' IN (SELECT id::text FROM _reset_ids WHERE kind = 'utterance')
         OR j.payload_json->>'mediaAssetId' IN (SELECT id::text FROM _reset_ids WHERE kind = 'media_asset')
         OR (j.type = 'delete_storage_object' AND EXISTS (
               SELECT 1 FROM _reset_ids s
               WHERE s.kind = 'session'
                 AND position('/sessions/' || s.id::text || '/' IN j.payload_json->>'storageKey') > 0))
       ))`);
  const pendingDeletions = await tx.execute<{ storage_key: string }>(sql`
    SELECT DISTINCT payload_json->>'storageKey' AS storage_key FROM jobs
    WHERE id IN (SELECT id FROM _reset_ids WHERE kind = 'job')
      AND type = 'delete_storage_object'
      AND status <> 'succeeded'
      AND payload_json->>'storageKey' IS NOT NULL`);

  const storage = await tx.execute<{ storage_driver: string; storage_key: string }>(sql`
    SELECT storage_driver, storage_key FROM media_assets
    WHERE id IN (SELECT id FROM _reset_ids WHERE kind = 'media_asset') AND deleted_at IS NULL`);

  const deleted: Record<string, number> = {};
  const run = async (table: string, statement: ReturnType<typeof sql>) => {
    const result = await tx.execute(statement);
    deleted[table] = (deleted[table] ?? 0) + (result.rowCount ?? 0);
  };
  const ids = (kind: string) => sql`(SELECT id FROM _reset_ids WHERE kind = ${kind})`;

  // Order follows the foreign keys, children first. The output review rows point
  // at translations, syntheses, revisions and utterances, so they go first.
  await run(
    "output_review_items",
    sql`DELETE FROM output_review_items WHERE session_id IN ${ids("session")}`,
  );
  await run("output_reviews", sql`DELETE FROM output_reviews WHERE session_id IN ${ids("session")}`);
  await run("english_checks", sql`DELETE FROM english_checks WHERE session_id IN ${ids("session")}`);
  await run("syntheses", sql`DELETE FROM syntheses WHERE id IN ${ids("synthesis")}`);
  await run("translations", sql`DELETE FROM translations WHERE id IN ${ids("translation")}`);
  await run(
    "difference_annotations",
    sql`DELETE FROM difference_annotations
        WHERE utterance_id IN ${ids("utterance")}
           OR source_transcript_revision_id IN ${ids("transcript_revision")}
           OR target_transcript_revision_id IN ${ids("transcript_revision")}`,
  );
  await run(
    "transcript_revisions",
    sql`DELETE FROM transcript_revisions WHERE id IN ${ids("transcript_revision")}`,
  );
  await run("model_runs", sql`DELETE FROM model_runs WHERE id IN ${ids("model_run")}`);
  await run("transcripts", sql`DELETE FROM transcripts WHERE id IN ${ids("transcript")}`);
  await run(
    "questionnaire_answers",
    sql`DELETE FROM questionnaire_answers WHERE response_id IN ${ids("questionnaire_response")}`,
  );
  await run(
    "questionnaire_responses",
    sql`DELETE FROM questionnaire_responses WHERE id IN ${ids("questionnaire_response")}`,
  );
  await run("session_consents", sql`DELETE FROM session_consents WHERE session_id IN ${ids("session")}`);
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
  await run(
    "task_presentations",
    sql`DELETE FROM task_presentations WHERE id IN ${ids("task_presentation")}`,
  );
  await run("sessions", sql`DELETE FROM sessions WHERE id IN ${ids("session")}`);
  await run("jobs", sql`DELETE FROM jobs WHERE id IN ${ids("job")}`);
  await run("processing_batches", sql`DELETE FROM processing_batches WHERE id IN ${ids("batch")}`);
  // Generic records that point at deleted entities by id.
  await run("research_flags", sql`DELETE FROM research_flags WHERE entity_id IN (SELECT id FROM _reset_ids)`);
  await run("research_notes", sql`DELETE FROM research_notes WHERE entity_id IN (SELECT id FROM _reset_ids)`);
  await run(
    "feature_annotations",
    sql`DELETE FROM feature_annotations WHERE target_id IN (SELECT id FROM _reset_ids)`,
  );
  await tx.execute(sql`DROP TABLE IF EXISTS _reset_ids`);

  return {
    storageObjects: storage.rows.map((row) => ({
      storageDriver: row.storage_driver,
      storageKey: row.storage_key,
    })),
    pendingStorageDeletions: pendingDeletions.rows.map((row) => row.storage_key),
    deleted,
  };
}

// Migration tests (spec 90.4): every committed migration must apply on an empty
// database and on a database that already holds representative study data.
//
// The representative data is inserted with raw SQL right after the baseline
// migration (0000), then every later migration is applied on top of it. A new
// migration is picked up automatically because the list comes from the journal.
// The hardening migration (0003) is also applied on a database that was at 0002
// with data in it, which is the state of every database that existed before it.
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabase } from "./client";
import { getPgError } from "./errors";
import { MIGRATIONS_FOLDER, runMigrations } from "./migrate";

const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgresql://postgres:postgres@localhost:5546/postgres";

type Journal = { version: string; dialect: string; entries: Array<{ idx: number; tag: string; when: number }> };

const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as Journal;
const BASELINE_TAG = "0000_initial_schema";

const createdDatabases: string[] = [];
const temporaryFolders: string[] = [];

async function createEmptyDatabase(): Promise<string> {
  const name = `dialect_mig_${randomBytes(8).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  createdDatabases.push(name);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

// A copy of the migrations folder that holds only the first `count` migrations.
function migrationsFolderWithFirst(count: number): string {
  const folder = mkdtempSync(path.join(tmpdir(), "dialect-migrations-"));
  temporaryFolders.push(folder);
  mkdirSync(path.join(folder, "meta"));
  const entries = journal.entries.slice(0, count);
  writeFileSync(path.join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) {
    cpSync(path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
  }
  return folder;
}

async function applyFirstMigrations(url: string, count: number): Promise<void> {
  const handle = createDatabase(url, { max: 1 });
  try {
    await migrate(handle.db, { migrationsFolder: migrationsFolderWithFirst(count) });
  } finally {
    await handle.close();
  }
}

async function withClient<T>(url: string, action: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await action(client);
  } finally {
    await client.end();
  }
}

async function appliedMigrationCount(client: pg.Client): Promise<number> {
  const result = await client.query("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations");
  return (result.rows[0] as { n: number }).n;
}

// Representative study data written against the baseline schema (0000) only.
// One research session with a full lineage: published protocol, consent,
// questionnaire answers, a submitted utterance with audio metadata, transcripts,
// model runs, a translation, a synthesis, a job, a flag and an audit entry.
const REPRESENTATIVE_DATA_SQL = `
INSERT INTO studies (id, slug, name) VALUES
  ('00000000-0000-4000-8000-000000000001', 'existing-study', 'Existing study');
INSERT INTO consent_versions (id, study_id, version_number, title, information_text, items_json, published_at) VALUES
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 1, 'Consent', 'Information',
   '[{"id":"participation","text":"I agree","required":true}]', now());
INSERT INTO questionnaire_versions (id, study_id, key, version_number, status, name, published_at) VALUES
  ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'background', 1, 'published', 'Background', now());
INSERT INTO questionnaire_items (id, questionnaire_version_id, item_key, type, prompt, required, order_index) VALUES
  ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000003', 'age_range', 'single_choice', 'Age range?', true, 0);
INSERT INTO protocol_versions (id, study_id, version_number, status, name, consent_version_id,
                               background_questionnaire_version_id, published_at) VALUES
  ('00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', 1, 'published', 'Protocol 1',
   '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', now()),
  ('00000000-0000-4000-8000-000000000025', '00000000-0000-4000-8000-000000000001', 2, 'draft', 'Protocol 2 draft',
   '00000000-0000-4000-8000-000000000002', NULL, NULL);
UPDATE studies SET current_protocol_version_id = '00000000-0000-4000-8000-000000000005';
INSERT INTO protocol_tasks (id, protocol_version_id, task_key, task_type, title, participant_prompt, block_key,
                            order_index, min_duration_seconds, suggested_duration_seconds, max_duration_seconds) VALUES
  ('00000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000005', 'semi_1', 'semi_structured',
   'Where you grew up', 'Tell us about the place where you grew up.', 'semi_structured', 0, 5, 60, 180);
INSERT INTO protocol_task_followups (id, protocol_task_id, followup_key, prompt_text, order_index) VALUES
  ('00000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000006', 'followup_1', 'Anything else?', 0);
INSERT INTO sessions (id, study_id, participant_code, protocol_version_id, mode, status, app_version, consented_at) VALUES
  ('00000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000001', 'P-EXIST001',
   '00000000-0000-4000-8000-000000000005', 'research', 'completed', '0.1.0', now());
INSERT INTO session_consents (id, session_id, consent_version_id, responses_json) VALUES
  ('00000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000002',
   '[{"itemId":"participation","textSnapshot":"I agree","required":true,"accepted":true}]');
INSERT INTO task_presentations (id, session_id, protocol_task_id, sequence_index, title_snapshot, prompt_snapshot, status) VALUES
  ('00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000006',
   0, 'Where you grew up', 'Tell us about the place where you grew up.', 'completed');
INSERT INTO utterances (id, session_id, task_presentation_id, prompt_snapshot, turn_index, attempt_count, status) VALUES
  ('00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-00000000000a',
   'Tell us about the place where you grew up.', 0, 2, 'uploading');
INSERT INTO media_assets (id, study_id, session_id, utterance_id, entity_type, entity_id, kind, storage_driver, storage_key,
                          mime_type, container, codec, sample_rate_hz, channels, bit_depth, duration_ms, size_bytes, sha256) VALUES
  ('00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000008',
   '00000000-0000-4000-8000-00000000000b', 'utterance', '00000000-0000-4000-8000-00000000000b', 'source_audio', 'local',
   'existing/source.wav', 'audio/wav', 'wav', 'pcm_s16le', 48000, 1, 16, 4200, 403244,
   '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'),
  ('00000000-0000-4000-8000-00000000000d', '00000000-0000-4000-8000-000000000001', NULL, NULL, 'synthesis',
   '00000000-0000-4000-8000-000000000016', 'tts_audio', 'local', 'existing/tts.wav', 'audio/wav', 'wav', 'pcm_s16le',
   24000, 1, 16, 1800, 86444, '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae');
UPDATE utterances SET accepted_media_asset_id = '00000000-0000-4000-8000-00000000000c', status = 'submitted',
                      submitted_at = now(), duration_ms = 4200
WHERE id = '00000000-0000-4000-8000-00000000000b';
INSERT INTO questionnaire_responses (id, session_id, questionnaire_version_id) VALUES
  ('00000000-0000-4000-8000-00000000000e', '00000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000003');
INSERT INTO questionnaire_answers (id, response_id, questionnaire_item_id, value_json) VALUES
  ('00000000-0000-4000-8000-00000000000f', '00000000-0000-4000-8000-00000000000e', '00000000-0000-4000-8000-000000000004', '"25_34"');
INSERT INTO ai_prompt_versions (id, study_id, key, stage, condition_key, version_number, status, name, prompt_text, activated_at) VALUES
  ('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'translation_default', 'translation',
   'default', 1, 'active', 'Default', 'Translate.', now());
INSERT INTO model_configs (id, study_id, key, stage, condition_key, version_number, status, provider, model_id,
                           parameters_json, prompt_version_id, activated_at) VALUES
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'translation_default', 'translation',
   'default', 1, 'active', 'mock', 'mock-translation', '{}', '00000000-0000-4000-8000-000000000010', now());
INSERT INTO processing_batches (id, study_id, name, status, data_mode, configuration_snapshot_json, started_at, completed_at) VALUES
  ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001', 'existing-batch', 'completed', 'research',
   '{"utteranceIds":[]}', now(), now());
INSERT INTO transcripts (id, utterance_id, type, status) VALUES
  ('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-00000000000b', 'asr', 'draft'),
  ('00000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-00000000000b', 'human_dialect', 'verified');
INSERT INTO model_runs (id, stage, provider, requested_model, returned_model, model_config_id, prompt_version_id,
                        processing_batch_id, condition_key, source_entity_type, source_entity_id, input_manifest_json,
                        status, attempt_number, finished_at, latency_ms, app_version, idempotency_key) VALUES
  ('00000000-0000-4000-8000-000000000017', 'asr', 'mock', 'mock-asr', 'mock-asr', NULL, NULL, NULL, NULL, 'utterance',
   '00000000-0000-4000-8000-00000000000b', '{}', 'succeeded', 1, now(), 900, '0.1.0', 'existing-asr'),
  ('00000000-0000-4000-8000-000000000018', 'translation', 'mock', 'mock-translation', 'mock-translation',
   '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000012',
   'default', 'transcript_revision', '00000000-0000-4000-8000-00000000001a', '{}', 'succeeded', 1, now(), 700, '0.1.0',
   'existing-translation'),
  ('00000000-0000-4000-8000-000000000019', 'tts', 'mock', 'mock-tts', NULL, NULL, NULL, '00000000-0000-4000-8000-000000000012',
   'default', 'translation', '00000000-0000-4000-8000-000000000015', '{}', 'failed', 2, now(), 0, '0.1.0', 'existing-tts-failed'),
  ('00000000-0000-4000-8000-00000000001c', 'tts', 'mock', 'mock-tts', 'mock-tts', NULL, NULL, '00000000-0000-4000-8000-000000000012',
   'default', 'translation', '00000000-0000-4000-8000-000000000015', '{}', 'succeeded', 3, now(), 300, '0.1.0', 'existing-tts');
INSERT INTO transcript_revisions (id, transcript_id, revision_number, text, source_model_run_id, created_by_type,
                                  created_by_label, is_current, verified_at) VALUES
  ('00000000-0000-4000-8000-00000000001b', '00000000-0000-4000-8000-000000000013', 1, 'Minä en oikeastaan tiedä.',
   '00000000-0000-4000-8000-000000000017', 'model', NULL, true, NULL),
  ('00000000-0000-4000-8000-00000000001d', '00000000-0000-4000-8000-000000000014', 1, 'Mie en oikeestaan tiä.', NULL,
   'researcher', 'annotator-1', false, NULL),
  ('00000000-0000-4000-8000-00000000001a', '00000000-0000-4000-8000-000000000014', 2, 'Mie en oikeestaan tiiä.', NULL,
   'researcher', 'annotator-1', true, now());
INSERT INTO translations (id, source_transcript_revision_id, condition_key, processing_batch_id, model_run_id, translated_text) VALUES
  ('00000000-0000-4000-8000-000000000015', '00000000-0000-4000-8000-00000000001a', 'default',
   '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000018', 'I don''t really know.');
INSERT INTO syntheses (id, translation_id, source_text, condition_key, processing_batch_id, model_run_id, media_asset_id, voice_key) VALUES
  ('00000000-0000-4000-8000-000000000016', '00000000-0000-4000-8000-000000000015', 'I don''t really know.', 'default',
   '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-00000000001c', '00000000-0000-4000-8000-00000000000d', 'voice-1');
INSERT INTO jobs (id, type, payload_json, status, attempts, max_attempts, processing_batch_id, idempotency_key) VALUES
  ('00000000-0000-4000-8000-00000000001e', 'translation', '{}', 'succeeded', 1, 3, '00000000-0000-4000-8000-000000000012', 'existing-job');
INSERT INTO difference_annotations (id, utterance_id, source_transcript_revision_id, target_transcript_revision_id,
                                    annotation_scope, source_start, source_end, target_start, target_end, categories_json,
                                    annotator_label, scheme_version) VALUES
  ('00000000-0000-4000-8000-00000000001f', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000001b',
   '00000000-0000-4000-8000-00000000001a', 'span', 0, 4, 0, 3, '["normalization"]', 'annotator-1', '1.0');
INSERT INTO feature_annotations (id, target_type, target_id, feature_family, feature_key, label, confidence, annotator_label, scheme_version) VALUES
  ('00000000-0000-4000-8000-000000000020', 'translation', '00000000-0000-4000-8000-000000000015', 'pronoun', 'mie', 'neutralized',
   0.8, 'annotator-1', '1.0');
INSERT INTO research_flags (id, entity_type, entity_id, reason_code) VALUES
  ('00000000-0000-4000-8000-000000000021', 'utterance', '00000000-0000-4000-8000-00000000000b', 'interesting_dialect_feature');
INSERT INTO research_notes (id, entity_type, entity_id, body) VALUES
  ('00000000-0000-4000-8000-000000000022', 'session', '00000000-0000-4000-8000-000000000008', 'Pilot participant.');
INSERT INTO admin_audit_log (id, action, entity_type, entity_id) VALUES
  ('00000000-0000-4000-8000-000000000023', 'protocol.publish', 'protocol_version', '00000000-0000-4000-8000-000000000005');
INSERT INTO export_jobs (id, study_id, export_type, filters_json, status) VALUES
  ('00000000-0000-4000-8000-000000000024', '00000000-0000-4000-8000-000000000001', 'dataset_package', '{}', 'completed');
`;

// Rows written while the database was at migration 0002. Each one is valid under
// 0002 and would be refused by 0003: a model revision on a human transcript, and
// a translation of a test session inside a research batch.
const HARDENING_TAG = "0003_hardening_guards";
const ROWS_WRITTEN_BEFORE_HARDENING_SQL = `
INSERT INTO sessions (id, study_id, participant_code, protocol_version_id, mode, status, app_version) VALUES
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001', 'P-LEGACY01',
   '00000000-0000-4000-8000-000000000005', 'test', 'recording', '0.1.0');
INSERT INTO task_presentations (id, session_id, protocol_task_id, sequence_index, title_snapshot, prompt_snapshot) VALUES
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000006',
   0, 'Where you grew up', 'Tell us about the place where you grew up.');
INSERT INTO utterances (id, session_id, task_presentation_id, prompt_snapshot, turn_index) VALUES
  ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000102',
   'Tell us about the place where you grew up.', 0);
INSERT INTO transcripts (id, utterance_id, type) VALUES
  ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000103', 'human_dialect');
INSERT INTO transcript_revisions (id, transcript_id, revision_number, text, created_by_type) VALUES
  ('00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000104', 1, 'Model text on a human transcript.', 'model');
INSERT INTO model_runs (id, stage, provider, requested_model, processing_batch_id, source_entity_type, source_entity_id,
                        input_manifest_json, status, app_version, idempotency_key) VALUES
  ('00000000-0000-4000-8000-000000000106', 'translation', 'mock', 'mock-translation', '00000000-0000-4000-8000-000000000012',
   'transcript_revision', '00000000-0000-4000-8000-000000000105', '{}', 'succeeded', '0.1.0', 'legacy-mixed-translation');
INSERT INTO translations (id, source_transcript_revision_id, condition_key, processing_batch_id, model_run_id, translated_text) VALUES
  ('00000000-0000-4000-8000-000000000107', '00000000-0000-4000-8000-000000000105', 'default',
   '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000106', 'Test session text in a research batch.');
`;

async function tableRowCounts(client: pg.Client): Promise<Record<string, number>> {
  const tables = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
  );
  const counts: Record<string, number> = {};
  for (const row of tables.rows as Array<{ table_name: string }>) {
    const result = await client.query(`SELECT count(*)::int AS n FROM "${row.table_name}"`);
    counts[row.table_name] = (result.rows[0] as { n: number }).n;
  }
  return counts;
}

afterAll(async () => {
  for (const folder of temporaryFolders) rmSync(folder, { recursive: true, force: true });
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    for (const name of createdDatabases) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

describe("migrations", () => {
  it("has a journal that starts with the baseline and lists a file for every entry", () => {
    expect(journal.entries[0]?.tag).toBe(BASELINE_TAG);
    expect(journal.entries.length).toBeGreaterThanOrEqual(3);
    for (const entry of journal.entries) {
      expect(readFileSync(path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), "utf8").length).toBeGreaterThan(0);
    }
    const times = journal.entries.map((entry) => entry.when);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("apply on an empty database, and applying again changes nothing", async () => {
    const url = await createEmptyDatabase();
    await runMigrations(url);
    await runMigrations(url);
    await withClient(url, async (client) => {
      expect(await appliedMigrationCount(client)).toBe(journal.entries.length);
      const counts = await tableRowCounts(client);
      expect(Object.keys(counts)).toContain("studies");
      expect(Object.keys(counts)).toContain("admin_audit_log");
      expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    });
  });

  it("apply one at a time on an empty database", async () => {
    const url = await createEmptyDatabase();
    for (let count = 1; count <= journal.entries.length; count += 1) {
      await applyFirstMigrations(url, count);
      await withClient(url, async (client) => {
        expect(await appliedMigrationCount(client)).toBe(count);
      });
    }
  });

  it("apply on a database that already contains representative study data", async () => {
    const url = await createEmptyDatabase();
    await applyFirstMigrations(url, 1);
    const before = await withClient(url, async (client) => {
      expect(await appliedMigrationCount(client)).toBe(1);
      await client.query(REPRESENTATIVE_DATA_SQL);
      return tableRowCounts(client);
    });
    // Every table of the baseline schema that holds study data has at least one row.
    const emptyTables = Object.entries(before)
      .filter(([, n]) => n === 0)
      .map(([name]) => name);
    expect(emptyTables.sort()).toEqual(["rate_limit_hits", "worker_heartbeats"]);

    // All later migrations, including ones added in the future.
    await runMigrations(url);

    await withClient(url, async (client) => {
      expect(await appliedMigrationCount(client)).toBe(journal.entries.length);
      // No migration lost or duplicated existing rows.
      const after = await tableRowCounts(client);
      for (const [table, n] of Object.entries(before)) expect(after[table], table).toBe(n);

      // The existing data is still readable and correctly linked.
      const lineage = await client.query(`
        SELECT s.participant_code, u.status, m.sha256, r.text, tr.translated_text, sy.source_text
        FROM sessions s
        JOIN utterances u ON u.session_id = s.id
        JOIN media_assets m ON m.id = u.accepted_media_asset_id
        JOIN transcripts t ON t.utterance_id = u.id AND t.type = 'human_dialect'
        JOIN transcript_revisions r ON r.transcript_id = t.id AND r.is_current
        JOIN translations tr ON tr.source_transcript_revision_id = r.id
        JOIN syntheses sy ON sy.translation_id = tr.id`);
      expect(lineage.rows).toEqual([
        {
          participant_code: "P-EXIST001",
          status: "submitted",
          sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
          text: "Mie en oikeestaan tiiä.",
          translated_text: "I don't really know.",
          source_text: "I don't really know.",
        },
      ]);

      // The invariants now protect the rows that existed before the migration.
      const blocked = [
        "UPDATE protocol_versions SET name = 'changed' WHERE status = 'published'",
        "UPDATE transcript_revisions SET text = 'changed'",
        "UPDATE translations SET translated_text = 'changed'",
        "DELETE FROM session_consents",
        "UPDATE admin_audit_log SET action = 'changed'",
      ];
      for (const statement of blocked) {
        const error = await client.query(statement).then(
          () => null,
          (reason: unknown) => reason,
        );
        expect(getPgError(error)?.code, statement).toBe("IMMUT");
      }
      // Ordinary work on existing rows still succeeds.
      await client.query("UPDATE protocol_versions SET name = 'Renamed draft' WHERE status = 'draft'");
      await client.query("UPDATE sessions SET flagged = true");
      await client.query("UPDATE utterances SET status = 'excluded', exclusion_reason = 'pilot'");
    });
  });

  it("the hardening migration applies on a database at 0002 that holds data, including rows it would now refuse", async () => {
    const hardeningIndex = journal.entries.findIndex((entry) => entry.tag === HARDENING_TAG);
    expect(hardeningIndex).toBe(3);
    const url = await createEmptyDatabase();
    await applyFirstMigrations(url, 1);
    await withClient(url, (client) => client.query(REPRESENTATIVE_DATA_SQL));
    // Up to and including 0002, then more rows under the rules of 0002.
    await applyFirstMigrations(url, hardeningIndex);
    const before = await withClient(url, async (client) => {
      expect(await appliedMigrationCount(client)).toBe(hardeningIndex);
      await client.query(ROWS_WRITTEN_BEFORE_HARDENING_SQL);
      return tableRowCounts(client);
    });

    await applyFirstMigrations(url, hardeningIndex + 1);

    await withClient(url, async (client) => {
      expect(await appliedMigrationCount(client)).toBe(hardeningIndex + 1);
      // The migration reads and changes no row: existing rows stay, also the ones
      // that the new INSERT rules refuse from now on.
      const after = await tableRowCounts(client);
      for (const [table, n] of Object.entries(before)) expect(after[table], table).toBe(n);
      const legacy = await client.query(
        "SELECT translated_text FROM translations WHERE id = '00000000-0000-4000-8000-000000000107'",
      );
      expect(legacy.rows).toEqual([{ translated_text: "Test session text in a research batch." }]);

      const codeOf = (statement: string) =>
        client.query(statement).then(
          () => "no error",
          (reason: unknown) => getPgError(reason)?.code,
        );
      // The new guards protect the rows that existed before the migration.
      const blocked = [
        "DELETE FROM utterances WHERE status = 'submitted'",
        "DELETE FROM media_assets WHERE kind = 'source_audio'",
        "DELETE FROM questionnaire_answers",
        "DELETE FROM sessions WHERE mode = 'research'",
        "UPDATE transcripts SET type = 'normalized' WHERE type = 'human_dialect'",
        "UPDATE sessions SET consented_at = now() WHERE consented_at IS NOT NULL",
        "UPDATE task_presentations SET randomization_metadata_json = '{}'",
        "UPDATE transcript_revisions SET verified_at = now() WHERE verified_at IS NOT NULL",
        "UPDATE processing_batches SET name = 'renamed' WHERE status = 'completed'",
        "TRUNCATE translations CASCADE",
        "TRUNCATE admin_audit_log",
        // The translation of a test session in a research batch counts as research data.
        "DELETE FROM translations WHERE id = '00000000-0000-4000-8000-000000000107'",
      ];
      for (const statement of blocked) expect(await codeOf(statement), statement).toBe("IMMUT");

      // What was accepted under 0002 is refused for new rows.
      const refused = [
        `INSERT INTO transcript_revisions (transcript_id, revision_number, text, created_by_type, is_current)
         VALUES ('00000000-0000-4000-8000-000000000104', 2, 'again', 'model', false)`,
        `WITH run AS (
           INSERT INTO model_runs (stage, provider, requested_model, processing_batch_id, source_entity_type, source_entity_id,
                                   input_manifest_json, status, app_version, idempotency_key)
           VALUES ('translation', 'mock', 'mock-translation', '00000000-0000-4000-8000-000000000012', 'transcript_revision',
                   '00000000-0000-4000-8000-000000000105', '{}', 'succeeded', '0.1.0', 'mixed-after-hardening')
           RETURNING id)
         INSERT INTO translations (source_transcript_revision_id, condition_key, processing_batch_id, model_run_id, translated_text)
         SELECT '00000000-0000-4000-8000-000000000105', 'second', '00000000-0000-4000-8000-000000000012', id, 'again' FROM run`,
        `INSERT INTO sessions (study_id, participant_code, protocol_version_id, mode, app_version)
         VALUES ('00000000-0000-4000-8000-000000000001', 'P-DRAFT0001', '00000000-0000-4000-8000-000000000025', 'research', '0.1.0')`,
      ];
      for (const statement of refused) expect(await codeOf(statement), statement).toBe("INVST");

      // Ordinary work on existing rows still succeeds.
      await client.query("UPDATE translations SET status = 'reviewed'");
      await client.query("UPDATE sessions SET last_activity_at = now(), flagged = true");
      await client.query(
        "UPDATE transcript_revisions SET verified_at = now(), verified_by_label = 'annotator-2' WHERE verified_at IS NULL AND id = '00000000-0000-4000-8000-00000000001d'",
      );
      await client.query("UPDATE processing_batches SET status = 'running', completed_at = NULL WHERE status = 'completed'");
    });
  });
});

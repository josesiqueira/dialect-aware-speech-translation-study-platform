// Settings page services (spec 59, 87, 113, 116): operational study state,
// limits, technical status, the explicit provider connectivity test and the
// guarded reset of TEST and DEMO data.
//
// There is no function here, or anywhere else, that resets research data.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { testOpenAIConnectivity } from "@dialect/ai";
import { deleteDemoAndTestData, sessions, studies, type StudySettings } from "@dialect/db";
import { AppError, corpusSchemas, type StudyStatus } from "@dialect/domain";
import { ffmpegAvailable, findRepositoryRoot } from "@dialect/storage";
import { recordAudit } from "../audit";
import type { ServiceContext } from "../context";
import { getQueueStats, getWorkerStatus } from "../jobs";
import {
  EXAMPLE_TEXT_STATUS_MESSAGE,
  currentProtocolExampleText,
  participantTitleOf,
  participantTitleSetting,
  participantTitleTranslationsSetting,
  primingFindings,
} from "../protocols";
import { effectiveSettings } from "../sessions/settings";
import { checkDatabase, checkStorage } from "./dashboard";
import { WORKER_STALE_AFTER_MS, adminTimezoneOf, loadStudy, parseInput, toIso, type StudyRow } from "./shared";

// Facts about the running process that only the caller knows. The route handler
// fills them from the validated environment; tests pass them directly.
export type SettingsRuntime = {
  // "development", "test" or "production".
  environment?: string;
  // Local directory or bucket name of the media storage. Never credentials.
  storageLocation?: string | null;
  // True when ALLOW_TEST_DATA_RESET=true is set. Only matters in production.
  allowTestDataResetInProduction?: boolean;
  // Path of the migration journal. Default: packages/db/migrations/meta/_journal.json
  // below the repository root.
  migrationsJournalPath?: string;
};

type JournalEntry = { idx: number; when: number; tag: string };

const JOURNAL_RELATIVE_PATH = "packages/db/migrations/meta/_journal.json";

async function readJournal(journalPath: string | undefined): Promise<JournalEntry[] | null> {
  const root = findRepositoryRoot();
  const file = journalPath ?? (root ? path.join(root, JOURNAL_RELATIVE_PATH) : null);
  if (!file) return null;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return null;
    return parsed.entries
      .filter(
        (entry): entry is JournalEntry =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as JournalEntry).when === "number" &&
          typeof (entry as JournalEntry).tag === "string",
      )
      .sort((a, b) => a.when - b.when);
  } catch {
    return null;
  }
}

// Compares the migrations recorded by the migrator in drizzle.__drizzle_migrations
// with the journal file of this code version.
export async function getMigrationStatus(
  ctx: ServiceContext,
  journalPath?: string,
): Promise<corpusSchemas.SettingsView["database"]["migrations"]> {
  let appliedTimes: number[];
  try {
    const result = await ctx.db.execute<{ created_at: string | number }>(
      sql`SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`,
    );
    appliedTimes = result.rows.map((row) => Number(row.created_at));
  } catch {
    return {
      status: "unknown",
      applied: 0,
      expected: null,
      pending: [],
      latestApplied: null,
      detail: "The migration table could not be read. Run the database migrations.",
    };
  }
  const journal = await readJournal(journalPath);
  if (!journal) {
    return {
      status: "unknown",
      applied: appliedTimes.length,
      expected: null,
      pending: [],
      latestApplied: null,
      detail: "The migration journal file of this code version was not found, so the status cannot be compared.",
    };
  }
  const applied = new Set(appliedTimes);
  const pending = journal.filter((entry) => !applied.has(entry.when)).map((entry) => entry.tag);
  const latest = [...journal].reverse().find((entry) => applied.has(entry.when)) ?? null;
  const unknownApplied = appliedTimes.filter((time) => !journal.some((entry) => entry.when === time)).length;
  return {
    status: pending.length === 0 ? "up_to_date" : "pending",
    applied: appliedTimes.length,
    expected: journal.length,
    pending,
    latestApplied: latest?.tag ?? null,
    detail:
      unknownApplied > 0
        ? `${unknownApplied} applied migrations are not in the journal of this code version. The database may be newer than the code.`
        : null,
  };
}

function isTestDataResetAllowed(runtime: SettingsRuntime): boolean {
  return runtime.environment !== "production" || runtime.allowTestDataResetInProduction === true;
}

// Settings keys that the settings type of the database package does not list yet.
type StoredSettings = StudySettings & { participantTitle?: string | null; demoDailyRunLimit?: number };

// The stored daily limit of Demo Mode runs, or the documented default.
export function demoDailyRunLimitOf(settings: StudySettings | null | undefined): number {
  const value = (settings as StoredSettings | null | undefined)?.demoDailyRunLimit;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : corpusSchemas.DEFAULT_DEMO_DAILY_RUN_LIMIT;
}

function operationalView(study: StudyRow) {
  const settings = study.settingsJson ?? {};
  const effective = effectiveSettings(settings);
  const storedTitle = participantTitleSetting(settings);
  return {
    study: {
      id: study.id,
      slug: study.slug,
      name: study.name,
      participantTitle: storedTitle,
      participantTitleTranslations: participantTitleTranslationsSetting(settings),
      effectiveParticipantTitle: participantTitleOf(study),
      // Checked on the title participants actually see.
      participantTitleWarnings: primingFindings("The participant-facing title", participantTitleOf(study)).map(
        (finding) => finding.message,
      ),
    },
    // The stored values, without a fallback: an empty value is shown as "not set".
    languages: {
      sourceLanguage: settings.sourceLanguage || null,
      targetLanguage: settings.targetLanguage || null,
      participantLocales: settings.participantLocales ?? [],
      defaultLocale: settings.defaultLocale || null,
      interfaceLocales: [...corpusSchemas.INTERFACE_LOCALES],
    },
    operational: {
      status: study.status,
      allowNewSessions: effective.allowNewSessions,
      maintenanceMode: effective.maintenanceMode,
      maintenanceMessage: effective.maintenanceMessage,
    },
    limits: {
      maxUploadMb: effective.maxUploadMb,
      maxUtteranceSeconds: effective.maxUtteranceSeconds,
      sessionInactivityTimeoutMinutes: effective.sessionInactivityTimeoutMinutes,
      demoDailyRunLimit: demoDailyRunLimitOf(settings),
    },
    flags: {
      studyLaptopMode: effective.studyLaptopMode,
      autoQueueAsr: effective.autoQueueAsr,
      demoPersist: settings.demoPersist ?? false,
      demoPublic: effective.demoPublic,
    },
    adminTimezone: adminTimezoneOf(settings),
    conventions: {
      transcriptionConventionVersion: settings.transcriptionConventionVersion ?? null,
      annotationSchemeVersion: settings.annotationSchemeVersion ?? null,
    },
    outputReview: {
      enabled: effective.outputReviewEnabled,
      maxItems: effective.outputReviewMaxItems,
      englishCheckEnabled: effective.englishCheckEnabled,
    },
  };
}

export async function getSettings(
  ctx: ServiceContext,
  studyId: string,
  runtime: SettingsRuntime = {},
): Promise<corpusSchemas.SettingsView> {
  const study = await loadStudy(ctx.db, studyId);
  const settings = study.settingsJson ?? {};
  const now = ctx.now();

  const [connected, migrations, storage, ffmpeg, worker, queue] = await Promise.all([
    checkDatabase(ctx),
    getMigrationStatus(ctx, runtime.migrationsJournalPath),
    checkStorage(ctx),
    ffmpegAvailable().catch(() => ({ available: false, ffmpegVersion: null, ffprobeVersion: null })),
    getWorkerStatus(ctx.db, { now, staleAfterMs: WORKER_STALE_AFTER_MS }),
    getQueueStats(ctx.db, { now }),
  ]);

  const modeCounts = await ctx.db
    .select({ mode: sessions.mode, total: sql<string>`count(*)` })
    .from(sessions)
    .where(eq(sessions.studyId, studyId))
    .groupBy(sessions.mode);
  const countOf = (mode: string) => Number(modeCounts.find((row) => row.mode === mode)?.total ?? 0);

  const lastTest = settings.lastProviderTest ?? null;
  const exampleText = await currentProtocolExampleText(ctx, studyId);

  return {
    ...operationalView(study),
    exampleText: {
      present: exampleText.present,
      protocolVersionNumber: exampleText.versionNumber,
      fields: exampleText.fields.map((entry) => entry.label),
      message: exampleText.present ? EXAMPLE_TEXT_STATUS_MESSAGE : null,
    },
    database: { connected, migrations },
    storage: {
      driver: ctx.storage.driver,
      location: runtime.storageLocation ?? null,
      connected: storage.ok,
      // The detail of a working storage can contain a path; only a failure is explained.
      detail: storage.ok ? null : storage.detail,
      ffmpeg,
    },
    provider: {
      providers: ctx.providers.listProviders().map((name) => ({ name, configured: ctx.providers.isConfigured(name) })),
      openaiConfigured: ctx.providers.isConfigured("openai"),
      lastTest: lastTest ? { at: lastTest.at, ok: lastTest.ok, message: lastTest.message ?? null } : null,
    },
    application: {
      appVersion: ctx.appVersion,
      gitCommitSha: ctx.gitCommitSha,
      environment: runtime.environment ?? process.env.NODE_ENV ?? "development",
      worker: {
        healthy: worker.healthy,
        workers: worker.workers.map((entry) => ({
          workerId: entry.workerId,
          state: entry.state,
          lastSeenAt: toIso(entry.lastSeenAt),
          startedAt: toIso(entry.startedAt),
        })),
      },
      queue: { queued: queue.queued, running: queue.running, failed: queue.failed },
    },
    testDataReset: {
      allowed: isTestDataResetAllowed(runtime),
      phrase: corpusSchemas.TEST_DATA_RESET_PHRASE,
      counts: { demoSessions: countOf("demo"), testSessions: countOf("test") },
    },
  };
}

// Validates each field, merges the changes into the study status and
// settings_json, and writes one audit row with the values before and after.
export async function updateSettings(
  ctx: ServiceContext,
  studyId: string,
  changes: corpusSchemas.SettingsUpdate,
  runtime: SettingsRuntime = {},
): Promise<corpusSchemas.SettingsView> {
  const parsed = parseInput(corpusSchemas.settingsUpdateSchema, changes);
  await ctx.db.transaction(async (tx) => {
    const [study] = await tx.select().from(studies).where(eq(studies.id, studyId)).for("update");
    if (!study) throw new AppError("NOT_FOUND", "The study does not exist.", { studyId });

    const { status, studyName, ...settingChanges } = parsed;
    const current = study.settingsJson ?? {};
    const next: StudySettings = { ...current };
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(settingChanges) as Array<[keyof StudySettings, unknown]>) {
      if (value === undefined) continue;
      const previous = current[key] ?? null;
      if (JSON.stringify(previous) === JSON.stringify(value)) continue;
      before[key] = previous;
      after[key] = value;
      (next as Record<string, unknown>)[key] = value;
    }

    // The default interface language must be one the study offers. Checked on
    // the merged result, so the two settings can be saved together or one at a time.
    if (after.participantLocales !== undefined || after.defaultLocale !== undefined) {
      const locales = next.participantLocales ?? [];
      if (next.defaultLocale && locales.length > 0 && !locales.includes(next.defaultLocale)) {
        throw new AppError(
          "VALIDATION_ERROR",
          `The default language "${next.defaultLocale}" is not among the languages offered to participants (${locales.join(", ")}).`,
          { issues: [{ path: "defaultLocale", message: "must be one of the participant languages" }] },
        );
      }
    }

    let nextStatus: StudyStatus = study.status;
    if (status !== undefined && status !== study.status) {
      before.status = study.status;
      after.status = status;
      nextStatus = status;
    }
    let nextName = study.name;
    if (studyName !== undefined && studyName !== study.name) {
      before.studyName = study.name;
      after.studyName = studyName;
      nextName = studyName;
    }
    if (Object.keys(after).length === 0) return;

    await tx.update(studies).set({ name: nextName, status: nextStatus, settingsJson: next }).where(eq(studies.id, studyId));
    await recordAudit(tx, {
      action: "settings.update",
      entityType: "study",
      entityId: studyId,
      before,
      after,
      actorLabel: ctx.actorLabel,
    });
  });
  return getSettings(ctx, studyId, runtime);
}

// The OpenAI client type, without importing the SDK into this package.
export type ProviderClient = Parameters<typeof testOpenAIConnectivity>[0];

// Runs the provider connectivity test. Only called on an explicit request from
// the Settings page, never from a health check (spec 113). The result is stored
// as lastProviderTest in the study settings. `client` is null when no API key
// is configured: nothing is called and nothing is stored.
export async function testProviderConnectivity(
  ctx: ServiceContext,
  studyId: string,
  input: { client: ProviderClient | null },
): Promise<corpusSchemas.ProviderTestResult> {
  await loadStudy(ctx.db, studyId);
  if (!input.client) {
    return {
      configured: false,
      ok: false,
      message: "No OpenAI API key is configured on the server. Set OPENAI_API_KEY and restart the application.",
      at: null,
      latencyMs: null,
    };
  }
  const result = await testOpenAIConnectivity(input.client);
  const at = ctx.now().toISOString();
  const lastProviderTest = { at, ok: result.ok, message: result.message };
  await ctx.db.transaction(async (tx) => {
    const [study] = await tx.select().from(studies).where(eq(studies.id, studyId)).for("update");
    if (!study) throw new AppError("NOT_FOUND", "The study does not exist.", { studyId });
    await tx
      .update(studies)
      .set({ settingsJson: { ...(study.settingsJson ?? {}), lastProviderTest } })
      .where(eq(studies.id, studyId));
    await recordAudit(tx, {
      action: "settings.update",
      entityType: "study",
      entityId: studyId,
      before: { lastProviderTest: study.settingsJson?.lastProviderTest ?? null },
      after: { lastProviderTest },
      actorLabel: ctx.actorLabel,
    });
  });
  return { configured: true, ok: result.ok, message: result.message, at, latencyMs: result.latencyMs };
}

export type ResetTestDataInput = {
  studyId: string;
  modes: corpusSchemas.ResettableMode[];
  confirmationPhrase: string;
  // From the route handler: NODE_ENV is "production".
  isProduction: boolean;
  // From the route handler: ALLOW_TEST_DATA_RESET=true.
  allowInProduction: boolean;
};

// Deletes DEMO and TEST sessions with everything below them, and the batches
// with that data mode. Research data cannot be selected, and the database
// triggers refuse to delete a research row even if it were. Requires the typed
// phrase, and in production the explicit environment setting.
export async function resetTestData(
  ctx: ServiceContext,
  input: ResetTestDataInput,
): Promise<corpusSchemas.ResetTestDataResult> {
  const parsed = parseInput(corpusSchemas.resetTestDataBodySchema, {
    modes: input.modes,
    confirmationPhrase: input.confirmationPhrase,
  });
  if (input.isProduction && !input.allowInProduction) {
    throw new AppError(
      "FORBIDDEN",
      "Deleting TEST and DEMO data is disabled in production. Set ALLOW_TEST_DATA_RESET=true to allow it.",
    );
  }
  if (parsed.confirmationPhrase !== corpusSchemas.TEST_DATA_RESET_PHRASE) {
    throw new AppError("VALIDATION_ERROR", "The confirmation phrase does not match.", {
      confirmationRequired: true,
      confirmationPhrase: corpusSchemas.TEST_DATA_RESET_PHRASE,
    });
  }
  await loadStudy(ctx.db, input.studyId);
  const modes = [...new Set(parsed.modes)];

  const result = await ctx.db.transaction(async (tx) => {
    const deleted = await deleteDemoAndTestData(tx, { studyId: input.studyId, modes });
    await recordAudit(tx, {
      action: "test_data.reset",
      entityType: "study",
      entityId: input.studyId,
      after: { modes, deleted: deleted.deleted, storageObjects: deleted.storageObjects.length },
      actorLabel: ctx.actorLabel,
    });
    return deleted;
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
        "a media file of deleted TEST or DEMO data could not be removed",
      );
    }
  }
  // Files whose clean-up job was removed together with its session.
  for (const storageKey of result.pendingStorageDeletions) {
    try {
      await ctx.storage.delete(storageKey);
      storageObjectsRemoved += 1;
    } catch (error) {
      storageObjectsFailed += 1;
      ctx.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "a discarded recording of deleted TEST or DEMO data could not be removed",
      );
    }
  }
  if (storageObjectsFailed > 0) {
    ctx.logger.warn(
      { storageObjectsFailed },
      "some files of deleted TEST or DEMO data remain in storage",
    );
  }

  return { modes, deleted: result.deleted, storageObjectsRemoved, storageObjectsFailed };
}

// The one place that answers "which study does this call work on".
//
// The deployment runs one study, so most callers pass nothing and get the study
// that was created first. A caller may name the study by its id or by its slug.
// Each service area exports this under its own name (for example
// protocols.resolveStudy, aiConfig.resolveStudy), so their callers did not change.
//
// Errors:
// - a named study that does not exist: NOT_FOUND;
// - no study at all: CONFIGURATION_MISSING (the server is not set up yet).
//
// packages/research/src/sessions/settings.ts still has its own copy with the
// same behavior for a slug. It is to be switched to this function.
import { asc, eq } from "drizzle-orm";
import { studies, type DbOrTx } from "@dialect/db";
import { AppError } from "@dialect/domain";

export type StudyRow = typeof studies.$inferSelect;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const NO_STUDY_MESSAGE = "No study exists yet. Run the database seed or create a study first.";

// A value in UUID form is read as the study id, any other value as the slug.
export async function resolveStudy(db: DbOrTx, studyIdOrSlug?: string | null): Promise<StudyRow> {
  if (studyIdOrSlug) {
    const byId = UUID_PATTERN.test(studyIdOrSlug);
    const [study] = await db
      .select()
      .from(studies)
      .where(byId ? eq(studies.id, studyIdOrSlug) : eq(studies.slug, studyIdOrSlug))
      .limit(1);
    if (!study) {
      throw new AppError(
        "NOT_FOUND",
        "The study does not exist.",
        byId ? { studyId: studyIdOrSlug } : { studySlug: studyIdOrSlug },
      );
    }
    return study;
  }
  const [study] = await db.select().from(studies).orderBy(asc(studies.createdAt), asc(studies.id)).limit(1);
  if (!study) throw new AppError("CONFIGURATION_MISSING", NO_STUDY_MESSAGE);
  return study;
}

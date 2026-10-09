// ASR difference coding (spec 19, 72, 120).
//
// One row classifies the differences between two transcript revisions of one
// utterance, for example A against B. Several categories may apply. Rows are
// never updated: coding the same pair again adds a row, so independent ratings
// and earlier decisions stay available. The read model returns the newest row
// per annotator and pair, plus the full history.
import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { differenceAnnotations, transcriptRevisions, transcripts, type DbOrTx } from "@dialect/db";
import { AppError, transcriptSchemas, type DifferenceCategory } from "@dialect/domain";
import { recordAudit } from "../audit";
import type { ServiceContext } from "../context";
import { loadUtteranceScope, parseInput, resolveLabel, toIso } from "./shared";

type AnnotationRow = typeof differenceAnnotations.$inferSelect;

const saveAnnotationInputSchema = z.intersection(
  transcriptSchemas.differenceAnnotationBodySchema,
  z.object({ utteranceId: z.uuid() }),
);
export type SaveDifferenceAnnotationInput = z.input<typeof saveAnnotationInputSchema>;

type RevisionInfo = { id: string; utteranceId: string; type: (typeof transcripts.$inferSelect)["type"]; revisionNumber: number; text: string };

async function loadRevisionInfo(db: DbOrTx, ids: string[]): Promise<RevisionInfo[]> {
  if (ids.length === 0) return [];
  return db
    .select({
      id: transcriptRevisions.id,
      utteranceId: transcripts.utteranceId,
      type: transcripts.type,
      revisionNumber: transcriptRevisions.revisionNumber,
      text: transcriptRevisions.text,
    })
    .from(transcriptRevisions)
    .innerJoin(transcripts, eq(transcripts.id, transcriptRevisions.transcriptId))
    .where(inArray(transcriptRevisions.id, ids));
}

function toAnnotationView(row: AnnotationRow, revisions: RevisionInfo[]): transcriptSchemas.DifferenceAnnotationView {
  const source = revisions.find((revision) => revision.id === row.sourceTranscriptRevisionId);
  const target = revisions.find((revision) => revision.id === row.targetTranscriptRevisionId);
  return {
    id: row.id,
    utteranceId: row.utteranceId,
    sourceTranscriptRevisionId: row.sourceTranscriptRevisionId,
    targetTranscriptRevisionId: row.targetTranscriptRevisionId,
    sourceTranscriptType: source?.type ?? null,
    sourceRevisionNumber: source?.revisionNumber ?? null,
    targetTranscriptType: target?.type ?? null,
    targetRevisionNumber: target?.revisionNumber ?? null,
    scope: row.annotationScope,
    sourceStart: row.sourceStart,
    sourceEnd: row.sourceEnd,
    targetStart: row.targetStart,
    targetEnd: row.targetEnd,
    categories: row.categoriesJson as DifferenceCategory[],
    notes: row.notes,
    annotatorLabel: row.annotatorLabel,
    schemeVersion: row.schemeVersion,
    createdAt: toIso(row.createdAt),
  };
}

export async function saveDifferenceAnnotation(
  ctx: ServiceContext,
  input: SaveDifferenceAnnotationInput,
): Promise<transcriptSchemas.SaveDifferenceAnnotationResponse> {
  const parsed = parseInput(saveAnnotationInputSchema, input);
  const annotatorLabel = resolveLabel(ctx, parsed.annotatorLabel);
  if (!annotatorLabel) {
    throw new AppError("VALIDATION_ERROR", "An annotator label is required for a difference annotation.");
  }

  return ctx.db.transaction(async (tx) => {
    const scope = await loadUtteranceScope(tx, parsed.utteranceId);
    const schemeVersion = scope.settings.annotationSchemeVersion?.trim();
    if (!schemeVersion) {
      throw new AppError(
        "CONFIGURATION_MISSING",
        "The study has no annotation scheme version. Set it in the study settings before coding differences.",
      );
    }

    const revisions = await loadRevisionInfo(tx, [parsed.sourceTranscriptRevisionId, parsed.targetTranscriptRevisionId]);
    const source = revisions.find((revision) => revision.id === parsed.sourceTranscriptRevisionId);
    const target = revisions.find((revision) => revision.id === parsed.targetTranscriptRevisionId);
    if (!source || !target || source.utteranceId !== parsed.utteranceId || target.utteranceId !== parsed.utteranceId) {
      throw new AppError("VALIDATION_ERROR", "Both revisions must be transcript revisions of this utterance.");
    }
    if (parsed.scope === "span") {
      const outside =
        (parsed.sourceEnd != null && parsed.sourceEnd > source.text.length) ||
        (parsed.targetEnd != null && parsed.targetEnd > target.text.length);
      if (outside) throw new AppError("VALIDATION_ERROR", "A span reaches beyond the end of the revision text.");
    }

    const categories = [...new Set(parsed.categories)];
    const [row] = await tx
      .insert(differenceAnnotations)
      .values({
        utteranceId: parsed.utteranceId,
        sourceTranscriptRevisionId: source.id,
        targetTranscriptRevisionId: target.id,
        annotationScope: parsed.scope,
        sourceStart: parsed.sourceStart ?? null,
        sourceEnd: parsed.sourceEnd ?? null,
        targetStart: parsed.targetStart ?? null,
        targetEnd: parsed.targetEnd ?? null,
        categoriesJson: categories,
        notes: parsed.notes ?? null,
        annotatorLabel,
        schemeVersion,
        createdAt: ctx.now(),
      })
      .returning();
    if (!row) throw new AppError("INTERNAL_ERROR", "The annotation could not be stored.");

    await recordAudit(tx, {
      action: "annotation.create",
      entityType: "annotation",
      entityId: row.id,
      after: {
        utteranceId: row.utteranceId,
        sourceTranscriptRevisionId: source.id,
        targetTranscriptRevisionId: target.id,
        scope: row.annotationScope,
        categories,
        schemeVersion,
      },
      actorLabel: annotatorLabel,
    });

    return { annotation: toAnnotationView(row, revisions) };
  });
}

function pairKey(row: AnnotationRow): string {
  return [
    row.annotatorLabel,
    row.sourceTranscriptRevisionId,
    row.targetTranscriptRevisionId,
    row.annotationScope,
    row.sourceStart,
    row.sourceEnd,
    row.targetStart,
    row.targetEnd,
  ].join("|");
}

// The difference annotations of one utterance: the newest row per annotator,
// revision pair, scope and span, and every row as history (newest first).
export async function listDifferenceAnnotations(
  db: DbOrTx,
  utteranceId: string,
): Promise<transcriptSchemas.DifferenceAnnotationsView> {
  const rows = await db
    .select()
    .from(differenceAnnotations)
    .where(eq(differenceAnnotations.utteranceId, utteranceId))
    .orderBy(desc(differenceAnnotations.createdAt), desc(differenceAnnotations.id));
  const revisionIds = [
    ...new Set(
      rows
        .flatMap((row) => [row.sourceTranscriptRevisionId, row.targetTranscriptRevisionId])
        .filter((value): value is string => value !== null),
    ),
  ];
  const revisions = await loadRevisionInfo(db, revisionIds);
  const history = rows.map((row) => toAnnotationView(row, revisions));
  const seen = new Set<string>();
  const latest: transcriptSchemas.DifferenceAnnotationView[] = [];
  rows.forEach((row, index) => {
    const key = pairKey(row);
    if (seen.has(key)) return;
    seen.add(key);
    const view = history[index];
    if (view) latest.push(view);
  });
  return { latest, history };
}

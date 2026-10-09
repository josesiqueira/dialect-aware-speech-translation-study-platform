import { describe, expect, it } from "vitest";
import { DIFFERENCE_CATEGORIES } from "../enums";
import { differenceAnnotationBodySchema, differenceCategoriesForPair, normalizedDerivationWarning } from "./transcripts";

describe("differenceCategoriesForPair", () => {
  it("offers every category for a pair that involves a recognizer output", () => {
    expect(differenceCategoriesForPair("asr", "human_dialect")).toEqual([...DIFFERENCE_CATEGORIES]);
    expect(differenceCategoriesForPair("asr", "asr_corrected")).toEqual([...DIFFERENCE_CATEGORIES]);
    expect(differenceCategoriesForPair("asr_corrected", "human_dialect")).toEqual([...DIFFERENCE_CATEGORIES]);
  });

  it("does not offer recognition_error for B versus C, which are both written by a person", () => {
    expect(differenceCategoriesForPair("human_dialect", "normalized")).toEqual([
      "normalization",
      "omission",
      "addition",
      "segmentation",
      "punctuation_or_formatting",
      "uncertain",
    ]);
  });

  it("leaves the request schema accepting every stored category, so earlier codings stay valid", () => {
    const parsed = differenceAnnotationBodySchema.safeParse({
      sourceTranscriptRevisionId: "7b0f3c1e-6f0a-4a6c-9d57-0d4c0f3a1b11",
      targetTranscriptRevisionId: "7b0f3c1e-6f0a-4a6c-9d57-0d4c0f3a1b12",
      categories: ["recognition_error", "normalization"],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("normalizedDerivationWarning", () => {
  const b1 = { id: "b1", revisionNumber: 1, createdAt: "2026-10-01T10:00:00.000Z", derivedFromRevisionId: null };
  const b2 = { id: "b2", revisionNumber: 2, createdAt: "2026-10-01T12:00:00.000Z", derivedFromRevisionId: null };

  it("is silent when B or C is missing, and when C was copied from the current B", () => {
    const c = { id: "c1", revisionNumber: 1, createdAt: "2026-10-01T11:00:00.000Z", derivedFromRevisionId: "b1" };
    expect(normalizedDerivationWarning(null, c)).toBeNull();
    expect(normalizedDerivationWarning(b1, null)).toBeNull();
    expect(normalizedDerivationWarning(b1, c)).toBeNull();
  });

  it("warns when C was copied from a B revision that is no longer the current one", () => {
    const c = { id: "c1", revisionNumber: 1, createdAt: "2026-10-01T11:00:00.000Z", derivedFromRevisionId: "b1" };
    const warning = normalizedDerivationWarning(b2, c);
    expect(warning?.kind).toBe("derived_from_older_revision");
    expect(warning?.message).toBe(
      "C revision 1 was copied from an earlier revision of B. B is now at revision 2. Check that C still matches B.",
    );
  });

  it("without a recorded derivation, compares the save times", () => {
    const typed = { id: "c1", revisionNumber: 1, createdAt: "2026-10-01T11:00:00.000Z", derivedFromRevisionId: null };
    expect(normalizedDerivationWarning(b1, typed)).toBeNull();
    const warning = normalizedDerivationWarning(b2, typed);
    expect(warning?.kind).toBe("source_changed_later");
    expect(warning?.message).toBe("B was changed (revision 2) after C revision 1 was saved. Check that C still matches B.");
    // C revised after the change of B: nothing to report.
    const revised = { ...typed, id: "c2", revisionNumber: 2, createdAt: "2026-10-01T13:00:00.000Z" };
    expect(normalizedDerivationWarning(b2, revised)).toBeNull();
  });
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { transcriptSchemas } from "@dialect/domain";
import { DifferenceCoding, offeredCategories, type CodingDraft, type CodingPairKey } from "./DifferenceCoding";

const revision = (id: string, text: string): transcriptSchemas.TranscriptRevisionView => ({
  id,
  transcriptId: `t-${id}`,
  revisionNumber: 1,
  text,
  createdByType: "researcher",
  createdByLabel: "admin",
  changeReason: null,
  transcriptionConventionVersion: null,
  isCurrent: true,
  createdAt: "2026-10-01T10:00:00.000Z",
  verifiedAt: null,
  verifiedByLabel: null,
  verificationNotes: null,
  derivedFromRevisionId: null,
  sourceModelRunId: null,
});

function renderCoding(pairKey: CodingPairKey, value: CodingDraft = { categories: [], notes: "" }) {
  render(
    <DifferenceCoding
      pairKey={pairKey}
      onPairChange={() => {}}
      source={revision("s", "Mie en tiiä.")}
      target={revision("t", "Minä en tiedä.")}
      pairHasUnsavedText={false}
      value={value}
      onChange={() => {}}
      dirty={false}
      latestForPair={[]}
      historyCount={0}
      annotatorLabel="admin"
      schemeVersion="1.0"
      timeZone="UTC"
      disabled={false}
      error={null}
    />,
  );
  return screen.getAllByRole("checkbox").map((box) => (box as HTMLInputElement).labels?.[0]?.textContent ?? box.getAttribute("aria-label"));
}

describe("difference categories depend on the pair", () => {
  it("offers the recognizer category for A versus B", () => {
    expect(renderCoding("asr:human_dialect")).toEqual([
      "Recognition error",
      "Normalization",
      "Omission",
      "Addition",
      "Segmentation",
      "Punctuation or formatting",
      "Uncertain",
    ]);
  });

  it("does not offer Recognition error for B versus C", () => {
    expect(renderCoding("human_dialect:normalized")).toEqual([
      "Normalization",
      "Omission",
      "Addition",
      "Segmentation",
      "Punctuation or formatting",
      "Uncertain",
    ]);
  });

  it("still shows a stored category outside the offered list, so an earlier coding can be read and unchecked", () => {
    const labels = renderCoding("human_dialect:normalized", { categories: ["recognition_error", "omission"], notes: "" });
    expect(labels[0]).toBe("Recognition error");
    expect(screen.getByRole("checkbox", { name: "Recognition error" })).toBeChecked();
    expect(offeredCategories({ source: "human_dialect", target: "normalized" }, ["recognition_error"])).toContain("recognition_error");
  });
});

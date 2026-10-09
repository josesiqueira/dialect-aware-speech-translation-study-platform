import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REFERENCES } from "../references";
import { referenceAnchor } from "./Cite";
import { ScientificRelevance } from "./ScientificRelevance";

const source = readFileSync(path.join(__dirname, "ScientificRelevance.tsx"), "utf8");
const citedKeys = new Set([...source.matchAll(/refs=\{\[([^\]]*)\]\}/g)].flatMap((match) => [...match[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)));

describe("Scientific Relevance page", () => {
  it("renders every section, which also checks that every citation has a reference", () => {
    render(<ScientificRelevance />);
    for (const title of ["In brief", "Motivation", "Research questions", "Hypotheses", "Methodology", "Expected discussion", "Provisional conclusion", "References"]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    }
    expect(screen.getByText("Planned study")).toBeInTheDocument();
  });

  it("cites every listed reference at least once, and lists no reference twice", () => {
    expect(REFERENCES.filter((ref) => !citedKeys.has(ref.key)).map((ref) => ref.key)).toEqual([]);
    const anchors = REFERENCES.map((ref) => referenceAnchor(ref.key));
    expect(new Set(anchors).size).toBe(anchors.length);
  });
});

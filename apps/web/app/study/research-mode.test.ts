// Guard for the rule that Research Mode never exposes AI output during speech
// collection (spec 3.1, 83, 110.9).
//
// It reads the source of every participant-facing module and fails when one of
// them imports admin code or the AI package, or refers to a transcript,
// translation or synthesis field. The participant API has no such field, so a
// participant module has no reason to name one.
//
// The one place where a participant sees AI output is the output review after
// all speaking tasks (docs/IMPLEMENTATION-STATUS.md, "Deviations"). Its screens
// live in components/participant/review, use neutral names ("Version 1",
// "sourceText"), and are rendered only by the study page at the steps
// "english_check" and "output_review", which the server reaches only after the
// last task. The last test below checks that no other participant module renders them.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = path.resolve(import.meta.dirname, "../..");

/** Files and folders that make up the participant-facing interface. */
const PARTICIPANT_SOURCES = ["app/page.tsx", "app/study", "components/participant", "lib/i18n"];

const FORBIDDEN_IMPORTS: Array<[reason: string, pattern: RegExp]> = [
  ["the AI package", /^@dialect\/ai(\/|$)/],
  ["admin components", /(^|\/)components\/admin(\/|$)/],
  ["admin pages", /(^|\/)app\/admin(\/|$)/],
  ["admin API handlers", /(^|\/)api\/admin(\/|$)/],
];

/** Names of AI output: transcripts, translations, synthesized speech, the stages that produce them. */
const FORBIDDEN_REFERENCE = /transcri|translat|synthes|\basr\b|\btts\b|modelRun|model_run/i;

function sourceFiles(entry: string): string[] {
  const absolute = path.join(WEB_ROOT, entry);
  if (statSync(absolute).isFile()) return [absolute];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((child) => {
    const relative = path.join(entry, child.name);
    if (child.isDirectory()) return sourceFiles(relative);
    return /\.(ts|tsx)$/.test(child.name) && !/\.test\.(ts|tsx)$/.test(child.name) ? [path.join(WEB_ROOT, relative)] : [];
  });
}

/** Removes comments: a comment may say what a component must never show. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

export function importsOf(source: string): string[] {
  const found: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
  for (const match of stripComments(source).matchAll(pattern)) found.push(match[1]);
  return found;
}

/** The problems of one source file. Empty when the file follows the rule. */
export function researchModeProblems(source: string): string[] {
  const problems: string[] = [];
  for (const specifier of importsOf(source)) {
    for (const [reason, pattern] of FORBIDDEN_IMPORTS) {
      if (pattern.test(specifier)) problems.push(`imports ${reason}: ${specifier}`);
    }
  }
  const code = stripComments(source);
  code.split("\n").forEach((line, index) => {
    const match = FORBIDDEN_REFERENCE.exec(line);
    if (match) problems.push(`line ${index + 1} refers to "${match[0]}": ${line.trim().slice(0, 120)}`);
  });
  return problems;
}

describe("Research Mode: participant modules never touch AI output", () => {
  const files = PARTICIPANT_SOURCES.flatMap(sourceFiles);

  it("finds the participant modules", () => {
    const names = files.map((file) => path.relative(WEB_ROOT, file));
    expect(names).toContain("app/page.tsx");
    expect(names).toContain(path.join("app/study/_components/StudyFlow.tsx"));
    expect(names).toContain(path.join("components/participant/flow/TaskStep.tsx"));
    expect(names).toContain(path.join("components/participant/recorder/RecordingTask.tsx"));
    expect(files.length).toBeGreaterThan(25);
  });

  it("no participant module imports admin code or @dialect/ai, or names a transcript, translation or synthesis field", () => {
    const problems = files.flatMap((file) =>
      researchModeProblems(readFileSync(file, "utf8")).map((problem) => `${path.relative(WEB_ROOT, file)}: ${problem}`),
    );
    expect(problems).toEqual([]);
  });

  it("the check itself catches each kind of violation", () => {
    expect(researchModeProblems('import { Transcriber } from "@dialect/ai";')).toHaveLength(2);
    expect(researchModeProblems('import { SessionDetail } from "@/components/admin";')).toHaveLength(1);
    expect(researchModeProblems('import { X } from "@/app/admin/(shell)/review/_components/X";')).toHaveLength(1);
    expect(researchModeProblems('const page = await import("../admin/preview/steps");')).toEqual([]);
    expect(researchModeProblems('const page = await import("../../app/admin/preview/steps");')).toHaveLength(1);
    expect(researchModeProblems("return <p>{utterance.transcriptText}</p>;")).toHaveLength(1);
    expect(researchModeProblems("const text = state.translation?.outputText;")).toHaveLength(1);
    expect(researchModeProblems("<audio src={synthesisUrl} />")).toHaveLength(1);
    expect(researchModeProblems('fetch("/api/admin/sessions")')).toEqual([]);
    expect(researchModeProblems('apiFetch("/api/study/asr")')).toHaveLength(1);
    // Comments may state the rule.
    expect(researchModeProblems("// It never shows a transcript or a translation.\nconst a = 1;")).toEqual([]);
    expect(researchModeProblems("/** No translation here. */\nexport const b = 2;")).toEqual([]);
    expect(researchModeProblems('const url = "https://example.org/x"; const t = 1;')).toEqual([]);
  });
});

describe("Research Mode: the output review screens are rendered only at the review steps", () => {
  const REVIEW_IMPORT = /(^|\/)components\/participant\/review(\/|$)/;
  const files = PARTICIPANT_SOURCES.flatMap(sourceFiles);

  it("only the study page imports the review screens, and only for the steps english_check and output_review", () => {
    const importers = files
      .filter((file) => !file.includes(`${path.sep}components${path.sep}participant${path.sep}review${path.sep}`))
      .filter((file) => importsOf(readFileSync(file, "utf8")).some((specifier) => REVIEW_IMPORT.test(specifier)))
      .map((file) => path.relative(WEB_ROOT, file));
    expect(importers).toEqual([path.join("app/study/_components/StudyFlow.tsx")]);
    const flow = stripComments(readFileSync(path.join(WEB_ROOT, "app/study/_components/StudyFlow.tsx"), "utf8"));
    const renders = [...flow.matchAll(/case "([a-z_]+)":\s*content = \(\s*<(EnglishCheckStep|OutputReviewStep)\b/g)].map(
      (match) => `${match[1]}:${match[2]}`,
    );
    expect(renders).toEqual(["english_check:EnglishCheckStep", "output_review:OutputReviewStep"]);
  });
});

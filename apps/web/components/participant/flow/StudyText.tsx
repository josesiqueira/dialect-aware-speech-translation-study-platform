"use client";

import { Fragment, type ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { useContentLanguage } from "./FlowShell";

/**
 * StudyText: shows a study text written by the researchers (welcome,
 * information, consent, instructions, debrief, contact).
 *
 * The text is treated as plain text. Nothing in it is interpreted as HTML:
 * every character is rendered through React text nodes, so "<b>" in a study
 * text is shown as the five characters "<b>".
 *
 * Supported syntax (line based, documented in docs/PARTICIPANT-UI.md):
 *
 *   # Heading          a line that starts with "# " is a heading
 *   ## Sub-heading     a line that starts with "## " is a smaller heading
 *   - item             consecutive lines that start with "- " form a list
 *   (blank line)       separates paragraphs
 *   any other line     paragraph text; a single line break inside a paragraph is kept
 */

export type StudyTextBlock =
  | { kind: "heading"; level: 1 | 2; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "paragraph"; lines: string[] };

/** Splits a study text into headings, lists and paragraphs. Pure, for the component and its tests. */
export function parseStudyText(text: string | null | undefined): StudyTextBlock[] {
  const blocks: StudyTextBlock[] = [];
  let paragraph: string[] | null = null;
  let list: string[] | null = null;
  const closeOpenBlocks = () => {
    if (paragraph) blocks.push({ kind: "paragraph", lines: paragraph });
    if (list) blocks.push({ kind: "list", items: list });
    paragraph = null;
    list = null;
  };

  for (const rawLine of (text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (line === "") {
      closeOpenBlocks();
    } else if (line.startsWith("## ")) {
      closeOpenBlocks();
      blocks.push({ kind: "heading", level: 2, text: line.slice(3).trim() });
    } else if (line.startsWith("# ")) {
      closeOpenBlocks();
      blocks.push({ kind: "heading", level: 1, text: line.slice(2).trim() });
    } else if (line.startsWith("- ")) {
      if (paragraph) closeOpenBlocks();
      list = [...(list ?? []), line.slice(2).trim()];
    } else {
      if (list) closeOpenBlocks();
      paragraph = [...(paragraph ?? []), line];
    }
  }
  closeOpenBlocks();
  return blocks;
}

export interface StudyTextProps {
  /** The text from the protocol, shown as it is. */
  text: string | null | undefined;
  /**
   * HTML heading level of a "# " line. "## " lines use the next level. The
   * page has one h1 (the step heading), so the default is 2.
   */
  headingLevel?: 2 | 3;
  /** base: reading text of a step. sm: secondary text such as contact details. */
  size?: "base" | "sm";
  /**
   * Language of the text, only when the study declares it. Never guessed.
   * Default: the content language of the surrounding FlowShell (`contentLang`).
   */
  lang?: string;
  className?: string;
}

export function StudyText({ text, headingLevel = 2, size = "base", lang, className }: StudyTextProps) {
  const declaredLang = useContentLanguage();
  const blocks = parseStudyText(text);
  if (blocks.length === 0) return null;
  const Major = headingLevel === 2 ? "h2" : "h3";
  const Minor = headingLevel === 2 ? "h3" : "h4";

  return (
    <div
      lang={lang ?? declaredLang}
      data-testid="study-text"
      className={cn("space-y-4 text-slate-700", size === "sm" ? "text-sm" : "text-base", className)}
    >
      {blocks.map((block, index): ReactNode => {
        if (block.kind === "heading") {
          return block.level === 1 ? (
            <Major key={index} className="pt-2 text-lg font-semibold text-slate-900 first:pt-0">
              {block.text}
            </Major>
          ) : (
            <Minor key={index} className="pt-1 text-base font-semibold text-slate-900 first:pt-0">
              {block.text}
            </Minor>
          );
        }
        if (block.kind === "list") {
          return (
            <ul key={index} className="list-disc space-y-1.5 pl-5 leading-relaxed marker:text-slate-400">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{item}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={index} className="leading-relaxed">
            {block.lines.map((line, lineIndex) => (
              <Fragment key={lineIndex}>
                {lineIndex > 0 && <br />}
                {line}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

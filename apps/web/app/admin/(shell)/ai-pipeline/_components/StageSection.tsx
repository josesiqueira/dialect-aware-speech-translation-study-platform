"use client";

import type { ReactNode } from "react";
import { Badge, Card, CardHeader } from "@/components/ui";
import { ConfigBlock } from "./ConfigBlock";
import { PromptBlock } from "./PromptBlock";
import type { ModelConfig, PageContext, PromptVersion, SectionDefinition } from "./types";

export interface StageSectionProps {
  section: SectionDefinition;
  prompts: PromptVersion[];
  configs: ModelConfig[];
  page: PageContext;
  /** Shown under the header, for example the note about the shared TTS voice. */
  note?: ReactNode;
}

/** One pipeline stage or condition: its prompt and its model configuration in one card (spec 50). */
export function StageSection({ section, prompts, configs, page, note }: StageSectionProps) {
  const promptVersions = prompts.filter((prompt) => prompt.key === section.promptKey);
  const configVersions = configs.filter((config) => config.key === section.configKey);
  const headingId = `section-${section.id.replace(/[^a-z0-9_-]/gi, "-")}`;
  return (
    <Card padding="none" as="section" aria-labelledby={headingId} data-testid={`section-${section.id}`}>
      <CardHeader
        title={<span id={headingId}>{section.title}</span>}
        description={section.description}
        meta={
          section.conditionKey ? (
            <Badge variant="neutral">
              Condition <span className="font-mono">{section.conditionKey}</span>
            </Badge>
          ) : undefined
        }
      />
      {note && <div className="border-b border-slate-100 px-6 py-4">{note}</div>}
      <div className="px-6 py-5">
        <PromptBlock blockId={`${section.id}:prompt`} section={section} versions={promptVersions} page={page} />
      </div>
      <div className="border-t border-slate-100 px-6 py-5">
        <ConfigBlock
          blockId={`${section.id}:config`}
          section={section}
          versions={configVersions}
          promptVersions={promptVersions}
          page={page}
        />
      </div>
    </Card>
  );
}

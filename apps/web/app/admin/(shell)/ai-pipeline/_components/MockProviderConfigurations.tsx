"use client";

import { Badge } from "@/components/ui";
import { MOCK_GROUP_TITLE } from "./sections";
import { StageSection } from "./StageSection";
import type { ModelConfig, PageContext, PromptVersion, SectionDefinition } from "./types";

export interface MockProviderConfigurationsProps {
  sections: SectionDefinition[];
  prompts: PromptVersion[];
  configs: ModelConfig[];
  page: PageContext;
}

/**
 * The stored configurations of the mock provider, in their own closed group.
 * They are not experimental conditions of a researcher: the server creates
 * them for the mock option of Demo Mode, the pipeline test and the sample
 * sessions (docs/DEMO-MODE.md, "Mock provider"). Renders nothing when the
 * database has none.
 */
export function MockProviderConfigurations({ sections, prompts, configs, page }: MockProviderConfigurationsProps) {
  if (sections.length === 0) return null;
  return (
    <details className="rounded-lg border border-slate-200 bg-white shadow-sm" data-testid="mock-provider-configurations">
      <summary className="flex cursor-pointer flex-wrap items-center gap-3 rounded-lg px-6 py-4 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-none">
        <h2 className="text-base font-semibold text-slate-900">{MOCK_GROUP_TITLE}</h2>
        <Badge variant="neutral">Not research output</Badge>
        <span className="text-xs text-slate-500 tabular-nums">
          {sections.length} {sections.length === 1 ? "configuration" : "configurations"}
        </span>
      </summary>
      <div className="space-y-4 border-t border-slate-100 px-6 py-5">
        <p className="text-sm text-slate-600">
          The mock provider produces fixed, clearly marked text and a test tone without calling any model. It is used to
          check that recording, storage and the processing steps work together: in Demo Mode with the mock option, in
          the pipeline test and in the sample test sessions. These configurations were created automatically, are
          retired from the start and cannot be activated, so a research batch and automatic transcription never use
          them.
        </p>
        <div className="space-y-4">
          {sections.map((section) => (
            <StageSection key={section.id} section={section} prompts={prompts} configs={configs} page={page} />
          ))}
        </div>
      </div>
    </details>
  );
}

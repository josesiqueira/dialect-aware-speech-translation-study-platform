"use client";

import { useCallback, useMemo, useState } from "react";
import { InlineMessage, PageHeading, useUnsavedChangesGuard } from "@/components/ui";
import { errorMessage, fetchConfigs, fetchPrompts } from "./api";
import { ExperimentalConditions } from "./ExperimentalConditions";
import { MockProviderConfigurations } from "./MockProviderConfigurations";
import { PipelineTestSlot } from "./PipelineTestSlot";
import { ProviderStatusCard } from "./ProviderStatusCard";
import { experimentalSections, mockSections, STANDARD_SECTIONS } from "./sections";
import { StageSection } from "./StageSection";
import type { ModelConfig, PageContext, PromptVersion, ProviderStatus } from "./types";

export interface AiPipelineClientProps {
  initialPrompts: PromptVersion[];
  initialConfigs: ModelConfig[];
  initialProviders: ProviderStatus[];
  /** IANA zone for timestamps, from the study settings. */
  timeZone: string;
  outputFormats: readonly string[];
}

/** The AI Pipeline page (spec 50, 51): prompts and model configurations per stage, versioned. */
export function AiPipelineClient({
  initialPrompts,
  initialConfigs,
  initialProviders,
  timeZone,
  outputFormats,
}: AiPipelineClientProps) {
  const [prompts, setPrompts] = useState(initialPrompts);
  const [configs, setConfigs] = useState(initialConfigs);
  const [providers, setProviders] = useState(initialProviders);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirtyBlocks, setDirtyBlocks] = useState<Record<string, boolean>>({});

  useUnsavedChangesGuard(Object.values(dirtyBlocks).some(Boolean));

  const reload = useCallback(async () => {
    try {
      const [nextPrompts, nextConfigs] = await Promise.all([fetchPrompts(), fetchConfigs()]);
      setPrompts(nextPrompts);
      setConfigs(nextConfigs.configs);
      setProviders(nextConfigs.providers);
      setLoadError(null);
    } catch (caught) {
      setLoadError(`The page could not be refreshed: ${errorMessage(caught)} Reload the page to see the current state.`);
    }
  }, []);

  const setDirty = useCallback((blockId: string, dirty: boolean) => {
    setDirtyBlocks((current) => (Boolean(current[blockId]) === dirty ? current : { ...current, [blockId]: dirty }));
  }, []);

  const page = useMemo<PageContext>(
    () => ({ timeZone, providers, outputFormats, reload, setDirty }),
    [timeZone, providers, outputFormats, reload, setDirty],
  );
  const experimental = useMemo(() => experimentalSections(prompts, configs), [prompts, configs]);
  const mock = useMemo(() => mockSections(prompts, configs), [prompts, configs]);

  return (
    <div className="space-y-6">
      <PageHeading
        title="AI Pipeline"
        description="Models, prompts and parameters for transcription, translation and speech synthesis. Every change is a new version."
      />

      <ProviderStatusCard providers={providers} />

      <InlineMessage variant="info" announce="none" title="How versions work">
        An active version is read-only. Edit creates a draft, and the draft replaces the active version only when you
        activate it. Existing model runs and batches keep the versions they were created with. Times are shown in{" "}
        {timeZone}.
      </InlineMessage>

      {loadError && <InlineMessage variant="error">{loadError}</InlineMessage>}

      {STANDARD_SECTIONS.map((section) => (
        <StageSection
          key={section.id}
          section={section}
          prompts={prompts}
          configs={configs}
          page={page}
          note={
            section.id === "tts_baseline" ? (
              <p className="text-sm text-slate-600">
                The same TTS configuration is used for every translation condition in the main experiment. Changing
                the voice together with the translation condition would confound linguistic and acoustic effects.
              </p>
            ) : undefined
          }
        />
      ))}

      <ExperimentalConditions sections={experimental} prompts={prompts} configs={configs} page={page} />

      <MockProviderConfigurations sections={mock} prompts={prompts} configs={configs} page={page} />

      <PipelineTestSlot />
    </div>
  );
}

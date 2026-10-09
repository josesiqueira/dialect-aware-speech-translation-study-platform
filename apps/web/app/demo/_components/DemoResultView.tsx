"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { demoSchemas } from "@dialect/domain";
import { ParticipantCard } from "@/components/participant";
import { AudioPlayer, InlineMessage } from "@/components/ui";
import { formatDurationMs } from "@/lib/format";
import { demoMediaUrl } from "./demoApi";
import { DEMO_STRINGS as S, fill } from "./strings";

type Stage = demoSchemas.PipelineStage;
export type StageKey = "asr" | "translation" | "tts";
export type StageState = "waiting" | "running" | "done" | "failed" | "partial" | "skipped";
export type StageStates = Record<StageKey, StageState>;

const STAGE_ORDER: StageKey[] = ["asr", "translation", "tts"];

/** The quiet progress line: each stage with its state written out. */
export function StageProgress({ states }: { states: StageStates }) {
  return (
    <section aria-labelledby="demo-progress-title" data-testid="demo-progress">
      <h2 id="demo-progress-title" className="sr-only">
        {S.progressTitle}
      </h2>
      <ol className="flex flex-col gap-1 text-sm text-slate-600 sm:flex-row sm:flex-wrap sm:gap-x-6">
        {STAGE_ORDER.map((key) => (
          <li key={key} data-stage={key} data-state={states[key]}>
            <span className="font-medium text-slate-900">{S.stageNames[key]}</span>
            {": "}
            <span>{S.stageStates[states[key]]}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function StageFailure({ stageKey, stage, isAdmin }: { stageKey: StageKey; stage: Stage; isAdmin: boolean }) {
  const error = stage.error;
  if (!error) return null;
  const configurationProblem = error.reason === "provider_not_configured" || error.reason === "configuration_missing";
  return (
    <InlineMessage variant="error" title={S.stageFailedTitle[stageKey]} announce="none">
      <span data-testid={`demo-error-${stageKey}`}>{error.message}</span>
      {isAdmin && error.detail && (
        <span className="mt-1 block text-xs">
          {S.technicalDetail}: {error.detail}
        </span>
      )}
      {isAdmin && configurationProblem && (
        <span className="mt-1 block">
          <Link href="/admin/ai-pipeline" className="font-medium underline underline-offset-2">
            {S.adminConfigLink}
          </Link>
        </span>
      )}
    </InlineMessage>
  );
}

function Pending({ children }: { children: ReactNode }) {
  return <p className="text-sm text-slate-500">{children}</p>;
}

function ConditionColumn({
  condition,
  states,
  isAdmin,
}: {
  condition: demoSchemas.PipelineConditionResult;
  states: StageStates;
  isAdmin: boolean;
}) {
  const { translation, synthesis } = condition;
  const headingId = `demo-condition-${condition.conditionKey}`;
  return (
    <ParticipantCard as="section" aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4" data-condition={condition.conditionKey}>
      <h3 id={headingId} className="text-base font-semibold text-slate-900">
        {condition.label}
      </h3>
      <div className="min-w-0 flex-1">
        {translation.status === "succeeded" ? (
          <p lang="en" className="break-words whitespace-pre-wrap text-slate-900" data-testid="demo-translation-text">
            {translation.text}
          </p>
        ) : translation.status === "failed" ? (
          <StageFailure stageKey="translation" stage={translation} isAdmin={isAdmin} />
        ) : (
          <Pending>
            {states.translation === "skipped" || states.asr === "failed" ? S.translationNotRun : S.translationPending}
          </Pending>
        )}
      </div>
      <div className="min-w-0">
        {synthesis.status === "succeeded" && synthesis.mediaAssetId ? (
          <AudioPlayer
            src={demoMediaUrl(synthesis.mediaAssetId)}
            type={synthesis.mimeType ?? undefined}
            label={fill(S.playLabel, { label: condition.label })}
          />
        ) : synthesis.status === "failed" ? (
          <StageFailure stageKey="tts" stage={synthesis} isAdmin={isAdmin} />
        ) : (
          <Pending>
            {translation.status === "succeeded" && states.tts !== "skipped" ? S.synthesisPending : S.synthesisNotRun}
          </Pending>
        )}
      </div>
    </ParticipantCard>
  );
}

function seconds(ms: number | null | undefined): string {
  if (typeof ms !== "number") return "";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function PipelineRow({ name, stage }: { name: string; stage: Stage }) {
  const provenance = stage.provenance;
  const state =
    stage.status === "succeeded" ? null : stage.status === "failed" ? S.pipelineFailed : S.pipelineNotRun;
  return (
    <div className="grid gap-1 border-t border-slate-100 py-3 text-sm first:border-t-0 sm:grid-cols-[11rem_1fr]">
      <dt className="font-medium text-slate-900">
        {name}
        {state && <span className="ml-2 font-normal text-slate-500">({state})</span>}
      </dt>
      <dd className="min-w-0 space-y-0.5 text-slate-600">
        {provenance ? (
          <>
            <p>
              {S.pipelineModel}:{" "}
              <span className="break-all font-mono text-slate-900">
                {provenance.provider} / {provenance.requestedModel}
              </span>
              <span className="text-slate-500">
                {" "}
                ({provenance.configKey} v{provenance.configVersionNumber})
              </span>
            </p>
            <p>
              {S.pipelinePrompt}:{" "}
              {provenance.promptKey ? (
                <span className="font-mono text-slate-900">
                  {provenance.promptKey} v{provenance.promptVersionNumber}
                </span>
              ) : (
                S.pipelineNoPrompt
              )}
            </p>
            {(provenance.latencyMs !== null || stage.durationMs !== null) && (
              <p className="tabular-nums">
                {S.pipelineTiming}: {seconds(provenance.latencyMs ?? stage.durationMs)}
              </p>
            )}
          </>
        ) : (
          <p>{stage.error?.message ?? S.pipelineNotRun}</p>
        )}
      </dd>
    </div>
  );
}

/** "Show pipeline": source, ASR, translation and TTS with model, prompt version and timing (spec 81). */
function PipelineDisclosure({ result }: { result: demoSchemas.DemoResult }) {
  const { source } = result;
  return (
    <details className="rounded-xl border border-slate-200 bg-white shadow-sm" data-testid="demo-pipeline">
      <summary className="cursor-pointer rounded-xl px-6 py-4 text-sm font-medium text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
        {S.pipelineSummary}
      </summary>
      <div className="border-t border-slate-100 px-6 pb-4">
        <p className="pt-3 text-sm text-slate-500">{S.pipelineIntro}</p>
        <dl>
          <div className="grid gap-1 py-3 text-sm sm:grid-cols-[11rem_1fr]">
            <dt className="font-medium text-slate-900">{S.pipelineSource}</dt>
            <dd className="min-w-0 space-y-0.5 text-slate-600">
              <p>
                <span className="font-mono text-slate-900">{source.mimeType}</span>
                {source.captureQualityClass ? `, ${source.captureQualityClass.replace(/_/g, " ")}` : ""}
                {source.durationMs !== null ? `, ${formatDurationMs(source.durationMs)}` : ""}
              </p>
              <p className="break-all">
                SHA-256: <span className="font-mono text-slate-900">{source.sha256}</span>
              </p>
            </dd>
          </div>
          <PipelineRow name={S.pipelineAsr} stage={result.asr} />
          {result.conditions.map((condition) => (
            <PipelineRow
              key={`translation-${condition.conditionKey}`}
              name={fill(S.pipelineTranslation, { label: condition.label })}
              stage={condition.translation}
            />
          ))}
          {result.conditions.map((condition) => (
            <PipelineRow
              key={`tts-${condition.conditionKey}`}
              name={fill(S.pipelineTts, { label: condition.label })}
              stage={condition.synthesis}
            />
          ))}
        </dl>
        {result.batchName && (
          <p className="border-t border-slate-100 pt-3 text-xs text-slate-500">
            {fill(S.pipelineBatch, { mode: result.dataMode, name: result.batchName })}
          </p>
        )}
      </div>
    </details>
  );
}

export interface DemoResultViewProps {
  result: demoSchemas.DemoResult | null;
  source: demoSchemas.PipelineSourceInfo;
  states: StageStates;
  isAdmin: boolean;
}

/** Source playback, the ASR transcript, the two translation columns and the pipeline disclosure. */
export function DemoResultView({ result, source, states, isAdmin }: DemoResultViewProps) {
  const asr = result?.asr ?? null;
  return (
    <div className="space-y-6" data-testid="demo-result">
      <ParticipantCard as="section" aria-labelledby="demo-source-title" className="space-y-4">
        <AudioPlayer
          src={demoMediaUrl(source.mediaAssetId)}
          type={source.mimeType}
          label={<span id="demo-source-title">{S.sourceTitle}</span>}
          meta={source.durationMs !== null ? formatDurationMs(source.durationMs) : undefined}
        />
        <div>
          <h2 className="text-base font-semibold text-slate-900">{S.transcriptTitle}</h2>
          <p className="mb-2 text-xs text-slate-500">{S.transcriptDescription}</p>
          {asr?.status === "succeeded" ? (
            asr.text && asr.text.trim().length > 0 ? (
              <p lang="fi" className="break-words whitespace-pre-wrap text-slate-900" data-testid="demo-transcript">
                {asr.text}
              </p>
            ) : (
              <Pending>{S.transcriptEmpty}</Pending>
            )
          ) : asr?.status === "failed" ? (
            <StageFailure stageKey="asr" stage={asr} isAdmin={isAdmin} />
          ) : (
            <Pending>{S.transcriptPending}</Pending>
          )}
        </div>
      </ParticipantCard>

      {result && result.conditions.length > 0 && (
        <section aria-labelledby="demo-comparison-title" className="space-y-3">
          <h2 id="demo-comparison-title" className="text-base font-semibold text-slate-900">
            {S.comparisonTitle}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {result.conditions.map((condition) => (
              <ConditionColumn key={condition.conditionKey} condition={condition} states={states} isAdmin={isAdmin} />
            ))}
          </div>
          <p className="text-sm text-slate-500">{S.comparisonCaption}</p>
        </section>
      )}

      {result && <PipelineDisclosure result={result} />}
    </div>
  );
}

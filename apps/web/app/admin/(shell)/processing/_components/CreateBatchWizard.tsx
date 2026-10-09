"use client";

import { useState } from "react";
import {
  STUDY_MODES,
  TASK_TYPES,
  TRANSCRIPT_TYPES,
  TRANSCRIPT_TYPE_LABELS,
  type StudyMode,
  type TaskType,
  type TranscriptType,
  type processingSchemas,
} from "@dialect/domain";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  FormField,
  InlineMessage,
  KeyValueList,
  LoadingState,
  MetricCard,
  Select,
  TextArea,
  TextInput,
  cn,
  useUnsavedChangesGuard,
} from "@/components/ui";
import { formatCount, formatCountOf } from "@/lib/format";
import { createBatch, errorMessage, previewBatch, startBatch } from "./api";
import { PreviewWarnings } from "./PreviewWarnings";
import { ConfigSnapshotList } from "./ConfigSnapshotView";
import { TASK_TYPE_NAMES, TRANSCRIPT_TYPE_NAMES } from "./labels";
import type { BatchConfigOption, BatchDetail, BatchOptions, BatchPreview } from "./types";

// The eight steps of spec 53.
const STEPS = [
  "Corpus subset",
  "Transcript types",
  "ASR",
  "Translation conditions",
  "TTS conditions",
  "Estimated workload",
  "Create batch",
  "Run",
] as const;
const REVIEW_STEP = 5;
const CREATE_STEP = 6;
const RUN_STEP = 7;

type Draft = {
  mode: StudyMode;
  completedSessionsOnly: boolean;
  verifiedTranscriptsOnly: boolean;
  excludeFlagged: boolean;
  excludeExcluded: boolean;
  protocolVersionIds: string[];
  taskTypes: TaskType[];
  dateFrom: string;
  dateTo: string;
  transcriptTypes: TranscriptType[];
  runAsr: boolean;
  asrModelConfigId: string;
  translationModelConfigIds: string[];
  ttsModelConfigIds: string[];
  name: string;
  description: string;
};

function initialDraft(options: BatchOptions): Draft {
  const defaults = (stage: string) =>
    options.modelConfigs.filter((config) => config.stage === stage && config.isDefault).map((config) => config.id);
  return {
    // Defaults of spec 53 and 150.
    mode: "research",
    completedSessionsOnly: true,
    verifiedTranscriptsOnly: true,
    excludeFlagged: true,
    excludeExcluded: true,
    protocolVersionIds: [],
    taskTypes: [],
    dateFrom: "",
    dateTo: "",
    transcriptTypes: ["asr", "human_dialect", "normalized"],
    runAsr: false,
    asrModelConfigId: defaults("asr")[0] ?? "",
    translationModelConfigIds: defaults("translation"),
    ttsModelConfigIds: defaults("tts"),
    name: "",
    description: "",
  };
}

function toPlan(draft: Draft, studyId: string): processingSchemas.PreviewBatchInput {
  return {
    studyId,
    selection: {
      mode: draft.mode,
      completedSessionsOnly: draft.completedSessionsOnly,
      verifiedTranscriptsOnly: draft.verifiedTranscriptsOnly,
      excludeFlagged: draft.excludeFlagged,
      excludeExcluded: draft.excludeExcluded,
      ...(draft.protocolVersionIds.length > 0 ? { protocolVersionIds: draft.protocolVersionIds } : {}),
      ...(draft.taskTypes.length > 0 ? { taskTypes: draft.taskTypes } : {}),
      ...(draft.dateFrom ? { dateFrom: draft.dateFrom } : {}),
      ...(draft.dateTo ? { dateTo: draft.dateTo } : {}),
    },
    transcriptTypes: draft.transcriptTypes,
    runAsr: draft.runAsr,
    ...(draft.runAsr && draft.asrModelConfigId ? { asrModelConfigId: draft.asrModelConfigId } : {}),
    translationModelConfigIds: draft.translationModelConfigIds,
    ttsModelConfigIds: draft.ttsModelConfigIds,
  };
}

function toggle<T>(values: T[], value: T, checked: boolean): T[] {
  return checked ? [...new Set([...values, value])] : values.filter((item) => item !== value);
}

function configDescription(config: BatchConfigOption): string {
  return [
    `${config.provider} ${config.modelId}`,
    config.conditionKey ? `condition ${config.conditionKey}` : null,
    config.promptKey ? `prompt ${config.promptKey} v${config.promptVersionNumber}` : "no prompt",
    config.stage === "tts" ? `voice ${config.voice ?? "not set"}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

const AI_PIPELINE_HINT = "Activate one on the AI Pipeline page. A batch never falls back to a built-in default.";

/**
 * "Create batch" wizard: corpus subset, transcript types, ASR, translation
 * conditions, TTS conditions, estimated workload, create, run.
 */
export function CreateBatchWizard({
  options,
  onCreated,
  onClose,
}: {
  options: BatchOptions;
  onCreated: (batch: BatchDetail) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(() => initialDraft(options));
  const [touched, setTouched] = useState(false);
  const [preview, setPreview] = useState<BatchPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<BatchDetail | null>(null);
  const [confirmStart, setConfirmStart] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useUnsavedChangesGuard(touched && created === null);

  const configsOf = (stage: string) => options.modelConfigs.filter((config) => config.stage === stage);
  const asrConfigs = configsOf("asr");
  const translationConfigs = configsOf("translation");
  const ttsConfigs = configsOf("tts");

  function update(changes: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...changes }));
    setTouched(true);
    setPreview(null);
    setError(null);
  }

  async function loadPreview() {
    setLoading(true);
    setError(null);
    try {
      setPreview(await previewBatch(toPlan(draft, options.studyId)));
    } catch (failure) {
      setPreview(null);
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }

  function goTo(next: number) {
    setError(null);
    setStep(next);
    if (next === REVIEW_STEP && preview === null) void loadPreview();
  }

  async function create() {
    if (draft.name.trim().length === 0) {
      setError("Give the batch a name.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const batch = await createBatch({
        ...toPlan(draft, options.studyId),
        name: draft.name.trim(),
        ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
      });
      setCreated(batch);
      onCreated(batch);
      setStep(RUN_STEP);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }

  async function start() {
    if (!created) return;
    setStarting(true);
    setStartError(null);
    try {
      onCreated(await startBatch(created.id));
      setConfirmStart(false);
      onClose();
    } catch (failure) {
      setStartError(errorMessage(failure));
    } finally {
      setStarting(false);
    }
  }

  function close() {
    if (touched && created === null && !window.confirm("Close the wizard and discard this batch setup?")) return;
    onClose();
  }

  const reviewBlocked = preview === null || preview.utteranceCount === 0 || preview.estimatedJobCounts.total === 0;

  return (
    <Card padding="none" as="section" aria-label="Create batch">
      <CardHeader
        title="Create batch"
        description={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}
        actions={
          <Button size="sm" variant="ghost" onClick={close}>
            {created ? "Close" : "Cancel"}
          </Button>
        }
      />
      <CardBody className="space-y-5">
        <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {STEPS.map((label, index) => (
            <li
              key={label}
              aria-current={index === step ? "step" : undefined}
              className={cn(
                "tabular-nums",
                index === step ? "font-semibold text-slate-900" : index < step ? "text-slate-700" : "text-slate-500",
              )}
            >
              {index + 1}. {label}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <FormField
                label="Data mode"
                help="One mode per batch. Research data is never mixed with demo or test data."
              >
                <Select
                  value={draft.mode}
                  onChange={(event) => update({ mode: event.target.value as StudyMode })}
                  options={STUDY_MODES.map((mode) => ({ value: mode, label: mode }))}
                />
              </FormField>
              <FormField label="Sessions started from">
                <TextInput type="date" value={draft.dateFrom} onChange={(event) => update({ dateFrom: event.target.value })} />
              </FormField>
              <FormField label="Sessions started until" help="Dates are whole days in UTC.">
                <TextInput type="date" value={draft.dateTo} onChange={(event) => update({ dateTo: event.target.value })} />
              </FormField>
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <Checkbox
                label="Completed sessions only"
                checked={draft.completedSessionsOnly}
                onChange={(event) => update({ completedSessionsOnly: event.target.checked })}
              />
              <Checkbox
                label="Verified transcripts only"
                description="A human transcript is translated only when its current revision is verified."
                checked={draft.verifiedTranscriptsOnly}
                onChange={(event) => update({ verifiedTranscriptsOnly: event.target.checked })}
              />
              <Checkbox
                label="Exclude flagged sessions and utterances"
                checked={draft.excludeFlagged}
                onChange={(event) => update({ excludeFlagged: event.target.checked })}
              />
              <Checkbox
                label="Exclude excluded sessions and utterances"
                checked={draft.excludeExcluded}
                onChange={(event) => update({ excludeExcluded: event.target.checked })}
              />
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-slate-700">Task types (none ticked means all)</legend>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {TASK_TYPES.map((type) => (
                  <Checkbox
                    key={type}
                    label={TASK_TYPE_NAMES[type]}
                    checked={draft.taskTypes.includes(type)}
                    onChange={(event) => update({ taskTypes: toggle(draft.taskTypes, type, event.target.checked) })}
                  />
                ))}
              </div>
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-slate-700">Protocol versions (none ticked means all)</legend>
              {options.protocolVersions.length === 0 ? (
                <p className="text-sm text-slate-500">No published protocol version exists yet.</p>
              ) : (
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  {options.protocolVersions.map((version) => (
                    <Checkbox
                      key={version.id}
                      label={`v${version.versionNumber} ${version.name}${version.status === "retired" ? " (retired)" : ""}`}
                      checked={draft.protocolVersionIds.includes(version.id)}
                      onChange={(event) =>
                        update({ protocolVersionIds: toggle(draft.protocolVersionIds, version.id, event.target.checked) })
                      }
                    />
                  ))}
                </div>
              )}
            </fieldset>
          </div>
        )}

        {step === 1 && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-700">Transcript types to translate</legend>
            {TRANSCRIPT_TYPES.map((type) => (
              <Checkbox
                key={type}
                label={`${TRANSCRIPT_TYPE_LABELS[type]}: ${TRANSCRIPT_TYPE_NAMES[type]}`}
                checked={draft.transcriptTypes.includes(type)}
                onChange={(event) => update({ transcriptTypes: toggle(draft.transcriptTypes, type, event.target.checked) })}
              />
            ))}
            <p className="text-xs text-slate-500">
              The batch translates the current revision of each ticked type as it is when the batch starts. Later edits
              create new revisions and do not change what the batch processed.
            </p>
          </fieldset>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <Checkbox
              label="Run ASR in this batch"
              description="Creates a new ASR transcript revision for every selected utterance. With A ticked as a transcript type, the batch translates the revision it produced. Without ASR, the batch uses the current ASR transcript."
              checked={draft.runAsr}
              onChange={(event) => update({ runAsr: event.target.checked })}
            />
            {draft.runAsr &&
              (asrConfigs.length === 0 ? (
                <InlineMessage variant="warning">No active ASR configuration exists. {AI_PIPELINE_HINT}</InlineMessage>
              ) : (
                <FormField label="ASR configuration" className="max-w-xl">
                  <Select
                    value={draft.asrModelConfigId}
                    onChange={(event) => update({ asrModelConfigId: event.target.value })}
                    options={asrConfigs.map((config) => ({
                      value: config.id,
                      label: `${config.key} v${config.versionNumber} (${configDescription(config)})`,
                    }))}
                    placeholder="Select a configuration"
                  />
                </FormField>
              ))}
          </div>
        )}

        {step === 3 && (
          <ConfigChoice
            legend="Translation conditions"
            configs={translationConfigs}
            selected={draft.translationModelConfigIds}
            onChange={(ids) => update({ translationModelConfigIds: ids })}
            emptyMessage={`No active translation configuration exists. ${AI_PIPELINE_HINT}`}
            note="Every ticked condition is applied to every selected transcript type of every utterance."
          />
        )}

        {step === 4 && (
          <ConfigChoice
            legend="TTS conditions"
            configs={ttsConfigs}
            selected={draft.ttsModelConfigIds}
            onChange={(ids) => update({ ttsModelConfigIds: ids })}
            emptyMessage={`No active TTS configuration exists. ${AI_PIPELINE_HINT}`}
            note="The same TTS configuration, voice and instruction are applied to every translation of the batch, so the voice never differs between translation conditions. Tick none to create translations without audio."
          />
        )}

        {step === REVIEW_STEP && (
          <div className="space-y-4" aria-busy={loading}>
            {loading && <LoadingState label="Calculating the workload..." size="sm" />}
            {preview && (
              <>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
                  <MetricCard density="compact" label="Utterances" value={formatCount(preview.utteranceCount)} />
                  <MetricCard density="compact" label="Sessions" value={formatCount(preview.sessionCount)} />
                  <MetricCard density="compact" label="ASR jobs" value={formatCount(preview.estimatedJobCounts.asr)} />
                  <MetricCard
                    density="compact"
                    label="Translation jobs"
                    value={formatCount(preview.estimatedJobCounts.translation)}
                  />
                  <MetricCard density="compact" label="TTS jobs" value={formatCount(preview.estimatedJobCounts.tts)} />
                  <MetricCard density="compact" label="Jobs in total" value={formatCount(preview.estimatedJobCounts.total)} />
                </div>
                <p className="text-xs text-slate-500">
                  The job counts are an estimate from the transcripts that exist now. The jobs are decided when the batch
                  starts.
                </p>
                <KeyValueList
                  items={[
                    { label: "Data mode", value: preview.dataMode },
                    ...Object.entries(preview.sourceTranscriptCounts).map(([type, value]) => ({
                      label: `Transcripts of type ${TRANSCRIPT_TYPE_LABELS[type as TranscriptType]} to translate`,
                      value: formatCount(value ?? 0),
                    })),
                  ]}
                />
                {preview.utteranceCount === 0 && (
                  <InlineMessage variant="warning">
                    The selection matches no utterances. Go back and change the filters.
                  </InlineMessage>
                )}
                {preview.utteranceCount > 0 && preview.estimatedJobCounts.total === 0 && (
                  <InlineMessage variant="warning">
                    No selected utterance has a transcript that can be translated with these settings, and ASR is not
                    part of the batch.
                  </InlineMessage>
                )}
                <PreviewWarnings warnings={preview.warnings} />
                <ConfigSnapshotList
                  asr={preview.configuration.asr}
                  translations={preview.configuration.translations}
                  tts={preview.configuration.tts}
                />
              </>
            )}
          </div>
        )}

        {step === CREATE_STEP && (
          <div className="max-w-xl space-y-4">
            <FormField label="Batch name" required help="Unique, for example 2026-10-pilot-openai-v1.">
              <TextInput value={draft.name} maxLength={200} onChange={(event) => update({ name: event.target.value })} />
            </FormField>
            <FormField label="Description">
              <TextArea
                rows={3}
                maxLength={2000}
                value={draft.description}
                onChange={(event) => update({ description: event.target.value })}
              />
            </FormField>
            <p className="text-sm text-slate-600">
              Creating the batch copies the selected configurations and prompt texts into the batch. The batch is stored
              as a draft and nothing is sent to an AI provider until it is started.
            </p>
          </div>
        )}

        {step === RUN_STEP && created && (
          <div className="space-y-3">
            <InlineMessage variant="success">
              The batch was created as a draft with {formatCountOf(created.utteranceCount, "utterance")}.
            </InlineMessage>
            <p className="text-sm text-slate-700">
              <span className="font-medium text-slate-900">{created.name}</span>{" "}
              <Badge variant="incomplete">Draft</Badge>
            </p>
            <p className="text-sm text-slate-600">
              Start it now, or close the wizard and start it later from the batch list.
            </p>
          </div>
        )}

        {error && <InlineMessage variant="error">{error}</InlineMessage>}

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
          {step > 0 && step < RUN_STEP && (
            <Button variant="secondary" onClick={() => goTo(step - 1)} disabled={loading}>
              Back
            </Button>
          )}
          {step < REVIEW_STEP && <Button onClick={() => goTo(step + 1)}>Next</Button>}
          {step === REVIEW_STEP && (
            <>
              <Button onClick={() => goTo(CREATE_STEP)} disabled={loading || reviewBlocked}>
                Next
              </Button>
              <Button variant="secondary" onClick={() => void loadPreview()} disabled={loading}>
                Recalculate
              </Button>
            </>
          )}
          {step === CREATE_STEP && (
            <Button onClick={() => void create()} loading={loading} loadingLabel="Creating...">
              Create batch
            </Button>
          )}
          {step === RUN_STEP && created && (
            <>
              <Button onClick={() => setConfirmStart(true)}>Start batch</Button>
              <Button variant="secondary" onClick={onClose}>
                Keep as draft
              </Button>
            </>
          )}
        </div>
      </CardBody>

      <ConfirmDialog
        open={confirmStart}
        title="Start this batch?"
        confirmLabel="Start batch"
        cancelLabel="Not now"
        busy={starting}
        busyLabel="Starting..."
        error={startError}
        onConfirm={() => void start()}
        onCancel={() => {
          setConfirmStart(false);
          setStartError(null);
        }}
      >
        <p>
          The jobs of this batch are queued and the selected audio and transcript text are sent to the configured AI
          provider. After the start the configuration cannot change.
        </p>
      </ConfirmDialog>
    </Card>
  );
}

function ConfigChoice({
  legend,
  configs,
  selected,
  onChange,
  emptyMessage,
  note,
}: {
  legend: string;
  configs: BatchConfigOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
  emptyMessage: string;
  note: string;
}) {
  if (configs.length === 0) return <InlineMessage variant="warning">{emptyMessage}</InlineMessage>;
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-slate-700">{legend}</legend>
      {configs.map((config) => (
        <Checkbox
          key={config.id}
          label={
            <span className="font-mono text-sm">
              {config.key} v{config.versionNumber}
            </span>
          }
          description={`${config.name ? `${config.name}. ` : ""}${configDescription(config)}`}
          checked={selected.includes(config.id)}
          onChange={(event) => onChange(toggle(selected, config.id, event.target.checked))}
        />
      ))}
      <p className="text-xs text-slate-500">{note}</p>
    </fieldset>
  );
}

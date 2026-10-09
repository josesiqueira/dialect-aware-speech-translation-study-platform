"use client";

/**
 * UI kit: every shared primitive and the building blocks of both shells, in
 * all states, for visual review against the reference application.
 * All values on this page are invented placeholders. No participant data.
 */

import { useState, useSyncExternalStore, type ReactNode } from "react";
import {
  AudioPlayer,
  Badge,
  BADGE_VARIANTS,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  ClearFiltersButton,
  ConfirmDialog,
  CopyableId,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  FilterDateInput,
  FilterSearch,
  FilterSelect,
  FormField,
  InlineMessage,
  KeyValueList,
  LikertScale,
  LinkButton,
  ListRowButton,
  LoadingState,
  MetricCard,
  PageHeading,
  Pagination,
  ProgressBar,
  RadioGroup,
  RefreshButton,
  SaveButton,
  SectionHeading,
  Select,
  Spinner,
  TextArea,
  TextInput,
  useUnsavedChangesGuard,
  type SaveStatus,
} from "@/components/ui";
import {
  EndParticipationButton,
  LanguageSwitcher,
  ModeBanner,
  ParticipantCard,
  ParticipantHeading,
  PreviewBanner,
  RecordingControlFrame,
  StepActions,
  type RecordingControlState,
} from "@/components/participant";
import { formatDateTime, formatDurationMs } from "@/lib/format";

/**
 * A short silent WAV as a blob: URL, so the audio players have a real source
 * without any recording. (The Content Security Policy allows blob: for media, not data:.)
 */
let silentWavUrl: string | null = null;

function createSilentWavUrl(): string {
  if (silentWavUrl) return silentWavUrl;
  const sampleRate = 8000;
  const samples = sampleRate; // one second, 8-bit mono
  const buffer = new ArrayBuffer(44 + samples);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeText(36, "data");
  view.setUint32(40, samples, true);
  new Uint8Array(buffer, 44).fill(128);
  silentWavUrl = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
  return silentWavUrl;
}

const subscribeToNothing = () => () => undefined;

/** null during server rendering and hydration, the blob: URL afterwards. */
function useSilentWavUrl(): string | null {
  return useSyncExternalStore(subscribeToNothing, createSilentWavUrl, () => null);
}

interface DemoRow {
  id: string;
  started: string;
  mode: "research" | "test" | "demo";
  utterances: number;
  durationMs: number;
  review: "verified" | "needs-review" | "incomplete";
}

const ROWS: DemoRow[] = [
  { id: "0f3a9c1e-placeholder-0001", started: "2026-10-01T08:12:00Z", mode: "research", utterances: 7, durationMs: 412000, review: "verified" },
  { id: "7b21d4aa-placeholder-0002", started: "2026-10-01T09:40:00Z", mode: "research", utterances: 7, durationMs: 388000, review: "needs-review" },
  { id: "c94e02f7-placeholder-0003", started: "2026-10-02T11:05:00Z", mode: "test", utterances: 3, durationMs: 95000, review: "incomplete" },
  { id: "e1d8b6c3-placeholder-0004", started: "2026-10-02T13:30:00Z", mode: "demo", utterances: 1, durationMs: 21000, review: "incomplete" },
];

const RECORDING_STATES: RecordingControlState[] = [
  "idle",
  "requesting_permission",
  "recording",
  "stopped",
  "uploading",
  "upload_failed",
  "error",
];

function KitSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-4">
        <h2 className="whitespace-nowrap text-base font-semibold text-slate-700">{title}</h2>
        <hr className="flex-1 border-slate-200" />
      </div>
      {children}
    </section>
  );
}

export function UiKit() {
  const [likert, setLikert] = useState<number | null>(4);
  const [radio, setRadio] = useState<string | null>("yes");
  const [format, setFormat] = useState<string | null>("csv");
  const [mode, setMode] = useState("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [page, setPage] = useState(2);
  const [selected, setSelected] = useState("a");
  const [dialog, setDialog] = useState<"none" | "simple" | "typed">("none");
  const [prompt, setPrompt] = useState("Translate the Finnish transcript into English.\nPreserve dialect features where possible.");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saving, setSaving] = useState(false);
  const [lang, setLang] = useState("fi");
  const [recordingState, setRecordingState] = useState<RecordingControlState>("recording");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const dirty = prompt !== "Translate the Finnish transcript into English.\nPreserve dialect features where possible.";
  useUnsavedChangesGuard(dirty);
  const silentWav = useSilentWavUrl();

  const filtersActive = mode !== "" || search !== "" || from !== "";

  return (
    <div className="min-h-screen bg-slate-50 text-sm text-slate-700">
      <main className="mx-auto max-w-6xl space-y-10 p-8">
        <PageHeading
          title="UI kit"
          description="Shared primitives and shell building blocks. Development only. All values are placeholders."
          actions={
            <RefreshButton
              onRefresh={() => setLastUpdated(new Date())}
              lastUpdated={lastUpdated}
              isAutoRefreshing={autoRefresh}
              onToggleAutoRefresh={setAutoRefresh}
            />
          }
        />

        <KitSection title="Buttons">
          <div className="flex flex-wrap items-center gap-3">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="danger">Danger</Button>
            <Button variant="ghost">Ghost</Button>
            <Button disabled>Disabled</Button>
            <Button loading loadingLabel="Saving...">
              Save
            </Button>
            <LinkButton href="/dev/ui-kit" variant="secondary">
              LinkButton
            </LinkButton>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="secondary">
              Edit
            </Button>
            <Button size="sm" variant="secondary">
              Cancel
            </Button>
            <Button size="sm">Save</Button>
            <Button size="lg">Continue (participant)</Button>
            <Button size="lg" variant="secondary">
              Back
            </Button>
            <Spinner label="Loading" />
          </div>
        </KitSection>

        <KitSection title="Badges">
          <div className="flex flex-wrap items-center gap-2">
            {BADGE_VARIANTS.map((variant) => (
              <Badge key={variant} variant={variant}>
                {variant === "test" ? "TEST" : variant === "demo" ? "DEMO" : variant}
              </Badge>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {BADGE_VARIANTS.map((variant) => (
              <Badge key={variant} variant={variant} size="sm">
                {variant === "test" ? "TEST" : variant === "demo" ? "DEMO" : variant}
              </Badge>
            ))}
          </div>
        </KitSection>

        <KitSection title="Metric cards">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-6">
            <MetricCard label="Sessions" value={128} subtitle="excluding TEST and DEMO" className="col-span-2" />
            <MetricCard density="compact" label="Completed" value="84%" subtitle="108 / 128" tooltip="Sessions where the participant reached the final screen." />
            <MetricCard density="compact" label="Flagged" value={3} accent="danger" />
            <MetricCard density="compact" label="Verified" value={412} accent="success" />
            <MetricCard density="compact" label="Audio" value={formatDurationMs(15_723_000)} subtitle="h:mm:ss" />
          </div>
        </KitSection>

        <KitSection title="Cards, headings, key values">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <SectionHeading title="Recent activity" aside="latest 10" />
              <KeyValueList
                items={[
                  { label: "Started", value: formatDateTime("2026-10-01T08:12:00Z", "Europe/Helsinki", { zone: true }) },
                  { label: "Protocol", value: "v3 (published)" },
                  { label: "Utterances", value: "7", mono: true },
                  { label: "Session", value: <CopyableId value="0f3a9c1e-placeholder-0001" label="session id" truncate={8} /> },
                ]}
              />
            </Card>
            <Card padding="none">
              <CardHeader
                title="Translation prompt"
                meta={
                  <>
                    <Badge variant="status">Active</Badge>
                    <span className="text-xs text-slate-500">v4 · 2026-09-28</span>
                  </>
                }
                actions={
                  <>
                    <Button size="sm" variant="secondary">
                      Cancel
                    </Button>
                    <SaveButton
                      size="sm"
                      isLoading={saving}
                      status={saveStatus}
                      onClick={() => {
                        setSaving(true);
                        setTimeout(() => {
                          setSaving(false);
                          setSaveStatus("saved");
                        }, 800);
                      }}
                    />
                  </>
                }
              />
              <CardBody>
                <FormField label="System prompt" help="Monospace for AI prompts. Editing marks the page as having unsaved changes.">
                  <TextArea mono rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
                </FormField>
              </CardBody>
            </Card>
          </div>
        </KitSection>

        <KitSection title="Form controls">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card className="space-y-4">
              <FormField label="Study name" required>
                <TextInput defaultValue="Dialect translation pilot" />
              </FormField>
              <FormField label="Contact email" help="Shown to participants on the information page." error="Enter a valid email address.">
                <TextInput type="email" defaultValue="researcher@" />
              </FormField>
              <FormField label="Model">
                <Select
                  placeholder="Select a model"
                  defaultValue="b"
                  options={[
                    { value: "a", label: "Model A" },
                    { value: "b", label: "Model B" },
                  ]}
                />
              </FormField>
              <FormField label="Disabled field">
                <TextInput disabled defaultValue="Published versions are read-only" />
              </FormField>
              <Checkbox label="Study active" description="Participants can start new sessions." defaultChecked />
              <RadioGroup
                label="Export format"
                layout="list"
                orientation="horizontal"
                value={format}
                onChange={setFormat}
                options={[
                  { value: "csv", label: "CSV" },
                  { value: "json", label: "JSON" },
                ]}
              />
            </Card>
            <ParticipantCard className="space-y-5">
              <h3 className="font-semibold text-slate-900">Questionnaire section (participant)</h3>
              <LikertScale
                label="How natural did the speaking task feel?"
                value={likert}
                onChange={setLikert}
                lowLabel="Not at all"
                highLabel="Completely"
              />
              <RadioGroup
                label="Do you speak a regional dialect at home?"
                layout="buttons"
                value={radio}
                onChange={setRadio}
                options={[
                  { value: "yes", label: "Yes" },
                  { value: "no", label: "No" },
                  { value: "unsure", label: "Not sure" },
                ]}
              />
              <FormField label="Anything you would like to add?">
                <TextArea inputSize="lg" rows={2} placeholder="Optional" />
              </FormField>
              <Checkbox density="participant" label="I have read the information and agree to take part." />
            </ParticipantCard>
          </div>
        </KitSection>

        <KitSection title="Messages and states">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <InlineMessage variant="success">Saved.</InlineMessage>
            <InlineMessage variant="error">Save failed. The server did not respond.</InlineMessage>
            <InlineMessage variant="info" title="Write prompts in English.">
              One prompt version covers every processing batch that references it.
            </InlineMessage>
            <InlineMessage variant="warning">This protocol has unpublished changes.</InlineMessage>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card padding="none" aria-busy="true">
              <LoadingState size="sm" />
            </Card>
            <Card padding="none">
              <EmptyState
                title="No sessions match the selected filters."
                action={<ClearFiltersButton onClick={() => undefined} />}
              />
            </Card>
            <Card padding="none">
              <ErrorState message="The session list could not be loaded." onRetry={() => undefined} />
            </Card>
          </div>
        </KitSection>

        <KitSection title="Filters, table, list rows, pagination">
          <FilterBar label="Session filters">
            <FilterSelect
              label="Filter by mode"
              value={mode}
              onChange={setMode}
              allLabel="All modes"
              options={[
                { value: "research", label: "Research" },
                { value: "test", label: "Test" },
                { value: "demo", label: "Demo" },
              ]}
            />
            <FilterSearch label="Search sessions" value={search} onChange={setSearch} placeholder="Search by id..." />
            <FilterDateInput label="From" value={from} onChange={setFrom} />
            <FilterDateInput label="To" value="" onChange={() => undefined} />
            {filtersActive && (
              <ClearFiltersButton
                onClick={() => {
                  setMode("");
                  setSearch("");
                  setFrom("");
                }}
              />
            )}
          </FilterBar>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_3fr]">
            <Card padding="none">
              <div className="divide-y divide-slate-100">
                {["a", "b", "c"].map((key, index) => (
                  <ListRowButton key={key} selected={selected === key} onClick={() => setSelected(key)}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Badge size="sm">Protocol v3</Badge>
                        {index === 1 && <Badge variant="test" size="sm">TEST</Badge>}
                        {index === 2 && <Badge variant="flagged" size="sm">Flagged</Badge>}
                      </div>
                      <span className="whitespace-nowrap text-xs text-slate-500 tabular-nums">2026-10-0{index + 1}</span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-slate-500">7 tasks · controlled and free speech</p>
                    <p className="mt-0.5 text-xs text-slate-500 tabular-nums">{7 - index} utterances</p>
                  </ListRowButton>
                ))}
              </div>
              <Pagination page={page} pageSize={20} total={128} onPageChange={setPage} itemLabel="sessions" />
            </Card>
            <DataTable
              caption="Placeholder sessions"
              rows={ROWS}
              getRowKey={(row) => row.id}
              selectedKey={ROWS[1]?.id}
              maxHeightClassName="max-h-64"
              columns={[
                { key: "id", header: "Session", rowHeader: true, cell: (row) => <CopyableId value={row.id} label="session id" truncate={8} /> },
                { key: "started", header: "Started", className: "tabular-nums whitespace-nowrap", cell: (row) => formatDateTime(row.started, "Europe/Helsinki") },
                {
                  key: "mode",
                  header: "Mode",
                  cell: (row) =>
                    row.mode === "test" ? <Badge variant="test" size="sm">TEST</Badge> : row.mode === "demo" ? <Badge variant="demo" size="sm">DEMO</Badge> : <Badge size="sm">Research</Badge>,
                },
                { key: "review", header: "Review", cell: (row) => <Badge variant={row.review} size="sm">{row.review === "needs-review" ? "Needs review" : row.review === "verified" ? "Verified" : "Incomplete"}</Badge> },
                { key: "utterances", header: "Utterances", align: "right", cell: (row) => row.utterances },
                { key: "duration", header: "Duration", align: "right", cell: (row) => formatDurationMs(row.durationMs) },
              ]}
            />
          </div>
        </KitSection>

        <KitSection title="Audio, progress, confirmation">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="space-y-4">
              {silentWav && (
                <AudioPlayer src={silentWav} type="audio/wav" label="Source recording" meta="00:01 · WAV" downloadHref={silentWav} />
              )}
              <ProgressBar value={2} max={7} label="Study progress" />
            </Card>
            <Card className="space-y-3">
              <p>Destructive actions ask for confirmation. Highly destructive actions ask for a typed phrase.</p>
              <div className="flex flex-wrap gap-3">
                <Button variant="secondary" onClick={() => setDialog("simple")}>
                  Exclude session
                </Button>
                <Button variant="danger" onClick={() => setDialog("typed")}>
                  Delete TEST data
                </Button>
              </div>
            </Card>
          </div>
          <ConfirmDialog
            open={dialog === "simple"}
            title="Exclude this session?"
            confirmLabel="Exclude session"
            onConfirm={() => setDialog("none")}
            onCancel={() => setDialog("none")}
          >
            <p>The session stays stored and is left out of research exports. You can include it again later.</p>
          </ConfirmDialog>
          <ConfirmDialog
            open={dialog === "typed"}
            tone="danger"
            title="Delete all TEST data?"
            confirmLabel="Delete TEST data"
            confirmPhrase="DELETE TEST DATA"
            onConfirm={() => setDialog("none")}
            onCancel={() => setDialog("none")}
          >
            <p>This removes every TEST session with its recordings. Research data is not affected. This cannot be undone.</p>
          </ConfirmDialog>
        </KitSection>

        <KitSection title="Participant building blocks">
          <div className="overflow-hidden rounded-lg border border-slate-200">
            <ModeBanner mode="TEST" className="static" />
            <ModeBanner mode="DEMO" className="static" />
            <PreviewBanner className="static">Protocol v4 draft</PreviewBanner>
          </div>
          <div className="rounded-lg border border-slate-200 bg-linear-to-b from-slate-50 to-white px-4 py-8">
            <div className="mx-auto max-w-2xl">
              <div className="mb-4 flex items-center justify-between">
                <EndParticipationButton />
                <LanguageSwitcher
                  languages={[
                    { code: "fi", label: "Suomi" },
                    { code: "en", label: "English" },
                  ]}
                  current={lang}
                  onChange={setLang}
                />
              </div>
              <div className="mb-6">
                <p className="mb-1.5 text-sm font-medium text-slate-500 tabular-nums">Task 2 of 7</p>
                <ProgressBar value={2} max={7} label="Task 2 of 7" />
              </div>
              <ParticipantHeading eyebrow="Controlled speaking task" title="Read the text aloud" />
              <div className="mb-4 flex flex-wrap justify-center gap-1">
                {RECORDING_STATES.map((state) => (
                  <Button
                    key={state}
                    size="sm"
                    variant={recordingState === state ? "primary" : "secondary"}
                    aria-pressed={recordingState === state}
                    onClick={() => setRecordingState(state)}
                  >
                    {state}
                  </Button>
                ))}
              </div>
              <RecordingControlFrame
                state={recordingState}
                prompt={<p className="text-lg leading-relaxed text-slate-800">Placeholder task text. The real text comes from the published protocol.</p>}
                elapsedMs={14_000}
                candidateUrl={silentWav}
                candidateType="audio/wav"
                candidateDurationMs={14_000}
                onStart={() => setRecordingState("recording")}
                onStop={() => setRecordingState("stopped")}
                onRecordAgain={() => setRecordingState("idle")}
                onSubmit={() => setRecordingState("uploading")}
                hint="Speak in the way you normally would."
              />
              <StepActions
                primary={<Button size="lg">Continue</Button>}
                secondary={
                  <Button size="lg" variant="secondary">
                    Back
                  </Button>
                }
              />
            </div>
          </div>
          <div className="flex justify-center rounded-lg border border-slate-200 bg-linear-to-b from-slate-50 to-white px-4 py-8">
            <ParticipantCard padding="lg" className="w-full max-w-md text-center">
              <h3 className="mb-4 text-2xl font-bold text-slate-900">Thank you</h3>
              <p className="text-slate-600">Your responses have been saved. You can close this page.</p>
            </ParticipantCard>
          </div>
        </KitSection>
      </main>
    </div>
  );
}

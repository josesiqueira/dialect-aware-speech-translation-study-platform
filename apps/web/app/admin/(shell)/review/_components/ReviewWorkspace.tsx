"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  STUDY_MODES,
  TASK_TYPES,
  TRANSCRIPT_TYPES,
  TRANSCRIPT_TYPE_LABELS,
  transcriptSchemas,
  type StudyMode,
} from "@dialect/domain";
import {
  Badge,
  Card,
  ClearFiltersButton,
  EmptyState,
  ErrorState,
  FilterBar,
  FilterSearch,
  FilterSelect,
  FormField,
  ListRowButton,
  LoadingState,
  PageHeading,
  Pagination,
  TextInput,
  confirmDiscardChanges,
  useUnsavedChangesGuard,
} from "@/components/ui";
import { formatDurationMs } from "@/lib/format";
import { STATUS_BADGE, STATUS_LABELS, TASK_TYPE_LABELS, shortUtteranceId } from "./labels";
import { ReviewScreen, type ReviewRowPatch } from "./ReviewScreen";
import { errorMessage, reviewApi } from "./reviewApi";
import { ShortcutLegend } from "./ShortcutLegend";
import { useStoredValue } from "./useStoredValue";

type QueueResponse = transcriptSchemas.ReviewQueueResponse;
type QueueRow = transcriptSchemas.ReviewQueueRow;

const ANNOTATOR_LABEL_KEY = "dialect.review.annotatorLabel";
const SHORTCUTS_KEY = "dialect.review.shortcuts";
const PAGE_SIZE = transcriptSchemas.REVIEW_QUEUE_DEFAULT_PAGE_SIZE;

const CONDITION_OPTIONS: { value: transcriptSchemas.ReviewQueueCondition; label: string }[] = [
  { value: "unreviewed", label: "Unreviewed" },
  { value: "b_missing", label: "B missing" },
  { value: "c_missing", label: "C missing" },
  { value: "a_star_missing", label: "A* missing" },
  { value: "needs_review", label: "Needs second review" },
  { value: "flagged", label: "Flagged" },
];

// The empty value is the default: research data only.
const MODE_OPTIONS = [
  { value: "test", label: "TEST data only" },
  { value: "demo", label: "DEMO data only" },
  { value: "all", label: "Research, TEST and DEMO" },
];

type Filters = {
  condition: string;
  taskType: string;
  protocolVersionId: string;
  mode: string;
  search: string;
  region: string;
};

const NO_FILTERS: Filters = { condition: "", taskType: "", protocolVersionId: "", mode: "", search: "", region: "" };

function queueQuery(filters: Filters, page: number): URLSearchParams {
  const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (filters.condition) query.set("condition", filters.condition);
  if (filters.taskType) query.set("taskType", filters.taskType);
  if (filters.protocolVersionId) query.set("protocolVersionId", filters.protocolVersionId);
  const modes: StudyMode[] = filters.mode === "all" ? [...STUDY_MODES] : filters.mode ? [filters.mode as StudyMode] : [];
  for (const mode of modes) query.append("mode", mode);
  if (filters.search.trim()) query.set("search", filters.search.trim());
  if (filters.region.trim()) query.set("region", filters.region.trim());
  return query;
}

// Waits until typing pauses before a text filter is sent to the server.
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function QueueRowContent({ row }: { row: QueueRow }) {
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-xs font-semibold text-slate-900">{row.participantCode}</span>
          <span className="font-mono text-xs text-slate-500">{shortUtteranceId(row.utteranceId)}</span>
          {row.mode === "test" && (
            <Badge variant="test" size="sm">
              TEST
            </Badge>
          )}
          {row.mode === "demo" && (
            <Badge variant="demo" size="sm">
              DEMO
            </Badge>
          )}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-slate-500">{formatDurationMs(row.durationMs)}</span>
      </div>
      <div className="mt-0.5 truncate text-xs text-slate-600">
        {TASK_TYPE_LABELS[row.taskType]}, {row.taskTitle}
        {row.turnIndex > 0 ? `, follow-up ${row.turnIndex}` : ""}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {TRANSCRIPT_TYPES.map((type) => {
          const state = row.transcripts[type];
          const letter = TRANSCRIPT_TYPE_LABELS[type];
          if (!state || !state.hasRevision) {
            return (
              <Badge key={type} size="sm" variant="incomplete">
                {letter} missing
              </Badge>
            );
          }
          // A is model output: it exists or not, it has no review status.
          if (type === "asr") {
            return (
              <Badge key={type} size="sm">
                {letter} present
              </Badge>
            );
          }
          return (
            <Badge key={type} size="sm" variant={STATUS_BADGE[state.status]}>
              {letter} {STATUS_LABELS[state.status]}
            </Badge>
          );
        })}
        {row.flagged && (
          <Badge size="sm" variant="flagged">
            Flagged
          </Badge>
        )}
        {row.utteranceStatus === "excluded" && (
          <Badge size="sm" variant="excluded">
            Excluded
          </Badge>
        )}
      </div>
    </>
  );
}

export interface ReviewWorkspaceProps {
  /** From /admin/review?utterance=<id>. */
  initialUtteranceId: string | null;
}

/** Review & Transcription: the queue on the left, the review screen on the right (spec 46). */
export function ReviewWorkspace({ initialUtteranceId }: ReviewWorkspaceProps) {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [page, setPage] = useState(1);
  const [reloadCount, setReloadCount] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(initialUtteranceId);
  const [isDirty, setIsDirty] = useState(false);
  const [annotatorLabel, setAnnotatorLabel] = useStoredValue(ANNOTATOR_LABEL_KEY, "");
  const [shortcutSetting, setShortcutSetting] = useStoredValue(SHORTCUTS_KEY, "on");
  const shortcutsEnabled = shortcutSetting !== "off";

  useUnsavedChangesGuard(isDirty);

  const search = useDebounced(filters.search, 300);
  const region = useDebounced(filters.region, 300);
  const queryString = useMemo(
    () => queueQuery({ ...filters, search, region }, page).toString(),
    [filters, search, region, page],
  );
  const requestKey = `${queryString}#${reloadCount}`;
  const [loaded, setLoaded] = useState<{ key: string; data?: QueueResponse; error?: string } | null>(null);
  // The last list that arrived stays visible while the next one loads.
  const [queue, setQueue] = useState<QueueResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    reviewApi
      .queue(new URLSearchParams(queryString), controller.signal)
      .then((data) => {
        setLoaded({ key: requestKey, data });
        setQueue(data);
        // A work queue opens on its first utterance unless one is already selected.
        setSelectedId((current) => current ?? data.rows[0]?.utteranceId ?? null);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoaded({ key: requestKey, error: errorMessage(error) });
      });
    return () => controller.abort();
  }, [queryString, requestKey]);

  // The selected utterance is part of the address, so other pages can link to it.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedId) url.searchParams.set("utterance", selectedId);
    else url.searchParams.delete("utterance");
    if (url.href !== window.location.href) window.history.replaceState(null, "", url);
  }, [selectedId]);

  const isLoading = loaded?.key !== requestKey;
  const loadError = !isLoading ? loaded?.error : undefined;
  const rows = useMemo(() => queue?.rows ?? [], [queue]);
  const selectedRow = rows.find((row) => row.utteranceId === selectedId) ?? null;
  const hasActiveFilters = Object.values(filters).some((value) => value !== "");

  const changeFilters = (patch: Partial<Filters>) => {
    setFilters((previous) => ({ ...previous, ...patch }));
    setPage(1);
  };

  const select = (utteranceId: string) => {
    if (utteranceId === selectedId) return;
    if (!confirmDiscardChanges(isDirty)) return;
    setIsDirty(false);
    setSelectedId(utteranceId);
  };

  const navigate = useCallback(
    (direction: "next" | "previous", options?: { saved?: boolean }) => {
      const targetId = direction === "next" ? selectedRow?.nextId : selectedRow?.previousId;
      if (!targetId) return;
      if (!options?.saved && !confirmDiscardChanges(isDirty)) return;
      setIsDirty(false);
      setSelectedId(targetId);
      // The neighbor is on another page of the queue: show that page.
      if (!rows.some((row) => row.utteranceId === targetId)) {
        setPage((current) => Math.max(1, current + (direction === "next" ? 1 : -1)));
      }
    },
    [selectedRow, rows, isDirty],
  );

  const applyRowPatch = useCallback((utteranceId: string, patch: ReviewRowPatch) => {
    setQueue((previous) =>
      previous
        ? { ...previous, rows: previous.rows.map((row) => (row.utteranceId === utteranceId ? { ...row, ...patch } : row)) }
        : previous,
    );
  }, []);

  return (
    <div className="space-y-4">
      <PageHeading
        title="Review & Transcription"
        description="Transcribe, correct and verify recorded utterances."
        actions={
          <FormField label="Annotator label" className="flex items-center gap-2 [&>label]:mb-0 [&>label]:whitespace-nowrap">
            <TextInput
              value={annotatorLabel}
              onChange={(event) => setAnnotatorLabel(event.target.value)}
              placeholder="for example annotator-1"
              maxLength={100}
              autoComplete="off"
              className="w-48 py-1.5"
            />
          </FormField>
        }
      />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(18rem,2fr)_3fr]">
        <div className="space-y-3">
          <FilterBar label="Review queue filters" className="gap-2">
            <FilterSelect
              label="Filter by review state"
              value={filters.condition}
              onChange={(condition) => changeFilters({ condition })}
              allLabel="All utterances"
              options={CONDITION_OPTIONS}
            />
            <FilterSelect
              label="Filter by task type"
              value={filters.taskType}
              onChange={(taskType) => changeFilters({ taskType })}
              allLabel="All task types"
              options={TASK_TYPES.map((type) => ({ value: type, label: TASK_TYPE_LABELS[type] }))}
            />
            <FilterSelect
              label="Filter by protocol version"
              value={filters.protocolVersionId}
              onChange={(protocolVersionId) => changeFilters({ protocolVersionId })}
              allLabel="All protocols"
              options={(queue?.protocolVersions ?? []).map((version) => ({
                value: version.id,
                label: `v${version.versionNumber} ${version.name}`,
              }))}
              className="max-w-44"
            />
            <FilterSelect
              label="Filter by data mode"
              value={filters.mode}
              onChange={(mode) => changeFilters({ mode })}
              allLabel="Research data"
              options={MODE_OPTIONS}
            />
            <FilterSearch
              label="Search transcript text, participant code or utterance id"
              value={filters.search}
              onChange={(value) => changeFilters({ search: value })}
              placeholder="Search transcripts..."
              className="w-44"
            />
            <FilterSearch
              label="Filter by region answer in the background questionnaire"
              value={filters.region}
              onChange={(value) => changeFilters({ region: value })}
              placeholder="Region answer..."
              className="w-36"
            />
            {hasActiveFilters && <ClearFiltersButton onClick={() => changeFilters(NO_FILTERS)} />}
          </FilterBar>

          <Card
            padding="none"
            className="flex flex-col lg:max-h-[calc(100vh-15rem)]"
            aria-busy={isLoading}
          >
            <div className="relative min-h-0 flex-1 overflow-y-auto">
              {loadError ? (
                <ErrorState
                  title="The review queue could not be loaded"
                  message={loadError}
                  onRetry={() => setReloadCount((count) => count + 1)}
                />
              ) : !queue ? (
                <LoadingState size="sm" label="Loading queue..." />
              ) : rows.length === 0 ? (
                <EmptyState
                  title={hasActiveFilters ? "No utterances match the selected filters." : "No utterances to review yet."}
                  description={
                    hasActiveFilters
                      ? undefined
                      : "Submitted recordings of research sessions appear here. TEST and DEMO recordings are shown through the data mode filter."
                  }
                  action={hasActiveFilters ? <ClearFiltersButton onClick={() => changeFilters(NO_FILTERS)} /> : undefined}
                />
              ) : (
                <ul className="divide-y divide-slate-100">
                  {rows.map((row) => (
                    <li key={row.utteranceId}>
                      <ListRowButton selected={row.utteranceId === selectedId} onClick={() => select(row.utteranceId)}>
                        <QueueRowContent row={row} />
                      </ListRowButton>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {queue && (
              <Pagination
                page={queue.page}
                pageSize={queue.pageSize}
                total={queue.total}
                onPageChange={setPage}
                itemLabel={queue.total === 1 ? "utterance" : "utterances"}
                disabled={isLoading}
              />
            )}
          </Card>

          <ShortcutLegend enabled={shortcutsEnabled} onEnabledChange={(enabled) => setShortcutSetting(enabled ? "on" : "off")} />
        </div>

        <Card padding="sm" className="relative lg:max-h-[calc(100vh-9.5rem)] lg:overflow-y-auto">
          {selectedId ? (
            <ReviewScreen
              utteranceId={selectedId}
              annotatorLabel={annotatorLabel}
              shortcutsEnabled={shortcutsEnabled}
              hasPrevious={Boolean(selectedRow?.previousId)}
              hasNext={Boolean(selectedRow?.nextId)}
              onNavigate={navigate}
              onDirtyChange={setIsDirty}
              onRowChange={applyRowPatch}
            />
          ) : (
            <EmptyState title="Select an utterance from the queue." />
          )}
        </Card>
      </div>
    </div>
  );
}

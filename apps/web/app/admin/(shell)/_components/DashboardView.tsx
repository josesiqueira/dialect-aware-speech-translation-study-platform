"use client";

import { useEffect, useState } from "react";
import type { corpusSchemas } from "@dialect/domain";
import {
  Card,
  ErrorState,
  InlineMessage,
  LoadingState,
  MetricCard,
  PageHeading,
  RefreshButton,
  SectionHeading,
  overlineLabel,
} from "@/components/ui";
import { formatCount, formatCountOf, formatDurationMs } from "@/lib/format";
import { ModeBadge } from "./badges";
import { DailyChart } from "./DailyChart";
import { RecentActivity } from "./RecentActivity";
import { StatusCard } from "./StatusCard";
import { useApiResource } from "./useApiResource";

const AUTO_REFRESH_SECONDS = 10;

/** Large first card: participants started, with today's sessions below (the reference HeroCard). */
function HeroCard({ dashboard }: { dashboard: corpusSchemas.Dashboard }) {
  const days = dashboard.sessionsPerDay;
  const yesterday = days.length >= 2 ? (days[days.length - 2]?.research ?? 0) : 0;
  return (
    <article className="col-span-2 row-span-2 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <p className={overlineLabel}>Participants started</p>
      <p className="mt-2 font-mono text-5xl font-semibold tabular-nums text-slate-900">
        {formatCount(dashboard.participants.started)}
      </p>
      <p className="mt-1 text-xs text-slate-500">research sessions since the start of the study</p>
      <div className="mt-4 border-t border-slate-100 pt-4">
        <p className={overlineLabel}>Sessions today</p>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="font-mono text-2xl font-semibold tabular-nums text-slate-900">{dashboard.sessionsToday}</span>
          <span className="text-xs tabular-nums text-slate-500">{yesterday} yesterday</span>
        </div>
      </div>
    </article>
  );
}

function OtherModes({ otherModes }: { otherModes: corpusSchemas.Dashboard["otherModes"] }) {
  const line = (counts: corpusSchemas.ModeCounts) =>
    `${formatCountOf(counts.sessions, "session")}, ${counts.completed} completed, ${formatCountOf(counts.utterances, "utterance")}`;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-slate-500">
      <span>Not included in the numbers above:</span>
      <span className="inline-flex items-center gap-1.5">
        <ModeBadge mode="demo" /> {line(otherModes.demo)}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <ModeBadge mode="test" /> {line(otherModes.test)}
      </span>
    </p>
  );
}

/**
 * Operational study health (spec 42, 154). This page shows collection and
 * processing status only. It never shows a comparison of translation
 * conditions or any other outcome of the research hypothesis.
 */
export function DashboardView() {
  const resource = useApiResource<corpusSchemas.Dashboard>("/api/admin/dashboard");
  const { data: dashboard, reload } = resource;
  const [autoRefresh, setAutoRefresh] = useState(false);
  // The clock used for "3 minutes ago". It moves with every refresh and every 10 seconds.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
      if (autoRefresh) void reload();
    }, AUTO_REFRESH_SECONDS * 1000);
    return () => clearInterval(id);
  }, [autoRefresh, reload]);

  const heading = (
    <PageHeading
      title="Dashboard"
      description="Operational study health: collection, review and processing status."
      actions={
        <RefreshButton
          onRefresh={reload}
          lastUpdated={resource.loadedAt}
          error={dashboard ? resource.error : null}
          isAutoRefreshing={autoRefresh}
          onToggleAutoRefresh={setAutoRefresh}
          autoRefreshSeconds={AUTO_REFRESH_SECONDS}
        />
      }
    />
  );

  if (!dashboard) {
    return (
      <div className="space-y-6" aria-busy={resource.loading}>
        {heading}
        {resource.error ? (
          <Card padding="sm">
            <ErrorState message={resource.error} onRetry={() => void reload()} />
          </Card>
        ) : (
          <LoadingState />
        )}
      </div>
    );
  }

  const { participants, processingErrors, flagged } = dashboard;
  const completionRate =
    participants.completionRate === null ? "n/a" : `${Math.round(participants.completionRate * 100)}%`;

  return (
    <div className="space-y-6">
      {heading}

      {dashboard.status.exampleText.present && (
        <InlineMessage variant="warning" announce="none" title="Example text in the current protocol">
          {dashboard.status.exampleText.message} Open Settings for the list of texts to replace.
        </InlineMessage>
      )}

      <div className="space-y-3">
        {/* The hero card takes two columns, so every second metric card can be in the last column
            (two, four or six columns). Those open their tooltip to the left (tooltipAlign="end"):
            a centered tooltip there reaches past the page and adds a horizontal scrollbar. */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-6">
          <HeroCard dashboard={dashboard} />
          <MetricCard
            density="compact"
            label="Consented"
            value={formatCount(participants.consented)}
            subtitle={`of ${formatCount(participants.started)} started`}
            tooltip="Research sessions in which the participant accepted the consent form."
          />
          <MetricCard
            density="compact"
            label="Completed"
            tooltipAlign="end"
            value={formatCount(participants.completed)}
            subtitle={`${participants.abandoned} abandoned, ${participants.withdrawn} withdrawn`}
            tooltip="Research sessions that reached the final page. Abandoned: no activity until the inactivity timeout. Withdrawn: the participant ended participation."
          />
          <MetricCard
            density="compact"
            label="Completion rate"
            value={completionRate}
            subtitle={`${participants.inProgress} in progress`}
            tooltip="Completed research sessions divided by started research sessions."
          />
          <MetricCard
            density="compact"
            label="Utterances"
            tooltipAlign="end"
            value={formatCount(dashboard.utterancesSubmitted)}
            subtitle="submitted recordings"
            tooltip="Research utterances with an accepted recording, including utterances that were later excluded from analysis."
          />
          <MetricCard
            density="compact"
            label="Source audio"
            value={formatDurationMs(dashboard.sourceAudioDurationMs)}
            subtitle="total duration"
            tooltip="Sum of the durations of all submitted research recordings."
          />
          <MetricCard
            density="compact"
            label="Awaiting review"
            tooltipAlign="end"
            value={formatCount(dashboard.awaitingTranscriptionReview)}
            subtitle="no verified B or C yet"
            tooltip="Submitted research utterances that lack a verified dialect transcript (B) or a verified normalized transcript (C)."
          />
          <MetricCard
            density="compact"
            label="Processing errors"
            value={formatCount(processingErrors.total)}
            accent={processingErrors.total > 0 ? "danger" : "default"}
            subtitle={`${formatCountOf(processingErrors.failedJobs, "job")}, ${formatCountOf(processingErrors.failedModelRuns, "model run")}`}
            tooltip="Failed jobs, and failed model runs that have no later successful retry. All data modes."
          />
          <MetricCard
            density="compact"
            label="Flagged"
            tooltipAlign="end"
            value={`${flagged.sessions} / ${flagged.utterances}`}
            accent={flagged.sessions + flagged.utterances > 0 ? "danger" : "default"}
            subtitle="sessions / utterances"
            tooltip="Research sessions and utterances flagged for review. A flag does not exclude anything."
          />
        </div>
        <OtherModes otherModes={dashboard.otherModes} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <StatusCard dashboard={dashboard} now={now} />
        <Card as="section" aria-labelledby="recent-heading">
          <SectionHeading id="recent-heading" title="Recent activity" aside="latest 5 of each kind" />
          <RecentActivity recent={dashboard.recent} now={now} />
        </Card>
      </div>

      <Card as="section" aria-labelledby="daily-heading">
        <SectionHeading
          id="daily-heading"
          title={`Research sessions per day (last ${formatCountOf(dashboard.sessionsPerDay.length, "day")})`}
          aside={`Days in ${dashboard.adminTimezone}`}
        />
        <DailyChart days={dashboard.sessionsPerDay} />
      </Card>
    </div>
  );
}

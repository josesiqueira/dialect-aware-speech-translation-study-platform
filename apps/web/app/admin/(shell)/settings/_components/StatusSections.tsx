"use client";

import { useState, type ReactNode } from "react";
import type { corpusSchemas } from "@dialect/domain";
import { Badge, Button, Card, CardBody, CardHeader, InlineMessage, KeyValueList } from "@/components/ui";
import { apiFetch } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import { errorMessage } from "../../_components/useApiResource";

type Settings = corpusSchemas.SettingsView;

function Health({ ok, okLabel, failLabel }: { ok: boolean; okLabel: string; failLabel: string }) {
  return <Badge variant={ok ? "status" : "error"}>{ok ? okLabel : failLabel}</Badge>;
}

function Section({ title, meta, description, actions, children }: { title: string; meta?: ReactNode; description?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <Card padding="none" as="section">
      <CardHeader title={title} meta={meta} description={description} actions={actions} />
      <CardBody>{children}</CardBody>
    </Card>
  );
}

function ProviderSection({ settings, onChanged }: { settings: Settings; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<corpusSchemas.ProviderTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { provider, adminTimezone } = settings;

  async function test() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await apiFetch<corpusSchemas.ProviderTestResult>("/api/admin/settings/provider-test", { method: "POST" }));
      await onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="AI provider"
      meta={<Badge variant={provider.openaiConfigured ? "status" : "incomplete"}>{provider.openaiConfigured ? "Configured" : "Not configured"}</Badge>}
      description="The API key stays on the server and is never shown. Recording works without it."
      actions={
        <Button size="sm" variant="secondary" onClick={test} loading={busy} loadingLabel="Testing...">
          Test connection
        </Button>
      }
    >
      <KeyValueList
        columns={1}
        items={[
          {
            label: "OpenAI API key",
            value: provider.openaiConfigured ? "Configured on the server" : "Not configured (set the OpenAI key variable in the server environment, see .env.example)",
          },
          {
            label: "Providers",
            mono: true,
            value: provider.providers.map((entry) => `${entry.name}: ${entry.configured ? "available" : "not configured"}`).join(", "),
          },
          {
            label: "Last test",
            value: provider.lastTest ? (
              <span>
                <span className="tabular-nums">{formatDateTime(provider.lastTest.at, adminTimezone, { zone: true })}</span>,{" "}
                {provider.lastTest.ok ? "succeeded" : "failed"}
                {provider.lastTest.message ? `: ${provider.lastTest.message}` : ""}
              </span>
            ) : (
              "Never tested"
            ),
          },
        ]}
      />
      {result && (
        <InlineMessage variant={result.ok ? "success" : "warning"} className="mt-3">
          {result.message}
          {result.latencyMs !== null && <span className="tabular-nums"> ({result.latencyMs} ms)</span>}
        </InlineMessage>
      )}
      {error && (
        <InlineMessage variant="error" className="mt-3">
          {error}
        </InlineMessage>
      )}
      <p className="mt-3 text-xs text-slate-500">
        The test lists the available models. It checks the network path and the key and generates no model output. It
        runs only when this button is pressed, never from a health check.
      </p>
    </Section>
  );
}

/** Read-only technical status: database, media storage, AI provider and application. */
export function StatusSections({ settings, onChanged }: { settings: Settings; onChanged: () => Promise<void> }) {
  const { database, storage, application, adminTimezone } = settings;
  const migrations = database.migrations;
  return (
    <>
      <Section
        title="Database"
        meta={<Health ok={database.connected} okLabel="Connected" failLabel="Not reachable" />}
      >
        <KeyValueList
          columns={1}
          items={[
            {
              label: "Migration status",
              value: (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <Badge variant={migrations.status === "up_to_date" ? "status" : migrations.status === "pending" ? "warning" : "neutral"}>
                    {migrations.status === "up_to_date" ? "Up to date" : migrations.status === "pending" ? "Migrations pending" : "Unknown"}
                  </Badge>
                  <span className="tabular-nums">
                    {migrations.applied} applied{migrations.expected !== null ? ` of ${migrations.expected}` : ""}
                  </span>
                </span>
              ),
            },
            { label: "Latest applied", mono: true, value: migrations.latestApplied ?? "not known" },
            ...(migrations.pending.length > 0 ? [{ label: "Pending", mono: true, value: migrations.pending.join(", ") }] : []),
          ]}
        />
        {migrations.detail && (
          <InlineMessage variant="warning" announce="none" className="mt-3">
            {migrations.detail}
          </InlineMessage>
        )}
      </Section>

      <Section
        title="Media storage"
        meta={<Health ok={storage.connected} okLabel="Accessible" failLabel="Not accessible" />}
        description="Audio files are private. They are reachable only through the signed-in admin routes."
      >
        <KeyValueList
          columns={1}
          items={[
            { label: "Driver", mono: true, value: storage.driver },
            { label: storage.driver === "s3" ? "Bucket" : "Path", mono: true, value: storage.location ?? "not known" },
            { label: "Connectivity", value: storage.connected ? "Readable and writable" : (storage.detail ?? "The storage check failed") },
            {
              label: "ffmpeg",
              value: storage.ffmpeg.available ? (
                <span className="font-mono text-xs">
                  ffmpeg {storage.ffmpeg.ffmpegVersion}, ffprobe {storage.ffmpeg.ffprobeVersion}
                </span>
              ) : (
                "Not installed. Compressed recordings cannot be validated or converted to WAV."
              ),
            },
          ]}
        />
      </Section>

      <ProviderSection settings={settings} onChanged={onChanged} />

      <Section
        title="Application"
        meta={<Health ok={application.worker.healthy} okLabel="Worker healthy" failLabel="Worker not running" />}
      >
        <KeyValueList
          columns={1}
          items={[
            { label: "App version", mono: true, value: application.appVersion },
            { label: "Git commit", mono: true, value: application.gitCommitSha ?? "not set" },
            { label: "Environment", mono: true, value: application.environment },
            {
              label: "Worker status",
              value:
                application.worker.workers.length === 0 ? (
                  "No worker has reported yet. Background processing does not run."
                ) : (
                  <ul className="space-y-0.5">
                    {application.worker.workers.map((worker) => (
                      <li key={worker.workerId} className="font-mono text-xs tabular-nums">
                        {worker.workerId}: {worker.state}, last heartbeat {formatDateTime(worker.lastSeenAt, adminTimezone, { seconds: true })}
                      </li>
                    ))}
                  </ul>
                ),
            },
            {
              label: "Job queue",
              mono: true,
              value: `${application.queue.queued} waiting, ${application.queue.running} running, ${application.queue.failed} failed`,
            },
          ]}
        />
      </Section>
    </>
  );
}

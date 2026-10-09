"use client";

import { useState } from "react";
import type { corpusSchemas } from "@dialect/domain";
import { Badge, Button, Checkbox, ConfirmDialog, InlineMessage } from "@/components/ui";
import { apiFetch } from "@/lib/client/api";
import { formatCountOf } from "@/lib/format";
import { errorMessage } from "../../_components/useApiResource";

type Mode = corpusSchemas.ResettableMode;

/**
 * The only destructive action on this page, kept apart from the routine
 * controls (spec 116). It deletes TEST and DEMO data. Research data cannot be
 * selected here or anywhere else.
 */
export function DangerZone({ settings, onChanged }: { settings: corpusSchemas.SettingsView; onChanged: () => Promise<void> }) {
  const { allowed, phrase, counts } = settings.testDataReset;
  const [modes, setModes] = useState<Record<Mode, boolean>>({ test: true, demo: true });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<corpusSchemas.ResetTestDataResult | null>(null);
  const selected = (Object.keys(modes) as Mode[]).filter((mode) => modes[mode]);
  const names = selected.map((mode) => mode.toUpperCase()).join(" and ");

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch<corpusSchemas.ResetTestDataResult>("/api/admin/settings/reset-test-data", {
        method: "POST",
        body: { modes: selected, confirmationPhrase: phrase },
      });
      setResult(response);
      setOpen(false);
      await onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="danger-heading" className="mt-10 border-t border-slate-200 pt-8">
      <div className="rounded-lg border border-rose-200 bg-white shadow-sm">
        <div className="border-b border-rose-100 px-6 py-4">
          <h2 id="danger-heading" className="text-base font-semibold text-rose-700">
            Danger zone
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">This action cannot be undone. It never touches research data.</p>
        </div>
        <div className="space-y-4 px-6 py-5">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Delete TEST and DEMO data</h3>
            <p className="mt-1 text-sm text-slate-600">
              Removes the sessions of the chosen modes with their recordings, transcripts, questionnaire answers and
              outputs, and the processing batches of those modes. Protocols, prompts, model configurations and the
              audit log stay.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Checkbox
              label={
                <span className="inline-flex items-center gap-2">
                  <Badge variant="test" size="sm">
                    TEST
                  </Badge>
                  <span className="tabular-nums">{formatCountOf(counts.testSessions, "session")}</span>
                </span>
              }
              checked={modes.test}
              onChange={(event) => setModes({ ...modes, test: event.target.checked })}
            />
            <Checkbox
              label={
                <span className="inline-flex items-center gap-2">
                  <Badge variant="demo" size="sm">
                    DEMO
                  </Badge>
                  <span className="tabular-nums">{formatCountOf(counts.demoSessions, "session")}</span>
                </span>
              }
              checked={modes.demo}
              onChange={(event) => setModes({ ...modes, demo: event.target.checked })}
            />
          </div>
          {!allowed && (
            <InlineMessage variant="info" announce="none">
              This action is disabled in production. An operator can allow it with ALLOW_TEST_DATA_RESET=true.
            </InlineMessage>
          )}
          {result && (
            <InlineMessage variant="success">
              Deleted {formatCountOf(result.deleted.sessions ?? 0, "session")},{" "}
              {formatCountOf(result.deleted.utterances ?? 0, "utterance")} and{" "}
              {formatCountOf(result.storageObjectsRemoved, "file")}.
              {result.storageObjectsFailed > 0 &&
                ` ${formatCountOf(result.storageObjectsFailed, "file")} could not be removed from storage.`}
            </InlineMessage>
          )}
          <Button
            variant="danger"
            disabled={!allowed || selected.length === 0}
            onClick={() => {
              setError(null);
              setOpen(true);
            }}
          >
            Delete {names || "TEST and DEMO"} data...
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={open}
        tone="danger"
        title={`Delete all ${names} data?`}
        confirmLabel={`Delete ${names} data`}
        confirmPhrase={phrase}
        busy={busy}
        busyLabel="Deleting..."
        error={error}
        onConfirm={() => void confirm()}
        onCancel={() => setOpen(false)}
      >
        <p>
          Every {names} session is deleted together with its recordings and all derived data. This cannot be undone.
        </p>
        <p>Research sessions are not affected.</p>
      </ConfirmDialog>
    </section>
  );
}

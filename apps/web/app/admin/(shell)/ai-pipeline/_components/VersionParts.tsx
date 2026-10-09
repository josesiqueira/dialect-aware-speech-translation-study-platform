"use client";

import { useEffect, useState } from "react";
import { Badge, Button, ConfirmDialog, InlineMessage, LoadingState, Select, tableClasses } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { compareVersions, errorMessage, type Kind } from "./api";
import { DiffView } from "./DiffView";
import type { ConfigDiff, PromptDiff } from "./types";

/** The fields prompt versions and model configs have in common. */
export type VersionRow = {
  id: string;
  key: string;
  versionNumber: number;
  status: "draft" | "active" | "retired";
  createdAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
  createdByLabel: string | null;
};

export function StatusBadge({ status }: { status: VersionRow["status"] }) {
  if (status === "active") return <Badge variant="status">Active</Badge>;
  if (status === "draft") return <Badge variant="incomplete">Draft</Badge>;
  return <Badge variant="neutral">Retired</Badge>;
}

/** "v2 · activated 2026-10-03 14:05 · created by admin" */
export function VersionMeta({ version, timeZone }: { version: VersionRow; timeZone: string }) {
  const parts = [`v${version.versionNumber}`];
  if (version.status === "active" && version.activatedAt) {
    parts.push(`activated ${formatDateTime(version.activatedAt, timeZone)}`);
  } else if (version.status === "retired" && version.retiredAt) {
    parts.push(`retired ${formatDateTime(version.retiredAt, timeZone)}`);
  } else {
    parts.push(`created ${formatDateTime(version.createdAt, timeZone)}`);
  }
  if (version.createdByLabel) parts.push(`created by ${version.createdByLabel}`);
  return <span className="text-xs text-slate-500 tabular-nums">{parts.join(" · ")}</span>;
}

/** Runs one request at a time for a block and keeps its error. */
export function useAction(reload: () => Promise<void>) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(name: string, action: () => Promise<void>): Promise<boolean> {
    setPending(name);
    setError(null);
    try {
      await action();
      await reload();
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setPending(null);
    }
  }

  return { pending, error, setError, run };
}

export interface ActivateDialogProps {
  kind: Kind;
  /** What is being activated, for example "prompt" or "model configuration". */
  noun: string;
  draft: VersionRow;
  active: VersionRow | null;
  /** Extra plain statements for this kind of version. */
  notes?: string[];
  onActivate: () => Promise<boolean>;
  onClose: () => void;
}

/**
 * Confirmation before a draft becomes the active version. Shows the difference
 * between the active version and the draft (spec 142). Mounted only while open.
 */
export function ActivateDialog({ kind, noun, draft, active, notes = [], onActivate, onClose }: ActivateDialogProps) {
  const [diff, setDiff] = useState<PromptDiff | ConfigDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const activeId = active?.id ?? null;

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    compareVersions(kind, activeId, draft.id).then(
      (result) => {
        if (!cancelled) setDiff(result);
      },
      (caught) => {
        if (!cancelled) setDiffError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [kind, activeId, draft.id]);

  return (
    <ConfirmDialog
      open
      title={`Activate ${draft.key} v${draft.versionNumber}?`}
      confirmLabel={`Activate v${draft.versionNumber}`}
      busy={busy}
      busyLabel="Activating..."
      error={failed ? "The activation failed. The reason is shown in the section." : undefined}
      onCancel={onClose}
      onConfirm={async () => {
        setBusy(true);
        setFailed(false);
        const ok = await onActivate();
        setBusy(false);
        if (ok) onClose();
        else setFailed(true);
      }}
    >
      <p>
        Version {draft.versionNumber} becomes the active {noun} for <span className="font-mono">{draft.key}</span>.{" "}
        {active
          ? `Version ${active.versionNumber} is retired and stays stored unchanged.`
          : "This key has no active version at the moment."}
      </p>
      <p>
        Existing model runs and existing batches are not changed. They keep the version they were created with.
      </p>
      {notes.map((note) => (
        <p key={note}>{note}</p>
      ))}
      {active &&
        (diff ? (
          <DiffView diff={diff} />
        ) : diffError ? (
          <InlineMessage variant="error">{diffError}</InlineMessage>
        ) : (
          <LoadingState size="inline" label="Loading the difference..." />
        ))}
    </ConfirmDialog>
  );
}

export interface VersionHistoryProps {
  kind: Kind;
  versions: VersionRow[];
  timeZone: string;
  /** Disables the row actions while an editor is open or a request runs. */
  disabled: boolean;
  onClone: (version: VersionRow) => void;
  onRetire: (version: VersionRow) => void;
}

/** Collapsed list of every version of a key, with Clone, Retire and Compare versions. */
export function VersionHistory({ kind, versions, timeZone, disabled, onClone, onRetire }: VersionHistoryProps) {
  const hasDraft = versions.some((version) => version.status === "draft");
  // Until the researcher picks versions, compare the second newest with the newest one.
  const [a, setA] = useState<string | null>(null);
  const [b, setB] = useState<string | null>(null);
  const [diff, setDiff] = useState<PromptDiff | ConfigDiff | null>(null);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ids = new Set(versions.map((version) => version.id));
  const selectedA = a !== null && ids.has(a) ? a : (versions[1]?.id ?? "");
  const selectedB = b !== null && ids.has(b) ? b : (versions[0]?.id ?? "");
  const options = versions.map((version) => ({
    value: version.id,
    label: `v${version.versionNumber} (${version.status})`,
  }));

  async function compare() {
    setComparing(true);
    setError(null);
    setDiff(null);
    try {
      setDiff(await compareVersions(kind, selectedA, selectedB));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setComparing(false);
    }
  }

  return (
    <details className="group mt-4 rounded-lg border border-slate-200">
      <summary className="cursor-pointer rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-none">
        Version history and comparison
        <span className="ml-2 text-xs font-normal text-slate-500 tabular-nums">
          {versions.length} {versions.length === 1 ? "version" : "versions"}
        </span>
      </summary>
      <div className="space-y-4 border-t border-slate-200 px-3 py-3">
        <div className="relative overflow-x-auto">
          <table className={tableClasses.table}>
            <caption className="sr-only">Versions of {versions[0]?.key}</caption>
            <thead>
              <tr>
                {["Version", "Status", "Created", "Activated", "Retired", "Created by", "Actions"].map((heading) => (
                  <th key={heading} scope="col" className={tableClasses.th}>
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={tableClasses.tbody}>
              {versions.map((version) => (
                <tr key={version.id}>
                  <th scope="row" className={`${tableClasses.td} font-mono font-medium tabular-nums`}>
                    v{version.versionNumber}
                  </th>
                  <td className={tableClasses.td}>
                    <StatusBadge status={version.status} />
                  </td>
                  <td className={`${tableClasses.td} tabular-nums`}>{formatDateTime(version.createdAt, timeZone)}</td>
                  <td className={`${tableClasses.td} tabular-nums`}>
                    {version.activatedAt ? formatDateTime(version.activatedAt, timeZone) : "Never"}
                  </td>
                  <td className={`${tableClasses.td} tabular-nums`}>
                    {version.retiredAt ? formatDateTime(version.retiredAt, timeZone) : "No"}
                  </td>
                  <td className={tableClasses.td}>{version.createdByLabel ?? "Seed or system"}</td>
                  <td className={tableClasses.td}>
                    <div className="flex flex-wrap gap-2">
                      {version.status !== "draft" && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={disabled || hasDraft}
                          title={hasDraft ? "A draft already exists. Edit, activate or delete it first." : undefined}
                          onClick={() => onClone(version)}
                        >
                          Clone as draft
                        </Button>
                      )}
                      {version.status === "active" && (
                        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onRetire(version)}>
                          Retire
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-slate-700">Compare versions</p>
          {versions.length < 2 ? (
            <p className="text-xs text-slate-500">There is only one version, so there is nothing to compare yet.</p>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs text-slate-600">
                From
                <Select
                  className="mt-1 w-40"
                  value={selectedA}
                  options={options}
                  onChange={(event) => setA(event.target.value)}
                />
              </label>
              <label className="text-xs text-slate-600">
                To
                <Select
                  className="mt-1 w-40"
                  value={selectedB}
                  options={options}
                  onChange={(event) => setB(event.target.value)}
                />
              </label>
              <Button size="sm" variant="secondary" loading={comparing} loadingLabel="Comparing..." onClick={compare}>
                Compare versions
              </Button>
            </div>
          )}
          {error && (
            <InlineMessage variant="error" className="mt-3">
              {error}
            </InlineMessage>
          )}
          {diff && (
            <div className="mt-3">
              <DiffView diff={diff} />
            </div>
          )}
        </div>
      </div>
    </details>
  );
}

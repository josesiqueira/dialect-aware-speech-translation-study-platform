"use client";

import { useCallback, useState } from "react";
import { protocolSchemas } from "@dialect/domain";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DataTable,
  FormField,
  InlineMessage,
  LinkButton,
  PageHeading,
  TextInput,
  confirmDiscardChanges,
  useUnsavedChangesGuard,
  type BadgeVariant,
} from "@/components/ui";
import { isApiClientError } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import {
  cloneProtocol,
  createDraft,
  deleteDraft,
  errorMessage,
  fetchDiff,
  fetchOverview,
  fetchProtocol,
  retireProtocol,
} from "./api";
import { DiffView } from "./DiffView";
import { DirtyContext } from "./EditorCard";
import { ProtocolEditor, type Mutate } from "./ProtocolEditor";
import { PublishReview } from "./PublishReview";
import { protocolLabel, type Overview, type ProtocolDetail, type ProtocolDiff, type ProtocolSummary } from "./types";

const STATUS_BADGE: Record<ProtocolSummary["status"], { variant: BadgeVariant; label: string }> = {
  draft: { variant: "incomplete", label: "Draft" },
  published: { variant: "status", label: "Published" },
  retired: { variant: "neutral", label: "Retired" },
};

export function StatusBadge({ status }: { status: ProtocolSummary["status"] }) {
  return <Badge variant={STATUS_BADGE[status].variant}>{STATUS_BADGE[status].label}</Badge>;
}

type Confirm = { kind: "retire" | "delete"; version: ProtocolSummary };

export interface StudyFlowClientProps {
  initialOverview: Overview;
  /** The version shown first: the draft when there is one, otherwise the current version. */
  initialDetail: ProtocolDetail | null;
  /** IANA time zone for timestamps, from the study settings. */
  timeZone: string;
}

export function StudyFlowClient({ initialOverview, initialDetail, timeZone }: StudyFlowClientProps) {
  const [overview, setOverview] = useState(initialOverview);
  const [detail, setDetail] = useState(initialDetail);
  const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<string>>(new Set());
  const [reviewOpen, setReviewOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [comparison, setComparison] = useState<ProtocolDiff | null>(null);
  const [newName, setNewName] = useState("");

  const anyDirty = dirtyKeys.size > 0;
  useUnsavedChangesGuard(anyDirty);
  const reportDirty = useCallback((key: string, dirty: boolean) => {
    setDirtyKeys((previous) => {
      if (previous.has(key) === dirty) return previous;
      const next = new Set(previous);
      if (dirty) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const versions = overview.protocols;
  const current = versions.find((version) => version.isCurrent) ?? null;
  const draft = versions.find((version) => version.status === "draft") ?? null;
  const viewed = detail ? (versions.find((version) => version.id === detail.protocol.id) ?? null) : null;
  const editable = detail?.protocol.status === "draft";
  const time = (value: string | null) => (value ? formatDateTime(value, timeZone) : "");

  async function refreshOverview(): Promise<Overview | null> {
    try {
      const next = await fetchOverview();
      setOverview(next);
      return next;
    } catch (caught) {
      setError(errorMessage(caught));
      return null;
    }
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function show(next: ProtocolDetail | null) {
    setDetail(next);
    setReviewOpen(false);
    setConflict(false);
    setDirtyKeys(new Set());
  }

  async function view(id: string) {
    if (!confirmDiscardChanges(anyDirty)) return;
    await run(async () => show(await fetchProtocol(id)));
  }

  const mutate: Mutate = async (change) => {
    if (!detail) return;
    try {
      setDetail(await change(detail.protocol.updatedAt));
      setNotice(null);
      void refreshOverview();
    } catch (caught) {
      if (isApiClientError(caught) && caught.code === "CONFLICT" && (caught.details as { currentUpdatedAt?: string } | undefined)?.currentUpdatedAt) {
        setConflict(true);
      }
      throw caught;
    }
  };

  async function clone(sourceId: string) {
    if (!confirmDiscardChanges(anyDirty)) return;
    await run(async () => {
      const created = await cloneProtocol(sourceId);
      show(created);
      await refreshOverview();
      setNotice(`${protocolLabel(created.protocol)} was created as a draft. Edit it below, preview it, then publish it.`);
    });
  }

  async function createEmptyDraft() {
    const name = newName.trim();
    if (!name) {
      setError("Enter a name for the new protocol.");
      return;
    }
    await run(async () => {
      const created = await createDraft(name);
      show(created);
      setNewName("");
      await refreshOverview();
    });
  }

  async function confirmAction() {
    if (!confirm) return;
    setBusy(true);
    setConfirmError(null);
    try {
      if (confirm.kind === "retire") {
        const retired = await retireProtocol(confirm.version.id);
        if (detail?.protocol.id === retired.protocol.id) setDetail(retired);
        await refreshOverview();
        setNotice(`${protocolLabel(confirm.version)} was retired.`);
      } else {
        await deleteDraft(confirm.version.id);
        const next = await refreshOverview();
        if (detail?.protocol.id === confirm.version.id) {
          const fallback = next?.currentProtocolVersionId ?? next?.protocols[0]?.id ?? null;
          show(fallback ? await fetchProtocol(fallback) : null);
        }
        setNotice(`The draft ${protocolLabel(confirm.version)} was deleted.`);
      }
      setConfirm(null);
    } catch (caught) {
      setConfirmError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function compare(version: ProtocolSummary) {
    const previous = versions
      .filter((candidate) => candidate.versionNumber < version.versionNumber)
      .sort((a, b) => b.versionNumber - a.versionNumber)[0];
    await run(async () => setComparison(await fetchDiff(version.id, previous?.id ?? null)));
  }

  async function onPublished(publishedId: string) {
    setReviewOpen(false);
    await run(async () => {
      show(await fetchProtocol(publishedId));
      const next = await refreshOverview();
      const published = next?.protocols.find((version) => version.id === publishedId);
      setNotice(
        `${published ? protocolLabel(published) : "The protocol"} is published. New sessions use it from now on. Sessions that already started stay on their version.`,
      );
    });
  }

  return (
    <DirtyContext.Provider value={reportDirty}>
      <div className="space-y-6">
        <PageHeading
          title="Study Flow"
          description={`What participants see, in versions. A published version never changes: clone it, edit the draft, preview it and publish it. Times are shown in ${timeZone}.`}
        />

        {/* Status: which version is live, which is being edited, and the three main actions. */}
        <Card as="section" aria-label="Protocol status">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <dl className="space-y-2 text-sm">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <dt className="w-20 text-slate-500">Published:</dt>
                <dd className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {current ? (
                    <>
                      <span className="text-base font-semibold text-slate-900">{protocolLabel(current)}</span>
                      <span className="text-slate-700">{current.name}</span>
                      <span className="text-slate-500 tabular-nums">published {time(current.publishedAt)}</span>
                    </>
                  ) : (
                    <span className="text-slate-700">Nothing is published yet. Participants cannot start a session.</span>
                  )}
                </dd>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <dt className="w-20 text-slate-500">Draft:</dt>
                <dd className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {draft ? (
                    <>
                      <span className="text-base font-semibold text-slate-900">{protocolLabel(draft)}</span>
                      <span className="text-slate-700">{draft.name}</span>
                      <span className="text-slate-500 tabular-nums">last saved {time(draft.updatedAt)}</span>
                    </>
                  ) : (
                    <span className="text-slate-700">
                      No draft. {current ? "Clone the published version to change the study." : "Create a first draft below."}
                    </span>
                  )}
                </dd>
              </div>
            </dl>
            <div className="flex flex-wrap items-center gap-2">
              {detail && (
                <LinkButton
                  href={`/admin/preview/${detail.protocol.id}`}
                  target="_blank"
                  rel="noopener"
                  variant="secondary"
                  size="sm"
                >
                  Preview participant study (v{detail.protocol.versionNumber})
                </LinkButton>
              )}
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || !current || draft !== null}
                title={draft ? `A draft already exists (${protocolLabel(draft)}). Only one draft exists at a time.` : undefined}
                onClick={() => current && clone(current.id)}
              >
                Clone published version to new draft
              </Button>
              <Button
                size="sm"
                disabled={busy || !draft}
                onClick={() =>
                  run(async () => {
                    if (draft && detail?.protocol.id !== draft.id) setDetail(await fetchProtocol(draft.id));
                    setReviewOpen(true);
                  })
                }
              >
                Publish draft
              </Button>
            </div>
          </div>
        </Card>

        {error && <InlineMessage variant="error">{error}</InlineMessage>}
        {notice && <InlineMessage variant="success">{notice}</InlineMessage>}

        {versions.length === 0 && (
          <Card padding="none" as="section" aria-label="Create the first protocol">
            <CardHeader title="Create the first protocol" description="Starts an empty draft, Protocol v1." />
            <CardBody className="flex flex-wrap items-end gap-3">
              <FormField label="Name" className="w-full max-w-md">
                <TextInput
                  value={newName}
                  maxLength={protocolSchemas.MAX_NAME_LENGTH}
                  onChange={(event) => setNewName(event.target.value)}
                />
              </FormField>
              <Button disabled={busy} onClick={createEmptyDraft}>
                Create draft
              </Button>
            </CardBody>
          </Card>
        )}

        {reviewOpen && detail && editable && (
          <PublishReview
            draft={detail}
            currentVersionNumber={current?.versionNumber ?? null}
            hasUnsavedChanges={anyDirty}
            onClose={() => setReviewOpen(false)}
            onPublished={onPublished}
          />
        )}

        {versions.length > 0 && (
          <Card padding="none" as="section" aria-label="Version history">
            <CardHeader
              title="Version history"
              description="Every version stays readable. Sessions keep the version they started with."
            />
            <DataTable<ProtocolSummary>
              caption="Protocol versions, newest first"
              className="rounded-none border-0"
              rows={versions}
              getRowKey={(version) => version.id}
              selectedKey={detail?.protocol.id ?? null}
              columns={[
                {
                  key: "version",
                  header: "Version",
                  rowHeader: true,
                  cell: (version) => <span className="font-medium text-slate-900">{protocolLabel(version)}</span>,
                },
                { key: "name", header: "Name", cell: (version) => version.name },
                {
                  key: "status",
                  header: "Status",
                  cell: (version) => (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <StatusBadge status={version.status} />
                      {version.isCurrent && <Badge variant="neutral">Current for new sessions</Badge>}
                    </span>
                  ),
                },
                {
                  key: "published",
                  header: "Published",
                  className: "tabular-nums whitespace-nowrap",
                  cell: (version) => time(version.publishedAt) || <span className="text-slate-600">Not published</span>,
                },
                {
                  key: "tasks",
                  header: "Tasks",
                  align: "right",
                  cell: (version) => `${version.enabledTaskCount} of ${version.taskCount}`,
                },
                { key: "sessions", header: "Sessions", align: "right", cell: (version) => version.sessionCount },
                {
                  key: "actions",
                  header: "Actions",
                  cell: (version) => (
                    <span className="flex flex-wrap gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="px-2 py-0.5"
                        disabled={busy}
                        aria-label={`${version.status === "draft" ? "Edit" : "View"} ${protocolLabel(version)}`}
                        aria-current={detail?.protocol.id === version.id ? "true" : undefined}
                        onClick={() => view(version.id)}
                      >
                        {version.status === "draft" ? "Edit" : "View"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="px-2 py-0.5"
                        disabled={busy}
                        aria-label={`Show what changed in ${protocolLabel(version)}`}
                        onClick={() => compare(version)}
                      >
                        Changes
                      </Button>
                      {version.status === "published" && !version.isCurrent && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="px-2 py-0.5"
                          disabled={busy}
                          aria-label={`Retire ${protocolLabel(version)}`}
                          onClick={() => {
                            setConfirmError(null);
                            setConfirm({ kind: "retire", version });
                          }}
                        >
                          Retire
                        </Button>
                      )}
                      {version.status === "draft" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="px-2 py-0.5 text-rose-700 hover:bg-rose-50 hover:text-rose-700"
                          disabled={busy}
                          aria-label={`Delete draft ${protocolLabel(version)}`}
                          onClick={() => {
                            setConfirmError(null);
                            setConfirm({ kind: "delete", version });
                          }}
                        >
                          Delete draft
                        </Button>
                      )}
                    </span>
                  ),
                },
              ]}
            />
            {comparison && (
              <div className="space-y-3 border-t border-slate-200 px-6 py-5">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-base font-semibold text-slate-900">
                    What changed in Protocol v{comparison.to.versionNumber}
                  </h3>
                  <Button size="sm" variant="secondary" onClick={() => setComparison(null)}>
                    Close
                  </Button>
                </div>
                <DiffView diff={comparison} />
              </div>
            )}
          </Card>
        )}

        {conflict && detail && (
          <InlineMessage variant="warning" title="This draft was changed somewhere else">
            <p>
              Another window or another person saved this draft after you loaded it, so your save was refused. Reload
              the draft to see the latest state. Edits that are still open on this page stay in their forms, so you can
              copy them before saving again.
            </p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  setDetail(await fetchProtocol(detail.protocol.id));
                  setConflict(false);
                  await refreshOverview();
                })
              }
            >
              Reload draft
            </Button>
          </InlineMessage>
        )}

        {detail && (
          <section aria-label={`${protocolLabel(detail.protocol)} content`} className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-lg font-semibold text-slate-900">
                {editable ? "Editing" : "Viewing"} {protocolLabel(detail.protocol)}
              </h2>
              <StatusBadge status={detail.protocol.status} />
              {detail.protocol.isCurrent && <Badge variant="neutral">Current for new sessions</Badge>}
              {viewed && viewed.sessionCount > 0 && (
                <span className="text-sm text-slate-500 tabular-nums">
                  {viewed.sessionCount} session{viewed.sessionCount === 1 ? "" : "s"} used this version
                </span>
              )}
            </div>

            {!editable && (
              <InlineMessage variant="info" announce="none">
                <p>
                  {protocolLabel(detail.protocol)} is {detail.protocol.status}
                  {detail.protocol.publishedAt ? ` (published ${time(detail.protocol.publishedAt)})` : ""}. Published
                  versions cannot be edited, so that every session can be traced to the exact texts and tasks it used.
                  To change the study, clone a version to a new draft, edit the draft and publish it.
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {draft ? (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => view(draft.id)}>
                      Open the draft {protocolLabel(draft)}
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => clone(detail.protocol.id)}>
                      Clone to new draft
                    </Button>
                  )}
                </div>
              </InlineMessage>
            )}

            <ProtocolEditor
              key={detail.protocol.id}
              detail={detail}
              editable={editable}
              options={overview.options}
              mutate={mutate}
              timeZone={timeZone}
            />
          </section>
        )}

        <ConfirmDialog
          open={confirm !== null}
          tone="danger"
          title={
            confirm?.kind === "retire"
              ? `Retire ${protocolLabel(confirm.version)}?`
              : confirm
                ? `Delete the draft ${protocolLabel(confirm.version)}?`
                : ""
          }
          confirmLabel={confirm?.kind === "retire" ? "Retire version" : "Delete draft"}
          busy={busy}
          error={confirmError}
          onConfirm={confirmAction}
          onCancel={() => setConfirm(null)}
        >
          {confirm?.kind === "retire" && (
            <>
              <p>
                The version is marked as retired and can no longer become the current protocol. This cannot be undone.
              </p>
              <p>
                Its {confirm.version.sessionCount} session{confirm.version.sessionCount === 1 ? "" : "s"} and all
                recordings stay linked to it and stay readable.
              </p>
            </>
          )}
          {confirm?.kind === "delete" && (
            <p>
              The draft, its {confirm.version.taskCount} task{confirm.version.taskCount === 1 ? "" : "s"} and their
              follow-ups are deleted. This cannot be undone. Published versions are not affected.
            </p>
          )}
        </ConfirmDialog>
      </div>
    </DirtyContext.Provider>
  );
}

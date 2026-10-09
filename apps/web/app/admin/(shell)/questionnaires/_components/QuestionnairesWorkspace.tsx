"use client";

// The Questionnaires admin page (spec 55): questionnaires by key with their
// versions on the left, the selected version on the right (read-only when
// published or retired, the editor when it is a draft).
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { questionnaireSchemas as s } from "@dialect/domain";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  FormField,
  InlineMessage,
  ListRowButton,
  LoadingState,
  PageHeading,
  TextInput,
  confirmDiscardChanges,
  useUnsavedChangesGuard,
} from "@/components/ui";
import { formatDate } from "@/lib/format";
import { errorMessage, questionnaireApi } from "./api";
import { DraftEditor } from "./DraftEditor";
import { STATUS_BADGES, STATUS_LABELS } from "./model";
import { VersionReadOnly } from "./VersionReadOnly";

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: s.ListQuestionnairesResponse };

type DetailState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; version: s.QuestionnaireVersionDetail };

export function QuestionnairesWorkspace() {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({ status: "none" });
  const [isDirty, setIsDirty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useUnsavedChangesGuard(isDirty);

  const loadList = useCallback(async (): Promise<s.ListQuestionnairesResponse | null> => {
    try {
      const data = await questionnaireApi.list();
      setList({ status: "ready", data });
      return data;
    } catch (error) {
      setList({ status: "error", message: errorMessage(error) });
      return null;
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetail({ status: "loading" });
    try {
      setDetail({ status: "ready", version: await questionnaireApi.get(id) });
    } catch (error) {
      setDetail({ status: "error", message: errorMessage(error) });
    }
  }, []);

  // First load: the list, then the newest version of the first questionnaire.
  useEffect(() => {
    let cancelled = false;
    void questionnaireApi.list().then(
      (data) => {
        if (cancelled) return;
        setList({ status: "ready", data });
        const first = data.questionnaires[0]?.versions[0];
        if (first) void loadDetail(first.id);
      },
      (error: unknown) => {
        if (!cancelled) setList({ status: "error", message: errorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loadDetail]);

  function select(id: string) {
    if (id === selectedId) return;
    if (!confirmDiscardChanges(isDirty)) return;
    setIsDirty(false);
    setNotice(null);
    void loadDetail(id);
  }

  // After a change on the server: show the returned version and refresh the list.
  function show(version: s.QuestionnaireVersionDetail, message: string | null) {
    setIsDirty(false);
    setSelectedId(version.id);
    setDetail({ status: "ready", version });
    setNotice(message);
    void loadList();
  }

  async function afterDelete() {
    setIsDirty(false);
    setNotice("The draft was deleted.");
    setSelectedId(null);
    setDetail({ status: "none" });
    await loadList();
  }

  const timeZone = list.status === "ready" ? list.data.adminTimezone : "Europe/Helsinki";

  return (
    <div className="space-y-6">
      <PageHeading
        title="Questionnaires"
        description="Versioned research instruments shown to participants: edit a draft, preview it and publish it."
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              if (!creating && !confirmDiscardChanges(isDirty)) return;
              setCreating(!creating);
            }}
          >
            {creating ? "Cancel" : "New questionnaire"}
          </Button>
        }
      />

      <InlineMessage variant="info" announce="none" title="Questionnaires are research instruments">
        <ul className="list-disc space-y-0.5 pl-5">
          <li>They are collected after the speech tasks, so that the questions do not prime how participants speak.</li>
          <li>
            Add only variables with a defined research purpose. Do not ask for a full name, home address, personal
            identity code or email address.
          </li>
          <li>
            A published version is immutable. Publishing a new version does not change any protocol: a protocol draft
            on the Study Flow page must select it.
          </li>
        </ul>
      </InlineMessage>

      {creating && (
        <NewQuestionnaireForm
          existingKeys={list.status === "ready" ? list.data.questionnaires.map((group) => group.key) : []}
          onCreated={(version) => {
            setCreating(false);
            show(version, `Created the draft ${version.key} v${version.versionNumber}.`);
          }}
        />
      )}

      {notice && <InlineMessage variant="success">{notice}</InlineMessage>}

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(16rem,1fr)_3fr]">
        <Card padding="none" as="section" aria-label="Questionnaires and versions" aria-busy={list.status === "loading"}>
          {list.status === "loading" && <LoadingState />}
          {list.status === "error" && <ErrorState message={list.message} onRetry={() => void loadList()} />}
          {list.status === "ready" && list.data.questionnaires.length === 0 && (
            <EmptyState title="No questionnaires yet." description="Use New questionnaire to create the first draft." />
          )}
          {list.status === "ready" &&
            list.data.questionnaires.map((group) => (
              <div key={group.key} className="border-b border-slate-100 last:border-b-0">
                <div className="px-3 pt-3 pb-1">
                  <h2 className="font-mono text-sm font-semibold text-slate-900">{group.key}</h2>
                  <p className="truncate text-xs text-slate-500">{group.versions[0]?.name}</p>
                </div>
                <div className="divide-y divide-slate-100">
                  {group.versions.map((version) => (
                    <ListRowButton key={version.id} selected={version.id === selectedId} onClick={() => select(version.id)}>
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-slate-900 tabular-nums">v{version.versionNumber}</span>
                        <Badge size="sm" variant={STATUS_BADGES[version.status]}>
                          {STATUS_LABELS[version.status]}
                        </Badge>
                      </span>
                      <span className="mt-0.5 block text-xs text-slate-500 tabular-nums">
                        {version.itemCount} {version.itemCount === 1 ? "item" : "items"},{" "}
                        {version.publishedAt
                          ? `published ${formatDate(version.publishedAt, timeZone)}`
                          : `created ${formatDate(version.createdAt, timeZone)}`}
                      </span>
                    </ListRowButton>
                  ))}
                </div>
              </div>
            ))}
        </Card>

        <div className="min-w-0" aria-busy={detail.status === "loading"}>
          {detail.status === "none" && (
            <Card>
              <EmptyState title="Select a version to see it." />
            </Card>
          )}
          {detail.status === "loading" && (
            <Card>
              <LoadingState />
            </Card>
          )}
          {detail.status === "error" && (
            <Card>
              <ErrorState message={detail.message} onRetry={selectedId ? () => void loadDetail(selectedId) : undefined} />
            </Card>
          )}
          {detail.status === "ready" &&
            (detail.version.status === "draft" ? (
              <DraftEditor
                key={detail.version.id}
                version={detail.version}
                onSaved={() => {
                  setNotice(null);
                  void loadList();
                }}
                onPublished={(version) =>
                  show(version, `Published ${version.key} v${version.versionNumber}. Select it in a protocol draft to use it.`)
                }
                onDeleted={() => void afterDelete()}
                onDirtyChange={setIsDirty}
              />
            ) : (
              <VersionReadOnly
                key={detail.version.id}
                version={detail.version}
                timeZone={timeZone}
                onCloned={(draft) => show(draft, `Created the draft ${draft.key} v${draft.versionNumber} from v${detail.version.versionNumber}.`)}
                onRetired={(version) => show(version, `Retired ${version.key} v${version.versionNumber}.`)}
              />
            ))}
        </div>
      </div>
    </div>
  );
}

function NewQuestionnaireForm({
  existingKeys,
  onCreated,
}: {
  existingKeys: string[];
  onCreated: (version: s.QuestionnaireVersionDetail) => void;
}) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ key?: string; name?: string }>({});

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = s.createDraftBodySchema.safeParse({ key, name });
    if (!parsed.success) {
      const next: { key?: string; name?: string } = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if ((field === "key" || field === "name") && !next[field]) next[field] = issue.message;
      }
      setFieldErrors(next);
      return;
    }
    setFieldErrors({});
    setBusy(true);
    setError(null);
    try {
      onCreated(await questionnaireApi.create(parsed.data));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const isNewKey = key.trim() !== "" && !existingKeys.includes(key.trim());

  return (
    <Card padding="none">
      <form onSubmit={submit} noValidate>
        <CardHeader
          title="New questionnaire draft"
          description="Creates an empty draft. For a new version of an existing questionnaire, open its latest version and use Clone to new draft."
          actions={
            <Button type="submit" size="sm" loading={busy} loadingLabel="Creating...">
              Create draft
            </Button>
          }
        />
        <CardBody className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <FormField
              label="Key"
              help="Identifies the questionnaire across versions, for example source_speaker_evaluation. Lower case letters, digits and underscores."
              error={fieldErrors.key}
              required
            >
              <TextInput mono value={key} onChange={(event) => setKey(event.target.value)} spellCheck={false} autoComplete="off" />
            </FormField>
            <FormField label="Name" help="Shown to researchers in lists." error={fieldErrors.name} required>
              <TextInput value={name} onChange={(event) => setName(event.target.value)} />
            </FormField>
          </div>
          {isNewKey && s.QUESTIONNAIRE_KEY_PATTERN.test(key.trim()) && (
            <p className="text-xs text-slate-500">
              The participant flow shows the questionnaires that a protocol selects as background and post-recording
              questionnaire. A questionnaire under another key is stored and versioned here for later use.
            </p>
          )}
          {error && <InlineMessage variant="error">{error}</InlineMessage>}
        </CardBody>
      </form>
    </Card>
  );
}

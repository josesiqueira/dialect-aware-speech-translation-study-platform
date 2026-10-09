"use client";

// Editor of one draft questionnaire version: name, description, ordered items,
// Save with inline status, Preview, Publish (with the difference against the
// previous published version) and Delete draft.
import { useEffect, useMemo, useState } from "react";
import { questionnaireSchemas as s, STUDY_TEXT_LOCALE_NAMES, STUDY_TEXT_TRANSLATION_LOCALES } from "@dialect/domain";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  FormField,
  InlineMessage,
  LoadingState,
  SaveButton,
  SectionHeading,
  TextArea,
  TextInput,
  type SaveStatus,
} from "@/components/ui";
import { errorMessage, questionnaireApi } from "./api";
import { DiffSummary } from "./DiffSummary";
import { ItemEditor } from "./ItemEditor";
import { findSaveProblems, newEditorItem, toEditorDraft, toItemView, toSaveBody, type EditorDraft, type EditorItem } from "./model";
import { QuestionnairePreview } from "./QuestionnairePreview";

export interface DraftEditorProps {
  version: s.QuestionnaireVersionDetail;
  onSaved: (version: s.QuestionnaireVersionDetail) => void;
  onPublished: (version: s.QuestionnaireVersionDetail) => void;
  onDeleted: () => void;
  onDirtyChange: (dirty: boolean) => void;
}

const snapshot = (draft: EditorDraft): string => JSON.stringify(toSaveBody(draft));

export function DraftEditor({ version, onSaved, onPublished, onDeleted, onDirtyChange }: DraftEditorProps) {
  const [draft, setDraft] = useState<EditorDraft>(() => toEditorDraft(version));
  const [baseline, setBaseline] = useState(() => snapshot(toEditorDraft(version)));
  const [openUid, setOpenUid] = useState<string | null>(null);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showSaveProblems, setShowSaveProblems] = useState(false);
  const [publish, setPublish] = useState<{ diff: s.QuestionnaireDiff | null; busy: boolean; error: string | null } | null>(null);
  const [remove, setRemove] = useState<{ busy: boolean; error: string | null } | null>(null);

  const isDirty = snapshot(draft) !== baseline;
  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  const itemViews = useMemo(() => draft.items.map(toItemView), [draft.items]);
  const saveProblems = useMemo(() => findSaveProblems(draft), [draft]);
  const publishProblems = useMemo(() => s.findPublishProblems(itemViews), [itemViews]);
  const label = `${version.key} v${version.versionNumber}`;

  function change(next: EditorDraft) {
    setDraft(next);
    setSaveStatus("idle");
    setSaveError(null);
  }

  function changeItem(uid: string, item: EditorItem) {
    change({ ...draft, items: draft.items.map((other) => (other.uid === uid ? item : other)) });
  }

  function moveItem(index: number, direction: "up" | "down") {
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= draft.items.length) return;
    const items = [...draft.items];
    [items[index], items[target]] = [items[target]!, items[index]!];
    change({ ...draft, items });
  }

  function addItem() {
    const item = newEditorItem();
    change({ ...draft, items: [...draft.items, item] });
    setOpenUid(item.uid);
  }

  async function save() {
    if (Object.keys(saveProblems).length > 0) {
      setShowSaveProblems(true);
      const firstInvalid = draft.items.find((item) => saveProblems[item.uid]);
      if (firstInvalid) setOpenUid(firstInvalid.uid);
      setSaveStatus("error");
      setSaveError("Correct the marked fields first.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await questionnaireApi.save(version.id, toSaveBody(draft));
      const next = toEditorDraft(saved);
      // Keep the same item open: the saved copy has new editor ids.
      const openIndex = draft.items.findIndex((item) => item.uid === openUid);
      setDraft(next);
      setBaseline(snapshot(next));
      setOpenUid(openIndex >= 0 ? (next.items[openIndex]?.uid ?? null) : null);
      setShowSaveProblems(false);
      setSaveStatus("saved");
      onSaved(saved);
    } catch (error) {
      setSaveStatus("error");
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function openPublish() {
    setPublish({ diff: null, busy: false, error: null });
    try {
      const diff = await questionnaireApi.diff(version.id);
      setPublish((current) => current && { ...current, diff });
    } catch (error) {
      setPublish((current) => current && { ...current, error: errorMessage(error) });
    }
  }

  async function confirmPublish() {
    setPublish((current) => current && { ...current, busy: true, error: null });
    try {
      const published = await questionnaireApi.publish(version.id);
      setPublish(null);
      onPublished(published);
    } catch (error) {
      setPublish((current) => current && { ...current, busy: false, error: errorMessage(error) });
    }
  }

  async function confirmRemove() {
    setRemove({ busy: true, error: null });
    try {
      await questionnaireApi.remove(version.id);
      setRemove(null);
      onDeleted();
    } catch (error) {
      setRemove({ busy: false, error: errorMessage(error) });
    }
  }

  const canPublish = !isDirty && !saving && publishProblems.length === 0;

  return (
    <Card padding="none">
      <CardHeader
        title={<span className="font-mono">{label}</span>}
        meta={<Badge variant="needs-review">Draft</Badge>}
        description={isDirty ? "Unsaved changes" : "All changes saved"}
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={() => setMode(mode === "edit" ? "preview" : "edit")}>
              {mode === "edit" ? "Preview" : "Back to editor"}
            </Button>
            <Button size="sm" variant="secondary" onClick={openPublish} disabled={!canPublish}>
              Publish
            </Button>
            <SaveButton
              size="sm"
              isLoading={saving}
              onClick={save}
              disabled={!isDirty}
              status={saveStatus}
              statusMessage={saveStatus === "error" ? (saveError ?? undefined) : undefined}
            />
          </>
        }
      />

      {mode === "preview" ? (
        <CardBody>
          <QuestionnairePreview
            name={draft.name}
            description={draft.description.trim() || null}
            items={itemViews}
            versionLabel={`${label} (draft${isDirty ? ", with unsaved changes" : ""})`}
          />
        </CardBody>
      ) : (
        <CardBody className="space-y-6">
          <div className="grid grid-cols-1 gap-4">
            <FormField label="Name" error={showSaveProblems ? saveProblems[""] : undefined} required>
              <TextInput value={draft.name} onChange={(event) => change({ ...draft, name: event.target.value })} disabled={saving} />
            </FormField>
            <FormField label="Description" help="Optional. Shown to researchers, and under the title in the preview.">
              <TextArea
                rows={2}
                value={draft.description}
                onChange={(event) => change({ ...draft, description: event.target.value })}
                disabled={saving}
              />
            </FormField>
            {STUDY_TEXT_TRANSLATION_LOCALES.map((locale) => {
              const language = STUDY_TEXT_LOCALE_NAMES[locale] ?? locale;
              const texts = draft.translations[locale] ?? { name: "", description: "" };
              const setText = (field: "name" | "description", value: string) =>
                change({ ...draft, translations: { ...draft.translations, [locale]: { ...texts, [field]: value } } });
              return (
                <div key={locale} className="grid grid-cols-1 gap-4">
                  <FormField
                    label={`${language} name (${locale})`}
                    help="The questionnaire heading for participants who choose this language. Empty: the English name."
                  >
                    <TextInput
                      lang={locale}
                      value={texts.name}
                      onChange={(event) => setText("name", event.target.value)}
                      disabled={saving}
                    />
                  </FormField>
                  <FormField label={`${language} description (${locale})`} help="Optional.">
                    <TextArea
                      lang={locale}
                      rows={2}
                      value={texts.description}
                      onChange={(event) => setText("description", event.target.value)}
                      disabled={saving}
                    />
                  </FormField>
                </div>
              );
            })}
          </div>

          <section aria-labelledby={`items-heading-${version.id}`}>
            <SectionHeading
              id={`items-heading-${version.id}`}
              title="Items"
              description="Participants see the items in this order."
              aside={`${draft.items.length} ${draft.items.length === 1 ? "item" : "items"}`}
            />
            {draft.items.length === 0 ? (
              <EmptyState
                className="rounded-lg border border-dashed border-slate-300"
                title="This draft has no items yet."
                action={
                  <Button size="sm" onClick={addItem}>
                    Add item
                  </Button>
                }
              />
            ) : (
              <>
                <ol className="space-y-2">
                  {draft.items.map((item, index) => (
                    <ItemEditor
                      key={item.uid}
                      item={item}
                      index={index}
                      count={draft.items.length}
                      open={openUid === item.uid}
                      keyError={showSaveProblems ? saveProblems[item.uid] : undefined}
                      disabled={saving}
                      onToggle={() => setOpenUid(openUid === item.uid ? null : item.uid)}
                      onChange={(next) => changeItem(item.uid, next)}
                      onMove={(direction) => moveItem(index, direction)}
                      onRemove={() => change({ ...draft, items: draft.items.filter((other) => other.uid !== item.uid) })}
                    />
                  ))}
                </ol>
                <div className="mt-3">
                  <Button size="sm" variant="secondary" onClick={addItem} disabled={saving}>
                    Add item
                  </Button>
                </div>
              </>
            )}
          </section>

          {publishProblems.length > 0 && (
            <InlineMessage variant="info" announce="none" title="Needed before this version can be published">
              <ul className="list-disc space-y-0.5 pl-5">
                {publishProblems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </InlineMessage>
          )}
          {publishProblems.length === 0 && isDirty && (
            <p className="text-sm text-slate-500">Save the draft to enable Publish.</p>
          )}

          <div className="flex justify-end border-t border-slate-100 pt-4">
            <Button
              size="sm"
              variant="ghost"
              className="text-rose-700 hover:bg-rose-50 hover:text-rose-700"
              onClick={() => setRemove({ busy: false, error: null })}
              disabled={saving}
            >
              Delete draft
            </Button>
          </div>
        </CardBody>
      )}

      <ConfirmDialog
        open={publish !== null}
        title={`Publish ${label}?`}
        confirmLabel="Publish version"
        busy={publish?.busy}
        busyLabel="Publishing..."
        error={publish?.error}
        onConfirm={confirmPublish}
        onCancel={() => setPublish(null)}
      >
        {publish?.diff ? <DiffSummary diff={publish.diff} /> : !publish?.error && <LoadingState size="inline" label="Loading the differences..." />}
        <p>
          <strong className="font-semibold text-slate-900">A published version is immutable.</strong> Its name and items
          can no longer be edited or deleted. A later change is made by cloning it as a new draft.
        </p>
        <p>
          Publishing does not change any protocol. To use this version, select it in a protocol draft on the Study Flow
          page and publish that protocol.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={remove !== null}
        title={`Delete the draft ${label}?`}
        tone="danger"
        confirmLabel="Delete draft"
        busy={remove?.busy}
        busyLabel="Deleting..."
        error={remove?.error}
        onConfirm={confirmRemove}
        onCancel={() => setRemove(null)}
      >
        <p>
          The draft and its {draft.items.length} {draft.items.length === 1 ? "item" : "items"} are removed. This cannot
          be undone. Published versions are not affected.
        </p>
      </ConfirmDialog>
    </Card>
  );
}

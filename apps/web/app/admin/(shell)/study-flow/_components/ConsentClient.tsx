"use client";

import { useCallback, useState } from "react";
import {
  keyedTranslationOf,
  protocolSchemas,
  STUDY_TEXT_TRANSLATION_LOCALES,
  translationOf,
  withTranslation,
  type ConsentTranslations,
} from "@dialect/domain";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FormField,
  InlineMessage,
  LinkButton,
  PageHeading,
  TextArea,
  TextInput,
  confirmDiscardChanges,
  useUnsavedChangesGuard,
} from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import {
  cloneConsent,
  createConsent,
  deleteConsent,
  errorMessage,
  fetchConsents,
  publishConsent,
  updateConsent,
} from "./api";
import { DirtyContext, EditorCard, ProseView } from "./EditorCard";
import { localeLabel } from "./ProtocolEditor";
import type { ConsentVersion } from "./types";

type Item = ConsentVersion["itemsJson"][number];
/** An item while editing, with its text per translation locale. */
type ItemDraft = Item & { translations: Record<string, string> };

/** Per translation locale: the stored text of one field. */
function translationsFor(stored: unknown, field: string): Record<string, string> {
  return Object.fromEntries(STUDY_TEXT_TRANSLATION_LOCALES.map((locale) => [locale, translationOf(stored, locale, field)]));
}

/** The stored translations with the given texts of one field set (empty removes them). */
function mergeField(stored: ConsentTranslations, field: string, texts: Record<string, string>): ConsentTranslations {
  let next = stored;
  for (const locale of STUDY_TEXT_TRANSLATION_LOCALES) next = withTranslation(next, locale, field, texts[locale] ?? "");
  return next;
}
type Confirm = { kind: "publish" | "delete"; version: ConsentVersion };

const consentLabel = (version: { versionNumber: number }) => `Consent v${version.versionNumber}`;

function ItemsCard({
  version,
  editable,
  onSave,
}: {
  version: ConsentVersion;
  editable: boolean;
  onSave: (items: Item[], translations: ConsentTranslations) => Promise<void>;
}) {
  const storedIds = version.itemsJson.map((item) => item.id);
  const stored = version.translationsJson as ConsentTranslations;
  const value: ItemDraft[] = version.itemsJson.map((item) => ({
    ...item,
    translations: Object.fromEntries(
      STUDY_TEXT_TRANSLATION_LOCALES.map((locale) => [locale, keyedTranslationOf(stored, locale, "items", item.id)]),
    ),
  }));

  function validate(draft: ItemDraft[]): string | null {
    const ids = draft.map((item) => item.id.trim());
    if (ids.some((id) => !/^[a-z0-9][a-z0-9_]*$/.test(id))) {
      return "Every item needs an id made of lowercase letters, digits and underscores.";
    }
    if (new Set(ids).size !== ids.length) return "Item ids must be unique.";
    return null;
  }

  return (
    <EditorCard<ItemDraft[]>
      id="consent-items"
      title="Consent items"
      description="Each item is one statement the participant accepts or declines. Required items must be accepted to take part."
      value={value}
      editable={editable}
      validate={validate}
      onSave={(draft) => {
        // The item texts per locale, keyed by item id. Removed items lose their translations.
        let translations: ConsentTranslations = stored;
        for (const locale of STUDY_TEXT_TRANSLATION_LOCALES) {
          const texts = Object.fromEntries(
            draft
              .map((item) => [item.id.trim(), item.translations[locale] ?? ""] as const)
              .filter(([, text]) => text.trim() !== ""),
          );
          translations = withTranslation(translations, locale, "items", texts);
        }
        return onSave(
          draft.map((item) => ({
            id: item.id.trim(),
            text: item.text,
            required: item.required,
            ...(item.scope?.trim() ? { scope: item.scope.trim() } : {}),
          })),
          translations,
        );
      }}
      renderView={(items) =>
        items.length === 0 ? (
          <p className="text-sm text-slate-500">No items yet. At least one required item is needed before publishing.</p>
        ) : (
          <ol className="divide-y divide-slate-100">
            {items.map((item, index) => (
              <li key={item.id} className="flex items-start gap-3 py-3 text-sm">
                <span className="w-5 shrink-0 text-right text-slate-500 tabular-nums">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-wrap text-slate-700">{item.text || "No text yet."}</p>
                  {STUDY_TEXT_TRANSLATION_LOCALES.map((locale) => (
                    <p key={locale} lang={locale} className="mt-1 whitespace-pre-wrap text-slate-500">
                      {item.translations[locale] || `No ${localeLabel(locale)} text.`}
                    </p>
                  ))}
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <Badge variant="neutral" size="sm">
                      {item.required ? "Required" : "Optional"}
                    </Badge>
                    <span>
                      id <span className="font-mono">{item.id}</span>
                    </span>
                    {item.scope && (
                      <span>
                        scope <span className="font-mono">{item.scope}</span>
                      </span>
                    )}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )
      }
      renderEdit={(draft, setDraft, disabled) => {
        const change = (index: number, patch: Partial<ItemDraft>) =>
          setDraft(draft.map((item, position) => (position === index ? { ...item, ...patch } : item)));
        const move = (index: number, offset: number) => {
          const next = [...draft];
          const [item] = next.splice(index, 1);
          if (item) next.splice(index + offset, 0, item);
          setDraft(next);
        };
        return (
          <div className="space-y-3">
            <InlineMessage variant="info" announce="none">
              Item ids are stable. An id that is already saved stays the same across versions, so that answers can be
              compared. Do not reuse an id for a statement with a different meaning: remove the item and add a new one.
            </InlineMessage>
            <ol className="space-y-3">
              {draft.map((item, index) => {
                const idLocked = storedIds.includes(item.id);
                return (
                  // The position is the identity while editing: ids of new items can be retyped.
                  <li key={index} className="space-y-3 rounded-md border border-slate-200 p-4">
                    <FormField label={`Item ${index + 1} text`} help="Shown to the participant next to a checkbox.">
                      <TextArea
                        rows={2}
                        value={item.text}
                        disabled={disabled}
                        maxLength={protocolSchemas.MAX_PROMPT_LENGTH}
                        onChange={(event) => change(index, { text: event.target.value })}
                      />
                    </FormField>
                    {STUDY_TEXT_TRANSLATION_LOCALES.map((locale) => (
                      <FormField
                        key={locale}
                        label={`Item ${index + 1} text, ${localeLabel(locale)}`}
                        help="Empty: participants who choose this language see the English text."
                      >
                        <TextArea
                          lang={locale}
                          rows={2}
                          value={item.translations[locale] ?? ""}
                          disabled={disabled}
                          maxLength={protocolSchemas.MAX_PROMPT_LENGTH}
                          onChange={(event) =>
                            change(index, { translations: { ...item.translations, [locale]: event.target.value } })
                          }
                        />
                      </FormField>
                    ))}
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <FormField label="Id" help={idLocked ? "Saved ids cannot be changed." : "Lowercase letters, digits, underscores."}>
                        <TextInput
                          mono
                          value={item.id}
                          disabled={disabled || idLocked}
                          maxLength={protocolSchemas.MAX_KEY_LENGTH}
                          onChange={(event) => change(index, { id: event.target.value })}
                        />
                      </FormField>
                      <FormField label="Scope label" help="Optional, for example participation or voice_recording.">
                        <TextInput
                          mono
                          value={item.scope ?? ""}
                          disabled={disabled}
                          maxLength={protocolSchemas.MAX_KEY_LENGTH}
                          onChange={(event) => change(index, { scope: event.target.value })}
                        />
                      </FormField>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <Checkbox
                        label="Required"
                        checked={item.required}
                        disabled={disabled}
                        onChange={(event) => change(index, { required: event.target.checked })}
                      />
                      <span className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={disabled || index === 0}
                          aria-label={`Move item ${index + 1} up`}
                          onClick={() => move(index, -1)}
                        >
                          Move up
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={disabled || index === draft.length - 1}
                          aria-label={`Move item ${index + 1} down`}
                          onClick={() => move(index, 1)}
                        >
                          Move down
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={disabled}
                          aria-label={`Remove item ${index + 1}`}
                          onClick={() => setDraft(draft.filter((_, position) => position !== index))}
                        >
                          Remove
                        </Button>
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
            <Button
              size="sm"
              variant="secondary"
              disabled={disabled || draft.length >= protocolSchemas.MAX_CONSENT_ITEMS}
              onClick={() => {
                const ids = draft.map((item) => item.id);
                let number = draft.length + 1;
                while (ids.includes(`item_${number}`)) number += 1;
                setDraft([...draft, { id: `item_${number}`, text: "", required: true, translations: {} }]);
              }}
            >
              Add item
            </Button>
          </div>
        );
      }}
    />
  );
}

export interface ConsentClientProps {
  initialConsents: ConsentVersion[];
  timeZone: string;
}

/** Consent versions: list, draft editor and publishing (spec 6.2, 76). */
export function ConsentClient({ initialConsents, timeZone }: ConsentClientProps) {
  const [consents, setConsents] = useState(initialConsents);
  const [selectedId, setSelectedId] = useState<string | null>(
    () => (initialConsents.find((consent) => consent.status === "draft") ?? initialConsents[0])?.id ?? null,
  );
  const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");

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

  const draft = consents.find((consent) => consent.status === "draft") ?? null;
  const selected = consents.find((consent) => consent.id === selectedId) ?? null;
  const editable = selected?.status === "draft";
  const time = (value: string | null) => (value ? formatDateTime(value, timeZone) : "");

  async function reload(selectId?: string | null) {
    const next = await fetchConsents();
    setConsents(next.consents);
    if (selectId !== undefined) setSelectedId(selectId);
    return next.consents;
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

  async function save(changes: protocolSchemas.ConsentDraftChanges) {
    if (!selected) return;
    const updated = await updateConsent(selected.id, changes);
    setConsents((list) => list.map((consent) => (consent.id === updated.id ? updated : consent)));
  }

  async function confirmAction() {
    if (!confirm) return;
    setBusy(true);
    setConfirmError(null);
    try {
      if (confirm.kind === "publish") {
        await publishConsent(confirm.version.id);
        await reload(confirm.version.id);
        setNotice(`${consentLabel(confirm.version)} is published. It can now be selected in a draft protocol on the Study Flow page.`);
      } else {
        await deleteConsent(confirm.version.id);
        const next = await reload();
        setSelectedId(next[0]?.id ?? null);
        setNotice(`The draft ${consentLabel(confirm.version)} was deleted.`);
      }
      setConfirm(null);
    } catch (caught) {
      setConfirmError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DirtyContext.Provider value={reportDirty}>
      <div className="space-y-6">
        <PageHeading
          title="Consent versions"
          description={`The information text and consent items that a protocol selects. A published consent version never changes. Times are shown in ${timeZone}.`}
          actions={
            <LinkButton href="/admin/study-flow" variant="secondary" size="sm">
              Back to Study Flow
            </LinkButton>
          }
        />

        {error && <InlineMessage variant="error">{error}</InlineMessage>}
        {notice && <InlineMessage variant="success">{notice}</InlineMessage>}

        <Card padding="none" as="section" aria-label="Consent versions">
          <CardHeader
            title="Versions"
            description={
              draft
                ? `${consentLabel(draft)} is the draft. Only one consent draft exists at a time.`
                : "No draft. Clone a published version to change the consent, or create a new one."
            }
          />
          <DataTable<ConsentVersion>
            caption="Consent versions, newest first"
            className="rounded-none border-0"
            rows={consents}
            getRowKey={(consent) => consent.id}
            selectedKey={selectedId}
            emptyTitle="There is no consent version yet."
            columns={[
              {
                key: "version",
                header: "Version",
                rowHeader: true,
                cell: (consent) => <span className="font-medium text-slate-900">{consentLabel(consent)}</span>,
              },
              { key: "title", header: "Title", cell: (consent) => consent.title },
              {
                key: "status",
                header: "Status",
                cell: (consent) => (
                  <Badge variant={consent.status === "draft" ? "incomplete" : "status"}>
                    {consent.status === "draft" ? "Draft" : "Published"}
                  </Badge>
                ),
              },
              {
                key: "published",
                header: "Published",
                className: "tabular-nums whitespace-nowrap",
                cell: (consent) => time(consent.publishedAt) || <span className="text-slate-500">Not published</span>,
              },
              { key: "items", header: "Items", align: "right", cell: (consent) => consent.itemsJson.length },
              {
                key: "used",
                header: "Used by",
                cell: (consent) =>
                  consent.usedByProtocolVersions.length > 0
                    ? consent.usedByProtocolVersions.map((number) => `Protocol v${number}`).join(", ")
                    : <span className="text-slate-500">No protocol</span>,
              },
              {
                key: "actions",
                header: "Actions",
                cell: (consent) => (
                  <span className="flex flex-wrap gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="px-2 py-0.5"
                      disabled={busy}
                      aria-label={`${consent.status === "draft" ? "Edit" : "View"} ${consentLabel(consent)}`}
                      onClick={() => {
                        if (confirmDiscardChanges(anyDirty)) setSelectedId(consent.id);
                      }}
                    >
                      {consent.status === "draft" ? "Edit" : "View"}
                    </Button>
                    {consent.status === "published" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="px-2 py-0.5"
                        disabled={busy || draft !== null}
                        title={draft ? "A consent draft already exists." : undefined}
                        aria-label={`Clone ${consentLabel(consent)} to a new draft`}
                        onClick={() =>
                          run(async () => {
                            const created = await cloneConsent(consent.id);
                            await reload(created.id);
                            setNotice(`${consentLabel(created)} was created as a draft with the same item ids.`);
                          })
                        }
                      >
                        Clone to new draft
                      </Button>
                    )}
                    {consent.status === "draft" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="px-2 py-0.5 text-rose-700 hover:bg-rose-50 hover:text-rose-700"
                        disabled={busy}
                        aria-label={`Delete draft ${consentLabel(consent)}`}
                        onClick={() => {
                          setConfirmError(null);
                          setConfirm({ kind: "delete", version: consent });
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
          {!draft && (
            <div className="flex flex-wrap items-end gap-3 border-t border-slate-200 px-6 py-4">
              <FormField label="Title of a new, empty consent draft" className="w-full max-w-md">
                <TextInput
                  value={newTitle}
                  maxLength={protocolSchemas.MAX_NAME_LENGTH}
                  onChange={(event) => setNewTitle(event.target.value)}
                />
              </FormField>
              <Button
                variant="secondary"
                disabled={busy || newTitle.trim() === ""}
                onClick={() =>
                  run(async () => {
                    const created = await createConsent({ title: newTitle.trim() });
                    setNewTitle("");
                    await reload(created.id);
                  })
                }
              >
                Create empty draft
              </Button>
            </div>
          )}
        </Card>

        {!selected ? (
          <Card padding="none">
            <EmptyState title="Select a consent version to view it." />
          </Card>
        ) : (
          <section key={selected.id} aria-label={`${consentLabel(selected)} content`} className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold text-slate-900">
                  {editable ? "Editing" : "Viewing"} {consentLabel(selected)}
                </h2>
                <Badge variant={editable ? "incomplete" : "status"}>{editable ? "Draft" : "Published"}</Badge>
              </div>
              {editable && (
                <Button
                  size="sm"
                  disabled={busy || anyDirty}
                  title={anyDirty ? "Save or cancel your open edits first." : undefined}
                  onClick={() => {
                    setConfirmError(null);
                    setConfirm({ kind: "publish", version: selected });
                  }}
                >
                  Publish {consentLabel(selected)}
                </Button>
              )}
            </div>
            {!editable && (
              <InlineMessage variant="info" announce="none">
                {consentLabel(selected)} was published {time(selected.publishedAt)} and cannot be edited, because
                sessions record which consent text they accepted. To change the consent, clone it to a new draft, edit
                the draft, publish it and select it in a draft protocol.
              </InlineMessage>
            )}

            <EditorCard<{
              title: string;
              informationText: string;
              titles: Record<string, string>;
              informationTexts: Record<string, string>;
            }>
              id="consent-text"
              title="Title and information text"
              description="Shown above the consent items."
              value={{
                title: selected.title,
                informationText: selected.informationText,
                titles: translationsFor(selected.translationsJson, "title"),
                informationTexts: translationsFor(selected.translationsJson, "informationText"),
              }}
              editable={editable}
              validate={(value) => (value.title.trim() ? null : "The consent version needs a title.")}
              onSave={(value) =>
                save({
                  title: value.title.trim(),
                  informationText: value.informationText,
                  translations: mergeField(
                    mergeField(selected.translationsJson as ConsentTranslations, "title", value.titles),
                    "informationText",
                    value.informationTexts,
                  ),
                })
              }
              renderView={(value) => (
                <div className="space-y-3">
                  <p className="text-sm font-medium text-slate-900">{value.title}</p>
                  <ProseView
                    text={value.informationText}
                    label="Information text"
                    empty="Empty. The information text is required before publishing."
                  />
                  {STUDY_TEXT_TRANSLATION_LOCALES.map((locale) => (
                    <div key={locale} className="space-y-1">
                      <p className="text-xs font-medium text-slate-500">{localeLabel(locale)}</p>
                      <p lang={locale} className="text-sm font-medium text-slate-900">
                        {value.titles[locale] || "No translated title."}
                      </p>
                      <ProseView
                        text={value.informationTexts[locale] ?? ""}
                        label={`Information text, ${localeLabel(locale)}`}
                        empty="No translation. Participants who choose this language see the English text."
                      />
                    </div>
                  ))}
                </div>
              )}
              renderEdit={(value, setValue, disabled) => (
                <div className="space-y-4">
                  <FormField label="Title" required className="max-w-xl">
                    <TextInput
                      value={value.title}
                      disabled={disabled}
                      maxLength={protocolSchemas.MAX_NAME_LENGTH}
                      onChange={(event) => setValue({ ...value, title: event.target.value })}
                    />
                  </FormField>
                  <FormField
                    label="Information text"
                    help="The exact text is supplied by the researchers and approved in the ethics and data protection process."
                  >
                    <TextArea
                      rows={10}
                      value={value.informationText}
                      disabled={disabled}
                      maxLength={protocolSchemas.MAX_CONTENT_LENGTH}
                      onChange={(event) => setValue({ ...value, informationText: event.target.value })}
                    />
                  </FormField>
                  {STUDY_TEXT_TRANSLATION_LOCALES.map((locale) => (
                    <div key={locale} className="space-y-4">
                      <FormField label={`Title, ${localeLabel(locale)}`} className="max-w-xl">
                        <TextInput
                          lang={locale}
                          value={value.titles[locale] ?? ""}
                          disabled={disabled}
                          maxLength={protocolSchemas.MAX_NAME_LENGTH}
                          onChange={(event) =>
                            setValue({ ...value, titles: { ...value.titles, [locale]: event.target.value } })
                          }
                        />
                      </FormField>
                      <FormField
                        label={`Information text, ${localeLabel(locale)}`}
                        help="Shown to participants who choose this language. Empty: they see the English text."
                      >
                        <TextArea
                          lang={locale}
                          rows={10}
                          value={value.informationTexts[locale] ?? ""}
                          disabled={disabled}
                          maxLength={protocolSchemas.MAX_CONTENT_LENGTH}
                          onChange={(event) =>
                            setValue({
                              ...value,
                              informationTexts: { ...value.informationTexts, [locale]: event.target.value },
                            })
                          }
                        />
                      </FormField>
                    </div>
                  ))}
                </div>
              )}
            />

            <EditorCard<{ privacyNoticeUrl: string; contactText: string; contactTexts: Record<string, string> }>
              id="consent-contact"
              title="Privacy notice and contact"
              description="A link to the privacy notice, and who to contact about the study."
              value={{
                privacyNoticeUrl: selected.privacyNoticeUrl ?? "",
                contactText: selected.contactText ?? "",
                contactTexts: translationsFor(selected.translationsJson, "contactText"),
              }}
              editable={editable}
              validate={(value) =>
                value.privacyNoticeUrl.trim() === "" || /^https?:\/\/\S+$/.test(value.privacyNoticeUrl.trim())
                  ? null
                  : "The privacy notice URL must start with http:// or https://."
              }
              onSave={(value) =>
                save({
                  privacyNoticeUrl: value.privacyNoticeUrl.trim() || null,
                  contactText: value.contactText.trim() ? value.contactText : null,
                  translations: mergeField(
                    selected.translationsJson as ConsentTranslations,
                    "contactText",
                    value.contactTexts,
                  ),
                })
              }
              renderView={(value) => (
                <dl className="space-y-2 text-sm">
                  <div>
                    <dt className="text-xs font-medium text-slate-500">Privacy notice URL</dt>
                    <dd className="break-all text-slate-700">{value.privacyNoticeUrl || "Not set."}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium text-slate-500">Contact</dt>
                    <dd className="whitespace-pre-wrap text-slate-700">{value.contactText || "Not set."}</dd>
                  </div>
                  {STUDY_TEXT_TRANSLATION_LOCALES.map((locale) => (
                    <div key={locale}>
                      <dt className="text-xs font-medium text-slate-500">Contact, {localeLabel(locale)}</dt>
                      <dd lang={locale} className="whitespace-pre-wrap text-slate-700">
                        {value.contactTexts[locale] || "Not set."}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              renderEdit={(value, setValue, disabled) => (
                <div className="space-y-4">
                  <FormField label="Privacy notice URL" className="max-w-xl">
                    <TextInput
                      type="url"
                      value={value.privacyNoticeUrl}
                      disabled={disabled}
                      placeholder="https://"
                      onChange={(event) => setValue({ ...value, privacyNoticeUrl: event.target.value })}
                    />
                  </FormField>
                  <FormField label="Contact" help="Researcher or data controller contact details.">
                    <TextArea
                      rows={3}
                      value={value.contactText}
                      disabled={disabled}
                      maxLength={protocolSchemas.MAX_PROMPT_LENGTH}
                      onChange={(event) => setValue({ ...value, contactText: event.target.value })}
                    />
                  </FormField>
                  {STUDY_TEXT_TRANSLATION_LOCALES.map((locale) => (
                    <FormField key={locale} label={`Contact, ${localeLabel(locale)}`}>
                      <TextArea
                        lang={locale}
                        rows={3}
                        value={value.contactTexts[locale] ?? ""}
                        disabled={disabled}
                        maxLength={protocolSchemas.MAX_PROMPT_LENGTH}
                        onChange={(event) =>
                          setValue({ ...value, contactTexts: { ...value.contactTexts, [locale]: event.target.value } })
                        }
                      />
                    </FormField>
                  ))}
                </div>
              )}
            />

            <ItemsCard
              version={selected}
              editable={editable}
              onSave={(items, translations) => save({ items, translations })}
            />
          </section>
        )}

        <ConfirmDialog
          open={confirm !== null}
          tone={confirm?.kind === "delete" ? "danger" : "default"}
          title={
            confirm?.kind === "publish"
              ? `Publish ${consentLabel(confirm.version)}?`
              : confirm
                ? `Delete the draft ${consentLabel(confirm.version)}?`
                : ""
          }
          confirmLabel={confirm?.kind === "publish" ? `Publish ${consentLabel(confirm.version)}` : "Delete draft"}
          busy={busy}
          error={confirmError}
          onConfirm={confirmAction}
          onCancel={() => setConfirm(null)}
        >
          {confirm?.kind === "publish" && (
            <>
              <p>After publishing, this consent version is immutable: its texts and items can no longer be edited, and it cannot be deleted.</p>
              <p>Publishing does not change any protocol. Select the new version in a draft protocol to use it for new sessions.</p>
            </>
          )}
          {confirm?.kind === "delete" && <p>The draft is deleted. This cannot be undone. Published versions are not affected.</p>}
        </ConfirmDialog>
      </div>
    </DirtyContext.Provider>
  );
}

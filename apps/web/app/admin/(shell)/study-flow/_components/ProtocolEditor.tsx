"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import {
  protocolSchemas,
  STUDY_TEXT_LOCALE_NAMES,
  STUDY_TEXT_TRANSLATION_LOCALES,
  translationOf,
  withTranslation,
  type ProtocolTranslations,
} from "@dialect/domain";
import { Badge, Button, FormField, Select, TextArea, TextInput } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { updateDraft } from "./api";
import { EditorCard, ProseView } from "./EditorCard";
import { TaskList } from "./TaskList";
import { ORDER_MODE_LABELS, type OrderBlock, type ProtocolDetail, type ProtocolOptions } from "./types";

export type Mutate = (run: (stamp: string) => Promise<ProtocolDetail>) => Promise<void>;

export interface ProtocolEditorProps {
  detail: ProtocolDetail;
  /** True for a draft. A published or retired version is shown in the same layout without edit controls. */
  editable: boolean;
  options: ProtocolOptions;
  /** Runs a change with the current updated_at and stores the returned protocol. Rejects on failure. */
  mutate: Mutate;
  timeZone: string;
}

const linkClass =
  "font-medium text-slate-900 underline underline-offset-2 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded-sm";

type ProseField = "welcomeContent" | "informationContent" | "instructionContent" | "debriefContent";

/** A study text with its translations, as edited in one card. */
type ProseDraft = { base: string; translations: Record<string, string> };

/** "Finnish (fi)" */
export function localeLabel(locale: string): string {
  return `${STUDY_TEXT_LOCALE_NAMES[locale] ?? locale} (${locale})`;
}

function ProseCard({
  field,
  title,
  description,
  help,
  detail,
  editable,
  mutate,
}: {
  field: ProseField;
  title: string;
  description: string;
  help?: ReactNode;
} & Pick<ProtocolEditorProps, "detail" | "editable" | "mutate">) {
  const id = detail.protocol.id;
  const stored = detail.protocol.translationsJson as ProtocolTranslations;
  const value: ProseDraft = {
    base: detail.protocol[field],
    translations: Object.fromEntries(
      STUDY_TEXT_TRANSLATION_LOCALES.map((locale) => [locale, translationOf(stored, locale, field)]),
    ),
  };
  return (
    <EditorCard<ProseDraft>
      id={`card-${field}`}
      title={title}
      description={description}
      value={value}
      editable={editable}
      onSave={(draft) => {
        let translations = stored;
        for (const locale of STUDY_TEXT_TRANSLATION_LOCALES) {
          translations = withTranslation(translations, locale, field, draft.translations[locale] ?? "");
        }
        return mutate((stamp) => updateDraft(id, stamp, { [field]: draft.base, translations }));
      }}
      renderView={(current) => (
        <div className="space-y-3">
          <ProseView text={current.base} label={title} empty="Empty. This text is required before publishing." />
          {STUDY_TEXT_TRANSLATION_LOCALES.map((locale) => (
            <div key={locale} className="space-y-1">
              <p className="text-xs font-medium text-slate-500">{localeLabel(locale)}</p>
              <ProseView
                text={current.translations[locale] ?? ""}
                label={`${title}, ${localeLabel(locale)}`}
                empty="No translation. Participants who choose this language see the English text."
              />
            </div>
          ))}
        </div>
      )}
      renderEdit={(draft, setDraft, disabled) => (
        <div className="space-y-4">
          <FormField label={`${title}, English (en)`} help={help}>
            {/* Participant-facing prose: normal sans-serif, not monospace. */}
            <TextArea
              rows={10}
              value={draft.base}
              disabled={disabled}
              maxLength={protocolSchemas.MAX_CONTENT_LENGTH}
              onChange={(event) => setDraft({ ...draft, base: event.target.value })}
            />
          </FormField>
          {STUDY_TEXT_TRANSLATION_LOCALES.map((locale) => (
            <FormField
              key={locale}
              label={`${title}, ${localeLabel(locale)}`}
              help="Shown to participants who choose this language. Empty: they see the English text."
            >
              <TextArea
                rows={10}
                lang={locale}
                value={draft.translations[locale] ?? ""}
                disabled={disabled}
                maxLength={protocolSchemas.MAX_CONTENT_LENGTH}
                onChange={(event) =>
                  setDraft({ ...draft, translations: { ...draft.translations, [locale]: event.target.value } })
                }
              />
            </FormField>
          ))}
        </div>
      )}
    />
  );
}

type SelectionOption = { id: string; versionNumber: number; label: string };

function SelectionCard({
  cardId,
  title,
  description,
  noun,
  selectedId,
  selectedLabel,
  selectedMeta,
  choices,
  allowNone,
  manageLink,
  editable,
  onSave,
}: {
  cardId: string;
  title: string;
  description: string;
  /** For example "consent version". */
  noun: string;
  selectedId: string | null;
  selectedLabel: string | null;
  selectedMeta?: ReactNode;
  choices: SelectionOption[];
  allowNone: boolean;
  manageLink: ReactNode;
  editable: boolean;
  onSave: (id: string | null) => Promise<void>;
}) {
  const selectedIsListed = selectedId === null || choices.some((choice) => choice.id === selectedId);
  return (
    <EditorCard<string | null>
      id={cardId}
      title={title}
      description={description}
      value={selectedId}
      editable={editable}
      onSave={onSave}
      renderView={() => (
        <div className="space-y-2 text-sm">
          {selectedId ? (
            <p className="text-slate-700">
              <span className="font-medium text-slate-900">{selectedLabel}</span>
              {selectedMeta}
            </p>
          ) : (
            <p className="text-slate-500">
              No {noun} is selected.{allowNone ? " Participants will not see this step." : " One is required before publishing."}
            </p>
          )}
          <p className="text-slate-500">{manageLink}</p>
        </div>
      )}
      renderEdit={(draft, setDraft, disabled) => (
        <div className="space-y-2">
          <FormField
            label={`Published ${noun}`}
            help={`Only published versions can be selected. A published ${noun} never changes.`}
            className="max-w-xl"
          >
            <Select value={draft ?? ""} disabled={disabled} onChange={(event) => setDraft(event.target.value || null)}>
              <option value="">{allowNone ? "None" : `Select a ${noun}`}</option>
              {!selectedIsListed && selectedId && (
                <option value={selectedId}>{selectedLabel} (no longer selectable)</option>
              )}
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </Select>
          </FormField>
          {choices.length === 0 && (
            <p className="text-sm text-slate-500">There is no published {noun} yet.</p>
          )}
          <p className="text-sm text-slate-500">{manageLink}</p>
        </div>
      )}
    />
  );
}

function BlocksCard({ detail, editable, mutate }: Pick<ProtocolEditorProps, "detail" | "editable" | "mutate">) {
  const id = detail.protocol.id;
  const stored = detail.protocol.orderConfigJson.blocks;
  const taskCount = (key: string) => detail.tasks.filter((task) => task.blockKey === key).length;
  const storedKeys = stored.map((block) => block.key);

  function validate(draft: OrderBlock[]): string | null {
    const keys = draft.map((block) => block.key.trim());
    if (keys.some((key) => !/^[a-z0-9][a-z0-9_]*$/.test(key))) {
      return "Every block needs a key made of lowercase letters, digits and underscores.";
    }
    if (new Set(keys).size !== keys.length) return "Block keys must be unique.";
    return null;
  }

  return (
    <EditorCard<OrderBlock[]>
      id="card-blocks"
      title="Task blocks"
      description="Blocks are presented in this order. Each block has its own order mode."
      value={stored}
      editable={editable}
      validate={validate}
      onSave={(draft) =>
        mutate((stamp) =>
          updateDraft(id, stamp, {
            orderConfig: {
              blocks: draft.map((block) => ({
                key: block.key.trim(),
                ...(block.title?.trim() ? { title: block.title.trim() } : {}),
                orderMode: block.orderMode,
              })),
            },
          }),
        )
      }
      renderView={(blocks) =>
        blocks.length === 0 ? (
          <p className="text-sm text-slate-500">No blocks yet. Add a block before adding tasks.</p>
        ) : (
          <ol className="divide-y divide-slate-100 text-sm">
            {blocks.map((block, index) => (
              <li key={block.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="w-5 text-right text-slate-500 tabular-nums">{index + 1}</span>
                <span className="font-medium text-slate-900">{block.title || block.key}</span>
                <span className="font-mono text-xs text-slate-500">{block.key}</span>
                <Badge variant="neutral">{ORDER_MODE_LABELS[block.orderMode]}</Badge>
                <span className="text-xs text-slate-500 tabular-nums">
                  {taskCount(block.key)} task{taskCount(block.key) === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ol>
        )
      }
      renderEdit={(draft, setDraft, disabled) => {
        const change = (index: number, patch: Partial<OrderBlock>) =>
          setDraft(draft.map((block, position) => (position === index ? { ...block, ...patch } : block)));
        const move = (index: number, offset: number) => {
          const next = [...draft];
          const [block] = next.splice(index, 1);
          if (block) next.splice(index + offset, 0, block);
          setDraft(next);
        };
        return (
          <div className="space-y-3">
            {draft.length === 0 && <p className="text-sm text-slate-500">No blocks yet.</p>}
            <ol className="space-y-3">
              {draft.map((block, index) => {
                const keyLocked = storedKeys.includes(block.key) && taskCount(block.key) > 0;
                const name = block.title || block.key || `block ${index + 1}`;
                return (
                  // The position is the identity while editing: keys can be retyped.
                  <li key={index} className="rounded-md border border-slate-200 p-4">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                      <FormField label="Title" help="Shown to researchers only.">
                        <TextInput
                          value={block.title ?? ""}
                          disabled={disabled}
                          maxLength={protocolSchemas.MAX_NAME_LENGTH}
                          onChange={(event) => change(index, { title: event.target.value })}
                        />
                      </FormField>
                      <FormField
                        label="Key"
                        help={keyLocked ? "Fixed while the block has tasks." : "Lowercase letters, digits, underscores."}
                      >
                        <TextInput
                          mono
                          value={block.key}
                          disabled={disabled || keyLocked}
                          maxLength={protocolSchemas.MAX_KEY_LENGTH}
                          onChange={(event) => change(index, { key: event.target.value })}
                        />
                      </FormField>
                      <FormField label="Order mode">
                        <Select
                          value={block.orderMode}
                          disabled={disabled}
                          onChange={(event) => change(index, { orderMode: event.target.value as OrderBlock["orderMode"] })}
                          options={[
                            { value: "fixed", label: ORDER_MODE_LABELS.fixed },
                            { value: "shuffle_within_block", label: ORDER_MODE_LABELS.shuffle_within_block },
                          ]}
                        />
                      </FormField>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={disabled || index === 0}
                        aria-label={`Move block ${name} up`}
                        onClick={() => move(index, -1)}
                      >
                        Move up
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={disabled || index === draft.length - 1}
                        aria-label={`Move block ${name} down`}
                        onClick={() => move(index, 1)}
                      >
                        Move down
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={disabled || taskCount(block.key) > 0}
                        aria-label={`Remove block ${name}`}
                        onClick={() => setDraft(draft.filter((_, position) => position !== index))}
                      >
                        Remove
                      </Button>
                      {taskCount(block.key) > 0 && (
                        <span className="text-xs text-slate-500">
                          Has {taskCount(block.key)} task{taskCount(block.key) === 1 ? "" : "s"}. Move or delete them to
                          remove the block.
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
            <Button
              size="sm"
              variant="secondary"
              disabled={disabled || draft.length >= protocolSchemas.MAX_BLOCKS}
              onClick={() => setDraft([...draft, { key: "", title: "", orderMode: "fixed" }])}
            >
              Add block
            </Button>
          </div>
        );
      }}
    />
  );
}

/**
 * The protocol in white bordered cards, in the order the participant meets the
 * content. With `editable` false the same layout is shown without edit controls.
 */
export function ProtocolEditor({ detail, editable, options, mutate, timeZone }: ProtocolEditorProps) {
  const { protocol } = detail;
  const id = protocol.id;
  const consent = detail.consentVersion;
  const background = detail.backgroundQuestionnaire;
  const post = detail.postQuestionnaire;
  const postReview = detail.postReviewQuestionnaire;
  const published = (value: string | null) => (value ? `published ${formatDateTime(value, timeZone)}` : "draft");

  return (
    <div className="space-y-4">
      <EditorCard<{ name: string; description: string }>
        id="card-general"
        title="General"
        description="For researchers. Participants do not see the name or the description."
        value={{ name: protocol.name, description: protocol.description ?? "" }}
        editable={editable}
        validate={(draft) => (draft.name.trim() ? null : "The protocol needs a name.")}
        onSave={(draft) =>
          mutate((stamp) =>
            updateDraft(id, stamp, { name: draft.name.trim(), description: draft.description.trim() || null }),
          )
        }
        renderView={(value) => (
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-xs font-medium text-slate-500">Name</dt>
              <dd className="text-slate-900">{value.name}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-slate-500">Description</dt>
              <dd className="whitespace-pre-wrap text-slate-700">{value.description || "No description."}</dd>
            </div>
          </dl>
        )}
        renderEdit={(draft, setDraft, disabled) => (
          <div className="space-y-4">
            <FormField label="Name" required className="max-w-xl">
              <TextInput
                value={draft.name}
                disabled={disabled}
                maxLength={protocolSchemas.MAX_NAME_LENGTH}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </FormField>
            <FormField label="Description" help="What this version changes and why.">
              <TextArea
                rows={3}
                value={draft.description}
                disabled={disabled}
                maxLength={protocolSchemas.MAX_DESCRIPTION_LENGTH}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </FormField>
          </div>
        )}
      />

      <ProseCard
        field="welcomeContent"
        title="Welcome text"
        description="First page: what the study is, how long it takes, that the voice is recorded."
        help="Describe the study truthfully without stating what you expect to find (spec 6.1)."
        detail={detail}
        editable={editable}
        mutate={mutate}
      />
      <ProseCard
        field="informationContent"
        title="Participant information text"
        description="The information sheet shown with the consent items."
        detail={detail}
        editable={editable}
        mutate={mutate}
      />

      <SelectionCard
        cardId="card-consent"
        title="Consent version"
        description="The consent items and privacy details that participants accept before recording."
        noun="consent version"
        selectedId={protocol.consentVersionId}
        selectedLabel={consent ? `Consent v${consent.versionNumber}: ${consent.title}` : null}
        selectedMeta={
          consent ? (
            <span className="text-slate-500 tabular-nums">
              {" "}
              ({consent.itemsJson.length} item{consent.itemsJson.length === 1 ? "" : "s"}, {published(consent.publishedAt)})
            </span>
          ) : undefined
        }
        choices={options.consentVersions.map((version) => ({
          id: version.id,
          versionNumber: version.versionNumber,
          label: `Consent v${version.versionNumber}: ${version.title}`,
        }))}
        allowNone={false}
        manageLink={
          <Link href="/admin/study-flow/consent" className={linkClass}>
            Open the consent editor
          </Link>
        }
        editable={editable}
        onSave={(value) => mutate((stamp) => updateDraft(id, stamp, { consentVersionId: value }))}
      />

      <ProseCard
        field="instructionContent"
        title="Study instructions"
        description="Shown after the microphone check, before the first task."
        help="Ask participants to speak the way they normally would. Avoid naming dialect or asking for marked speech (spec 6.4)."
        detail={detail}
        editable={editable}
        mutate={mutate}
      />

      <BlocksCard detail={detail} editable={editable} mutate={mutate} />
      <TaskList detail={detail} editable={editable} mutate={mutate} />

      <SelectionCard
        cardId="card-background-questionnaire"
        title="Background questionnaire"
        description="Shown after the speech tasks, so that it does not influence how participants speak."
        noun="background questionnaire"
        selectedId={protocol.backgroundQuestionnaireVersionId}
        selectedLabel={background ? `${background.name} v${background.versionNumber}` : null}
        selectedMeta={
          background ? (
            <span className="text-slate-500 tabular-nums">
              {" "}
              ({background.items.length} item{background.items.length === 1 ? "" : "s"}, {background.status})
            </span>
          ) : undefined
        }
        choices={options.backgroundQuestionnaires.map((version) => ({
          id: version.id,
          versionNumber: version.versionNumber,
          label: `${version.name} v${version.versionNumber}`,
        }))}
        allowNone
        manageLink={
          <Link href="/admin/questionnaires" className={linkClass}>
            Open Questionnaires
          </Link>
        }
        editable={editable}
        onSave={(value) => mutate((stamp) => updateDraft(id, stamp, { backgroundQuestionnaireVersionId: value }))}
      />
      <SelectionCard
        cardId="card-post-questionnaire"
        title="Post-recording questionnaire"
        description="About the recording experience. Shown after the background questionnaire."
        noun="post-recording questionnaire"
        selectedId={protocol.postQuestionnaireVersionId}
        selectedLabel={post ? `${post.name} v${post.versionNumber}` : null}
        selectedMeta={
          post ? (
            <span className="text-slate-500 tabular-nums">
              {" "}
              ({post.items.length} item{post.items.length === 1 ? "" : "s"}, {post.status})
            </span>
          ) : undefined
        }
        choices={options.postQuestionnaires.map((version) => ({
          id: version.id,
          versionNumber: version.versionNumber,
          label: `${version.name} v${version.versionNumber}`,
        }))}
        allowNone
        manageLink={
          <Link href="/admin/questionnaires" className={linkClass}>
            Open Questionnaires
          </Link>
        }
        editable={editable}
        onSave={(value) => mutate((stamp) => updateDraft(id, stamp, { postQuestionnaireVersionId: value }))}
      />
      <SelectionCard
        cardId="card-post-review-questionnaire"
        title="Post-review questionnaire"
        description="After the output review, for participants who agreed to see and rate the output of their own recordings. Optional."
        noun="post-review questionnaire"
        selectedId={protocol.postReviewQuestionnaireVersionId}
        selectedLabel={postReview ? `${postReview.name} v${postReview.versionNumber}` : null}
        selectedMeta={
          postReview ? (
            <span className="text-slate-500 tabular-nums">
              {" "}
              ({postReview.items.length} item{postReview.items.length === 1 ? "" : "s"}, {postReview.status})
            </span>
          ) : undefined
        }
        choices={options.postReviewQuestionnaires.map((version) => ({
          id: version.id,
          versionNumber: version.versionNumber,
          label: `${version.name} v${version.versionNumber}`,
        }))}
        allowNone
        manageLink={
          <Link href="/admin/questionnaires" className={linkClass}>
            Open Questionnaires
          </Link>
        }
        editable={editable}
        onSave={(value) => mutate((stamp) => updateDraft(id, stamp, { postReviewQuestionnaireVersionId: value }))}
      />

      <ProseCard
        field="debriefContent"
        title="Debrief text"
        description="Last page: a fuller explanation of the study and contact details."
        help="Do not promise a right or a deletion process that has not been defined for this study (spec 13)."
        detail={detail}
        editable={editable}
        mutate={mutate}
      />
    </div>
  );
}

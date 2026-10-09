"use client";

import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  ConfirmDialog,
  FormField,
  InlineMessage,
  InlineStatus,
  KeyValueList,
  SaveButton,
  Select,
  TextArea,
  TextInput,
  cn,
  confirmDiscardChanges,
  focusRing,
  scrollRegionProps,
  type KeyValueItem,
} from "@/components/ui";
import { activateVersion, cloneVersion, createConfig, deleteDraft, retireVersion, updateConfig } from "./api";
import { mergeParameters, splitParameters } from "./parameters";
import type { ModelConfig, PageContext, PromptVersion, ProviderStatus, SectionDefinition } from "./types";
import { ActivateDialog, StatusBadge, useAction, VersionHistory, VersionMeta, type VersionRow } from "./VersionParts";

type ConfigForm = {
  name: string;
  provider: string;
  modelId: string;
  // Dedicated parameter fields: language (ASR), voice and response_format (TTS).
  fields: Record<string, string>;
  otherJson: string;
  promptVersionId: string;
  notes: string;
};

function formOf(
  section: SectionDefinition,
  version: ModelConfig | undefined,
  activePromptId: string | undefined,
): ConfigForm {
  const split = splitParameters(section.stage, version?.parametersJson ?? {});
  return {
    name: version?.name ?? "",
    // No provider and no model are chosen for the researcher (spec 143).
    provider: version?.provider ?? "",
    modelId: version?.modelId ?? "",
    fields: split.fields,
    otherJson: split.otherJson,
    promptVersionId: version ? (version.promptVersionId ?? "") : (activePromptId ?? ""),
    notes: version?.notes ?? "",
  };
}

function providerLabel(provider: ProviderStatus): string {
  if (provider.isMock) return `${provider.name} (MOCK, not a real model)`;
  return provider.configured ? provider.name : `${provider.name} (not configured on the server)`;
}

function ProviderValue({ name, providers }: { name: string; providers: ProviderStatus[] }) {
  const provider = providers.find((entry) => entry.name === name);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="font-mono text-xs">{name}</span>
      {provider?.isMock && (
        <Badge variant="test" size="sm">
          Mock
        </Badge>
      )}
      {!provider && (
        <Badge variant="error" size="sm">
          Not available on this server
        </Badge>
      )}
      {provider && !provider.isMock && !provider.configured && (
        <Badge variant="warning" size="sm">
          Not configured
        </Badge>
      )}
    </span>
  );
}

function otherParameters(section: SectionDefinition, config: ModelConfig): string | null {
  const { otherJson } = splitParameters(section.stage, config.parametersJson);
  return otherJson === "{}" ? null : otherJson;
}

/** Read-only summary of one config version, with the fields of spec 50. */
function ConfigSummary({
  section,
  config,
  providers,
}: {
  section: SectionDefinition;
  config: ModelConfig;
  providers: ProviderStatus[];
}) {
  const { fields } = splitParameters(section.stage, config.parametersJson);
  const other = otherParameters(section, config);
  const notSet = <span className="text-slate-500">Not set</span>;
  const items: KeyValueItem[] = [
    { label: "Provider", value: <ProviderValue name={config.provider} providers={providers} /> },
    { label: "Model", value: config.modelId, mono: true },
  ];
  if (section.stage === "asr") items.push({ label: "Language hint", value: fields.language || notSet, mono: true });
  if (section.stage === "tts") {
    items.push({ label: "Voice", value: fields.voice || notSet, mono: true });
    items.push({ label: "Output format", value: fields.response_format || notSet, mono: true });
  }
  items.push({
    label: "Prompt version",
    value: config.prompt ? `${config.prompt.key} v${config.prompt.versionNumber} (${config.prompt.status})` : "None",
    mono: true,
  });
  items.push({ label: "Config version", value: `${config.key} v${config.versionNumber}`, mono: true });
  if (config.name) items.push({ label: "Name", value: config.name });
  if (config.notes) items.push({ label: "Notes", value: config.notes });
  return (
    <div className="space-y-3">
      <KeyValueList items={items} columns={2} />
      <div>
        <p className="text-sm font-medium text-slate-700">Parameters</p>
        {other ? (
          <pre
            {...scrollRegionProps(`Parameters of ${config.key} v${config.versionNumber}`)}
            className={cn(
              "mt-1 max-h-40 overflow-y-auto rounded-lg bg-slate-50 p-3 font-mono text-xs whitespace-pre-wrap text-slate-700",
              focusRing,
            )}
          >
            {other}
          </pre>
        ) : (
          <p className="mt-1 text-sm text-slate-500">
            None set. Only the fields above are sent, and nothing is added by the application.
          </p>
        )}
      </div>
    </div>
  );
}

export interface ConfigBlockProps {
  blockId: string;
  section: SectionDefinition;
  /** Every version of the section's config key, newest first. */
  versions: ModelConfig[];
  /** Every version of the section's prompt key, newest first. */
  promptVersions: PromptVersion[];
  page: PageContext;
}

/** The model configuration of one section: active version read-only, draft editor, activation, history. */
export function ConfigBlock({ blockId, section, versions, promptVersions, page }: ConfigBlockProps) {
  const active = versions.find((version) => version.status === "active");
  const draft = versions.find((version) => version.status === "draft");
  const activePrompt = promptVersions.find((version) => version.status === "active");

  const [editing, setEditing] = useState(false);
  const [baseline, setBaseline] = useState<ConfigForm>(() => formOf(section, undefined, undefined));
  const [form, setForm] = useState<ConfigForm>(baseline);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRetire, setConfirmRetire] = useState<VersionRow | null>(null);
  const { pending, error, setError, run } = useAction(page.reload);

  const isDirty = editing && JSON.stringify(form) !== JSON.stringify(baseline);
  const { setDirty } = page;
  useEffect(() => {
    setDirty(blockId, isDirty);
    return () => setDirty(blockId, false);
  }, [blockId, isDirty, setDirty]);

  function startEditing() {
    const start = formOf(section, draft ?? active, activePrompt?.id);
    setBaseline(start);
    setForm(start);
    setSaved(null);
    setError(null);
    setFormError(null);
    setEditing(true);
  }

  function cancelEditing() {
    if (!confirmDiscardChanges(isDirty)) return;
    setEditing(false);
    setError(null);
    setFormError(null);
  }

  async function save() {
    const merged = mergeParameters(section.stage, { fields: form.fields, otherJson: form.otherJson });
    if (!merged.ok) {
      setFormError(merged.error);
      return;
    }
    if (form.provider === "" || form.modelId.trim() === "") {
      setFormError("Choose a provider and enter a model identifier.");
      return;
    }
    setFormError(null);
    const content = {
      name: form.name.trim() === "" ? null : form.name,
      provider: form.provider,
      modelId: form.modelId,
      parameters: merged.parameters,
      promptVersionId: form.promptVersionId === "" ? null : form.promptVersionId,
      notes: form.notes.trim() === "" ? null : form.notes,
    };
    const ok = await run("save", () =>
      draft
        ? updateConfig(draft.id, content)
        : createConfig({ key: section.configKey, stage: section.stage, conditionKey: section.conditionKey, ...content }),
    );
    if (ok) {
      setSaved("Draft saved");
      setEditing(false);
    }
  }

  const busy = pending !== null;
  const usesOlderPrompt =
    active?.prompt && active.activePrompt && active.prompt.id !== active.activePrompt.id ? active : null;
  const pinnedPromptRetiredWithoutActive =
    active?.prompt && !active.activePrompt && active.prompt.status === "retired" ? active : null;

  const providerOptions = page.providers.map((provider) => ({ value: provider.name, label: providerLabel(provider) }));
  if (form.provider !== "" && !page.providers.some((provider) => provider.name === form.provider)) {
    providerOptions.push({ value: form.provider, label: `${form.provider} (not available on this server)` });
  }
  const promptOptions = promptVersions.map((version) => ({
    value: version.id,
    label: `${version.key} v${version.versionNumber} (${version.status})`,
  }));
  const linkedElsewhere = (draft ?? active)?.prompt;
  if (linkedElsewhere && !promptVersions.some((version) => version.id === linkedElsewhere.id)) {
    promptOptions.push({
      value: linkedElsewhere.id,
      label: `${linkedElsewhere.key} v${linkedElsewhere.versionNumber} (${linkedElsewhere.status})`,
    });
  }

  return (
    <div data-testid={`config-block-${section.configKey}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-sm font-semibold text-slate-900">Model configuration</h3>
            {active ? (
              <>
                <StatusBadge status="active" />
                <VersionMeta version={active} timeZone={page.timeZone} />
              </>
            ) : (
              <Badge variant="warning">No active version</Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-slate-500">
            Config key <span className="font-mono">{section.configKey}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <Button size="sm" variant="secondary" onClick={cancelEditing} disabled={busy}>
                Cancel
              </Button>
              <SaveButton size="sm" label="Save draft" isLoading={pending === "save"} onClick={save} />
            </>
          ) : (
            <>
              {saved && <InlineStatus variant="success">{saved}</InlineStatus>}
              <Button size="sm" variant="secondary" onClick={startEditing} disabled={busy}>
                {draft ? "Edit draft" : "Edit"}
              </Button>
            </>
          )}
        </div>
      </div>

      {(error || formError) && (
        <InlineMessage variant="error" className="mt-3">
          {formError ?? error}
        </InlineMessage>
      )}

      {!editing && usesOlderPrompt?.prompt && usesOlderPrompt.activePrompt && (
        <InlineMessage
          variant="warning"
          className="mt-3"
          title={`Uses prompt v${usesOlderPrompt.prompt.versionNumber}, active prompt is v${usesOlderPrompt.activePrompt.versionNumber}`}
        >
          <p>
            This active configuration pins <span className="font-mono">{usesOlderPrompt.prompt.key}</span> v
            {usesOlderPrompt.prompt.versionNumber}. Processing keeps using that version until a new configuration
            version is activated. Nothing is switched automatically.
          </p>
          <div className="mt-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || draft !== undefined}
              title={draft ? "A draft already exists. Edit, activate or delete it first." : undefined}
              loading={pending === "adopt"}
              loadingLabel="Creating draft..."
              onClick={() => {
                setSaved(null);
                void run("adopt", () => cloneVersion("configs", usesOlderPrompt.id, { useActivePrompt: true }));
              }}
            >
              Create config draft with the active prompt
            </Button>
          </div>
        </InlineMessage>
      )}
      {!editing && pinnedPromptRetiredWithoutActive?.prompt && (
        <InlineMessage variant="warning" className="mt-3">
          This active configuration pins <span className="font-mono">{pinnedPromptRetiredWithoutActive.prompt.key}</span>{" "}
          v{pinnedPromptRetiredWithoutActive.prompt.versionNumber}, which is retired, and the prompt has no active
          version.
        </InlineMessage>
      )}

      {editing ? (
        <div className="mt-4 space-y-4">
          <p className="text-xs text-slate-500">
            {draft
              ? `Editing draft v${draft.versionNumber}. The active version stays in use until the draft is activated.`
              : active
                ? `Saving creates a new draft from active v${active.versionNumber}. The active version is not changed.`
                : "Saving creates the first draft of this configuration."}
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <FormField label="Provider" required>
              <Select
                value={form.provider}
                options={providerOptions}
                placeholder="Select a provider"
                onChange={(event) => setForm({ ...form, provider: event.target.value })}
              />
            </FormField>
            <FormField label="Model" required help="The exact model identifier of the provider. Entered by you, never preset.">
              <TextInput
                mono
                value={form.modelId}
                spellCheck={false}
                onChange={(event) => setForm({ ...form, modelId: event.target.value })}
              />
            </FormField>
            {section.stage === "asr" && (
              <FormField label="Language hint" help="Language code of the recordings, for example fi. Leave empty to send none.">
                <TextInput
                  mono
                  value={form.fields.language ?? ""}
                  spellCheck={false}
                  onChange={(event) => setForm({ ...form, fields: { ...form.fields, language: event.target.value } })}
                />
              </FormField>
            )}
            {section.stage === "tts" && (
              <>
                <FormField label="Voice" help="Voice name of the provider. Required before activation.">
                  <TextInput
                    mono
                    value={form.fields.voice ?? ""}
                    spellCheck={false}
                    onChange={(event) => setForm({ ...form, fields: { ...form.fields, voice: event.target.value } })}
                  />
                </FormField>
                <FormField label="Output format" help="Audio format of the synthesized speech.">
                  <Select
                    value={form.fields.response_format ?? ""}
                    options={page.outputFormats.map((format) => ({ value: format, label: format }))}
                    placeholder="Not set"
                    onChange={(event) =>
                      setForm({ ...form, fields: { ...form.fields, response_format: event.target.value } })
                    }
                  />
                </FormField>
              </>
            )}
            <FormField
              label="Prompt version"
              help="The configuration pins exactly this version. A draft prompt must be activated before the configuration."
            >
              <Select
                value={form.promptVersionId}
                options={promptOptions}
                placeholder="None"
                onChange={(event) => setForm({ ...form, promptVersionId: event.target.value })}
              />
            </FormField>
            <FormField label="Name">
              <TextInput value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </FormField>
          </div>
          <FormField
            label="Parameters"
            help="A JSON object with further provider parameters. Use {} for none. Unknown parameters are rejected when saving, and nothing is added that you did not set."
          >
            <TextArea
              mono
              rows={5}
              value={form.otherJson}
              spellCheck={false}
              onChange={(event) => setForm({ ...form, otherJson: event.target.value })}
            />
          </FormField>
          <FormField label="Notes" help="For researchers only. Not sent to any model.">
            <TextArea rows={2} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
          </FormField>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {active ? (
            <ConfigSummary section={section} config={active} providers={page.providers} />
          ) : (
            <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600">
              No model configuration is active for this key. Processing that needs it stops with a clear error. There
              is no built-in provider, model or voice.
            </p>
          )}

          {draft && (
            <div className="rounded-lg border border-dashed border-slate-300 p-3" data-testid="draft-panel">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <StatusBadge status="draft" />
                  <VersionMeta version={draft} timeZone={page.timeZone} />
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)} disabled={busy}>
                    Delete draft
                  </Button>
                  <Button size="sm" onClick={() => setActivating(true)} disabled={busy}>
                    Activate
                  </Button>
                </div>
              </div>
              <div className="mt-3">
                <ConfigSummary section={section} config={draft} providers={page.providers} />
              </div>
            </div>
          )}
        </div>
      )}

      {versions.length > 0 && (
        <VersionHistory
          kind="configs"
          versions={versions}
          timeZone={page.timeZone}
          disabled={busy || editing}
          onClone={(version) => {
            setSaved(null);
            void run("clone", () => cloneVersion("configs", version.id));
          }}
          onRetire={setConfirmRetire}
        />
      )}

      {activating && draft && (
        <ActivateDialog
          kind="configs"
          noun="model configuration"
          draft={draft}
          active={active ?? null}
          notes={["New batches created after this point use the new version."]}
          onActivate={() => {
            setSaved(null);
            return run("activate", () => activateVersion("configs", draft.id));
          }}
          onClose={() => setActivating(false)}
        />
      )}

      <ConfirmDialog
        open={confirmDelete && draft !== undefined}
        title={`Delete draft v${draft?.versionNumber ?? ""}?`}
        confirmLabel="Delete draft"
        tone="danger"
        busy={pending === "delete"}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          if (!draft) return;
          setSaved(null);
          await run("delete", () => deleteDraft("configs", draft.id));
          setConfirmDelete(false);
        }}
      >
        <p>The draft is removed. Active and retired versions are not affected.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmRetire !== null}
        title={`Retire ${section.configKey} v${confirmRetire?.versionNumber ?? ""}?`}
        confirmLabel="Retire version"
        tone="danger"
        busy={pending === "retire"}
        onCancel={() => setConfirmRetire(null)}
        onConfirm={async () => {
          if (!confirmRetire) return;
          await run("retire", () => retireVersion("configs", confirmRetire.id));
          setConfirmRetire(null);
        }}
      >
        <p>
          The key then has no active model configuration. Processing that needs it stops with a clear error until
          another version is activated.
        </p>
        <p>The version stays stored unchanged, and existing model runs and batches are not changed.</p>
      </ConfirmDialog>
    </div>
  );
}

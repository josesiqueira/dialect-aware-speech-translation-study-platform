"use client";

// A published or retired questionnaire version: read-only, with Preview, Clone
// to new draft and Retire.
import { useState } from "react";
import { questionnaireSchemas as s } from "@dialect/domain";
import { Badge, Button, Card, CardBody, CardHeader, ConfirmDialog, InlineMessage, KeyValueList, SectionHeading } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { errorMessage, questionnaireApi } from "./api";
import { STATUS_BADGES, STATUS_LABELS } from "./model";
import { QuestionnairePreview } from "./QuestionnairePreview";

export interface VersionReadOnlyProps {
  version: s.QuestionnaireVersionDetail;
  timeZone: string;
  onCloned: (draft: s.QuestionnaireVersionDetail) => void;
  onRetired: (version: s.QuestionnaireVersionDetail) => void;
}

function describeConfig(item: s.QuestionnaireItemView): string | null {
  const config = item.config ?? {};
  switch (item.type) {
    case "likert": {
      const { min, max } = s.likertBounds(config);
      const labels = [config.scaleMinLabel, config.scaleMaxLabel].filter(Boolean).join(" / ");
      return `Scale ${min} to ${max}${labels ? `: ${labels}` : ""}`;
    }
    case "single_choice":
    case "multi_choice":
      return (config.options ?? []).map((option) => `${option.label} (${option.value})`).join("; ");
    case "integer":
      return config.min !== undefined || config.max !== undefined
        ? `Range: ${config.min ?? "no minimum"} to ${config.max ?? "no maximum"}`
        : null;
    case "short_text":
    case "free_text":
      return config.maxLength ? `At most ${config.maxLength} characters` : null;
    default:
      return null;
  }
}

export function VersionReadOnly({ version, timeZone, onCloned, onRetired }: VersionReadOnlyProps) {
  const [mode, setMode] = useState<"view" | "preview">("view");
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retire, setRetire] = useState<{ busy: boolean; error: string | null } | null>(null);
  const label = `${version.key} v${version.versionNumber}`;

  async function clone() {
    setCloning(true);
    setError(null);
    try {
      onCloned(await questionnaireApi.clone(version.id));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setCloning(false);
    }
  }

  async function confirmRetire() {
    setRetire({ busy: true, error: null });
    try {
      const retired = await questionnaireApi.retire(version.id);
      setRetire(null);
      onRetired(retired);
    } catch (caught) {
      setRetire({ busy: false, error: errorMessage(caught) });
    }
  }

  const uses = version.usedByProtocols;

  return (
    <Card padding="none">
      <CardHeader
        title={<span className="font-mono">{label}</span>}
        meta={<Badge variant={STATUS_BADGES[version.status]}>{STATUS_LABELS[version.status]}</Badge>}
        description="Read-only. A published version never changes."
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={() => setMode(mode === "view" ? "preview" : "view")}>
              {mode === "view" ? "Preview" : "Back to details"}
            </Button>
            {version.status === "published" && (
              <Button size="sm" variant="secondary" onClick={() => setRetire({ busy: false, error: null })}>
                Retire
              </Button>
            )}
            <Button size="sm" onClick={clone} loading={cloning} loadingLabel="Cloning...">
              Clone to new draft
            </Button>
          </>
        }
      />
      {mode === "preview" ? (
        <CardBody>
          <QuestionnairePreview
            name={version.name}
            description={version.description}
            items={version.items}
            versionLabel={`${label} (${version.status})`}
          />
        </CardBody>
      ) : (
        <CardBody className="space-y-6">
          {error && <InlineMessage variant="error">{error}</InlineMessage>}
          <div>
            <h3 className="text-base font-semibold text-slate-900">{version.name}</h3>
            {version.description && <p className="mt-1 text-sm text-slate-600">{version.description}</p>}
          </div>
          <KeyValueList
            items={[
              { label: "Created", value: formatDateTime(version.createdAt, timeZone), mono: true },
              { label: "Published", value: version.publishedAt ? formatDateTime(version.publishedAt, timeZone) : "Not published", mono: true },
              ...(version.retiredAt ? [{ label: "Retired", value: formatDateTime(version.retiredAt, timeZone), mono: true }] : []),
              { label: "Created by", value: version.createdByLabel ?? "Not recorded" },
              {
                label: "Selected by",
                value:
                  uses.length === 0
                    ? "No protocol version"
                    : uses
                        .map((use) => `protocol v${use.versionNumber} (${use.status}${use.isCurrent ? ", current" : ""})`)
                        .join(", "),
              },
            ]}
          />

          <section aria-labelledby={`items-heading-${version.id}`}>
            <SectionHeading
              id={`items-heading-${version.id}`}
              title="Items"
              aside={`${version.items.length} ${version.items.length === 1 ? "item" : "items"}`}
            />
            <ol className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {version.items.map((item, index) => {
                const detail = describeConfig(item);
                return (
                  <li key={item.id} className="flex gap-3 px-4 py-3">
                    <span className="w-5 shrink-0 text-right text-sm text-slate-500 tabular-nums">{index + 1}.</span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900">{item.prompt}</p>
                      {item.helpText && <p className="text-xs text-slate-500">{item.helpText}</p>}
                      <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-slate-500">
                        <span className="font-mono">{item.itemKey}</span>
                        <span>{s.QUESTIONNAIRE_ITEM_TYPE_LABELS[item.type]}</span>
                        <span>{item.required ? "Required" : "Optional"}</span>
                      </p>
                      {detail && <p className="mt-1 text-xs text-slate-600">{detail}</p>}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        </CardBody>
      )}

      <ConfirmDialog
        open={retire !== null}
        title={`Retire ${label}?`}
        tone="danger"
        confirmLabel="Retire version"
        busy={retire?.busy}
        busyLabel="Retiring..."
        error={retire?.error}
        onConfirm={confirmRetire}
        onCancel={() => setRetire(null)}
      >
        <p>
          A retired version stays stored with every answer given to it, and it can still be cloned. It cannot be made
          published again, and it should no longer be selected by a new protocol.
        </p>
        <p>Retiring is refused while the current protocol uses this version.</p>
      </ConfirmDialog>
    </Card>
  );
}

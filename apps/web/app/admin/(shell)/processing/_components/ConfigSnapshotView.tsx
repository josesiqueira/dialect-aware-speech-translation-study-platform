import { KeyValueList, cn, focusRing, scrollRegionProps } from "@/components/ui";
import { configLabel } from "./labels";
import type { ConfigSnapshot } from "./types";

/**
 * One frozen model configuration of a batch, read-only: provider, model,
 * parameters and the exact prompt text that the batch uses.
 */
export function ConfigSnapshotView({ stage, config }: { stage: string; config: ConfigSnapshot }) {
  const parameters = Object.keys(config.parameters).length > 0 ? JSON.stringify(config.parameters) : "none";
  return (
    <div className="space-y-2 rounded-md border border-slate-200 p-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="text-sm font-semibold text-slate-900">{stage}</h4>
        <span className="font-mono text-xs text-slate-700">{configLabel(config)}</span>
        {config.conditionKey && <span className="text-xs text-slate-500">condition {config.conditionKey}</span>}
      </div>
      <KeyValueList
        items={[
          { label: "Provider", value: config.provider, mono: true },
          { label: "Model", value: config.modelId, mono: true },
          { label: "Parameters", value: parameters, mono: true },
          {
            label: "Prompt version",
            value: config.promptKey ? `${config.promptKey} v${config.promptVersionNumber}` : "none",
            mono: true,
          },
        ]}
      />
      {config.promptText !== null && (
        <div>
          <p className="text-xs font-medium text-slate-500">Prompt text</p>
          <pre
            {...scrollRegionProps(`Prompt text of ${stage} ${configLabel(config)}`)}
            className={cn(
              "mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-800",
              focusRing,
            )}
          >
            {config.promptText.length > 0 ? config.promptText : "(empty: no prompt is sent)"}
          </pre>
        </div>
      )}
    </div>
  );
}

/** The ASR, translation and TTS configurations of a snapshot, stacked. */
export function ConfigSnapshotList({
  asr,
  translations,
  tts,
}: {
  asr: ConfigSnapshot | null;
  translations: ConfigSnapshot[];
  tts: ConfigSnapshot[];
}) {
  return (
    <div className="space-y-3">
      {asr ? (
        <ConfigSnapshotView stage="ASR" config={asr} />
      ) : (
        <p className="text-sm text-slate-500">ASR is not part of this batch.</p>
      )}
      {translations.map((config) => (
        <ConfigSnapshotView key={config.modelConfigId} stage="Translation" config={config} />
      ))}
      {translations.length === 0 && <p className="text-sm text-slate-500">Translation is not part of this batch.</p>}
      {tts.map((config) => (
        <ConfigSnapshotView key={config.modelConfigId} stage="TTS" config={config} />
      ))}
      {tts.length === 0 && <p className="text-sm text-slate-500">TTS is not part of this batch.</p>}
    </div>
  );
}

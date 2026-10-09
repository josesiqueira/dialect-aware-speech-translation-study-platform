// The model config form shows a few parameters as their own fields (spec 50):
// the language hint for ASR, the voice and the output format for TTS. They are
// stored in parameters_json next to the other parameters. These helpers move
// them between the stored record and the form.
import type { Stage } from "./types";

export const FIELD_KEYS: Record<Stage, readonly string[]> = {
  asr: ["language"],
  translation: [],
  tts: ["voice", "response_format"],
  realtime_translation: [],
};

export type SplitParameters = {
  // Values of the dedicated fields, as text. Empty text means "not set".
  fields: Record<string, string>;
  // The remaining parameters as formatted JSON.
  otherJson: string;
};

export function splitParameters(stage: Stage, parameters: Record<string, unknown>): SplitParameters {
  const fields: Record<string, string> = {};
  const other: Record<string, unknown> = {};
  for (const key of FIELD_KEYS[stage]) fields[key] = "";
  for (const [key, value] of Object.entries(parameters)) {
    if (FIELD_KEYS[stage].includes(key) && typeof value === "string") fields[key] = value;
    else other[key] = value;
  }
  return { fields, otherJson: Object.keys(other).length === 0 ? "{}" : JSON.stringify(other, null, 2) };
}

export type MergeResult = { ok: true; parameters: Record<string, unknown> } | { ok: false; error: string };

// Builds the record to store. Nothing is added: an empty field is left out.
export function mergeParameters(stage: Stage, split: SplitParameters): MergeResult {
  let other: unknown;
  try {
    other = JSON.parse(split.otherJson.trim() === "" ? "{}" : split.otherJson);
  } catch {
    return { ok: false, error: "The parameters are not valid JSON. Write an object such as {} or {\"speed\": 1}." };
  }
  if (other === null || typeof other !== "object" || Array.isArray(other)) {
    return { ok: false, error: "The parameters must be a JSON object, for example {} or {\"speed\": 1}." };
  }
  const parameters: Record<string, unknown> = { ...(other as Record<string, unknown>) };
  for (const key of FIELD_KEYS[stage]) {
    if (key in parameters) {
      return { ok: false, error: `"${key}" has its own field above. Remove it from the parameters JSON.` };
    }
    const value = (split.fields[key] ?? "").trim();
    if (value !== "") parameters[key] = value;
  }
  return { ok: true, parameters };
}

import type { AiUsage } from "./types";

// Optional operational cost estimate (spec 102).
//
// This package contains no prices. A price table must be supplied by
// configuration. Without one, or when the usage has no number that a supplied
// rate applies to, the result is null. The result is always labelled an
// estimate and must never be treated as scientific data.

export type PricingTable = {
  // Currency code of the rates, for example "USD".
  currency: string;
  inputPerMillionTokens?: number;
  outputPerMillionTokens?: number;
  perAudioMinute?: number;
  perMillionInputCharacters?: number;
};

export type CostEstimate = {
  isEstimate: true;
  amount: number;
  currency: string;
  // Which usage numbers and rates produced the amount.
  basis: Array<{ component: string; quantity: number; rate: number; amount: number }>;
};

export function estimateCost(
  usage: AiUsage | null | undefined,
  pricing: PricingTable | null | undefined,
): CostEstimate | null {
  if (!usage || !pricing) return null;

  const basis: CostEstimate["basis"] = [];
  const add = (component: string, quantity: number | undefined, rate: number | undefined, unit: number) => {
    if (quantity === undefined || rate === undefined) return;
    if (!Number.isFinite(quantity) || !Number.isFinite(rate)) return;
    basis.push({ component, quantity, rate, amount: (quantity / unit) * rate });
  };

  add("input_tokens", usage.inputTokens, pricing.inputPerMillionTokens, 1_000_000);
  add("output_tokens", usage.outputTokens, pricing.outputPerMillionTokens, 1_000_000);
  add("audio_seconds", usage.audioSeconds, pricing.perAudioMinute, 60);
  add("input_characters", usage.inputCharacters, pricing.perMillionInputCharacters, 1_000_000);

  if (basis.length === 0) return null;
  const amount = basis.reduce((sum, part) => sum + part.amount, 0);
  return { isEstimate: true, amount, currency: pricing.currency, basis };
}

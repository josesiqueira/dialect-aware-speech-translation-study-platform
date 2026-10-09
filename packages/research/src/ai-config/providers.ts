// Which AI providers this server offers, for the AI Pipeline page.
import { MOCK_PROVIDER } from "@dialect/ai";
import type { ServiceContext } from "../context";

export type ProviderStatus = {
  name: string;
  // True when the server has what the provider needs (for openai: an API key).
  // Only this yes or no leaves the server, never the key (spec 26).
  configured: boolean;
  // The mock provider never calls a real model.
  isMock: boolean;
};

export function listProviderStatus(ctx: ServiceContext): ProviderStatus[] {
  return ctx.providers.listProviders().map((name) => ({
    name,
    configured: ctx.providers.isConfigured(name),
    isMock: name === MOCK_PROVIDER,
  }));
}

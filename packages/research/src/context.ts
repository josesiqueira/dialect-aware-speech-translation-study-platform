// Every service function takes a ServiceContext as its first argument.
// The web app and the worker each build one from their environment.
import type { ProviderRegistry } from "@dialect/ai";
import type { Database, DbOrTx } from "@dialect/db";
import type { StorageAdapter } from "@dialect/storage";

export type Logger = {
  info: (obj: Record<string, unknown> | string, msg?: string) => void;
  warn: (obj: Record<string, unknown> | string, msg?: string) => void;
  error: (obj: Record<string, unknown> | string, msg?: string) => void;
  debug: (obj: Record<string, unknown> | string, msg?: string) => void;
};

export type ServiceContext = {
  db: Database;
  storage: StorageAdapter;
  // AI providers by name (openai, mock). A provider without credentials throws
  // only when it is requested, so collection works without an API key.
  providers: ProviderRegistry;
  // Injectable clock so tests are deterministic.
  now: () => Date;
  appVersion: string;
  gitCommitSha: string | null;
  // Who is acting: "admin" (or an annotator label) for researcher actions,
  // null for participant and system actions.
  actorLabel: string | null;
  logger: Logger;
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

export type { DbOrTx };

// Structured logger for the worker (spec 68). Two layers keep secrets out:
// 1. pino `redact` removes well-known keys (authorization, apiKey, password, ...).
// 2. Every serialized line is scanned for the configured secret values, so a key
//    that a provider echoes inside an error message is also replaced.
//
// Handlers log ids, job type, status and duration. Never log job payload text,
// transcripts or audio.
import pino, { type Logger as PinoLogger } from "pino";

const REDACTED = "[REDACTED]";

const SENSITIVE_KEYS = [
  "authorization",
  "Authorization",
  "cookie",
  "password",
  "apiKey",
  "api_key",
  "secret",
  "token",
  "accessKeyId",
  "secretAccessKey",
  "OPENAI_API_KEY",
  "S3_SECRET_ACCESS_KEY",
  "S3_ACCESS_KEY_ID",
  "DATABASE_URL",
];

// Matches the key at the top level and nested up to three objects deep.
function redactPaths(): string[] {
  return SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`]);
}

export type CreateWorkerLoggerOptions = {
  level?: string;
  // Secret values to replace wherever they appear in a log line.
  secrets?: string[];
  // Destination for serialized lines. Defaults to standard output.
  write?: (line: string) => void;
};

export function createWorkerLogger(options: CreateWorkerLoggerOptions = {}): PinoLogger {
  const secrets = (options.secrets ?? []).filter((value) => value.length >= 8);
  // A secret inside a JSON string may be escaped, so both forms are replaced.
  const needles = [...new Set(secrets.flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)]))];
  const write = options.write ?? ((line: string) => void process.stdout.write(line));

  return pino(
    {
      level: options.level ?? "info",
      base: { service: "worker" },
      redact: { paths: redactPaths(), censor: REDACTED },
    },
    {
      write(line: string) {
        let safe = line;
        for (const needle of needles) {
          if (safe.includes(needle)) safe = safe.split(needle).join(REDACTED);
        }
        write(safe);
      },
    },
  );
}

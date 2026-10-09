// Structured logger (spec 68). Two layers keep secrets out of the log:
// 1. pino `redact` removes well-known keys (authorization, cookie, password, apiKey, ...).
// 2. Every serialized line is scanned for the configured secret values themselves, so a
//    key that a provider echoes back inside an error message is also replaced.
//
// Logging rules for route handlers and services: log ids, route, status and duration.
// Never log request bodies, transcripts, audio or consent answers.
import "server-only";
import pino, { type Logger as PinoLogger } from "pino";

const REDACTED = "[REDACTED]";

const SENSITIVE_KEYS = [
  "authorization",
  "Authorization",
  "cookie",
  "Cookie",
  "set-cookie",
  "password",
  "apiKey",
  "api_key",
  "secret",
  "token",
  "OPENAI_API_KEY",
  "ADMIN_PASSWORD",
  "ADMIN_SESSION_SECRET",
  "S3_SECRET_ACCESS_KEY",
  "S3_ACCESS_KEY_ID",
  "DATABASE_URL",
];

function quote(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : `["${key}"]`;
}

// Matches the key at the top level and nested up to three objects deep
// (for example `req.headers.cookie` or `err.config.headers.authorization`).
function redactPaths(): string[] {
  const paths: string[] = [];
  for (const key of SENSITIVE_KEYS) {
    const k = quote(key);
    const join = k.startsWith("[") ? "" : ".";
    paths.push(k);
    paths.push(`*${join}${k}`, `*.*${join}${k}`, `*.*.*${join}${k}`);
  }
  return paths;
}

export type CreateLoggerOptions = {
  level?: string;
  // Secret values to replace wherever they appear in a log line.
  secrets?: Array<string | undefined | null>;
  // Destination for serialized lines. Defaults to standard output.
  write?: (line: string) => void;
};

export function createLogger(options: CreateLoggerOptions = {}): PinoLogger {
  // Short values would match ordinary text, so only values of 8 or more characters are scanned for.
  const secrets = (options.secrets ?? []).filter(
    (value): value is string => typeof value === "string" && value.length >= 8,
  );
  // A secret inside a JSON string may be escaped, so both forms are replaced.
  const needles = [...new Set(secrets.flatMap((s) => [s, JSON.stringify(s).slice(1, -1)]))];
  const write = options.write ?? ((line: string) => void process.stdout.write(line));

  return pino(
    {
      level: options.level ?? "info",
      base: { service: "web" },
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

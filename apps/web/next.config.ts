import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { NextConfig } from "next";

const repositoryRoot = path.join(import.meta.dirname, "../../");

// The single .env file lives at the repository root (shared with the worker and the
// database scripts). Next.js only reads .env files in apps/web, so the root file is
// loaded here. Variables that are already set win, and NODE_ENV is left to Next.js.
function loadRootEnvFile(): void {
  const file = path.join(repositoryRoot, ".env");
  if (!existsSync(file)) return;
  const parsed = parseEnv(readFileSync(file, "utf8"));
  for (const [name, value] of Object.entries(parsed)) {
    if (name === "NODE_ENV") continue;
    if (process.env[name] === undefined && value !== undefined) process.env[name] = value;
  }
}
loadRootEnvFile();

const isProduction = process.env.NODE_ENV === "production";

// Static security headers for every response (spec 67). The Content Security Policy
// for HTML pages needs a per-request nonce and is set in proxy.ts.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  // The recorder needs the microphone. Camera and geolocation are never used.
  { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=()" },
  ...(isProduction
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
    : []),
];

const nextConfig: NextConfig = {
  // Workspace packages are consumed as TypeScript source.
  transpilePackages: [
    "@dialect/domain",
    "@dialect/db",
    "@dialect/storage",
    "@dialect/ai",
    "@dialect/research",
  ],
  outputFileTracingRoot: repositoryRoot,
  // The container image is built with NEXT_OUTPUT=standalone (docker/web.Dockerfile):
  // Next.js then writes .next/standalone with server.js and only the traced files.
  // Without the variable the build stays a normal one, so `next start` keeps working.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const } : {}),
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        // API responses are data, never documents: nothing in them may load or run.
        // media-src lets a browser play an audio response that an admin opens directly.
        source: "/api/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "default-src 'none'; media-src 'self'; frame-ancestors 'none'" },
        ],
      },
      {
        // Admin responses contain transcripts and audio metadata (spec 67).
        source: "/api/admin/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, private" }],
      },
      {
        source: "/api/study/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default nextConfig;

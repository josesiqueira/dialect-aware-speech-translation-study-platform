// Content Security Policy for HTML pages (spec 67), following the Next.js 16 guide
// (node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md).
// proxy.ts creates a fresh nonce per request and calls buildContentSecurityPolicy().
// The other security headers are static and live in next.config.ts.
//
// No "server-only" import here: this file is pure and proxy.ts loads it on every request.

export type CspOptions = {
  nonce: string;
  // Development needs 'unsafe-eval' (React debugging features) and a websocket for hot reload.
  isDevelopment: boolean;
  // Adds upgrade-insecure-requests. Only for deployments served over HTTPS.
  upgradeInsecureRequests: boolean;
};

export function buildContentSecurityPolicy(options: CspOptions): string {
  const directives = [
    "default-src 'self'",
    // Next.js puts the nonce on its own script tags. 'strict-dynamic' lets those scripts load their chunks.
    `script-src 'self' 'nonce-${options.nonce}' 'strict-dynamic'${options.isDevelopment ? " 'unsafe-eval'" : ""}`,
    // React `style` attributes (used by the chart library and for dynamic sizes) need 'unsafe-inline'.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    // Recording playback uses blob: URLs.
    "media-src 'self' blob:",
    // The audio worklet module and any worker are loaded from the app or from a blob: URL.
    "worker-src 'self' blob:",
    // The browser talks only to this app. No provider is called from the browser (spec 26).
    `connect-src 'self'${options.isDevelopment ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (options.upgradeInsecureRequests) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export function generateNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

// Checks the Content Security Policy of a running deployment in a real browser.
//
// It opens the welcome page, signs in to the admin, opens every admin page, then
// starts a TEST session and runs the microphone check, which loads the recorder
// worklet (/worklets/pcm-capture.worklet.js). It fails when the browser reports
// a Content Security Policy violation, a console error or a page error.
//
// Usage (from the repository root, against a production build):
//   CHECK_BASE_URL=https://study.example.org CHECK_ADMIN_PASSWORD=... node scripts/check-production-csp.mjs
//
// Options (environment variables):
//   CHECK_BASE_URL            address of the deployment (required)
//   CHECK_ADMIN_PASSWORD      admin password (required, never printed)
//   CHECK_IGNORE_TLS_ERRORS   "true" accepts a self-signed certificate (local tests only)
//   CHECK_TOLERATE_BLOCKED_EVAL  "true" lists blocked eval calls without failing
//
// The session it starts has mode "test", so it never becomes research data. The
// browser uses a built-in test microphone, so no audio hardware is needed and the
// microphone check audio stays in the browser.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Playwright is a development dependency of the web app.
const require = createRequire(path.join(repositoryRoot, "apps/web/package.json"));
const { chromium } = require("@playwright/test");

const baseURL = process.env.CHECK_BASE_URL;
const adminPassword = process.env.CHECK_ADMIN_PASSWORD;
if (!baseURL || !adminPassword) {
  console.error("Set CHECK_BASE_URL and CHECK_ADMIN_PASSWORD.");
  process.exit(2);
}

const ADMIN_PAGES = [
  "/admin",
  "/admin/sessions",
  "/admin/review",
  "/admin/study-flow",
  "/admin/ai-pipeline",
  "/admin/processing",
  "/admin/questionnaires",
  "/admin/data",
  "/admin/settings",
];
const WORKLET_PATH = "/worklets/pcm-capture.worklet.js";

const tolerateBlockedEval = process.env.CHECK_TOLERATE_BLOCKED_EVAL === "true";
const problems = [];
const tolerated = [];
const policies = new Map();
let currentStep = "start";

function note(kind, text) {
  problems.push({ step: currentStep, kind, text });
}

const browser = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const context = await browser.newContext({
  baseURL,
  ignoreHTTPSErrors: process.env.CHECK_IGNORE_TLS_ERRORS === "true",
  permissions: ["microphone"],
});
// Reports every violation with its directive and the blocked resource.
await context.addInitScript(() => {
  document.addEventListener("securitypolicyviolation", (event) => {
    console.error(
      `CSP-VIOLATION directive=${event.violatedDirective} effective=${event.effectiveDirective} ` +
        `blocked=${event.blockedURI} source=${event.sourceFile}:${event.lineNumber}`,
    );
  });
});
const page = await context.newPage();
page.on("console", (message) => {
  const text = message.text();
  if (text.startsWith("CSP-VIOLATION")) {
    // A blocked eval means the policy did its work and nothing was loaded. Zod 4 probes
    // for eval with `Function("")` inside try and catch. It is still listed.
    const blockedEval = / blocked=eval /.test(text);
    if (blockedEval && tolerateBlockedEval) tolerated.push({ step: currentStep, text });
    else note("csp", text);
  }
  else if (message.type() === "error" && !(tolerateBlockedEval && /unsafe-eval/.test(text))) note("console error", text);
});
page.on("pageerror", (error) => note("page error", String(error)));
page.on("response", (response) => {
  const url = new URL(response.url());
  if (response.request().resourceType() === "document") {
    const policy = response.headers()["content-security-policy"];
    if (policy) policies.set(url.pathname, policy);
  }
});

async function open(pathname) {
  currentStep = pathname;
  const response = await page.goto(pathname, { waitUntil: "networkidle" });
  console.log(`${String(response?.status() ?? "?").padEnd(4)} ${pathname}`);
  return response;
}

try {
  // 1. Welcome page.
  await open("/");

  // 2. Admin login through the real form, then every admin page.
  await open("/admin/login");
  await page.locator("#admin-password").fill(adminPassword);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL((url) => url.pathname === "/admin", { timeout: 15_000 });
  await page.waitForLoadState("networkidle");
  console.log("ok   admin sign-in, landed on /admin");
  for (const adminPage of ADMIN_PAGES) await open(adminPage);

  // 3. Participant flow as a TEST session, up to the microphone check.
  await open("/?mode=test");
  currentStep = "participant flow";
  await page.getByRole("button", { name: "English" }).click();
  await page.getByRole("button", { name: "Begin" }).click();
  await page.waitForURL("**/study");
  await page.getByRole("button", { name: "Continue to consent" }).click();
  // Required consent items only. The optional reuse item stays unchecked.
  for (const box of await page.getByRole("checkbox").all()) {
    const name = (await box.getAttribute("aria-label")) ?? (await box.evaluate((el) => el.labels?.[0]?.textContent ?? ""));
    if (!/reused in later research/i.test(name)) await box.check();
  }
  await page.getByRole("button", { name: "I agree and continue" }).click();
  currentStep = "microphone check";
  const micCheck = page.getByTestId("mic-check");
  await micCheck.getByRole("button", { name: "Allow microphone" }).click();
  await micCheck.getByRole("button", { name: "Record test" }).click();
  await micCheck.and(page.locator('[data-state="stopped"]')).waitFor({ timeout: 20_000 });
  // The page reports which recorder it used. "audio_worklet_pcm" means the worklet
  // module was loaded and ran; "media_recorder" means the page fell back.
  const [micCheckRequest] = await Promise.all([
    page.waitForRequest((request) => new URL(request.url()).pathname === "/api/study/mic-check"),
    micCheck.getByRole("button", { name: "Continue" }).click(),
  ]);
  const captureMethod = micCheckRequest.postDataJSON()?.audioEnvironment?.captureMethod ?? null;
  const workletFile = await context.request.get(WORKLET_PATH);
  console.log(
    `ok   microphone check finished, capture method: ${captureMethod}, ` +
      `${WORKLET_PATH}: ${workletFile.status()} ${workletFile.headers()["content-type"] ?? ""}`,
  );
  if (captureMethod !== "audio_worklet_pcm") {
    note("worklet", `the recorder did not use the worklet (capture method: ${captureMethod})`);
  }
  if (workletFile.status() !== 200) note("worklet", `${WORKLET_PATH} answered ${workletFile.status()}`);

  // End the test session so that it does not stay open.
  currentStep = "end participation";
  await page.evaluate(async () => {
    await fetch("/api/study/session/withdraw", { method: "POST" });
  });
} catch (error) {
  note("script", String(error));
} finally {
  await browser.close();
}

const scriptPolicy = [...policies.values()][0] ?? "";
console.log("");
console.log(`Pages with a Content-Security-Policy header: ${policies.size}`);
console.log(`Policy (nonce shortened): ${scriptPolicy.replace(/'nonce-[^']+'/, "'nonce-...'")}`);
for (const [pathname, policy] of policies) {
  if (!/script-src[^;]*'nonce-/.test(policy) || !/script-src[^;]*'strict-dynamic'/.test(policy)) {
    problems.push({ step: pathname, kind: "policy", text: "script-src has no nonce or no 'strict-dynamic'" });
  }
  if (/script-src[^;]*'unsafe-eval'/.test(policy)) {
    problems.push({ step: pathname, kind: "policy", text: "script-src contains 'unsafe-eval' (development policy)" });
  }
}

if (tolerated.length > 0) {
  console.log(`\nBlocked eval calls (listed, not counted as failures): ${tolerated.length}`);
  for (const item of tolerated) console.log(`  [${item.step}] ${item.text}`);
}

if (problems.length > 0) {
  console.log(`\nFAILED: ${problems.length} problem(s)`);
  for (const problem of problems) console.log(`  [${problem.step}] ${problem.kind}: ${problem.text}`);
  process.exit(1);
}
console.log(
  tolerated.length > 0
    ? "\nPASSED: apart from the blocked eval calls listed above, no Content Security Policy violation, console error or page error."
    : "\nPASSED: no Content Security Policy violation, console error or page error.",
);

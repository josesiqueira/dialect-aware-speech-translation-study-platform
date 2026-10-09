// Browser test of the recorder on /dev/recorder with Chromium's test microphone
// (--use-fake-ui-for-media-stream --use-fake-device-for-media-stream).
// It checks the capture path end to end: mic check, lossless PCM WAV, honest
// sample rate, playback, re-recording, upload failure and retry, and that no
// audio leaves the page.
import { readFile } from "node:fs/promises";
import { expect, test, type Page, type Request } from "@playwright/test";
import { ISOLATED } from "./support/env";

// /dev/recorder exists only in a development build. The isolated stack runs the
// production image, where the page answers 404 (docs/DEPLOYMENT.md, section 9),
// so these tests run only against a development server: pnpm test:e2e
test.skip(ISOLATED, "/dev/recorder is a development page and answers 404 in the production image of the isolated run");

/** Reads the fields of a canonical 44-byte PCM WAV header. */
function readWavHeader(bytes: Buffer) {
  return {
    riff: bytes.toString("latin1", 0, 4),
    riffSize: bytes.readUInt32LE(4),
    wave: bytes.toString("latin1", 8, 12),
    fmt: bytes.toString("latin1", 12, 16),
    format: bytes.readUInt16LE(20),
    channels: bytes.readUInt16LE(22),
    sampleRate: bytes.readUInt32LE(24),
    byteRate: bytes.readUInt32LE(28),
    blockAlign: bytes.readUInt16LE(32),
    bitDepth: bytes.readUInt16LE(34),
    data: bytes.toString("latin1", 36, 40),
    dataSize: bytes.readUInt32LE(40),
  };
}

/** "loaded" when an audio element can read the URL, "error" when it cannot (a revoked blob URL). */
function probeAudioUrl(page: Page, url: string): Promise<string> {
  return page.evaluate(
    (source) =>
      new Promise<string>((resolve) => {
        const audio = new Audio();
        audio.preload = "metadata";
        audio.onloadedmetadata = () => resolve("loaded");
        audio.onerror = () => resolve("error");
        setTimeout(() => resolve("timeout"), 5000);
        audio.src = source;
      }),
    url,
  );
}

async function fact(page: Page, name: string): Promise<string> {
  return (await page.getByTestId(`fact-${name}`).innerText()).trim();
}

test("mic check, lossless recording, re-record, upload failure and retry, no audio leaves the page", async ({ page }) => {
  const consoleProblems: string[] = [];
  const cspViolations: string[] = [];
  const requests: Request[] = [];

  page.on("console", (message) => {
    const text = message.text();
    if (/content security policy/i.test(text)) cspViolations.push(text);
    if (message.type() === "error") consoleProblems.push(text);
  });
  page.on("pageerror", (error) => consoleProblems.push(String(error)));
  page.on("request", (request) => requests.push(request));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(`Content Security Policy violation: ${event.violatedDirective} blocked ${event.blockedURI}`);
    });
  });

  await page.goto("/dev/recorder");
  await expect(page.getByRole("heading", { name: "Recorder test page" })).toBeVisible();

  // The microphone is not requested on page load.
  const micCheck = page.getByTestId("mic-check");
  await expect(micCheck).toHaveAttribute("data-state", "idle");
  await expect(micCheck.getByRole("button", { name: "Allow microphone" })).toBeVisible();

  // --- Mic check (spec 6.3) ---
  await micCheck.getByRole("button", { name: "Allow microphone" }).click();
  await micCheck.getByRole("button", { name: "Record test" }).click();
  await expect(micCheck).toHaveAttribute("data-state", "recording");
  await expect(page.getByTestId("mic-check-announcement")).toHaveText("Recording started.");
  // The test stops by itself after about 5 seconds.
  await expect(micCheck).toHaveAttribute("data-state", "stopped", { timeout: 15_000 });
  // Playback is the native player alone (no second Play button). Keyboard focus is on it when
  // the test stops, so Space plays the test.
  await expect(micCheck.getByRole("button", { name: "Play" })).toHaveCount(0);
  await expect(micCheck.locator("audio")).toBeFocused();
  await page.keyboard.press("Space");
  await expect
    .poll(() => micCheck.locator("audio").evaluate((audio: HTMLAudioElement) => audio.currentTime > 0 || audio.ended))
    .toBe(true);
  const micCheckAudioUrl = await micCheck.locator("audio source").getAttribute("src");
  expect(micCheckAudioUrl).toMatch(/^blob:/);
  await micCheck.getByRole("button", { name: "Continue" }).click();

  const micCheckResult = JSON.parse(await page.getByTestId("mic-check-result").innerText());
  expect(micCheckResult.audioEnvironment.captureMethod).toBe("audio_worklet_pcm");
  expect(micCheckResult.audioEnvironment.requestedConstraints).toMatchObject({
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  });
  expect(typeof micCheckResult.audioEnvironment.audioContextSampleRate).toBe("number");
  expect(micCheckResult.browserInfo.userAgent).toContain("Chrome");
  // The result carries settings only. Nothing in it is audio.
  expect(JSON.stringify(micCheckResult)).not.toContain("blob:");
  // The test recording was dropped when the participant continued.
  expect(await probeAudioUrl(page, micCheckAudioUrl!)).toBe("error");

  // --- Recording task: first attempt (about two seconds) ---
  const frame = page.locator("[data-state]").filter({ has: page.getByTestId("recording-announcement") });
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(frame).toHaveAttribute("data-state", "recording");
  await expect(page.getByTestId("recording-announcement")).toHaveText("Recording started.");
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(frame).toHaveAttribute("data-state", "stopped");

  expect(await fact(page, "attempt")).toBe("1");
  expect(await fact(page, "capture-method")).toBe("audio_worklet_pcm");
  expect(await fact(page, "quality-class")).toBe("lossless_pcm");
  expect(await fact(page, "mime-type")).toBe("audio/wav");
  expect(await fact(page, "bit-depth")).toBe("16");
  expect(await fact(page, "channels")).toBe("1");
  expect(await fact(page, "stopped-by")).toBe("user");
  const sampleRate = Number(await fact(page, "sample-rate"));
  const contextRate = Number(await fact(page, "context-rate"));
  const trackRate = await fact(page, "track-rate");
  const durationMs = Number(await fact(page, "duration-ms"));
  const sizeBytes = Number(await fact(page, "size-bytes"));
  const peak = Number(await fact(page, "peak"));
  expect(sampleRate).toBe(contextRate);
  expect(sampleRate).toBeGreaterThanOrEqual(8000);
  expect(durationMs).toBeGreaterThan(1500);
  expect(durationMs).toBeLessThan(4000);
  // The test microphone produces beeps, so the signal is not silent.
  expect(peak).toBeGreaterThan(0);
  console.log(
    `Recorder facts: file rate ${sampleRate} Hz, AudioContext rate ${contextRate} Hz, track rate ${trackRate}, ` +
      `duration ${durationMs} ms, size ${sizeBytes} bytes, peak ${peak}, ` +
      `input channels ${await fact(page, "input-channels")}, mismatches ${await fact(page, "mismatches")}, settings ${await fact(page, "settings")}`,
  );

  // The downloaded file is a PCM WAV whose header sizes are exact and whose rate is the context rate.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("download-candidate").click(),
  ]);
  const wav = await readFile(await download.path());
  const header = readWavHeader(wav);
  expect(wav.length).toBe(sizeBytes);
  expect(header.riff).toBe("RIFF");
  expect(header.wave).toBe("WAVE");
  expect(header.fmt).toBe("fmt ");
  expect(header.data).toBe("data");
  expect(header.format).toBe(1);
  expect(header.channels).toBe(1);
  expect(header.bitDepth).toBe(16);
  expect(header.blockAlign).toBe(2);
  expect(header.sampleRate).toBe(contextRate);
  expect(header.byteRate).toBe(contextRate * 2);
  expect(header.dataSize).toBe(wav.length - 44);
  expect(header.riffSize).toBe(wav.length - 8);
  expect(Math.abs((header.dataSize / 2 / header.sampleRate) * 1000 - durationMs)).toBeLessThan(1);

  // Playback with the native audio element.
  const taskAudio = frame.locator("audio");
  const firstUrl = await fact(page, "blob-url");
  expect(await taskAudio.locator("source").getAttribute("src")).toBe(firstUrl);
  await taskAudio.evaluate((audio: HTMLAudioElement) => audio.play());
  await expect.poll(() => taskAudio.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0);
  await taskAudio.evaluate((audio: HTMLAudioElement) => audio.pause());
  expect(await probeAudioUrl(page, firstUrl)).toBe("loaded");

  // --- Record again: attempt 2, the first candidate is revoked ---
  await page.getByRole("button", { name: "Record again" }).click();
  await expect(frame).toHaveAttribute("data-state", "recording");
  expect(await probeAudioUrl(page, firstUrl)).toBe("error");
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(frame).toHaveAttribute("data-state", "stopped");
  expect(await fact(page, "attempt")).toBe("2");
  const secondUrl = await fact(page, "blob-url");
  expect(secondUrl).not.toBe(firstUrl);

  // --- Upload failure, then retry without re-recording ---
  await page.getByLabel("Simulate upload failure once").check();
  await page.getByRole("button", { name: "Submit and continue" }).click();
  await expect(frame).toHaveAttribute("data-state", "upload_failed");
  await expect(page.getByTestId("recording-announcement")).toHaveText(/Upload failed/);
  // The candidate is kept: same attempt, same blob URL, still playable.
  expect(await fact(page, "attempt")).toBe("2");
  expect(await fact(page, "blob-url")).toBe(secondUrl);
  expect(await probeAudioUrl(page, secondUrl)).toBe("loaded");

  await page.getByRole("button", { name: "Try uploading again" }).click();
  await expect(page.locator('[data-state="submitted"]')).toBeVisible();
  const logEntries = page.getByTestId("submit-log").locator("li");
  await expect(logEntries).toHaveCount(2);
  await expect(logEntries.nth(0)).toHaveAttribute("data-outcome", "failed");
  await expect(logEntries.nth(1)).toHaveAttribute("data-outcome", "accepted");
  // Both submits carried the same recording and the attempt count 2.
  await expect(logEntries.nth(0)).toHaveAttribute("data-url", secondUrl);
  await expect(logEntries.nth(1)).toHaveAttribute("data-url", secondUrl);
  await expect(logEntries.nth(1)).toHaveAttribute("data-attempt", "2");
  // After the confirmed submit the candidate is released.
  await expect(page.getByTestId("no-candidate")).toBeVisible();
  expect(await probeAudioUrl(page, secondUrl)).toBe("error");

  // --- No audio left the page ---
  const networkRequests = requests.filter((request) => /^https?:/.test(request.url()));
  const withBody = networkRequests.filter((request) => request.method() !== "GET" && request.method() !== "HEAD");
  const audioUploads = withBody.filter((request) => {
    const contentType = request.headers()["content-type"] ?? "";
    const body = request.postDataBuffer();
    return (
      /audio\/|multipart\/form-data|octet-stream/i.test(contentType) ||
      (body !== null && (body.length > 10_000 || body.includes("RIFF") || body.includes("WAVE")))
    );
  });
  expect(audioUploads.map((request) => `${request.method()} ${request.url()}`)).toEqual([]);
  expect(withBody.map((request) => `${request.method()} ${request.url()}`)).toEqual([]);

  // --- Content Security Policy: the worklet loaded and nothing was blocked ---
  // (The capture method "audio_worklet_pcm" asserted above proves that the worklet module was loaded.
  // A blocked module would have produced the compressed fallback and a violation message.)
  expect(cspViolations).toEqual([]);
  // The three probes of revoked blob URLs above each log one "file not found" error. Nothing else may appear.
  const revokedProbe = "Failed to load resource: net::ERR_FILE_NOT_FOUND";
  expect(consoleProblems.filter((text) => text !== revokedProbe)).toEqual([]);
  expect(consoleProblems.filter((text) => text === revokedProbe)).toHaveLength(3);
});

test("the compressed recorder is marked as compressed fallback, never as lossless", async ({ page }) => {
  await page.goto("/dev/recorder");
  await page.getByLabel("Use the compressed recorder (MediaRecorder)").check();
  const frame = page.locator("[data-state]").filter({ has: page.getByTestId("recording-announcement") });
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(frame).toHaveAttribute("data-state", "recording");
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(frame).toHaveAttribute("data-state", "stopped");

  expect(await fact(page, "capture-method")).toBe("media_recorder");
  expect(await fact(page, "quality-class")).toBe("compressed_fallback");
  expect(await fact(page, "mime-type")).toBe("audio/webm;codecs=opus");
  expect(await fact(page, "bit-depth")).toBe("null");
  expect(await fact(page, "context-rate")).toBe("null");
  expect(Number(await fact(page, "duration-ms"))).toBeGreaterThan(1000);
  expect(Number(await fact(page, "size-bytes"))).toBeGreaterThan(0);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("download-candidate").click(),
  ]);
  const bytes = await readFile(await download.path());
  // EBML magic number: the file is WebM (Matroska family), not WAV.
  expect(bytes.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
});

test("the recorder stops by itself at the maximum duration", async ({ page }) => {
  await page.goto("/dev/recorder");
  const micCheck = page.getByTestId("mic-check");
  await micCheck.getByRole("button", { name: "Allow microphone" }).click();
  const started = Date.now();
  await micCheck.getByRole("button", { name: "Record test" }).click();
  await expect(micCheck).toHaveAttribute("data-state", "stopped", { timeout: 15_000 });
  // The 5 second test limit ended the recording without a press on Stop.
  expect(Date.now() - started).toBeGreaterThan(4500);
  const duration = await micCheck.locator("audio").evaluate(
    (audio: HTMLAudioElement) =>
      new Promise<number>((resolve) => {
        if (Number.isFinite(audio.duration)) resolve(audio.duration);
        else audio.addEventListener("loadedmetadata", () => resolve(audio.duration), { once: true });
      }),
  );
  // The limit is enforced on the sample count, so the file is exactly 5 seconds long.
  expect(duration).toBeCloseTo(5, 2);
});

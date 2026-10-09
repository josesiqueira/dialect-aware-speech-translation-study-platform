// Helpers shared by the admin specs (e2e/admin-*.spec.ts).
//
// The admin specs run only in the isolated environment (pnpm test:e2e:isolated),
// in file name order, with one worker. They share one database:
//   - three sample TEST sessions from scripts/seed-test-sessions.ts. The first
//     two have human transcripts and a completed mock batch, the third is as
//     collected (no transcripts);
//   - the seeded study content: protocol v1 published, protocol v2 as a draft.
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { expect, type APIRequestContext, type Download, type Page } from "@playwright/test";
import { BASE_URL } from "./env";

export type SessionListItem = {
  id: string;
  participantCode: string;
  mode: "research" | "test" | "demo";
  status: string;
  startedAt: string;
  protocolVersionNumber: number;
  utteranceCount: number;
  flagged: boolean;
  review: { verifiedB?: number; verifiedC?: number } & Record<string, unknown>;
};

/** GET an admin API route with the signed-in session of the context. */
export async function getJson<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.status(), `GET ${path}`).toBe(200);
  return (await response.json()) as T;
}

/**
 * A state-changing admin API call. The server refuses such a request without a
 * same-origin proof, so the Origin header is sent as a browser would send it.
 */
export async function sendJson<T>(
  request: APIRequestContext,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  data?: unknown,
): Promise<T> {
  const response = await request.fetch(path, {
    method,
    headers: { Origin: new URL(BASE_URL).origin },
    ...(data === undefined ? {} : { data }),
  });
  expect(response.status(), `${method} ${path}: ${await response.text()}`).toBe(200);
  return (await response.json()) as T;
}

/** The TEST sessions, oldest first: index 0 and 1 are processed, index 2 is as collected. */
export async function testSessions(request: APIRequestContext): Promise<SessionListItem[]> {
  const list = await getJson<{ items: SessionListItem[] }>(
    request,
    "/api/admin/sessions?mode=test&sort=started_at&direction=asc&pageSize=100",
  );
  return list.items;
}

/** The three sample TEST sessions of the seed, oldest first. */
export async function sampleSessions(request: APIRequestContext): Promise<SessionListItem[]> {
  const all = await testSessions(request);
  expect(all.length, "sample TEST sessions in the e2e database").toBeGreaterThanOrEqual(3);
  return all.slice(0, 3);
}

/**
 * What an export or a batch with the default "completed sessions only" selects
 * from the TEST data: the sample sessions, plus the short sessions that the
 * pipeline test of the AI Pipeline spec leaves behind.
 */
export async function completedTestCorpus(
  request: APIRequestContext,
): Promise<{ sessions: SessionListItem[]; utterances: number }> {
  const sessions = (await testSessions(request)).filter((session) => session.status === "completed");
  return { sessions, utterances: sessions.reduce((sum, session) => sum + session.utteranceCount, 0) };
}

/** Reads a finished download into memory. */
export async function downloadBytes(download: Download): Promise<Buffer> {
  const file = await download.path();
  return readFileSync(file);
}

export type ZipEntry = { name: string; data: () => Buffer };

/**
 * Minimal ZIP reader for the assertions on exported archives: it reads the
 * central directory and supports the two methods the export uses (stored and
 * deflate). No ZIP64, which a test archive of a few megabytes never needs.
 */
export function readZip(bytes: Buffer): Map<string, ZipEntry> {
  const END_SIGNATURE = 0x06054b50;
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== END_SIGNATURE) end -= 1;
  if (end < 0) throw new Error("Not a ZIP archive: no end of central directory record.");
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const entries = new Map<string, ZipEntry>();
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Broken ZIP central directory.");
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength);
    entries.set(name, {
      name,
      data: () => {
        const localNameLength = bytes.readUInt16LE(localOffset + 26);
        const localExtraLength = bytes.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const raw = bytes.subarray(start, start + compressedSize);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return inflateRawSync(raw);
        throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);
      },
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Opens an admin page and waits for its heading. */
export async function openAdminPage(page: Page, path: string, heading: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
}

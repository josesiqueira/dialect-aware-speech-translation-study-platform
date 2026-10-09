import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAll, runAdapterContract, SAMPLE_KEY } from "../testing/adapterContract";
import { LocalFilesystemStorage } from "./LocalFilesystemStorage";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "dialect-storage-test-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function hasSha256sum(): boolean {
  try {
    execFileSync("sha256sum", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("LocalFilesystemStorage", () => {
  runAdapterContract(() => new LocalFilesystemStorage({ root }));

  it("has the driver name local", () => {
    expect(new LocalFilesystemStorage({ root }).driver).toBe("local");
  });

  it("writes the file under the root at the path given by the key", async () => {
    const storage = new LocalFilesystemStorage({ root });
    await storage.put({ key: SAMPLE_KEY, body: Buffer.from("audio"), contentType: "audio/wav" });
    expect(await fs.readFile(path.join(root, ...SAMPLE_KEY.split("/")), "utf8")).toBe("audio");
  });

  it.skipIf(!hasSha256sum())("computes the same hash as sha256sum", async () => {
    const storage = new LocalFilesystemStorage({ root });
    const data = randomBytes(300_000);
    const stored = await storage.put({
      key: "a/random.bin",
      body: Readable.from([data.subarray(0, 100_000), data.subarray(100_000)]),
      contentType: "application/octet-stream",
    });
    const output = execFileSync("sha256sum", [path.join(root, "a", "random.bin")], { encoding: "utf8" });
    expect(stored.sha256).toBe(output.split(/\s+/)[0]);
    expect(stored.sizeBytes).toBe(300_000);
  });

  it("does not make the object visible before the write has finished", async () => {
    const storage = new LocalFilesystemStorage({ root });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* slowBody(): AsyncGenerator<Buffer> {
      yield Buffer.from("first half, ");
      await gate;
      yield Buffer.from("second half");
    }
    const pending = storage.put({ key: "a/slow.bin", body: Readable.from(slowBody()), contentType: "x/y" });

    // Wait until the temporary file exists, then look for the final file.
    const tempDir = path.join(root, ".tmp");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const entries = await fs.readdir(tempDir).catch(() => [] as string[]);
      if (entries.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await fs.readdir(tempDir)).length).toBe(1);
    expect(await storage.exists("a/slow.bin")).toBe(false);
    await expect(storage.get("a/slow.bin")).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND" });

    release();
    await pending;
    expect((await readAll(await storage.get("a/slow.bin"))).toString()).toBe("first half, second half");
    expect(await fs.readdir(tempDir)).toEqual([]);
  });

  it("removes the temporary file when the upload fails", async () => {
    const storage = new LocalFilesystemStorage({ root });
    const failing = new Readable({
      read() {
        this.push(Buffer.from("partial"));
        this.destroy(new Error("connection lost"));
      },
    });
    await expect(storage.put({ key: "a/failed.bin", body: failing, contentType: "x/y" })).rejects.toMatchObject({
      code: "STORAGE_ERROR",
    });
    expect(await fs.readdir(path.join(root, ".tmp"))).toEqual([]);
    await expect(fs.stat(path.join(root, "a", "failed.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the temporary file when the key already exists", async () => {
    const storage = new LocalFilesystemStorage({ root });
    await storage.put({ key: "a/once.bin", body: Buffer.from("1"), contentType: "x/y" });
    await expect(storage.put({ key: "a/once.bin", body: Buffer.from("2"), contentType: "x/y" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await fs.readdir(path.join(root, ".tmp"))).toEqual([]);
  });

  it("never writes outside the root for a traversal key", async () => {
    const nested = path.join(root, "media");
    const storage = new LocalFilesystemStorage({ root: nested });
    await expect(
      storage.put({ key: "../escaped.bin", body: Buffer.from("x"), contentType: "x/y" }),
    ).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    await expect(fs.stat(path.join(root, "escaped.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats a directory as a missing object", async () => {
    const storage = new LocalFilesystemStorage({ root });
    await storage.put({ key: "a/b/file.bin", body: Buffer.from("x"), contentType: "x/y" });
    expect(await storage.exists("a/b")).toBe(false);
    expect(await storage.stat("a/b")).toBeNull();
    await expect(storage.get("a/b")).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND" });
  });

  it("creates the root on first use and leaves no probe file after a health check", async () => {
    const fresh = path.join(root, "not", "created", "yet");
    const storage = new LocalFilesystemStorage({ root: fresh });
    const health = await storage.healthCheck();
    expect(health.ok).toBe(true);
    expect(await fs.readdir(path.join(fresh, ".tmp"))).toEqual([]);
  });

  it("reports an unwritable root in the health check", async () => {
    const blocker = path.join(root, "blocker");
    await fs.writeFile(blocker, "a file where the root directory should be");
    const storage = new LocalFilesystemStorage({ root: path.join(blocker, "media") });
    const health = await storage.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("not writable");
  });

  it("refuses a relative root and a root inside a public directory", () => {
    expect(() => new LocalFilesystemStorage({ root: "data/media" })).toThrowError(
      expect.objectContaining({ code: "CONFIGURATION_MISSING" }),
    );
    expect(() => new LocalFilesystemStorage({ root: path.join(root, "public", "media") })).toThrowError(
      expect.objectContaining({ code: "CONFIGURATION_MISSING" }),
    );
  });
});

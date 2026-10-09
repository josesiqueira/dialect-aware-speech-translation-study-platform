import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryStorage, createStorage, findRepositoryRoot, storageConfigFromEnv } from "./config";
import { LocalFilesystemStorage } from "./drivers/LocalFilesystemStorage";
import { S3CompatibleStorage } from "./drivers/S3CompatibleStorage";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe("findRepositoryRoot", () => {
  it("finds the directory containing pnpm-workspace.yaml from a nested directory", () => {
    const root = findRepositoryRoot(import.meta.dirname);
    expect(root).not.toBeNull();
    expect(existsSync(path.join(root as string, "pnpm-workspace.yaml"))).toBe(true);
    expect(existsSync(path.join(root as string, "packages", "storage", "package.json"))).toBe(true);
  });

  it("returns null outside a workspace", () => {
    expect(findRepositoryRoot(path.parse(os.tmpdir()).root)).toBeNull();
  });
});

describe("storageConfigFromEnv", () => {
  it("resolves a relative LOCAL_STORAGE_ROOT against the repository root, not the working directory", () => {
    const repositoryRoot = findRepositoryRoot(import.meta.dirname) as string;
    // Tests run with packages/storage as the working directory.
    expect(process.cwd()).not.toBe(repositoryRoot);
    expect(storageConfigFromEnv({ STORAGE_DRIVER: "local", LOCAL_STORAGE_ROOT: "./data/media" })).toEqual({
      driver: "local",
      localRoot: path.join(repositoryRoot, "data", "media"),
    });
  });

  it("uses the explicit base directory when one is given", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "dialect-config-test-"));
    tempDirs.push(baseDir);
    expect(storageConfigFromEnv({ LOCAL_STORAGE_ROOT: "media" }, { baseDir })).toEqual({
      driver: "local",
      localRoot: path.join(baseDir, "media"),
    });
  });

  it("keeps an absolute LOCAL_STORAGE_ROOT as it is", () => {
    const absolute = path.join(os.tmpdir(), "dialect-media");
    expect(storageConfigFromEnv({ STORAGE_DRIVER: "local", LOCAL_STORAGE_ROOT: absolute })).toEqual({
      driver: "local",
      localRoot: absolute,
    });
  });

  it("requires LOCAL_STORAGE_ROOT for the local driver", () => {
    expect(() => storageConfigFromEnv({ STORAGE_DRIVER: "local" })).toThrowError(
      expect.objectContaining({ code: "CONFIGURATION_MISSING", message: expect.stringContaining("LOCAL_STORAGE_ROOT") }),
    );
    expect(() => storageConfigFromEnv({ STORAGE_DRIVER: "local", LOCAL_STORAGE_ROOT: "  " })).toThrowError(
      expect.objectContaining({ code: "CONFIGURATION_MISSING" }),
    );
  });

  it("reads the S3 settings", () => {
    expect(
      storageConfigFromEnv({
        STORAGE_DRIVER: "s3",
        S3_ENDPOINT: "https://objects.example.org",
        S3_REGION: "eu-north-1",
        S3_BUCKET: "dialect",
        S3_ACCESS_KEY_ID: "key",
        S3_SECRET_ACCESS_KEY: "secret",
        S3_FORCE_PATH_STYLE: "true",
      }),
    ).toEqual({
      driver: "s3",
      endpoint: "https://objects.example.org",
      region: "eu-north-1",
      bucket: "dialect",
      accessKeyId: "key",
      secretAccessKey: "secret",
      forcePathStyle: true,
    });
  });

  it("treats an empty S3_ENDPOINT as not set and defaults path style to false", () => {
    const config = storageConfigFromEnv({
      STORAGE_DRIVER: "s3",
      S3_ENDPOINT: "",
      S3_REGION: "eu-north-1",
      S3_BUCKET: "dialect",
      S3_ACCESS_KEY_ID: "key",
      S3_SECRET_ACCESS_KEY: "secret",
    });
    expect(config).toEqual({
      driver: "s3",
      region: "eu-north-1",
      bucket: "dialect",
      accessKeyId: "key",
      secretAccessKey: "secret",
      forcePathStyle: false,
    });
    expect("endpoint" in config).toBe(false);
  });

  it("names every missing S3 setting", () => {
    expect(() => storageConfigFromEnv({ STORAGE_DRIVER: "s3", S3_REGION: "eu-north-1" })).toThrowError(
      expect.objectContaining({
        code: "CONFIGURATION_MISSING",
        message: "Missing S3 storage settings: S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY.",
      }),
    );
  });

  it("rejects an unknown driver and a malformed path style flag", () => {
    expect(() => storageConfigFromEnv({ STORAGE_DRIVER: "ftp" })).toThrowError(
      expect.objectContaining({ code: "CONFIGURATION_MISSING", message: expect.stringContaining("STORAGE_DRIVER") }),
    );
    expect(() =>
      storageConfigFromEnv({
        STORAGE_DRIVER: "s3",
        S3_REGION: "r",
        S3_BUCKET: "b",
        S3_ACCESS_KEY_ID: "k",
        S3_SECRET_ACCESS_KEY: "s",
        S3_FORCE_PATH_STYLE: "yes please",
      }),
    ).toThrowError(expect.objectContaining({ code: "CONFIGURATION_MISSING" }));
  });
});

describe("createStorage", () => {
  it("creates the local driver", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dialect-config-test-"));
    tempDirs.push(root);
    const storage = createStorage({ driver: "local", localRoot: root });
    expect(storage).toBeInstanceOf(LocalFilesystemStorage);
    expect(storage.driver).toBe("local");
    expect((await storage.healthCheck()).ok).toBe(true);
  });

  it("creates the S3 driver", () => {
    const storage = createStorage({
      driver: "s3",
      region: "eu-north-1",
      bucket: "dialect",
      accessKeyId: "key",
      secretAccessKey: "secret",
      forcePathStyle: false,
    });
    expect(storage).toBeInstanceOf(S3CompatibleStorage);
    expect(storage.driver).toBe("s3");
  });

  it("creates the in-memory driver for tests", () => {
    expect(createInMemoryStorage().driver).toBe("memory");
  });
});

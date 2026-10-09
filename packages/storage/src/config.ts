// Storage configuration and driver factory.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "@dialect/domain";
import { InMemoryStorage } from "./drivers/InMemoryStorage";
import { LocalFilesystemStorage } from "./drivers/LocalFilesystemStorage";
import { S3CompatibleStorage } from "./drivers/S3CompatibleStorage";
import type { StorageAdapter } from "./StorageAdapter";

export type StorageConfig =
  | { driver: "local"; localRoot: string }
  | {
      driver: "s3";
      endpoint?: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
    };

export type StorageConfigOptions = {
  // Directory against which a relative LOCAL_STORAGE_ROOT is resolved. When
  // omitted, the repository root (the directory containing pnpm-workspace.yaml)
  // is used.
  baseDir?: string;
};

const WORKSPACE_FILE = "pnpm-workspace.yaml";

// Walks up from `startDir` to the directory containing pnpm-workspace.yaml.
// Returns null when no such directory exists.
export function findRepositoryRoot(startDir: string = process.cwd()): string | null {
  let current = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(current, WORKSPACE_FILE))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function moduleDirectory(): string | null {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

function missing(message: string, details?: unknown): AppError {
  return new AppError("CONFIGURATION_MISSING", message, details);
}

function read(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

// Reads STORAGE_DRIVER, LOCAL_STORAGE_ROOT and S3_* from the given environment.
//
// A relative LOCAL_STORAGE_ROOT is resolved against the repository root, not the
// current working directory, because the web app runs from apps/web and the worker
// from apps/worker and both must use the same directory. The repository root is
// found by walking up to pnpm-workspace.yaml, first from the current working
// directory and then from this source file. Pass `options.baseDir` to choose the
// base directory explicitly. In a deployment without pnpm-workspace.yaml (for
// example a container image), set LOCAL_STORAGE_ROOT to an absolute path.
export function storageConfigFromEnv(
  env: Record<string, string | undefined>,
  options: StorageConfigOptions = {},
): StorageConfig {
  const driver = read(env, "STORAGE_DRIVER") ?? "local";

  if (driver === "local") {
    const configuredRoot = read(env, "LOCAL_STORAGE_ROOT");
    if (!configuredRoot) {
      throw missing("LOCAL_STORAGE_ROOT is required when STORAGE_DRIVER is \"local\".", {
        missing: ["LOCAL_STORAGE_ROOT"],
      });
    }
    if (path.isAbsolute(configuredRoot)) {
      return { driver: "local", localRoot: path.resolve(configuredRoot) };
    }
    const moduleDir = moduleDirectory();
    const baseDir =
      options.baseDir ?? findRepositoryRoot() ?? (moduleDir ? findRepositoryRoot(moduleDir) : null);
    if (!baseDir) {
      throw missing(
        "LOCAL_STORAGE_ROOT is a relative path and the repository root (the directory containing " +
          "pnpm-workspace.yaml) was not found. Set LOCAL_STORAGE_ROOT to an absolute path.",
        { missing: ["LOCAL_STORAGE_ROOT"] },
      );
    }
    return { driver: "local", localRoot: path.resolve(baseDir, configuredRoot) };
  }

  if (driver === "s3") {
    const required = ["S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
    const absent = required.filter((name) => !read(env, name));
    if (absent.length > 0) {
      throw missing(`Missing S3 storage settings: ${absent.join(", ")}.`, { missing: absent });
    }
    const forcePathStyleText = (read(env, "S3_FORCE_PATH_STYLE") ?? "false").toLowerCase();
    if (!["true", "false", "1", "0"].includes(forcePathStyleText)) {
      throw missing('S3_FORCE_PATH_STYLE must be "true" or "false".', {
        invalid: ["S3_FORCE_PATH_STYLE"],
      });
    }
    const endpoint = read(env, "S3_ENDPOINT");
    return {
      driver: "s3",
      ...(endpoint ? { endpoint } : {}),
      region: read(env, "S3_REGION") as string,
      bucket: read(env, "S3_BUCKET") as string,
      accessKeyId: read(env, "S3_ACCESS_KEY_ID") as string,
      secretAccessKey: read(env, "S3_SECRET_ACCESS_KEY") as string,
      forcePathStyle: forcePathStyleText === "true" || forcePathStyleText === "1",
    };
  }

  throw missing(`STORAGE_DRIVER must be "local" or "s3" (received "${driver}").`, {
    invalid: ["STORAGE_DRIVER"],
  });
}

export function createStorage(config: StorageConfig): StorageAdapter {
  switch (config.driver) {
    case "local":
      return new LocalFilesystemStorage({ root: config.localRoot });
    case "s3":
      return new S3CompatibleStorage(config);
    default:
      throw missing("Unknown storage driver.");
  }
}

// Storage for unit tests in other packages.
export function createInMemoryStorage(): InMemoryStorage {
  return new InMemoryStorage();
}

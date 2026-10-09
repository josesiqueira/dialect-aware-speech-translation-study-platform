import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Rules that apply to every source file of this package.

const srcDir = dirname(fileURLToPath(import.meta.url));

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

const allFiles = listFiles(srcDir);
const sourceFiles = allFiles.filter((file) => !file.endsWith(".test.ts"));

describe("package source rules", () => {
  it("finds the source files", () => {
    expect(sourceFiles.length).toBeGreaterThan(10);
  });

  it("has no model identifier literals in non-test source (spec 25, 143)", () => {
    // Model identifiers come from the database configuration through the input.
    const patterns = [/gpt-/i, /whisper-/i, /\btts-1/i, /\bo[1-9]-(mini|preview|pro)/i, /davinci/i];
    const hits: string[] = [];
    for (const file of sourceFiles) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (patterns.some((pattern) => pattern.test(line))) {
          hits.push(`${relative(srcDir, file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it("has no em dash, and no en dash, in non-test source and the README", () => {
    const emDash = String.fromCharCode(0x2014);
    const enDash = String.fromCharCode(0x2013);
    const files = [...sourceFiles, join(srcDir, "..", "README.md")];
    const hits = files.filter((file) => {
      const text = readFileSync(file, "utf8");
      return text.includes(emDash) || text.includes(enDash);
    });
    expect(hits.map((file) => relative(srcDir, file))).toEqual([]);
  });

  it("does not read the API key from the environment inside the package", () => {
    const hits = sourceFiles.filter((file) => readFileSync(file, "utf8").includes("process.env"));
    expect(hits.map((file) => relative(srcDir, file))).toEqual([]);
  });
});

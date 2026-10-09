// Style check (docs/IMPLEMENTATION-PLAN.md, global constraint 5): fails when a
// source or documentation file contains the em dash character, or an en dash
// used as a sentence break (an en dash with a space on both sides).
//
// Usage: pnpm check:style        (or: node scripts/check-no-em-dash.mjs)
//
// Files checked: every file Git tracks, plus files that are not yet tracked and
// not ignored. Left out: node_modules, .next, binary files, the lockfile, and the
// user's original documents (docs/IMPLEMENTATION-SPEC.md, IMPLEMENT_THIS_*.md,
// initial_research_prompt-*.md).
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Built from character codes so that this file passes its own check.
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH_BREAK = ` ${String.fromCharCode(0x2013)} `;

const EXCLUDED_DIRECTORIES = ["node_modules/", ".next/"];
const EXCLUDED_FILES = [/^docs\/IMPLEMENTATION-SPEC\.md$/, /^IMPLEMENT_THIS_[^/]*\.md$/, /^initial_research_prompt-[^/]*\.md$/, /^pnpm-lock\.yaml$/,
  // Generated and re-added by `next dev`; not ours to edit.
  /^apps\/web\/AGENTS\.md$/,
];
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".wav", ".webm", ".ogg", ".mp3", ".mp4",
  ".m4a", ".woff", ".woff2", ".ttf", ".tsbuildinfo",
]);
const MAX_BYTES = 5 * 1024 * 1024;

function listFiles() {
  const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: repositoryRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.toString("utf8").split("\0").filter(Boolean);
}

function isChecked(file) {
  if (EXCLUDED_DIRECTORIES.some((directory) => file.startsWith(directory) || file.includes(`/${directory}`))) return false;
  if (EXCLUDED_FILES.some((pattern) => pattern.test(file))) return false;
  if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) return false;
  return true;
}

const hits = [];
let checked = 0;
for (const file of listFiles()) {
  if (!isChecked(file)) continue;
  const absolute = path.join(repositoryRoot, file);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    continue; // listed by Git but removed from the working tree
  }
  if (!stats.isFile() || stats.size > MAX_BYTES) continue;
  const buffer = readFileSync(absolute);
  if (buffer.includes(0)) continue; // binary content
  checked += 1;
  const lines = buffer.toString("utf8").split("\n");
  lines.forEach((line, index) => {
    if (line.includes(EM_DASH)) hits.push({ file, line: index + 1, kind: "em dash" });
    if (line.includes(EN_DASH_BREAK)) hits.push({ file, line: index + 1, kind: "en dash between spaces" });
  });
}

if (hits.length > 0) {
  console.error(`Style check failed: ${hits.length} hit(s) in ${new Set(hits.map((hit) => hit.file)).size} file(s).`);
  for (const hit of hits) console.error(`  ${hit.file}:${hit.line}  ${hit.kind}`);
  console.error("Use a comma, a colon, parentheses or a separate sentence instead.");
  process.exit(1);
}
console.log(`Style check passed: ${checked} files, no em dash and no en dash used as a sentence break.`);

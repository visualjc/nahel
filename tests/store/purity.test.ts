import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_DIR = join(import.meta.dir, "../../src");
const STORE_DIR = join(SRC_DIR, "store");

const EXPECTED_STORE_FILES = [
  "actor.ts",
  "frontmatter.ts",
  "hotstate.ts",
  "journal.ts",
  "layout.ts",
  "mutate.ts",
  "rotate.ts",
];

/** fs imports are the store layer's exclusive privilege. */
const FS_IMPORT = /from\s+["'](node:)?(fs|fs\/promises)["']/;

/** Network and process spawning belong to no layer in this codebase. */
const FORBIDDEN_EVERYWHERE = /from\s+["'](node:)?(net|http|https|http2|dns|tls|child_process|worker_threads)["']/;

/** Ambient I/O and environment access forbidden in the store layer. */
const FORBIDDEN_GLOBALS = [/\bfetch\s*\(/, /\bBun\.(file|write|spawn|serve|env)\b/, /\bprocess\.env\b/];

/** Ambient time/randomness — env.ts (schema layer) is the single source. */
const AMBIENT_TIME_RANDOMNESS = [/\bDate\b/, /\bMath\.random\b/, /\bcrypto\b/];

function tsFilesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...tsFilesUnder(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("store layer owns ALL fs I/O", () => {
  test("src/store contains exactly the seven store modules", () => {
    expect(readdirSync(STORE_DIR).sort()).toEqual(EXPECTED_STORE_FILES);
  });

  test("no file outside src/store imports fs — the store is the only layer touching the filesystem", () => {
    const offenders = tsFilesUnder(SRC_DIR)
      .filter((path) => !path.startsWith(STORE_DIR + "/"))
      .filter((path) => FS_IMPORT.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC_DIR, path));
    expect(offenders).toEqual([]);
  });

  test("no file anywhere in src/ reaches for the network or child processes", () => {
    const offenders = tsFilesUnder(SRC_DIR)
      .filter((path) => FORBIDDEN_EVERYWHERE.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC_DIR, path));
    expect(offenders).toEqual([]);
  });

  for (const file of EXPECTED_STORE_FILES) {
    test(`store/${file} uses no ambient environment, time, or randomness (Env is injected)`, () => {
      const source = readFileSync(join(STORE_DIR, file), "utf8");
      for (const pattern of [...FORBIDDEN_GLOBALS, ...AMBIENT_TIME_RANDOMNESS]) {
        expect(source).not.toMatch(pattern);
      }
    });
  }
});

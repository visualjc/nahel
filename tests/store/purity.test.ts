import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_DIR = join(import.meta.dir, "../../src");
const STORE_DIR = join(SRC_DIR, "store");

const EXPECTED_STORE_FILES = [
  "actor.ts",
  "baseline.ts",
  "frontmatter.ts",
  "hotstate.ts",
  "journal.ts",
  "layout.ts",
  "mutate.ts",
  "rotate.ts",
];

/** fs imports are the store layer's exclusive privilege. */
const FS_IMPORT = /from\s+["'](node:)?(fs|fs\/promises)["']/;

/** The network belongs to no layer in this codebase. */
const FORBIDDEN_EVERYWHERE = /from\s+["'](node:)?(net|http|https|http2|dns|tls)["']/;

/**
 * Process spawning is store-layer I/O with exactly one legitimate use:
 * baseline.ts spawning `git` for claim baselines and handback evidence
 * (PRD F9). Everywhere else it stays forbidden.
 */
const PROCESS_SPAWN_IMPORT = /from\s+["'](node:)?(child_process|worker_threads)["']/;

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
  test("src/store contains exactly the known store modules", () => {
    expect(readdirSync(STORE_DIR).sort()).toEqual(EXPECTED_STORE_FILES);
  });

  test("no file outside src/store imports fs — the store is the only layer touching the filesystem", () => {
    const offenders = tsFilesUnder(SRC_DIR)
      .filter((path) => !path.startsWith(STORE_DIR + "/"))
      .filter((path) => FS_IMPORT.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC_DIR, path));
    expect(offenders).toEqual([]);
  });

  test("no file anywhere in src/ reaches for the network", () => {
    const offenders = tsFilesUnder(SRC_DIR)
      .filter((path) => FORBIDDEN_EVERYWHERE.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC_DIR, path));
    expect(offenders).toEqual([]);
  });

  test("spawning processes is store/baseline.ts's exclusive privilege (git evidence capture)", () => {
    const baselinePath = join(STORE_DIR, "baseline.ts");
    const offenders = tsFilesUnder(SRC_DIR)
      .filter((path) => path !== baselinePath)
      .filter((path) => PROCESS_SPAWN_IMPORT.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC_DIR, path));
    expect(offenders).toEqual([]);
    // The exemption is load-bearing, not decorative: baseline.ts really does
    // spawn git through child_process (and nothing broader).
    const source = readFileSync(baselinePath, "utf8");
    expect(source).toMatch(/from\s+["']node:child_process["']/);
    expect(source).not.toMatch(/worker_threads/);
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

describe("command and template layers are pure over the store", () => {
  // Commands are thin verbs: all I/O flows through src/store, all time and
  // randomness through the injected Env. Templates are pure strings. Only the
  // cli.ts entry point may touch the ambient process (argv, cwd, exit).
  for (const layer of ["commands", "templates"]) {
    test(`src/${layer} files use no ambient environment, time, or randomness`, () => {
      const files = tsFilesUnder(join(SRC_DIR, layer));
      expect(files.length).toBeGreaterThan(0);
      for (const path of files) {
        const source = readFileSync(path, "utf8");
        for (const pattern of [...FORBIDDEN_GLOBALS, ...AMBIENT_TIME_RANDOMNESS]) {
          expect(source).not.toMatch(pattern);
        }
      }
    });
  }

  test("src/templates modules import nothing at all — pure string templates", () => {
    for (const path of tsFilesUnder(join(SRC_DIR, "templates"))) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(/^\s*import\s/m);
    }
  });
});

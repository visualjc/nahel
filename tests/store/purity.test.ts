import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_DIR = join(import.meta.dir, "../../src");
const STORE_DIR = join(SRC_DIR, "store");

const EXPECTED_STORE_FILES = [
  "actor.ts",
  "baseline.ts",
  "ccpm.ts",
  "dispatch.ts",
  "frontmatter.ts",
  "healthcheck.ts",
  "hotstate.ts",
  "journal.ts",
  "layout.ts",
  "mutate.ts",
  "rotate.ts",
  "skills.ts",
];

/** fs imports are the store layer's exclusive privilege. */
const FS_IMPORT = /from\s+["'](node:)?(fs|fs\/promises)["']/;

/** The network belongs to no layer in this codebase. */
const FORBIDDEN_EVERYWHERE = /from\s+["'](node:)?(net|http|https|http2|dns|tls)["']/;

/**
 * Process spawning is store-layer I/O with exactly four legitimate uses:
 * baseline.ts spawning `git` for claim baselines and handback evidence
 * (PRD F9), healthcheck.ts spawning the run contract's healthcheck (PRD F2),
 * skills.ts spawning `git` / the `skills` CLI to fetch pinned skills
 * (PRD F7, ADR-0009), and dispatch.ts spawning the routed agent CLI
 * (Phase 2 F1.4, ADR-0016 — the allowlist joined deliberately). Everywhere
 * else it stays forbidden.
 */
const PROCESS_SPAWN_IMPORT = /from\s+["'](node:)?(child_process|worker_threads)["']/;
const SPAWN_ALLOWED = ["baseline.ts", "dispatch.ts", "healthcheck.ts", "skills.ts"];

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

  test("spawning processes is store-layer I/O, limited to baseline.ts (git), healthcheck.ts (contract), skills.ts and dispatch.ts (agent CLI)", () => {
    const allowedPaths = SPAWN_ALLOWED.map((name) => join(STORE_DIR, name));
    const offenders = tsFilesUnder(SRC_DIR)
      .filter((path) => !allowedPaths.includes(path))
      .filter((path) => PROCESS_SPAWN_IMPORT.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC_DIR, path));
    expect(offenders).toEqual([]);
    // The exemptions are load-bearing, not decorative: each allowed file really
    // does spawn through child_process (and nothing broader).
    for (const path of allowedPaths) {
      const source = readFileSync(path, "utf8");
      expect(source).toMatch(/from\s+["']node:child_process["']/);
      expect(source).not.toMatch(/worker_threads/);
    }
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

describe("command, template, view, and validate layers are pure over the store", () => {
  // Commands are thin verbs: all I/O flows through src/store, all time and
  // randomness through the injected Env. Templates are pure strings. Views
  // are pure functions over store reads (task #7); validate's checks are pure
  // functions over collected store reads (task #9); install's agent table and
  // shim rendering are pure functions the install command drives (task #11);
  // dispatch's routing resolution and invocation composition are pure
  // functions of committed config plus the task args (Phase 2 F1).
  // Only the cli.ts entry point may touch the ambient process (argv, cwd, exit).
  for (const layer of ["commands", "dispatch", "install", "templates", "views", "validate"]) {
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

  test("dispatch reaches no model API: no LLM endpoints, no API keys, no HTTP client (F1.4)", () => {
    // Hard constraint 1 made mechanical for the one verb that launches models:
    // dispatch composes an argv and spawns a CLI — the agent CLI holds its own
    // credentials, and nahel never names, reads, or forwards them.
    const dispatchFiles = [
      ...tsFilesUnder(join(SRC_DIR, "dispatch")),
      join(SRC_DIR, "store", "dispatch.ts"),
      join(SRC_DIR, "commands", "dispatch.ts"),
    ];
    expect(dispatchFiles.length).toBeGreaterThan(2);
    for (const path of dispatchFiles) {
      const source = readFileSync(path, "utf8");
      for (const pattern of [
        /API_KEY/i,
        /\bfetch\s*\(/,
        /api\.anthropic\.com|api\.openai\.com/,
        FORBIDDEN_EVERYWHERE,
        /\bprocess\.env\b/,
      ]) {
        expect(source).not.toMatch(pattern);
      }
    }
  });

  test("src/templates modules import nothing at all — pure string templates", () => {
    for (const path of tsFilesUnder(join(SRC_DIR, "templates"))) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(/^\s*import\s/m);
    }
  });
});

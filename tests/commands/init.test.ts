import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main, type CommandContext } from "../../src/cli";
import type { Env } from "../../src/schema/env";
import { readJournal } from "../../src/store/journal";
import { readConfig, readItem, storeLayout } from "../../src/store/layout";
import { createStoreContext, mutate } from "../../src/store/mutate";
import { makeFrontmatter, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel init` (PRD F2, task #4): non-interactive scaffold of nahel/ +
 * config + knowledge templates. Run through the real CLI dispatch (main),
 * against real temp dirs that are real git repos — no mocks.
 */

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Fresh temp dir initialized as an empty git repo. */
async function makeRepo(): Promise<string> {
  const dir = await makeTempDir("nahel-init-");
  tempDirs.push(dir);
  const proc = Bun.spawn(["git", "init", "-q"], { cwd: dir });
  expect(await proc.exited).toBe(0);
  return dir;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Drive the CLI in-process with captured output and an injected Env. */
async function runCli(args: string[], cwd: string, env: Env = seededEnv()): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    env,
    cwd,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  const code = await main(args, ctx);
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

describe("nahel init — scaffold", () => {
  test("creates the full nahel/ structure in an empty git repo", async () => {
    const root = await makeRepo();
    const result = await runCli(["init"], root);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const layout = storeLayout(root);
    for (const dir of [
      layout.nahelDir,
      layout.itemsDir,
      layout.runsDir,
      layout.journalDir,
      layout.journalArchiveDir,
      layout.observationsDir,
    ]) {
      expect(existsSync(dir)).toBe(true);
    }
    expect(existsSync(layout.configPath)).toBe(true);
  });

  test("after init, the store works end-to-end: context + mutate + read back + journal", async () => {
    const root = await makeRepo();
    const env = seededEnv();
    expect((await runCli(["init"], root, env)).code).toBe(0);

    // The acceptance smoke check: every other store operation immediately works.
    const ctx = await createStoreContext(root, env);
    const frontmatter = makeFrontmatter(env, { name: "first-item" });
    const { event } = await mutate(ctx, {
      target: "item",
      eventType: "item.created",
      frontmatter,
      body: "The very first work item.\n",
    });

    const layout = storeLayout(root);
    const readBack = await readItem(layout, frontmatter.id);
    expect(readBack.frontmatter).toEqual(frontmatter);
    expect(readBack.body).toBe("The very first work item.\n");

    const events = [];
    for await (const e of readJournal(layout)) events.push(e);
    expect(events.map((e) => e.id)).toContain(event.id);
    expect(events[0]?.type).toBe("item.created");
  });

  test("is fully non-interactive: real CLI process with no stdin completes", async () => {
    const root = await makeRepo();
    const cliPath = join(import.meta.dir, "../../src/cli.ts");
    const proc = Bun.spawn(["bun", "run", cliPath, "init"], {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(stderr).toBe("");
    expect(existsSync(join(root, "nahel", "config"))).toBe(true);
    expect(existsSync(join(root, "PRODUCT.md"))).toBe(true);
  });
});

describe("nahel init — templates", () => {
  test("emits PRODUCT.md with the frozen heading contract and the change-log sign-off rule", async () => {
    const root = await makeRepo();
    await runCli(["init"], root);
    const product = readFileSync(join(root, "PRODUCT.md"), "utf8");

    // Frozen contract: brief (PRD F7) extracts these two headings VERBATIM.
    expect(product).toMatch(/^## Goal$/m);
    expect(product).toMatch(/^## Hard constraints$/m);

    // Constitution skeleton mirrors the blessed structure.
    expect(product).toMatch(/^## Domain facts$/m);
    expect(product).toMatch(/^## Non-goals$/m);
    expect(product).toMatch(/^## Governance$/m);
    expect(product).toMatch(/^## Change log$/m);

    // The change-log section explains the sign-off rule.
    expect(product.toLowerCase()).toContain("sign-off");
    // Seed entry is stamped with the injected clock's date (seededEnv default).
    expect(product).toContain("2026-07-16");
  });

  test("emits CONTEXT.md glossary skeleton and AGENTS.md conversational entry point", async () => {
    const root = await makeRepo();
    await runCli(["init"], root);

    const context = readFileSync(join(root, "CONTEXT.md"), "utf8");
    expect(context.length).toBeGreaterThan(0);
    expect(context.toLowerCase()).toContain("glossary");

    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("nahel brief");
    // Hard constraint 3: agents mutate through the CLI, never hand-edit state.
    expect(agents.toLowerCase()).toContain("never hand-edit");
  });

  test("identical inputs produce byte-identical output (deterministic CLI)", async () => {
    const rootA = await makeRepo();
    const rootB = await makeRepo();
    await runCli(["init"], rootA, seededEnv({ seed: 7 }));
    await runCli(["init"], rootB, seededEnv({ seed: 7 }));
    for (const file of ["nahel/config", "PRODUCT.md", "CONTEXT.md", "AGENTS.md"]) {
      expect(readFileSync(join(rootA, file), "utf8")).toBe(
        readFileSync(join(rootB, file), "utf8"),
      );
    }
  });
});

describe("nahel init — config", () => {
  test("records conventional knowledge-path defaults and the default actor", async () => {
    const root = await makeRepo();
    await runCli(["init"], root);
    const config = await readConfig(storeLayout(root));
    expect(config.knowledge).toEqual({
      product: "PRODUCT.md",
      context: "CONTEXT.md",
      adr: "docs/adr",
    });
    expect(config.actor).toEqual({ kind: "human", id: "maintainer" });
  });

  test("flags override the defaults and templates land at the overridden paths", async () => {
    const root = await makeRepo();
    const result = await runCli(
      [
        "init",
        "--product",
        "docs/PRODUCT.md",
        "--context",
        "docs/CONTEXT.md",
        "--adr",
        "decisions",
        "--actor",
        "agent:claude-code",
      ],
      root,
    );
    expect(result.code).toBe(0);

    const config = await readConfig(storeLayout(root));
    expect(config.knowledge).toEqual({
      product: "docs/PRODUCT.md",
      context: "docs/CONTEXT.md",
      adr: "decisions",
    });
    expect(config.actor).toEqual({ kind: "agent", id: "claude-code" });

    expect(existsSync(join(root, "docs", "PRODUCT.md"))).toBe(true);
    expect(existsSync(join(root, "docs", "CONTEXT.md"))).toBe(true);
    expect(existsSync(join(root, "PRODUCT.md"))).toBe(false);
  });

  test("rejects an invalid --actor spec with a clear error and writes nothing", async () => {
    const root = await makeRepo();
    const result = await runCli(["init", "--actor", "wizard"], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("actor");
    expect(existsSync(join(root, "nahel", "config"))).toBe(false);
    expect(existsSync(join(root, "PRODUCT.md"))).toBe(false);
  });

  test("rejects unknown flags with a non-zero exit", async () => {
    const root = await makeRepo();
    const result = await runCli(["init", "--bogus"], root);
    expect(result.code).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(existsSync(join(root, "nahel", "config"))).toBe(false);
  });
});

describe("nahel init — knowledge-path containment (hard constraint 2)", () => {
  // Every knowledge flag, escaping two ways: an absolute path and a relative
  // traversal above the repo root. Verified escape (PR #12 review, blocker 1):
  // `nahel init --product /tmp/x.md` created /tmp/x.md.
  const flags = ["product", "context", "adr"] as const;

  /** Unique per-test absolute path under /tmp (never created on green). */
  function tmpEscapePath(flag: string): string {
    return `/tmp/nahel-escape-${flag}-${process.pid}.md`;
  }

  afterEach(() => {
    for (const flag of flags) rmSync(tmpEscapePath(flag), { force: true });
  });

  for (const flag of flags) {
    test(`rejects an absolute --${flag} path, creates nothing at all`, async () => {
      const root = await makeRepo();
      const outside = tmpEscapePath(flag);
      const result = await runCli(["init", `--${flag}`, outside], root);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(flag);
      // Nothing outside the repo…
      expect(existsSync(outside)).toBe(false);
      // …and nothing inside either: refusal happens before any write.
      expect(existsSync(join(root, "nahel"))).toBe(false);
      expect(existsSync(join(root, "PRODUCT.md"))).toBe(false);
      expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
    });

    test(`rejects a relative --${flag} path that resolves above the repo root`, async () => {
      const root = await makeRepo();
      const escape = `../outside-${flag}-${process.pid}.md`;
      const result = await runCli(["init", `--${flag}`, escape], root);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(flag);
      expect(existsSync(join(root, "..", `outside-${flag}-${process.pid}.md`))).toBe(false);
      expect(existsSync(join(root, "nahel"))).toBe(false);
      expect(existsSync(join(root, "PRODUCT.md"))).toBe(false);
    });
  }

  test("rejects a sneaky in-repo prefix that traverses out (docs/../../evil.md)", async () => {
    const root = await makeRepo();
    const result = await runCli(["init", "--product", "docs/../../evil.md"], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("product");
    expect(existsSync(join(root, "..", "evil.md"))).toBe(false);
    expect(existsSync(join(root, "nahel"))).toBe(false);
  });

  test("rejects a knowledge path resolving to the repo root itself", async () => {
    const root = await makeRepo();
    const result = await runCli(["init", "--adr", "."], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("adr");
    expect(existsSync(join(root, "nahel"))).toBe(false);
  });
});

describe("nahel init — never overwrites, re-run safe", () => {
  test("pristine re-run no-ops with a clear message and leaves every byte unchanged", async () => {
    const root = await makeRepo();
    await runCli(["init"], root);

    const files = ["nahel/config", "PRODUCT.md", "CONTEXT.md", "AGENTS.md"];
    const before = files.map((f) => readFileSync(join(root, f), "utf8"));

    const rerun = await runCli(["init"], root);
    expect(rerun.code).toBe(0);
    expect(rerun.stdout).toContain("already initialized");

    const after = files.map((f) => readFileSync(join(root, f), "utf8"));
    expect(after).toEqual(before);
  });

  test("modified-scaffold re-run keeps edits, restores only what is missing", async () => {
    const root = await makeRepo();
    await runCli(["init"], root);

    // The human edits the constitution and deletes AGENTS.md.
    const edited = "# My Project\n\n## Goal\n\nShip it.\n\n## Hard constraints\n\n1. None.\n";
    writeFileSync(join(root, "PRODUCT.md"), edited);
    rmSync(join(root, "AGENTS.md"));
    const configBefore = readFileSync(join(root, "nahel", "config"), "utf8");

    const rerun = await runCli(["init"], root);
    expect(rerun.code).toBe(0);

    // The edit survives byte-for-byte; the missing template is restored.
    expect(readFileSync(join(root, "PRODUCT.md"), "utf8")).toBe(edited);
    expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
    expect(readFileSync(join(root, "nahel", "config"), "utf8")).toBe(configBefore);
    expect(rerun.stdout).toContain("AGENTS.md");
  });

  test("brownfield: pre-existing knowledge files are skipped on FIRST init, and reported", async () => {
    const root = await makeRepo();
    const existing = "# Existing constitution — do not touch\n";
    writeFileSync(join(root, "PRODUCT.md"), existing);

    const result = await runCli(["init"], root);
    expect(result.code).toBe(0);
    expect(readFileSync(join(root, "PRODUCT.md"), "utf8")).toBe(existing);
    expect(result.stdout).toMatch(/PRODUCT\.md.*(exists|kept|skipped)/);
    // The rest of the scaffold still lands.
    expect(existsSync(join(root, "nahel", "config"))).toBe(true);
    expect(existsSync(join(root, "CONTEXT.md"))).toBe(true);
    expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
  });

  test("re-run uses the RECORDED knowledge paths, not fresh flags", async () => {
    const root = await makeRepo();
    await runCli(["init", "--product", "docs/PRODUCT.md"], root);
    rmSync(join(root, "docs", "PRODUCT.md"));

    // Re-run without flags must respect the recorded config, not write PRODUCT.md at root.
    const rerun = await runCli(["init"], root);
    expect(rerun.code).toBe(0);
    expect(existsSync(join(root, "docs", "PRODUCT.md"))).toBe(true);
    expect(existsSync(join(root, "PRODUCT.md"))).toBe(false);
    const config = await readConfig(storeLayout(root));
    expect(config.knowledge.product).toBe("docs/PRODUCT.md");
  });

  test("refuses to touch an existing but invalid nahel/config", async () => {
    const root = await makeRepo();
    mkdirSync(join(root, "nahel"), { recursive: true });
    const garbage = "surprise: not-a-nahel-config\n";
    writeFileSync(join(root, "nahel", "config"), garbage);

    const result = await runCli(["init"], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("nahel/config");
    expect(readFileSync(join(root, "nahel", "config"), "utf8")).toBe(garbage);
    expect(existsSync(join(root, "PRODUCT.md"))).toBe(false);
  });
});

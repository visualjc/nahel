import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main, type CommandContext } from "../../src/cli";
import { GOVERNANCE_DEFAULTS } from "../../src/governance/authority";
import type { Env } from "../../src/schema/env";
import { readJournal } from "../../src/store/journal";
import { readConfig, readItem, storeLayout } from "../../src/store/layout";
import { createStoreContext, mutate } from "../../src/store/mutate";
import {
  AGENTS_SECTION_BEGIN,
  AGENTS_SECTION_END,
  mergeAgentsSection,
} from "../../src/templates/agents";
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

/**
 * Drive the CLI in-process with captured output and an injected Env.
 * `actorOverride` is the NAHEL_ACTOR spec value cli.ts injects from the
 * process environment — load-bearing for the hands-off founding act, whose
 * ACTOR is the paragraph's signature provenance (F9.4/F9.5).
 */
async function runCli(
  args: string[],
  cwd: string,
  env: Env = seededEnv(),
  actorOverride?: string,
): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    env,
    cwd,
    ...(actorOverride === undefined ? {} : { actorOverride }),
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

  test("the scaffolded governance block shows the REAL defaults, not a stricter fiction", async () => {
    // The skeleton is a founder's first read of what nahel does by default. It
    // showed `product: human` while resolution defaults product to delegated
    // (F2.2) — an illustrative value that misleads about the shipped posture.
    const root = await makeRepo();
    await runCli(["init"], root);
    const product = readFileSync(join(root, "PRODUCT.md"), "utf8");
    const governance = product.slice(product.indexOf("## Governance"));
    console.log("[scaffolded governance]\n" + governance.split("## Change log")[0]);
    expect(governance).toContain(`product: ${GOVERNANCE_DEFAULTS.product}`);
    expect(governance).toContain(`architecture: ${GOVERNANCE_DEFAULTS.architecture}`);
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

  test("AGENTS.md tells agents to self-identify via NAHEL_ACTOR before any nahel command", async () => {
    const root = await makeRepo();
    await runCli(["init"], root);
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");

    // PR #12 review: without this instruction, cooperative fresh agents run
    // under the config's human default and silently bypass the claim
    // guardrail — the onboarding doc must make self-identification explicit.
    expect(agents).toContain("NAHEL_ACTOR=agent:");
    expect(agents).toContain("NAHEL_ACTOR=agent:claude-code"); // concrete example
    expect(agents.toLowerCase()).toContain("before");
    // Humans are told they need not set it — the config actor is their default.
    expect(agents).toContain("config actor");
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

describe("nahel init — AGENTS.md merge (PRD F8.3, item pjcgrgx1)", () => {
  /** How many times the owned-section start marker appears in the file. */
  function sectionCount(content: string): number {
    return content.split(AGENTS_SECTION_BEGIN).length - 1;
  }

  test("merge is a pure function: append when unmarked, replace in place when marked", () => {
    const existing = "# House rules\n\nBe kind.\n";
    const appended = mergeAgentsSection(existing);
    expect(appended.outcome).toBe("merged");
    expect(appended.content.startsWith(existing)).toBe(true);
    expect(sectionCount(appended.content)).toBe(1);
    expect(appended.content).toContain(AGENTS_SECTION_END);

    // Re-merging its own output changes nothing at all.
    const again = mergeAgentsSection(appended.content);
    expect(again.outcome).toBe("unchanged");
    expect(again.content).toBe(appended.content);

    // A file with only a start marker is ambiguous — refuse, never guess.
    expect(() => mergeAgentsSection(`x\n${AGENTS_SECTION_BEGIN}\ny\n`)).toThrow(/marker/);
  });

  test("an existing AGENTS.md keeps every pre-existing byte and gains the section once", async () => {
    const root = await makeRepo();
    const existing = "# AGENTS.md\n\n## Our rules\n\n- Run `make test` before pushing.\n";
    writeFileSync(join(root, "AGENTS.md"), existing);

    const result = await runCli(["init"], root);
    expect(result.code).toBe(0);
    const merged = readFileSync(join(root, "AGENTS.md"), "utf8");

    // Every pre-existing byte, verbatim, still at the front of the file.
    expect(merged.startsWith(existing)).toBe(true);
    expect(sectionCount(merged)).toBe(1);
    expect(merged).toContain("nahel brief");
    expect(merged).toContain("NAHEL_ACTOR=agent:");
    // The merge is reported, not silently skipped (the closed backlog item).
    expect(result.stdout).toContain("AGENTS.md");
  });

  test("re-running init on a merged file is byte-identical", async () => {
    const root = await makeRepo();
    writeFileSync(join(root, "AGENTS.md"), "# Mine\n\nkeep me\n");
    await runCli(["init"], root);
    const afterFirst = readFileSync(join(root, "AGENTS.md"), "utf8");

    const rerun = await runCli(["init"], root);
    expect(rerun.code).toBe(0);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(afterFirst);
    expect(sectionCount(afterFirst)).toBe(1);
  });

  test("human edits around the owned section survive; the section itself is regenerated", async () => {
    const root = await makeRepo();
    writeFileSync(join(root, "AGENTS.md"), "# Mine\n\nkeep me\n");
    await runCli(["init"], root);
    const merged = readFileSync(join(root, "AGENTS.md"), "utf8");

    // The human appends a section BELOW the owned block and mangles the inside.
    const trailer = "\n## Deploy notes\n\nSSH to prod, cry.\n";
    const mangled = merged.replace("nahel brief", "nahel brief (I broke this line)") + trailer;
    writeFileSync(join(root, "AGENTS.md"), mangled);

    const rerun = await runCli(["init"], root);
    expect(rerun.code).toBe(0);
    const after = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(after.startsWith("# Mine\n\nkeep me\n")).toBe(true); // above: preserved
    expect(after.endsWith(trailer)).toBe(true); // below: preserved
    expect(after).not.toContain("I broke this line"); // inside: generator-owned
    expect(after).toBe(merged + trailer); // exactly the section restored
    expect(sectionCount(after)).toBe(1);
  });

  test("a fresh init writes the section exactly once, with its markers", async () => {
    const root = await makeRepo();
    await runCli(["init"], root);
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(sectionCount(agents)).toBe(1);
    expect(agents).toContain(AGENTS_SECTION_END);
  });

  test("an unterminated marker leaves AGENTS.md untouched and warns; the rest still scaffolds", async () => {
    const root = await makeRepo();
    const broken = `# Mine\n\n${AGENTS_SECTION_BEGIN}\n\nsomeone deleted the end marker\n`;
    writeFileSync(join(root, "AGENTS.md"), broken);

    const result = await runCli(["init"], root);
    expect(result.code).toBe(0);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(broken);
    expect(result.stderr).toContain("AGENTS.md");
    expect(existsSync(join(root, "nahel", "config"))).toBe(true);
    expect(existsSync(join(root, "PRODUCT.md"))).toBe(true);
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
    const escaped = `evil-${process.pid}.md`;
    const result = await runCli(["init", "--product", `docs/../../${escaped}`], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("product");
    expect(existsSync(join(root, "..", escaped))).toBe(false);
    expect(existsSync(join(root, "nahel"))).toBe(false);
  });

  test("rejects a knowledge path resolving to the repo root itself", async () => {
    const root = await makeRepo();
    const result = await runCli(["init", "--adr", "."], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("adr");
    expect(existsSync(join(root, "nahel"))).toBe(false);
  });

  // PR #12 review blocker (verified escape): `ln -s <outside-dir> repo/escape`
  // then `nahel init --product escape/PRODUCT.md` succeeded and wrote
  // PRODUCT.md OUTSIDE the repo — the lexical prefix check never canonicalizes
  // symlinked components.
  test("rejects a symlink-component escape and creates nothing outside the repo", async () => {
    const root = await makeRepo();
    const outside = await makeTempDir("nahel-init-canary-");
    tempDirs.push(outside);
    symlinkSync(outside, join(root, "escape"));

    const result = await runCli(["init", "--product", "escape/PRODUCT.md"], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("product");
    expect(result.stderr).toContain("hard constraint 2");
    // Nothing lands in the canary dir outside the repo…
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(outside, "PRODUCT.md"))).toBe(false);
    // …and nothing inside either: refusal happens before any write.
    expect(existsSync(join(root, "nahel"))).toBe(false);
    expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
  });

  test("inits fine when the repo itself sits under a symlinked parent (macOS /tmp style)", async () => {
    const parent = await makeTempDir("nahel-init-symparent-");
    tempDirs.push(parent);
    const real = join(parent, "real");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(parent, "link"));
    const linkedRoot = join(parent, "link");
    const proc = Bun.spawn(["git", "init", "-q"], { cwd: linkedRoot });
    expect(await proc.exited).toBe(0);

    const result = await runCli(["init"], linkedRoot);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(existsSync(join(real, "nahel", "config"))).toBe(true);
    expect(existsSync(join(real, "PRODUCT.md"))).toBe(true);
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

/**
 * `nahel init --hands-off "<paragraph>"` (Phase 2 F9.4): the shortcut door of
 * the founding mode-and-input capture. The CLI's whole job is deterministic
 * recording — mode + the VERBATIM paragraph as ordinary config state, plus the
 * journaled act whose ACTOR is the paragraph's signature provenance (F9.5).
 * The inception workflow does every judgment part.
 */
describe("nahel init — hands-off founding (F9.4, F9.5)", () => {
  /** Deliberately awkward: leading/trailing space, a newline, quotes, unicode. */
  const PARAGRAPH =
    '  A "speed count" game for kids — a timer, a grid of dots, a leaderboard.\n  Playable one-handed.  ';

  /** Every journal event in the store, oldest first. */
  async function events(root: string) {
    return Array.fromAsync(readJournal(storeLayout(root)));
  }

  /** The founding acts: config.updated events replacing the `founding` section. */
  async function foundingActs(root: string) {
    return (await events(root)).filter(
      (event) => event.type === "config.updated" && event.payload["section"] === "founding",
    );
  }

  test("records the mode and the paragraph VERBATIM as ordinary config state", async () => {
    const root = await makeRepo();
    const result = await runCli(["init", "--hands-off", PARAGRAPH], root, seededEnv(), "human:jim");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    // Read back through the real store: the paragraph survives the YAML round
    // trip byte for byte — no trim, no reflow, no quote mangling.
    const config = await readConfig(storeLayout(root));
    expect(config.founding).toEqual({ mode: "hands-off", paragraph: PARAGRAPH });
    expect(config.founding?.paragraph).toBe(PARAGRAPH);
    expect(result.stdout).toContain("hands-off");
  });

  test("the human-attributed init act is the signature provenance, deterministic to check", async () => {
    const root = await makeRepo();
    expect(
      (await runCli(["init", "--hands-off", PARAGRAPH], root, seededEnv(), "human:jim")).code,
    ).toBe(0);

    // Same shape the merge-authority and constitution-signature checks read:
    // a `config.updated` act naming the section, carrying the value, attributed
    // to a HUMAN actor. One act, not two — the paragraph has one provenance.
    const acts = await foundingActs(root);
    expect(acts).toHaveLength(1);
    expect(acts[0]!.actor).toEqual({ kind: "human", id: "jim" });
    expect(acts[0]!.payload).toEqual({
      section: "founding",
      value: { mode: "hands-off", paragraph: PARAGRAPH },
    });
  });

  test("provenance is the ACT's actor, never the flag: an agent-run init signs nothing", async () => {
    const root = await makeRepo();
    expect(
      (await runCli(["init", "--hands-off", PARAGRAPH], root, seededEnv(), "agent:claude-code"))
        .code,
    ).toBe(0);

    // The paragraph is still recorded — but the act is agent-attributed, which
    // is exactly what the inception workflow and the autonomy gate refuse to
    // treat as a signature.
    const acts = await foundingActs(root);
    expect(acts).toHaveLength(1);
    expect(acts[0]!.actor).toEqual({ kind: "agent", id: "claude-code" });
    expect((await readConfig(storeLayout(root))).founding?.paragraph).toBe(PARAGRAPH);
  });

  test("an empty or whitespace-only paragraph is refused, with nothing created", async () => {
    for (const blank of ["", "   ", "\n\t\n"]) {
      const root = await makeRepo();
      const result = await runCli(["init", "--hands-off", blank], root, seededEnv(), "human:jim");
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("hands-off");
      expect(existsSync(join(root, "nahel", "config"))).toBe(false);
      expect(existsSync(join(root, "PRODUCT.md"))).toBe(false);
    }
  });

  test("absent flag: no founding section, no journal event — the plain scaffold is untouched", async () => {
    const rootA = await makeRepo();
    const rootB = await makeRepo();
    expect((await runCli(["init"], rootA, seededEnv({ seed: 7 }))).code).toBe(0);
    expect(
      (await runCli(["init", "--hands-off", PARAGRAPH], rootB, seededEnv({ seed: 7 }), "human:jim"))
        .code,
    ).toBe(0);

    const plain = await readConfig(storeLayout(rootA));
    expect(plain.founding).toBeUndefined();
    expect(await events(rootA)).toEqual([]);
    // Everything OUTSIDE the founding section stays byte-identical between the
    // two: the flag adds state, it never changes the scaffold.
    for (const file of ["PRODUCT.md", "CONTEXT.md", "AGENTS.md"]) {
      expect(readFileSync(join(rootB, file), "utf8")).toBe(readFileSync(join(rootA, file), "utf8"));
    }
    const handsOff = await readConfig(storeLayout(rootB));
    const { founding, ...rest } = handsOff;
    expect(rest).toEqual(plain);
    expect(founding).toEqual({ mode: "hands-off", paragraph: PARAGRAPH });
  });

  test("an existing config is never rewritten: the flag is reported ignored, with the other door named", async () => {
    const root = await makeRepo();
    expect((await runCli(["init"], root, seededEnv(), "human:jim")).code).toBe(0);
    const before = readFileSync(join(root, "nahel", "config"), "utf8");

    const rerun = await runCli(["init", "--hands-off", PARAGRAPH], root, seededEnv(), "human:jim");
    expect(rerun.code).toBe(0);
    expect(readFileSync(join(root, "nahel", "config"), "utf8")).toBe(before);
    expect(await foundingActs(root)).toEqual([]);
    // The conversational door (hard constraint 5) is named, not just refused.
    expect(rerun.stderr).toContain("nahel config set founding");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import type { CommandContext } from "../../src/cli";
import { briefCommand } from "../../src/commands/brief";
import { itemPath, knowledgePaths, readConfig } from "../../src/store/layout";
import { GOAL_HEADING, HARD_CONSTRAINTS_HEADING } from "../../src/templates/product";
import { composeBrief } from "../../src/views/brief";
import { makeTempDir, seededEnv } from "../store/helpers";
import { buildPopulatedStore, type PopulatedStore } from "../views/helpers";

/**
 * `nahel brief` command (PRD F7, task #8): a thin I/O wrapper over
 * composeBrief. Exit 0 even when PRODUCT.md is missing (that's a finding IN
 * the brief); non-zero only for genuinely unreadable state (uninitialized
 * repo, corrupt records) and usage errors. Registration in cli.ts is the
 * orchestrator's — these tests drive the exported Command directly.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runBrief(args: string[], root: string): Promise<CommandResult> {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    env: seededEnv(),
    cwd: root,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  const code = await briefCommand.run(args, ctx);
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

async function writeProduct(store: PopulatedStore): Promise<void> {
  const config = await readConfig(store.layout);
  await writeFile(
    knowledgePaths(store.layout, config).product,
    `# P\n\n${GOAL_HEADING}\n\nShip the thing.\n\n${HARD_CONSTRAINTS_HEADING}\n\n1. Stay deterministic.\n`,
  );
}

describe("nahel brief — happy path", () => {
  test("emits exactly the composed brief for a populated store, exit 0", async () => {
    const store = await buildPopulatedStore(tempDirs);
    await writeProduct(store);
    const result = await runBrief([], store.root);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      await composeBrief(store.layout, await readConfig(store.layout)),
    );
    expect(result.stdout).toContain("Ship the thing.");
    expect(result.stdout).toContain("1. Stay deterministic.");
    expect(result.stdout).toContain("== item statuses ==");
  });

  test("byte-identical output across repeated invocations of the same state", async () => {
    const store = await buildPopulatedStore(tempDirs);
    await writeProduct(store);
    const first = await runBrief([], store.root);
    const second = await runBrief([], store.root);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe(second.stdout);
  });

  test("missing PRODUCT.md is a finding in the brief, exit 0 — not an error", async () => {
    const store = await buildPopulatedStore(tempDirs); // fixture never writes PRODUCT.md
    const result = await runBrief([], store.root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("finding:");
    expect(result.stdout).toContain("PRODUCT.md");
    expect(result.stdout).toContain("== validate warnings ==");
  });
});

describe("nahel brief — hard errors exit non-zero", () => {
  test("an uninitialized directory points at nahel init", async () => {
    const root = await makeTempDir("nahel-brief-bare-");
    tempDirs.push(root);
    const result = await runBrief([], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("nahel init");
  });

  test("a corrupt work-item record is a hard error, never silently partial output", async () => {
    const store = await buildPopulatedStore(tempDirs);
    await writeProduct(store);
    await writeFile(
      itemPath(store.layout, store.taskBetaId),
      "---\nid: not-a-valid-record\n---\nbody\n",
    );
    const result = await runBrief([], store.root);
    expect(result.code).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

describe("nahel brief — argument validation and registration shape", () => {
  test("unexpected positionals and unknown flags are usage errors", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const positional = await runBrief(["surprise"], store.root);
    expect(positional.code).toBe(1);
    expect(positional.stderr).toContain("usage");

    const unknown = await runBrief(["--bogus"], store.root);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("usage");
  });

  test("exports a registration-ready Command: a description and a run function", () => {
    expect(typeof briefCommand.description).toBe("string");
    expect(briefCommand.description.length).toBeGreaterThan(0);
    expect(typeof briefCommand.run).toBe("function");
  });
});

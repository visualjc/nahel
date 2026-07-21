import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import type { CommandContext } from "../../src/cli";
import { statusCommand } from "../../src/commands/status";
import { hotStatePath } from "../../src/store/hotstate";
import { ensureLayout, itemPath, writeConfig } from "../../src/store/layout";
import { loadSnapshot, type Snapshot } from "../../src/views/snapshot";
import { renderStatus } from "../../src/views/status";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";
import { buildPopulatedStore } from "../views/helpers";

/**
 * `nahel status` (PRD F5, task #7): the human tree by default, `--json` for
 * the raw snapshot, non-zero exit on unparseable state. The command is a thin
 * I/O wrapper over loadSnapshot + renderStatus — these tests drive the
 * exported object directly (cli.ts registration is the orchestrator's).
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

async function runStatus(args: string[], root: string): Promise<CommandResult> {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    env: seededEnv(),
    cwd: root,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  const code = await statusCommand.run(args, ctx);
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

describe("nahel status — human output", () => {
  test("renders the tree, active runs, and claims for a store populated via the real commands", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const result = await runStatus([], store.root);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    // The command emits exactly the pure renderer's output — no extras.
    expect(result.stdout).toBe(renderStatus(await loadSnapshot(store.layout)));
    expect(result.stdout).toContain("demo-epic");
    expect(result.stdout).toContain("claimed_by=jim");
    expect(result.stdout).toContain("phase=building");
  });

  test("an empty initialized store renders cleanly with exit 0", async () => {
    const root = await makeTempDir("nahel-status-empty-");
    tempDirs.push(root);
    await writeConfig(await ensureLayout(root), makeConfig());
    const result = await runStatus([], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("none");
  });

  test("byte-identical output across repeated invocations of the same state", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const first = await runStatus([], store.root);
    const second = await runStatus([], store.root);
    expect(first.stdout).toBe(second.stdout);
    expect(first.code).toBe(0);
  });
});

describe("nahel status --json", () => {
  test("emits the snapshot as parseable JSON that equals loadSnapshot's result", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const result = await runStatus(["--json"], store.root);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as Snapshot;
    expect(parsed).toEqual(
      JSON.parse(JSON.stringify(await loadSnapshot(store.layout))) as Snapshot,
    );
    expect(parsed.items.map((item) => item.id)).toContain(store.epicId);
    expect(parsed.runs.map((entry) => entry.run.id)).toEqual([
      store.activeRunId,
      store.endedRunId,
    ]);
  });
});

describe("nahel status — unparseable state exits non-zero", () => {
  test("a corrupt work-item record is a hard error naming the problem", async () => {
    const store = await buildPopulatedStore(tempDirs);
    await writeFile(
      itemPath(store.layout, store.taskBetaId),
      "---\nid: not-a-valid-record\n---\nbody\n",
    );
    const result = await runStatus([], store.root);
    expect(result.code).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  test("corrupt hot state (invalid JSON) is a hard error, not silently skipped", async () => {
    const store = await buildPopulatedStore(tempDirs);
    await writeFile(hotStatePath(store.layout, store.activeRunId), "{not json");
    const result = await runStatus([], store.root);
    expect(result.code).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  test("an uninitialized directory is a hard error pointing at nahel init", async () => {
    const root = await makeTempDir("nahel-status-bare-");
    tempDirs.push(root);
    const result = await runStatus([], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("nahel init");
  });
});

describe("nahel status — argument validation", () => {
  test("unexpected positionals and unknown flags are usage errors", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const positional = await runStatus(["surprise"], store.root);
    expect(positional.code).toBe(1);
    expect(positional.stderr).toContain("usage");

    const unknown = await runStatus(["--bogus"], store.root);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("usage");
  });

  test("exports a registration-ready Command: a description and a run function", () => {
    expect(typeof statusCommand.description).toBe("string");
    expect(statusCommand.description.length).toBeGreaterThan(0);
    expect(typeof statusCommand.run).toBe("function");
  });
});

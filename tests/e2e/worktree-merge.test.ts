import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * PRD success criterion 8 at the CLI level — merge-safety demonstrated on the
 * real binary: two git worktrees mutate state and log events in parallel
 * through child-process CLI invocations; the branches merge with ZERO
 * conflicts and `nahel validate` exits 0 on the merged result. The store-level
 * version lives in tests/store/worktree-merge.test.ts; this one drives only
 * the public CLI (zero src/ imports — the thesis proof). Verbose by design.
 */

const CLI = join(import.meta.dir, "../../src/cli.ts");

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn the real CLI as `actor` in `cwd`; echo the full exchange. */
function nahel(cwd: string, actor: string, ...args: string[]): CliResult {
  const result = spawnSync("bun", ["run", CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NAHEL_ACTOR: `agent:${actor}` },
  });
  const output = { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  console.log(
    `[${actor}] $ nahel ${args.join(" ")}\n  exit ${output.code}` +
      (output.stdout.trim() === "" ? "" : `\n  stdout: ${output.stdout.trim()}`) +
      (output.stderr.trim() === "" ? "" : `\n  stderr: ${output.stderr.trim()}`),
  );
  return output;
}

function ok(result: CliResult, what: string): CliResult {
  if (result.code !== 0) {
    throw new Error(`${what} failed (exit ${result.code}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/**
 * One agent's parallel workload, entirely through the CLI: re-run init
 * (idempotent — restores the empty state dirs git does not carry into a fresh
 * worktree), then a full item + run lifecycle with a logged observation.
 */
function driveWork(worktree: string, agent: string): { item: string; run: string } {
  const init = ok(nahel(worktree, agent, "init"), `${agent} init`);
  expect(init.stdout).toContain("already initialized"); // merge with main's state, create nothing
  const item = ok(
    nahel(worktree, agent, "item", "new", "feature", `${agent}-item`, "direct"),
    `${agent} item new`,
  ).stdout.trim();
  const run = ok(nahel(worktree, agent, "run", "start", item), `${agent} run start`).stdout.trim();
  ok(
    nahel(
      worktree,
      agent,
      "log",
      "decision.made",
      "--item",
      item,
      "--run",
      run,
      "--data",
      `{"note":"observation from ${agent}"}`,
    ),
    `${agent} log`,
  );
  ok(
    nahel(worktree, agent, "item", "update", item, "--status", "in-progress"),
    `${agent} item update`,
  );
  ok(nahel(worktree, agent, "run", "update", run, "--phase", "building"), `${agent} run update`);
  ok(nahel(worktree, agent, "run", "end", run, "success"), `${agent} run end`);
  return { item, run };
}

describe("two-worktree merge (PRD criterion 8) — merge-safety through the public CLI", () => {
  test(
    "parallel CLI mutations + logs in two worktrees merge with zero conflicts; validate exits 0 on the result",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "nahel-e2e-merge-"));
      tempDirs.push(root);

      // Founding commit on main: the CLI's own scaffold.
      git(root, "init", "--initial-branch=main");
      git(root, "config", "user.email", "test@nahel.test");
      git(root, "config", "user.name", "Nahel E2E");
      ok(nahel(root, "founder", "init"), "founding init");
      git(root, "add", "-A");
      git(root, "commit", "-m", "founding: nahel scaffold via the CLI");

      // Two parallel worktrees, as the AFK execution model runs them.
      const wtA = `${root}-wt-a`;
      const wtB = `${root}-wt-b`;
      tempDirs.push(wtA, wtB);
      git(root, "worktree", "add", wtA, "-b", "agent-a");
      git(root, "worktree", "add", wtB, "-b", "agent-b");

      // Both agents drive full lifecycles concurrently (parallel branches AND
      // parallel processes — random IDs and per-writer segments keep them apart).
      const [workA, workB] = await Promise.all([
        (async () => driveWork(wtA, "agent-a"))(),
        (async () => driveWork(wtB, "agent-b"))(),
      ]);
      expect(workA.item).not.toBe(workB.item);
      expect(workA.run).not.toBe(workB.run);
      git(wtA, "add", "-A");
      git(wtA, "commit", "-m", "agent-a: item + run lifecycle via the CLI");
      git(wtB, "add", "-A");
      git(wtB, "commit", "-m", "agent-b: item + run lifecycle via the CLI");

      // Merge both branches into main: zero conflicts.
      git(root, "merge", "--no-edit", "agent-a");
      const mergeB = spawnSync("git", ["merge", "--no-edit", "agent-b"], {
        cwd: root,
        encoding: "utf8",
      });
      console.log(`$ git merge agent-b\n  exit ${mergeB.status}\n${mergeB.stdout}${mergeB.stderr}`);
      expect(mergeB.status).toBe(0);
      expect(mergeB.stdout + mergeB.stderr).not.toContain("CONFLICT");
      expect(git(root, "status", "--porcelain").trim()).toBe("");

      // The merged store is coherent, read back through the CLI alone.
      const status = ok(nahel(root, "reader", "status"), "status on merge").stdout;
      expect(status).toContain("agent-a-item");
      expect(status).toContain("agent-b-item");
      expect(status).toContain("in-progress");

      const progress = ok(nahel(root, "reader", "progress"), "progress on merge").stdout;
      expect(progress).toContain("observation from agent-a");
      expect(progress).toContain("observation from agent-b");

      // validate: exit 0 on the merged result.
      const validate = ok(nahel(root, "reader", "validate"), "validate on merge");
      expect(validate.code).toBe(0);
      expect(validate.stderr).toBe("");
    },
    { timeout: 120_000 },
  );
});

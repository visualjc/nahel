import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "../store/helpers";

/**
 * Repro + regression coverage for the yolo-afk-dev test scripts
 * (bug `test-baseline-grep-under-set-e`, item 0k83q678): both scripts run
 * their failure-extraction grep under `set -euo pipefail`, and grep exits 1
 * on zero matches — so a fully GREEN test run killed the script before its
 * output JSON was written. The failing-tests path always worked; these
 * tests pin both paths.
 *
 * Real processes against real temp git repos — no mocks. `timeout(1)` is
 * absent on stock macOS (separate item y7vzx3be), and test-current.sh
 * wraps its test command in it — so these tests prepend a PATH shim whose
 * `timeout` simply drops the duration and execs the command. The shim is a
 * host dependency stand-in, not part of the system under test; timeout
 * *enforcement* is deliberately not covered here.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const BASELINE_SH = join(REPO_ROOT, ".claude/skills/yolo-afk-dev/scripts/test-baseline.sh");
const CURRENT_SH = join(REPO_ROOT, ".claude/skills/yolo-afk-dev/scripts/test-current.sh");

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface ScriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runScript(script: string, args: string[], cwd: string): Promise<ScriptResult> {
  const proc = Bun.spawn(["bash", script, ...args], {
    cwd,
    env: { ...process.env, PATH: `${await timeoutShimDir()}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** PATH dir holding a `timeout` that drops the duration and execs the command. */
async function timeoutShimDir(): Promise<string> {
  const dir = await makeTempDir("nahel-yolo-timeout-shim-");
  tempDirs.push(dir);
  const shim = join(dir, "timeout");
  await writeFile(shim, '#!/bin/bash\nshift\nexec "$@"\n');
  const proc = Bun.spawn(["chmod", "+x", shim], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

/** Fresh temp git repo with one commit so HEAD resolves for worktree add. */
async function makeFixtureRepo(): Promise<string> {
  const repo = await makeTempDir("nahel-yolo-fixture-");
  tempDirs.push(repo);
  await git(repo, "init", "-q");
  await git(repo, "-c", "user.email=test@test", "-c", "user.name=test", "commit", "--allow-empty", "-q", "-m", "init");
  await writeFile(join(repo, "README.md"), "fixture\n");
  await git(repo, "add", "README.md");
  await git(repo, "-c", "user.email=test@test", "-c", "user.name=test", "commit", "-q", "-m", "readme");
  return repo;
}

describe("test-baseline.sh", () => {
  test("green test run (no failure markers) still writes test-baseline.json with empty failures", async () => {
    const repo = await makeFixtureRepo();
    const stateDir = join(repo, ".yolo-state");
    const result = await runScript(
      BASELINE_SH,
      [stateDir, "demo-prd", "HEAD", "echo all tests passed"],
      repo,
    );

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const out = join(stateDir, "prds", "demo-prd", "test-baseline.json");
    // git worktree add prints "HEAD is now at …" to stdout first; the
    // script's own contract is that its LAST stdout line is the JSON path.
    expect(result.stdout.trim().split("\n").at(-1)).toBe(out);
    const baseline = JSON.parse(await Bun.file(out).text()) as {
      test_exit_code: number;
      failures: string[];
    };
    expect(baseline.test_exit_code).toBe(0);
    expect(baseline.failures).toEqual([]);
  });

  test("failing test run captures the failure lines (extraction regression guard)", async () => {
    const repo = await makeFixtureRepo();
    const stateDir = join(repo, ".yolo-state");
    const result = await runScript(
      BASELINE_SH,
      // `&& false` rather than `exit 1`: the script `eval`s the test cmd in
      // its own shell, so `exit` would kill the script itself.
      [stateDir, "demo-prd", "HEAD", "printf 'FAIL tests/foo.test.ts\\n' && false"],
      repo,
    );

    expect(result.code).toBe(0);
    const out = join(stateDir, "prds", "demo-prd", "test-baseline.json");
    const baseline = JSON.parse(await Bun.file(out).text()) as {
      test_exit_code: number;
      failures: string[];
    };
    expect(baseline.test_exit_code).toBe(1);
    expect(baseline.failures).toEqual(["FAIL tests/foo.test.ts"]);
  });

  test("test cmd containing double quotes and backslashes round-trips through valid JSON", async () => {
    const repo = await makeFixtureRepo();
    const stateDir = join(repo, ".yolo-state");
    // Actual TEST_CMD string (post-TS-unescaping):
    //   printf 'FAIL tests/say "hi" and\\ back.test.ts\n'; false
    // …which prints:  FAIL tests/say "hi" and\ back.test.ts
    const testCmd = `printf 'FAIL tests/say "hi" and\\\\ back.test.ts\\n'; false`;
    const result = await runScript(BASELINE_SH, [stateDir, "demo-prd", "HEAD", testCmd], repo);

    expect(result.code).toBe(0);
    const out = join(stateDir, "prds", "demo-prd", "test-baseline.json");
    const baseline = JSON.parse(await Bun.file(out).text()) as {
      test_cmd: string;
      test_exit_code: number;
      failures: string[];
    };
    expect(baseline.test_cmd).toBe(testCmd);
    expect(baseline.test_exit_code).toBe(1);
    expect(baseline.failures).toEqual([`FAIL tests/say "hi" and\\ back.test.ts`]);
  });
});

describe("test-current.sh", () => {
  /** Seed the baseline JSON test-current.sh diffs against. */
  async function seedBaseline(stateDir: string, prd: string, failures: string[]): Promise<void> {
    const prdDir = join(stateDir, "prds", prd);
    await mkdir(prdDir, { recursive: true });
    await writeFile(
      join(prdDir, "test-baseline.json"),
      JSON.stringify({ base_ref: "HEAD", test_cmd: "true", test_exit_code: failures.length === 0 ? 0 : 1, failures }),
    );
  }

  test("green test run (no failure markers) still writes test-current.json with empty arrays", async () => {
    const repo = await makeFixtureRepo();
    const stateDir = join(repo, ".yolo-state");
    await seedBaseline(stateDir, "demo-prd", []);
    const result = await runScript(
      CURRENT_SH,
      [stateDir, "demo-prd", "issue-1", repo, "echo all tests passed"],
      repo,
    );

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const out = join(stateDir, "prds", "demo-prd", "issues", "issue-1", "test-current.json");
    expect(result.stdout.trim()).toBe(out);
    const current = JSON.parse(await Bun.file(out).text()) as {
      current_failures: string[];
      net_new: string[];
      baseline_intersection: string[];
    };
    expect(current.current_failures).toEqual([]);
    expect(current.net_new).toEqual([]);
    expect(current.baseline_intersection).toEqual([]);
  });

  test("net-new failure against a baseline failure set diffs correctly (extraction regression guard)", async () => {
    const repo = await makeFixtureRepo();
    const stateDir = join(repo, ".yolo-state");
    await seedBaseline(stateDir, "demo-prd", ["FAIL tests/old.test.ts"]);
    const result = await runScript(
      CURRENT_SH,
      [
        stateDir,
        "demo-prd",
        "issue-1",
        repo,
        "printf 'FAIL tests/old.test.ts\\nFAIL tests/new.test.ts\\n'; exit 1",
      ],
      repo,
    );

    expect(result.code).toBe(0);
    const out = join(stateDir, "prds", "demo-prd", "issues", "issue-1", "test-current.json");
    const current = JSON.parse(await Bun.file(out).text()) as {
      current_failures: string[];
      net_new: string[];
      baseline_intersection: string[];
    };
    expect(current.current_failures).toEqual(["FAIL tests/new.test.ts", "FAIL tests/old.test.ts"]);
    expect(current.net_new).toEqual(["FAIL tests/new.test.ts"]);
    expect(current.baseline_intersection).toEqual(["FAIL tests/old.test.ts"]);
  });

  test("test cmd containing double quotes and backslashes round-trips through valid JSON", async () => {
    const repo = await makeFixtureRepo();
    const stateDir = join(repo, ".yolo-state");
    await seedBaseline(stateDir, "demo-prd", []);
    const testCmd = `printf 'FAIL tests/say "hi" and\\\\ back.test.ts\\n'; exit 1`;
    const result = await runScript(CURRENT_SH, [stateDir, "demo-prd", "issue-1", repo, testCmd], repo);

    expect(result.code).toBe(0);
    const out = join(stateDir, "prds", "demo-prd", "issues", "issue-1", "test-current.json");
    const current = JSON.parse(await Bun.file(out).text()) as {
      test_cmd: string;
      test_exit_code: number;
      current_failures: string[];
      net_new: string[];
    };
    expect(current.test_cmd).toBe(testCmd);
    expect(current.test_exit_code).toBe(1);
    expect(current.current_failures).toEqual([`FAIL tests/say "hi" and\\ back.test.ts`]);
    expect(current.net_new).toEqual([`FAIL tests/say "hi" and\\ back.test.ts`]);
  });
});

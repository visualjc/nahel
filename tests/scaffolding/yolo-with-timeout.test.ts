import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "../store/helpers";

/**
 * Coverage for the portable `timeout(1)` shim (item y7vzx3be,
 * macos-timeout-shim). Stock macOS ships no GNU coreutils, so `timeout` is
 * simply absent — yet five yolo-afk-dev scripts wrapped their long-running
 * child in it, and all five branch on exit code 124 to distinguish "timed
 * out" from "failed". Without a shim those runs died with 127.
 *
 * Real processes, no mocks. Absence of `timeout` is simulated by running with
 * PATH set to a single temp dir holding symlinks to exactly the tools under
 * test — nothing else is reachable, so `command -v timeout` fails
 * deterministically whether or not the host has coreutils installed.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPTS_DIR = join(REPO_ROOT, ".claude/skills/yolo-afk-dev/scripts");
const LIB = join(SCRIPTS_DIR, "lib/with-timeout.sh");
const CURRENT_SH = join(SCRIPTS_DIR, "test-current.sh");

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Temp bin dir holding symlinks to `tools` and nothing else. */
async function sandboxBin(tools: string[]): Promise<string> {
  const dir = await makeTempDir("nahel-yolo-bin-");
  tempDirs.push(dir);
  for (const tool of tools) {
    const resolved = Bun.which(tool);
    if (!resolved) throw new Error(`test prerequisite missing from host PATH: ${tool}`);
    await symlink(resolved, join(dir, tool));
  }
  return dir;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a bash snippet that has sourced the shim, under an exact PATH. */
async function runWithPath(snippet: string, path: string, stdin?: string): Promise<RunResult> {
  const proc = Bun.spawn(["bash", "-c", `source ${JSON.stringify(LIB)}\n${snippet}`], {
    env: { PATH: path },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
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

/** Tools the fallback watchdog and these snippets need. */
const FALLBACK_TOOLS = ["bash", "perl", "sleep", "cat", "printf"];

describe("with-timeout.sh — no `timeout` on PATH (stock macOS)", () => {
  test("returns the command's own exit status when it finishes in time", async () => {
    const bin = await sandboxBin(FALLBACK_TOOLS);
    const result = await runWithPath(`with_timeout 10 printf 'hello\\n'`, bin);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello\n");
  });

  test("propagates a non-zero exit status unchanged", async () => {
    const bin = await sandboxBin(FALLBACK_TOOLS);
    const result = await runWithPath(`with_timeout 10 bash -c 'exit 7'; echo "rc=$?"`, bin);

    expect(result.stdout.trim()).toBe("rc=7");
  });

  test("returns 124 and kills the child when the duration elapses", async () => {
    const bin = await sandboxBin(FALLBACK_TOOLS);
    const started = Date.now();
    const result = await runWithPath(`with_timeout 1 sleep 30; echo "rc=$?"`, bin);
    const elapsed = Date.now() - started;

    expect(result.stdout.trim()).toBe("rc=124");
    // Must not have waited out the full 30s sleep; must have waited ~1s.
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(15000);
  });

  test("passes stdin through to the command", async () => {
    const bin = await sandboxBin(FALLBACK_TOOLS);
    const result = await runWithPath(`with_timeout 10 cat`, bin, "piped payload\n");

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("piped payload\n");
  });

  test("passes arguments through verbatim without a shell re-parse", async () => {
    const bin = await sandboxBin(FALLBACK_TOOLS);
    // $HOME and the spaces/quotes must survive as literal argv bytes.
    const result = await runWithPath(
      `with_timeout 10 printf '[%s]' 'a b' '"c"' '$HOME'`,
      bin,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`[a b]["c"][$HOME]`);
  });
});

describe("with-timeout.sh — `timeout` present on PATH", () => {
  /** A `timeout` stand-in that records it was called, then drops the duration. */
  async function binWithFakeTimeout(sentinel: string): Promise<string> {
    const bin = await sandboxBin([...FALLBACK_TOOLS, "touch"]);
    const shim = join(bin, "timeout");
    await writeFile(shim, `#!/bin/bash\ntouch ${JSON.stringify(sentinel)}\nshift\nexec "$@"\n`, {
      mode: 0o755,
    });
    return bin;
  }

  test("delegates to the real `timeout` when it is installed", async () => {
    const scratch = await makeTempDir("nahel-yolo-sentinel-");
    tempDirs.push(scratch);
    const sentinel = join(scratch, "timeout-was-called");
    const bin = await binWithFakeTimeout(sentinel);

    const result = await runWithPath(`with_timeout 10 printf 'delegated\\n'`, bin);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("delegated\n");
    expect(await Bun.file(sentinel).exists()).toBe(true);
  });
});

describe("test-current.sh under a PATH without `timeout`", () => {
  /** Everything test-current.sh shells out to, minus `timeout`. */
  const SCRIPT_TOOLS = ["bash", "perl", "jq", "grep", "sort", "comm", "date", "mkdir", "dirname"];

  test("runs its test command and captures failures with no `timeout` installed", async () => {
    const repo = await makeTempDir("nahel-yolo-current-");
    tempDirs.push(repo);
    const stateDir = join(repo, ".yolo-state");
    const prdDir = join(stateDir, "prds", "demo-prd");
    await Bun.write(
      join(prdDir, "test-baseline.json"),
      JSON.stringify({ base_ref: "HEAD", test_cmd: "true", test_exit_code: 0, failures: [] }),
    );

    const bin = await sandboxBin(SCRIPT_TOOLS);
    const proc = Bun.spawn(
      [
        "bash",
        CURRENT_SH,
        stateDir,
        "demo-prd",
        "issue-1",
        repo,
        "printf 'FAIL tests/foo.test.ts\\n'; exit 1",
      ],
      { cwd: repo, env: { PATH: bin }, stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    expect(stderr).toBe("");
    expect(code).toBe(0);
    const out = join(stateDir, "prds", "demo-prd", "issues", "issue-1", "test-current.json");
    const current = JSON.parse(await Bun.file(out).text()) as {
      test_exit_code: number;
      current_failures: string[];
      net_new: string[];
    };
    expect(current.test_exit_code).toBe(1);
    expect(current.current_failures).toEqual(["FAIL tests/foo.test.ts"]);
    expect(current.net_new).toEqual(["FAIL tests/foo.test.ts"]);
  });
});

describe("yolo-afk-dev scripts", () => {
  test("no script invokes GNU `timeout` directly — all go through the shim", async () => {
    const names = (await readdir(SCRIPTS_DIR)).filter((n) => n.endsWith(".sh"));
    expect(names.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const name of names) {
      const lines = (await readFile(join(SCRIPTS_DIR, name), "utf8")).split("\n");
      for (const [i, line] of lines.entries()) {
        if (line.trimStart().startsWith("#")) continue;
        if (/(^|[^\w-])timeout\s+\d/.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

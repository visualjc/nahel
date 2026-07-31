import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "../store/helpers";

/**
 * Coverage for `with_timeout` (item y7vzx3be, macos-timeout-shim). Stock macOS
 * ships no GNU coreutils, so `timeout(1)` is simply absent — yet five
 * yolo-afk-dev scripts wrapped their long-running child in it, and all five
 * branch on exit code 124 to distinguish "timed out" from "failed". Those runs
 * died with 127 instead.
 *
 * The replacement is a perl watchdog used uniformly, never delegating to
 * `timeout` even where it exists: `timeout -k` reports 137 rather than 124
 * when the KILL escalation is what ended the command, which no caller can tell
 * apart from an external kill.
 *
 * Real processes, no mocks. Each case runs with PATH set to a single temp dir
 * holding symlinks to exactly the tools under test — nothing else is
 * reachable, so host coreutils can neither help nor interfere.
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
async function runWithPath(
  snippet: string,
  path: string,
  opts: { stdin?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  const proc = Bun.spawn(["bash", "-c", `source ${JSON.stringify(LIB)}\n${snippet}`], {
    env: { PATH: path, ...opts.env },
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
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

/** Tools the watchdog and these snippets need. */
const WATCHDOG_TOOLS = ["bash", "perl", "sleep", "cat", "printf"];

/** TERM->KILL grace the watchdog promises. */
const KILL_AFTER_SECONDS = 2;

/** Pids that must not survive a test; killed in afterEach so a red run leaks nothing. */
const strayPids: number[] = [];

afterEach(() => {
  for (const pid of strayPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone — that is the outcome the tests want anyway
    }
  }
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until `pid` is gone; signals are async, so a bare check would flake. */
async function died(pid: number, withinMs = 4000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await Bun.sleep(25);
  }
  return false;
}

async function readPid(file: string): Promise<number> {
  const pid = Number.parseInt((await Bun.file(file).text()).trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`no pid recorded in ${file}`);
  strayPids.push(pid);
  return pid;
}

/**
 * A child that ignores SIGTERM outright, so only the hard KILL can stop it.
 * Records its own pid so the test can prove it actually died. Single-quoted
 * for bash and free of apostrophes so the perl body survives verbatim.
 */
const TERM_IGNORING_CHILD =
  `perl -e '$SIG{TERM} = "IGNORE"; open my $f, ">", $ENV{PIDFILE} or die; print $f $$; close $f; sleep 60;'`;

describe("with-timeout.sh — the watchdog", () => {
  test("returns the command's own exit status when it finishes in time", async () => {
    const bin = await sandboxBin(WATCHDOG_TOOLS);
    const result = await runWithPath(`with_timeout 10 printf 'hello\\n'`, bin);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello\n");
  });

  test("propagates a non-zero exit status unchanged", async () => {
    const bin = await sandboxBin(WATCHDOG_TOOLS);
    const result = await runWithPath(`with_timeout 10 bash -c 'exit 7'; echo "rc=$?"`, bin);

    expect(result.stdout.trim()).toBe("rc=7");
  });

  test("returns 124 and kills the child when the duration elapses", async () => {
    const bin = await sandboxBin(WATCHDOG_TOOLS);
    const started = Date.now();
    const result = await runWithPath(`with_timeout 1 sleep 30; echo "rc=$?"`, bin);
    const elapsed = Date.now() - started;

    expect(result.stdout.trim()).toBe("rc=124");
    // Must not have waited out the full 30s sleep; must have waited ~1s.
    expect(elapsed).toBeGreaterThanOrEqual(900);
    // `sleep` dies on TERM, so the KILL grace must not be charged to it —
    // blind-sleeping the grace would put this at 1s + KILL_AFTER_SECONDS.
    expect(elapsed).toBeLessThan((1 + KILL_AFTER_SECONDS) * 1000 - 500);
  });

  test("passes stdin through to the command", async () => {
    const bin = await sandboxBin(WATCHDOG_TOOLS);
    const result = await runWithPath(`with_timeout 10 cat`, bin, { stdin: "piped payload\n" });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("piped payload\n");
  });

  test("passes arguments through verbatim without a shell re-parse", async () => {
    const bin = await sandboxBin(WATCHDOG_TOOLS);
    // $HOME and the spaces/quotes must survive as literal argv bytes.
    const result = await runWithPath(
      `with_timeout 10 printf '[%s]' 'a b' '"c"' '$HOME'`,
      bin,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`[a b]["c"][$HOME]`);
  });

  test("escalates to KILL, so a child that ignores TERM still dies at the hard cap", async () => {
    const bin = await sandboxBin(WATCHDOG_TOOLS);
    const scratch = await makeTempDir("nahel-yolo-pid-");
    tempDirs.push(scratch);
    const pidFile = join(scratch, "child.pid");

    const started = Date.now();
    const result = await runWithPath(`with_timeout 1 ${TERM_IGNORING_CHILD}; echo "rc=$?"`, bin, {
      env: { PIDFILE: pidFile },
    });
    const elapsed = Date.now() - started;

    expect(result.stdout.trim()).toBe("rc=124");
    expect(await died(await readPid(pidFile))).toBe(true);
    // 1s cap + the grace, not the child's 60s sleep.
    expect(elapsed).toBeLessThan((1 + KILL_AFTER_SECONDS + 6) * 1000);
  }, 30000);

  test("kills the whole process tree, so descendants do not outlive the timeout", async () => {
    const bin = await sandboxBin(WATCHDOG_TOOLS);
    const scratch = await makeTempDir("nahel-yolo-desc-");
    tempDirs.push(scratch);
    const descFile = join(scratch, "descendant.pid");

    // The direct child is bash; `sleep` is its grandchild. Signalling only the
    // direct pid reaps bash and orphans the sleep.
    const result = await runWithPath(
      `with_timeout 1 bash -c 'sleep 60 & echo $! > "$DESCFILE"; wait'; echo "rc=$?"`,
      bin,
      { env: { DESCFILE: descFile } },
    );

    expect(result.stdout.trim()).toBe("rc=124");
    expect(await died(await readPid(descFile))).toBe(true);
  }, 30000);
});

describe("with-timeout.sh — a `timeout` binary on PATH", () => {
  /**
   * A `timeout` that would be glaringly wrong if it were ever used. The shim
   * must never reach for it: GNU `timeout -k` reports 137 (128+SIGKILL), not
   * 124, when the KILL escalation is what actually ended the command, and that
   * is indistinguishable from a child the OOM killer took. Callers branch on
   * 124, so the watchdog owns the timing on every host.
   */
  async function binWithSabotageTimeout(): Promise<string> {
    const bin = await sandboxBin(WATCHDOG_TOOLS);
    await writeFile(join(bin, "timeout"), "#!/bin/bash\nexit 99\n", { mode: 0o755 });
    return bin;
  }

  test("ignores it entirely and still runs the command itself", async () => {
    const bin = await binWithSabotageTimeout();
    const result = await runWithPath(`with_timeout 10 printf 'ours\\n'`, bin);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("ours\n");
  });

  test("ignores it entirely and still reports 124 on expiry", async () => {
    const bin = await binWithSabotageTimeout();
    const result = await runWithPath(`with_timeout 1 sleep 30; echo "rc=$?"`, bin);

    expect(result.stdout.trim()).toBe("rc=124");
  });
});

describe("with-timeout.sh — perl missing", () => {
  test("fails loudly rather than running the command unbounded", async () => {
    // perl is the watchdog, so without it nothing can enforce the cap. Running
    // a 600s codex call unbounded is far worse than refusing. 125 is what GNU
    // timeout uses for "the timeout tool itself failed", and is distinct from
    // the 127 that means "the command was not found".
    const bin = await sandboxBin(["bash", "sleep", "printf"]);
    const result = await runWithPath(`with_timeout 10 printf 'ran'; echo "rc=$?"`, bin);

    expect(result.stdout.trim()).toBe("rc=125");
    expect(result.stderr).toContain("perl");
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

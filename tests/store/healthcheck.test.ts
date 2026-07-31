import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHealthcheck } from "../../src/store/healthcheck";

/**
 * Store-layer healthcheck runner (PRD F2, ADR-0014): spawning the contract's
 * healthcheck command is store-layer I/O — the sibling of baseline.ts's git
 * spawn. It returns only the exit STATUS: the child inherits this process's
 * environment (so the contract's named vars reach it) but their values never
 * flow back — `nahel doctor` reports pass/fail, never secret values.
 */
/** The healthcheck runs in a DIRECTORY the caller names; these run where the suite does. */
const HERE = process.cwd();

describe("store/healthcheck — runHealthcheck", () => {
  test("the child runs in the cwd it was given, not the process's own", async () => {
    // doctor hands it the resolved store root, so a root-relative healthcheck
    // (`test -f docker-compose.yml`, `bun test`) works from any subdirectory.
    const dir = await mkdtemp(join(tmpdir(), "nahel-healthcheck-"));
    try {
      const out = join(dir, "where");
      const result = await runHealthcheck(`pwd > ${JSON.stringify(out)}`, dir);
      expect(result.ok).toBe(true);
      expect((await readFile(out, "utf8")).trim()).toBe(await realpath(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a command that exits 0 reports success", async () => {
    const result = await runHealthcheck("exit 0", HERE);
    expect(result).toEqual({ ok: true, exitCode: 0, timedOut: false });
  });

  test("a command that exits non-zero reports that exact exit code as a failure", async () => {
    expect(await runHealthcheck("exit 4", HERE)).toEqual({ ok: false, exitCode: 4, timedOut: false });
    expect(await runHealthcheck("false", HERE)).toEqual({ ok: false, exitCode: 1, timedOut: false });
  });

  test("a command not found fails through the shell's 127, never throws", async () => {
    const result = await runHealthcheck("definitely-not-a-real-command-xyz", HERE);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(127);
  });

  test("returns only a status — no stdout/stderr channel that could carry a value", async () => {
    // Even a command that prints does not surface its output on the result.
    const result = await runHealthcheck("echo SUPERSECRET; exit 0", HERE);
    expect(Object.keys(result).sort()).toEqual(["exitCode", "ok", "timedOut"]);
    expect(JSON.stringify(result)).not.toContain("SUPERSECRET");
  });

  test("a command that outruns the timeout is killed and reported as timedOut, not a hang (Finding 6 / PR #13)", async () => {
    const start = Date.now();
    const result = await runHealthcheck("sleep 5", HERE, 1);
    const elapsedMs = Date.now() - start;
    // Killed within ~2s of the 1s deadline, never allowed to run the full sleep.
    expect(elapsedMs).toBeLessThan(3000);
    expect(result).toEqual({ ok: false, exitCode: null, timedOut: true });
  });

  test("a fast command under the timeout is not flagged timedOut", async () => {
    expect(await runHealthcheck("exit 0", HERE, 5)).toEqual({ ok: true, exitCode: 0, timedOut: false });
    expect(await runHealthcheck("exit 3", HERE, 5)).toEqual({ ok: false, exitCode: 3, timedOut: false });
  });
});

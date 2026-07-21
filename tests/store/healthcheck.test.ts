import { describe, expect, test } from "bun:test";
import { runHealthcheck } from "../../src/store/healthcheck";

/**
 * Store-layer healthcheck runner (PRD F2, ADR-0014): spawning the contract's
 * healthcheck command is store-layer I/O — the sibling of baseline.ts's git
 * spawn. It returns only the exit STATUS: the child inherits this process's
 * environment (so the contract's named vars reach it) but their values never
 * flow back — `nahel doctor` reports pass/fail, never secret values.
 */
describe("store/healthcheck — runHealthcheck", () => {
  test("a command that exits 0 reports success", async () => {
    const result = await runHealthcheck("exit 0");
    expect(result).toEqual({ ok: true, exitCode: 0 });
  });

  test("a command that exits non-zero reports that exact exit code as a failure", async () => {
    expect(await runHealthcheck("exit 4")).toEqual({ ok: false, exitCode: 4 });
    expect(await runHealthcheck("false")).toEqual({ ok: false, exitCode: 1 });
  });

  test("a command not found fails through the shell's 127, never throws", async () => {
    const result = await runHealthcheck("definitely-not-a-real-command-xyz");
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(127);
  });

  test("returns only a status — no stdout/stderr channel that could carry a value", async () => {
    // Even a command that prints does not surface its output on the result.
    const result = await runHealthcheck("echo SUPERSECRET; exit 0");
    expect(Object.keys(result).sort()).toEqual(["exitCode", "ok"]);
    expect(JSON.stringify(result)).not.toContain("SUPERSECRET");
  });
});

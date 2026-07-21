import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Run-contract healthcheck execution (PRD F2, ADR-0014). Spawning a process is
 * store-layer I/O — the same privilege baseline.ts exercises to run `git`, and
 * for the same reason it lives in the store: commands stay pure over the
 * returned data. The child inherits this process's environment (so the
 * contract's named env vars reach the healthcheck) but nothing about those
 * values, nor the command's own output, flows back: the result is the exit
 * STATUS only. `nahel doctor` reports pass/fail, never a secret value.
 */

const execFileAsync = promisify(execFile);

/** Generous ceiling so a chatty healthcheck's output never trips maxBuffer. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** The outcome of a healthcheck run: success plus the process exit code. */
export interface HealthcheckResult {
  ok: boolean;
  /** The command's exit code; null when it could not be determined. */
  exitCode: number | null;
}

/**
 * Run the contract's healthcheck command through a shell; success is exit 0.
 * The command string comes from committed config (no secrets); it is never
 * echoed with its output — only the exit status is returned.
 */
export async function runHealthcheck(command: string): Promise<HealthcheckResult> {
  try {
    await execFileAsync("/bin/sh", ["-c", command], { maxBuffer: MAX_OUTPUT_BYTES });
    return { ok: true, exitCode: 0 };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { ok: false, exitCode: typeof code === "number" ? code : null };
  }
}

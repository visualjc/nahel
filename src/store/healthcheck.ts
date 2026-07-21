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

/**
 * Default healthcheck deadline (seconds) when the contract names none. Without
 * a bound, `nahel doctor` — and the AFK gates that lean on it — could hang
 * forever on a wedged healthcheck (PRD F2, Finding 6).
 */
export const DEFAULT_HEALTHCHECK_TIMEOUT_SECONDS = 60;

/** The outcome of a healthcheck run: success plus the process exit code. */
export interface HealthcheckResult {
  ok: boolean;
  /** The command's exit code; null when it could not be determined. */
  exitCode: number | null;
  /** True when the command was killed for outrunning its timeout. */
  timedOut: boolean;
}

/**
 * Run the contract's healthcheck command through a shell; success is exit 0.
 * The command string comes from committed config (no secrets); it is never
 * echoed with its output — only the exit status is returned.
 *
 * A command that outruns `timeoutSeconds` is killed (execFile's `timeout`
 * option, which Bun honors: the child is sent SIGTERM at the deadline) and
 * reported as `timedOut` — a distinct signal so doctor can tell a hang from an
 * ordinary failure rather than blocking forever (Finding 6).
 */
export async function runHealthcheck(
  command: string,
  timeoutSeconds: number = DEFAULT_HEALTHCHECK_TIMEOUT_SECONDS,
): Promise<HealthcheckResult> {
  try {
    await execFileAsync("/bin/sh", ["-c", command], {
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: timeoutSeconds * 1000,
    });
    return { ok: true, exitCode: 0, timedOut: false };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    // A timeout kill surfaces with no numeric exit code and killed=true (the
    // deadline SIGTERM), distinguishing it from a command that merely exited
    // non-zero.
    const killed = (error as { killed?: unknown }).killed === true;
    if (killed && typeof code !== "number") {
      return { ok: false, exitCode: null, timedOut: true };
    }
    return { ok: false, exitCode: typeof code === "number" ? code : null, timedOut: false };
  }
}

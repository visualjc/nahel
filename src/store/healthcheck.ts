import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Contract } from "../schema/records";
import { MAX_OUTPUT_BYTES } from "./exec";

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
 * Run the contract's healthcheck command through a shell IN `cwd`; success is
 * exit 0. The directory is explicit rather than inherited: the healthcheck is
 * written against the repo root (`test -f docker-compose.yml`, `bun test`), so
 * doctor hands it the resolved store root and a run from any subdirectory
 * checks the same thing. The command string comes from committed config (no
 * secrets); it is never echoed with its output — only the exit status is
 * returned.
 *
 * A command that outruns `timeoutSeconds` is killed (execFile's `timeout`
 * option, which Bun honors: the child is sent SIGTERM at the deadline) and
 * reported as `timedOut` — a distinct signal so doctor can tell a hang from an
 * ordinary failure rather than blocking forever (Finding 6).
 */
export async function runHealthcheck(
  command: string,
  cwd: string,
  timeoutSeconds: number = DEFAULT_HEALTHCHECK_TIMEOUT_SECONDS,
): Promise<HealthcheckResult> {
  try {
    await execFileAsync("/bin/sh", ["-c", command], {
      cwd,
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

/** A contract healthcheck as run: the command, the deadline it ran under, and its outcome. */
export interface ContractHealthcheckRun extends HealthcheckResult {
  /** The committed command string, safe to echo (no secrets by contract). */
  command: string;
  /** The deadline actually applied — the contract's, or the default. */
  timeoutSeconds: number;
}

/**
 * Run the CONTRACT's healthcheck, deadline and all — the one place that knows
 * how a contract's healthcheck is executed. Two callers need exactly this and
 * must not drift: `nahel doctor` reports the verdict, and `nahel dispatch`
 * preflights it before spawning a worker (chore f35q1rax). A contract that
 * defines no healthcheck answers `undefined` — nothing to run is not a
 * failure — so each caller phrases "nothing to check" in its own words.
 */
export async function runContractHealthcheck(
  contract: Pick<Contract, "healthcheck" | "healthcheck_timeout_seconds">,
  cwd: string,
): Promise<ContractHealthcheckRun | undefined> {
  const command = contract.healthcheck;
  if (command === undefined) return undefined;
  const timeoutSeconds =
    contract.healthcheck_timeout_seconds ?? DEFAULT_HEALTHCHECK_TIMEOUT_SECONDS;
  const result = await runHealthcheck(command, cwd, timeoutSeconds);
  return { ...result, command, timeoutSeconds };
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Agent-CLI process spawning (PRD F1.1/F1.4, ADR-0016). Spawning is
 * store-layer I/O — the privilege baseline.ts (git), healthcheck.ts (the run
 * contract) and skills.ts already exercise — so dispatch's spawn lives here
 * and the command stays pure over the returned data. Dispatch joins that
 * allowlist deliberately: launching an executor is the one mechanical act
 * the deterministic CLI performs on the AFK loop's behalf.
 *
 * The child INHERITS this process's environment: the agent CLI carries its
 * own credentials, which nahel never names, reads, or forwards (hard
 * constraint 1 — dispatch itself needs zero API keys). Exactly one variable
 * is added, NAHEL_ACTOR, so every mutation the worker makes is attributed to
 * the worker rather than the dispatcher. It is added by exec'ing through
 * `env NAME=value <binary> …` rather than by rebuilding the environment,
 * because the store layer deliberately has no channel to the ambient process
 * environment (cli.ts is its single reader). No shell is involved, so
 * arguments — including a hostile config value — are passed literally.
 */

const execFileAsync = promisify(execFile);

/** Generous ceiling so a chatty agent's transcript never trips maxBuffer. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** The `env` wrapper that adds one variable while inheriting the rest. */
const ENV_WRAPPER = "env";

/** The child could not be started at all (bad working directory, no `env`). */
export class DispatchSpawnError extends Error {}

export interface DispatchSpawnInput {
  /** Agent CLI to run: a PATH name or an absolute path. */
  binary: string;
  /** The composed arguments, prompt last. */
  args: readonly string[];
  /** `kind:id` actor spec exported to the child as NAHEL_ACTOR. */
  actorSpec: string;
  /** Working directory — the repo the worker acts on. */
  cwd: string;
}

/** What the dispatched worker did: its exit status and captured output. */
export interface DispatchSpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the composed invocation to completion. A non-zero exit is a RESULT,
 * not an exception — the caller records the failed run either way; only a
 * failure to start the process at all throws. There is deliberately no
 * timeout: an agent run legitimately takes hours, and the loop's supervisor
 * (a host agent) owns when to stop waiting.
 */
export async function spawnDispatch(input: DispatchSpawnInput): Promise<DispatchSpawnResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      ENV_WRAPPER,
      [`NAHEL_ACTOR=${input.actorSpec}`, input.binary, ...input.args],
      { cwd: input.cwd, maxBuffer: MAX_OUTPUT_BYTES },
    );
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== "number") {
      // No exit status at all: the process never ran (missing working
      // directory, no `env` on PATH, killed before exec).
      throw new DispatchSpawnError(
        `could not spawn ${input.binary} in ${input.cwd}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return {
      exitCode: code,
      stdout: String((error as { stdout?: unknown }).stdout ?? ""),
      stderr: String((error as { stderr?: unknown }).stderr ?? ""),
    };
  }
}

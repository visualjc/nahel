import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";

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
 *
 * The worker's lifecycle is managed explicitly (bug evqagdsd, found in the
 * Phase 2 exit test):
 *
 * - stdin is CLOSED (`/dev/null`), never an open pipe. An inherited pipe that
 *   nobody writes and nobody closes is exactly what `codex exec` blocks on
 *   forever — dispatch.started journaled, then silence — and what `claude -p`
 *   only survives by its own 3-second stdin timeout.
 * - The worker gets its OWN process group (`detached`), so the teardown of a
 *   backgrounded dispatching shell cannot signal the worker mid-run through
 *   group delivery. Dispatch still waits on the worker; nothing is orphaned
 *   on the happy path, and when to stop waiting stays the supervisor's call.
 * - A worker killed by a signal is a RESULT, not a spawn failure: the caller
 *   journals dispatch.ended and closes the run with the signal named, so a
 *   dead worker can never leave a dangling started-but-never-ended bracket.
 */

/** Generous ceiling so a chatty agent's transcript never trips the capture cap. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** The `env` wrapper that adds one variable while inheriting the rest. */
const ENV_WRAPPER = "env";

/**
 * The child could not be started at all (bad working directory, no `env`), or
 * had to be killed for exceeding the output capture ceiling. Either way there
 * is no honest exit status to record — the caller journals the failure message.
 */
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
  /** Signal that killed the worker, when it died to one instead of exiting. */
  signal?: string;
}

/** The shell convention for a signal death: 128 + the signal's number. */
function signalExitCode(signal: string): number {
  const number = (osConstants.signals as Record<string, number | undefined>)[signal];
  return 128 + (number ?? 0);
}

/**
 * Run the composed invocation to completion. A non-zero exit is a RESULT,
 * not an exception — and so is a signal death — because the caller records
 * the failed run either way; only a failure to start the process at all (or
 * an output overflow that forced a kill) throws. There is deliberately no
 * timeout: an agent run legitimately takes hours, and the loop's supervisor
 * (a host agent) owns when to stop waiting.
 */
export function spawnDispatch(input: DispatchSpawnInput): Promise<DispatchSpawnResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(
        ENV_WRAPPER,
        [`NAHEL_ACTOR=${input.actorSpec}`, input.binary, ...input.args],
        { cwd: input.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true },
      );
    } catch (error) {
      // Bun raises some start failures (a gone working directory) at the
      // spawn call itself rather than through the "error" event.
      reject(
        new DispatchSpawnError(
          `could not spawn ${input.binary} in ${input.cwd}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let overflowed = false;
    let settled = false;

    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        if (!overflowed) {
          overflowed = true;
          // The worker (and anything it spawned — it leads its own group) is
          // past reasoning with; unbounded capture is the only alternative.
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
        return;
      }
      sink.push(chunk);
    };
    child.stdout!.on("data", collect(out));
    child.stderr!.on("data", collect(err));

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(
        new DispatchSpawnError(
          `could not spawn ${input.binary} in ${input.cwd}: ${error.message}`,
        ),
      );
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (overflowed) {
        reject(
          new DispatchSpawnError(
            `${input.binary} exceeded the ${MAX_OUTPUT_BYTES / (1024 * 1024)} MiB output ` +
              `capture ceiling and was killed`,
          ),
        );
        return;
      }
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (code !== null) {
        resolve({ exitCode: code, stdout, stderr });
        return;
      }
      // No exit code means a signal death ("close" always carries one of the
      // two). Node models it as `null`, so the fallback below is for the type
      // system, not for a reachable state.
      const name = signal ?? "SIGKILL";
      resolve({ exitCode: signalExitCode(name), stdout, stderr, signal: name });
    });
  });
}

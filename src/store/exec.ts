/**
 * The store's child-process output cap, and what it means to hit it.
 *
 * Every store spawn buffers its child's stdout in memory, so every one needs a
 * ceiling. A spawn that hits the ceiling is aborted mid-capture: what came back
 * is NOT the command's answer, so the overflow has to be reported as its own
 * refusal. Reported through the ordinary failure path it would read as "git
 * said no" — a wrong answer rather than a missing one. git is spawned from
 * three modules, so the cap and its detection live here once.
 */

/**
 * Ceiling on captured child output — generous for porcelain/numstat/ref
 * listings on large repos. Deliberately NOT raised when a repo outruns it:
 * nahel would be buffering hundreds of megabytes to answer a question about a
 * repo that is already pathological.
 */
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Node/Bun's error code for a child that outran its `maxBuffer`. */
const MAXBUFFER_ERROR_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

/**
 * Did this spawn failure come from the output cap rather than from the command
 * itself? The two are indistinguishable in the error's message ("stdout
 * maxBuffer length exceeded" carries no command, no cap, no cause), so callers
 * ask here and say something useful instead.
 */
export function isOutputCapExceeded(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === MAXBUFFER_ERROR_CODE
  );
}

/** The failure detail for a spawn whose output outran `cap` bytes. */
export function outputCapDetail(cap: number): string {
  return (
    `output exceeded nahel's ${cap}-byte capture cap — the repo state is unusually large; ` +
    "nahel refuses a truncated answer rather than acting on one"
  );
}

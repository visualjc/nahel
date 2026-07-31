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

/**
 * Git's repository-SELECTION environment: every one of these overrides the
 * directory git was handed.
 *
 *   - GIT_DIR / GIT_COMMON_DIR name another repository outright;
 *   - GIT_WORK_TREE / GIT_INDEX_FILE / GIT_OBJECT_DIRECTORY /
 *     GIT_ALTERNATE_OBJECT_DIRECTORIES swap out pieces of the one it finds;
 *   - GIT_CEILING_DIRECTORIES can stop discovery before it reaches the root.
 *
 * Hooks, CI runners, `git rebase --exec`, and any shell that exported one and
 * moved on all set these, so inheriting them is the ordinary case rather than
 * an exotic one. Every question nahel asks git is about "the repo AT this
 * root", so an inherited value can only produce an answer about the wrong
 * repository: a ref scan reporting "not a git repository" about a path nobody
 * asked about, or — silently, at exit 0 — a claim baseline recording another
 * repo's HEAD. Neither failure announces itself, which is why these are
 * stripped rather than detected.
 */
const GIT_REPOSITORY_SELECTION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CEILING_DIRECTORIES",
] as const;

/**
 * The environment for a git spawn: everything inherited — PATH, HOME, proxy
 * and credential settings git legitimately needs — MINUS the variables above.
 *
 * This is the ONLY place the store reads the ambient environment, and that is
 * the point (HC1): the spawn seam owns it, so no caller has to reason about
 * ambient git state and there is exactly one place to audit. Sanitizing beats
 * detecting because the question never varies — nahel always means the repo at
 * the root it was given, so an override is never information, only noise.
 */
export function gitSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of GIT_REPOSITORY_SELECTION_VARS) delete env[name];
  return env;
}

/** The failure detail for a spawn whose output outran `cap` bytes. */
export function outputCapDetail(cap: number): string {
  return (
    `output exceeded nahel's ${cap}-byte capture cap — the repo state is unusually large; ` +
    "nahel refuses a truncated answer rather than acting on one"
  );
}

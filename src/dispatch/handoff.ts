import { serializeFrontmatter } from "../store/frontmatter";

/**
 * The handoff (task) document renderer (PRD F1): a dispatched worker's task
 * travels as `nahel/runs/<run-id>/task.md`, not as a giant trailing argv
 * argument — oversized argv is a proven field failure (journal nt93edc0: codex
 * hung on a mega-prompt dispatch, the pointer-prompt re-dispatch ran healthy).
 *
 * This module is PURE string rendering, the install/agents.ts precedent: the
 * command owns the I/O and the clock, so `created` arrives as a parameter and
 * the same dispatch renders the same bytes on every machine.
 *
 * The orientation contract deliberately does NOT appear here — it stays in the
 * prompt (F3). Two sources for one contract is two contracts that drift.
 */

export interface TaskDocInput {
  /** The run this task was dispatched under — the document's own directory. */
  run: string;
  /** The work item the run is executing. */
  item: string;
  /** The routing responsibility the worker was dispatched for. */
  responsibility: string;
  /** Dispatch time, ISO 8601 — supplied by the caller, who owns the clock. */
  created: string;
  /** The task itself, reproduced in the body byte-for-byte. */
  task: string;
}

/**
 * Render one task document: frontmatter (`run`, `item`, `responsibility`,
 * `created`) followed by the task VERBATIM. Byte fidelity of the body is the
 * load-bearing property (F1 acceptance) — the brief a worker acts on must be
 * the brief the dispatcher wrote, so nothing here trims, wraps, or re-encodes
 * it. A body opening with its own `---` line is safe: the frontmatter split
 * closes on the renderer's fence, which comes first.
 */
export function renderTaskDoc(input: TaskDocInput): string {
  return serializeFrontmatter(
    {
      run: input.run,
      item: input.item,
      responsibility: input.responsibility,
      created: input.created,
    },
    input.task,
  );
}

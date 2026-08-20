import { z } from "zod";
import { requireValidId } from "../schema/id";
import { idField } from "../schema/records";

/**
 * The result-document contract (PRD F4): a dispatched worker writes back one
 * `result.md` in its run directory — YAML frontmatter (`run`, `item`,
 * `status`, `summary`) followed by unconstrained markdown prose.
 *
 * This module is PURE — shape validation and path RENDERING only; the reading
 * and writing belong to the store's I/O helpers. It sits beside the other
 * frontmatter schemas because a result doc is state that lands in `nahel/`,
 * even though nahel never authors one.
 *
 * The one deliberate difference from every other record schema here: this
 * object is NOT strict. Records nahel writes are strict so a field typo
 * surfaces instead of silently vanishing; a result doc is written by an agent
 * we do not control, and rejecting it because the worker added `tokens_used`
 * would throw away a perfectly good result. Unknown keys are tolerated and
 * dropped; the four keys we need are enforced exactly.
 *
 * A missing result.md is NOT an error anywhere (PRD F4 non-goal: worker
 * enforcement) — dispatch records whether it appeared, and `nahel validate`
 * checks only the ones that exist.
 */

/** File name of the task document dispatch hands a worker. */
export const TASK_DOC_FILENAME = "task.md";

/** File name of the result document a worker writes back. */
export const RESULT_DOC_FILENAME = "result.md";

/** Repo-relative directory run state lives in (POSIX form, for doc pointers). */
export const RUNS_RELATIVE_DIR = "nahel/runs";

/**
 * How a worker reports the shape of its outcome. Three values, not two: a
 * worker that did part of the job and stopped has something true to say, and
 * flattening that into `failure` would lose the distinction the reader needs.
 */
export const RESULT_DOC_STATUSES = ["success", "failure", "partial"] as const;

export const resultDocFrontmatterSchema = z.object({
  /** The run this document reports on — must match the dispatching run's id. */
  run: idField,
  /** The work item the run was executing. */
  item: idField,
  /** The outcome, from the fixed enum above. */
  status: z.enum(RESULT_DOC_STATUSES),
  /**
   * One line, always: the summary is rendered inline in journals and progress
   * views, so an embedded newline would silently break every consumer's
   * layout. Detail belongs in the body, which is unconstrained.
   */
  summary: z
    .string()
    .min(1, "summary must be a non-empty string")
    .refine((value) => !value.includes("\n"), "summary must be ONE line — it contains a newline"),
});
export type ResultDocFrontmatter = z.infer<typeof resultDocFrontmatterSchema>;

/**
 * Validate one result document's frontmatter, throwing with the FAILING FIELD
 * NAMED (parseWorkflowDoc's error style) — a worker's mistake has to be
 * actionable from the message alone, since nobody is watching the process that
 * made it.
 */
export function parseResultDoc(frontmatter: Record<string, unknown>): ResultDocFrontmatter {
  const parsed = resultDocFrontmatterSchema.safeParse(frontmatter);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field =
      issue === undefined || issue.path.length === 0 ? "frontmatter" : issue.path.join(".");
    throw new Error(`invalid result frontmatter: ${field} — ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

/**
 * The contract as prose, for embedding verbatim in a dispatched worker's
 * prompt. It is a CONST beside the schema on purpose: the prompt and the
 * parser are then the same source, so the keys a worker is told to write can
 * never drift from the keys the parser demands. A change to either one is a
 * change to this file, and the tests over both fail together.
 */
export const RESULT_DOC_CONTRACT = [
  `When you finish, write your result document to ${RESULT_DOC_FILENAME} in the run directory named in your task document.`,
  "It is YAML frontmatter followed by free markdown. All four frontmatter keys are required:",
  "",
  "---",
  "run: <the run id from your task document>",
  "item: <the work item id from your task document>",
  `status: ${RESULT_DOC_STATUSES.join(" | ")}`,
  "summary: <one line, no line breaks>",
  "---",
  "",
  "Below the frontmatter, write whatever a reader needs: what you did, what you found, what is left undone. The body is unconstrained markdown.",
].join("\n");

/**
 * Repo-relative POSIX path of a run's task document, e.g.
 * `nahel/runs/8j44rq9g/task.md`. Separators are ALWAYS `/`: these strings go
 * into prompts, journal entries and committed docs, which are read on every
 * platform and diffed across them — a host-shaped separator would make the
 * same fact render two ways. The id is validated exactly as the absolute path
 * helpers validate it, so a crafted id cannot be rendered into a pointer that
 * something downstream then opens.
 */
export function taskDocRelativePath(runId: string): string {
  return `${RUNS_RELATIVE_DIR}/${requireValidId(runId, "run")}/${TASK_DOC_FILENAME}`;
}

/** Repo-relative POSIX path of a run's result document (see taskDocRelativePath). */
export function resultDocRelativePath(runId: string): string {
  return `${RUNS_RELATIVE_DIR}/${requireValidId(runId, "run")}/${RESULT_DOC_FILENAME}`;
}

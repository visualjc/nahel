import { z } from "zod";

/**
 * Canonical workflow doc format (PRD F10, ADR-0005): agent-neutral procedure
 * docs in `nahel/workflows/*.md`, frontmatter `name`/`description`/`args`.
 * This module is PURE — shape validation only; the install command does the
 * reading through the store layer. The full format contract is documented in
 * docs/workflow-format.md.
 */

/** Repo-relative directory the canonical workflow docs live in (POSIX form for doc pointers). */
export const WORKFLOWS_RELATIVE_DIR = "nahel/workflows";

/** Workflow names are slugs — they become shim file names and slash commands. */
export const WORKFLOW_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const workflowFrontmatterSchema = z.strictObject({
  /** Slug identity; must equal the doc's file stem and names the shim. */
  name: z
    .string()
    .regex(
      WORKFLOW_NAME_PATTERN,
      "must be a slug: lowercase letters/digits separated by single hyphens (e.g. brief)",
    ),
  /** One line shown in agent command listings. */
  description: z.string().min(1, "description must be a non-empty string"),
  /** Argument hint for the shim (e.g. "<item-id>"); empty when the workflow takes none. */
  args: z.string(),
});
export type WorkflowFrontmatter = z.infer<typeof workflowFrontmatterSchema>;

/** One parsed workflow doc plus the repo-relative path shims point back at. */
export interface WorkflowDoc {
  frontmatter: WorkflowFrontmatter;
  /** Repo-relative POSIX path of the canonical doc, e.g. nahel/workflows/brief.md. */
  path: string;
}

/**
 * Validate one workflow doc's frontmatter against the format AND its file:
 * the frontmatter `name` must equal the file stem, so a shim's file name,
 * slash command, and canonical doc can never drift apart. Throws with the
 * reason on any violation.
 */
export function parseWorkflowDoc(
  fileName: string,
  frontmatter: Record<string, unknown>,
): WorkflowFrontmatter {
  const parsed = workflowFrontmatterSchema.safeParse(frontmatter);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue === undefined || issue.path.length === 0 ? "frontmatter" : issue.path.join(".");
    throw new Error(`invalid workflow frontmatter: ${field} — ${issue?.message ?? "invalid"}`);
  }
  const stem = fileName.endsWith(".md") ? fileName.slice(0, -3) : fileName;
  if (parsed.data.name !== stem) {
    throw new Error(
      `frontmatter name ${JSON.stringify(parsed.data.name)} must match the file stem ${JSON.stringify(stem)}`,
    );
  }
  return parsed.data;
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

/**
 * Git baseline capture and handback evidence (PRD F9). Spawning `git` is
 * store-layer I/O — the same privilege as the filesystem — so it lives here
 * and commands stay pure over the returned data. Everything this module
 * returns is a deterministic function of repo state: only porcelain/plumbing
 * git formats (rev-parse, status --porcelain, rev-list, diff --numstat), no
 * locale-dependent or relative-date output anywhere, so identical repo state
 * yields byte-identical evidence (PRD F9's determinism requirement).
 */

const execFileAsync = promisify(execFile);

/** A git invocation failed; the message carries the command and git's stderr. */
export class GitError extends Error {}

/** Generous ceiling for porcelain/numstat output on large repos. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

async function git(root: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail =
      typeof stderr === "string" && stderr.trim() !== ""
        ? stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new GitError(`git ${args.join(" ")} failed in ${root}: ${detail}`);
  }
}

/** Split command output into its non-empty lines, preserving git's order. */
function outputLines(output: string): string[] {
  return output.split("\n").filter((line) => line !== "");
}

const commitShaField = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "must be a 40-char lowercase hex commit SHA");

/**
 * The repo baseline a claim records in its journal event: the HEAD commit SHA
 * and the `git status --porcelain` snapshot at claim time (PRD F9).
 */
export const gitBaselineSchema = z.strictObject({
  head: commitShaField,
  dirty: z.array(z.string()),
});
export type GitBaseline = z.infer<typeof gitBaselineSchema>;

/** One file's diff summary: added/deleted line counts; "-" means binary. */
export const diffStatSchema = z.strictObject({
  file: z.string().min(1, "diff stat file must be a non-empty path"),
  added: z.union([z.number().int().nonnegative(), z.literal("-")]),
  deleted: z.union([z.number().int().nonnegative(), z.literal("-")]),
});
export type DiffStat = z.infer<typeof diffStatSchema>;

/**
 * What a handback journals about the human's intervention: the commits they
 * made (attribution), the diff summary baseline→HEAD, the working tree now,
 * and the changes that were already uncommitted at claim time — those are
 * listed as excluded from attribution rather than credited to the claimant.
 */
export const handbackEvidenceSchema = z.strictObject({
  baseline_head: commitShaField,
  commits: z.array(commitShaField),
  diff: z.array(diffStatSchema),
  dirty: z.array(z.string()),
  excluded_from_attribution: z.array(z.string()),
});
export type HandbackEvidence = z.infer<typeof handbackEvidenceSchema>;

function parseNumstatLine(line: string): DiffStat {
  const [added, deleted, ...pathParts] = line.split("\t");
  if (added === undefined || deleted === undefined || pathParts.length === 0) {
    throw new GitError(`unparseable git numstat line: ${JSON.stringify(line)}`);
  }
  const count = (field: string): number | "-" =>
    field === "-" ? "-" : Number.parseInt(field, 10);
  return diffStatSchema.parse({
    file: pathParts.join("\t"),
    added: count(added),
    deleted: count(deleted),
  });
}

/** Capture the claim baseline: HEAD SHA + porcelain working-tree snapshot. */
export async function captureBaseline(root: string): Promise<GitBaseline> {
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  const dirty = outputLines(await git(root, ["status", "--porcelain"]));
  return gitBaselineSchema.parse({ head, dirty });
}

/**
 * Collect the handback evidence for a claim baseline: commits since the
 * baseline (SHAs, oldest first), the diff summary baseline→HEAD, the current
 * dirty state, and the baseline's dirty snapshot as the exclusion list.
 */
export async function collectHandbackEvidence(
  root: string,
  baseline: GitBaseline,
): Promise<HandbackEvidence> {
  const valid = gitBaselineSchema.parse(baseline);
  const commits = outputLines(
    await git(root, ["rev-list", "--reverse", `${valid.head}..HEAD`]),
  );
  const diff = outputLines(await git(root, ["diff", "--numstat", valid.head, "HEAD"])).map(
    parseNumstatLine,
  );
  const dirty = outputLines(await git(root, ["status", "--porcelain"]));
  return handbackEvidenceSchema.parse({
    baseline_head: valid.head,
    commits,
    diff,
    dirty,
    excluded_from_attribution: valid.dirty,
  });
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { gitSpawnEnv, isOutputCapExceeded, MAX_OUTPUT_BYTES, outputCapDetail } from "./exec";

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

/**
 * The git call outran the output cap. A distinct class because it is NOT a
 * verdict about the repo's revisions — captureBaseline must not read it as an
 * unborn HEAD, which is the other reason `rev-parse HEAD` fails.
 */
class GitOutputCapError extends GitError {}

async function git(
  root: string,
  args: readonly string[],
  maxOutputBytes: number = MAX_OUTPUT_BYTES,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
      maxBuffer: maxOutputBytes,
      // `-C root` only sets the directory git starts from; an inherited
      // GIT_DIR still sends it to another repository — and a baseline for the
      // wrong repo is journaled without a murmur (exit 0, plausible SHA).
      env: gitSpawnEnv(),
    });
    return stdout;
  } catch (error) {
    if (isOutputCapExceeded(error)) {
      throw new GitOutputCapError(
        `git ${args.join(" ")} failed in ${root}: ${outputCapDetail(maxOutputBytes)}`,
      );
    }
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

/** Run a diagnostic git call for its ANSWER; undefined when it fails. */
async function probeGit(
  root: string,
  args: readonly string[],
  maxOutputBytes: number,
): Promise<string | undefined> {
  try {
    return (await git(root, args, maxOutputBytes)).trim();
  } catch {
    return undefined;
  }
}

/** A bare repo has no working tree, so no claim can ever be based on it. */
function bareRepoRefusal(root: string): string {
  return (
    `the git repo at ${root} is bare — a claim baseline is a snapshot of a working tree ` +
    "(HEAD plus git status), and a bare repo has none; claim from a normal checkout instead"
  );
}

/** Is this a bare repo? The ANSWER, never the exit code: both are exit 0. */
async function isBareRepo(root: string, maxOutputBytes: number): Promise<boolean> {
  return (await probeGit(root, ["rev-parse", "--is-bare-repository"], maxOutputBytes)) === "true";
}

/**
 * Why this repo can never yield a baseline — bare, or an unborn HEAD (`git
 * init` with no commit yet) — or undefined when neither applies and git's own
 * failure is the honest answer.
 *
 * Both probes are read for their OUTPUT: `--is-bare-repository` and
 * `--is-inside-work-tree` print "true"/"false" and exit 0 either way, so an
 * exit-code-only reading calls a bare repo an unborn worktree and tells the
 * operator to commit — advice that can never make a claim work there.
 */
async function unusableRepoReason(
  root: string,
  maxOutputBytes: number,
): Promise<string | undefined> {
  if (await isBareRepo(root, maxOutputBytes)) return bareRepoRefusal(root);
  if ((await probeGit(root, ["rev-parse", "--is-inside-work-tree"], maxOutputBytes)) !== "true") {
    return undefined;
  }
  // HEAD is a symbolic ref (a branch) that resolves to no commit: unborn.
  if ((await probeGit(root, ["symbolic-ref", "--quiet", "HEAD"], maxOutputBytes)) === undefined) {
    return undefined;
  }
  return (
    `the git repo at ${root} has no commits yet — a claim records the HEAD commit as its ` +
    "baseline, so make an initial commit before claiming"
  );
}

/** Capture the claim baseline: HEAD SHA + porcelain working-tree snapshot. */
export async function captureBaseline(
  root: string,
  maxOutputBytes: number = MAX_OUTPUT_BYTES,
): Promise<GitBaseline> {
  let head: string;
  try {
    head = (await git(root, ["rev-parse", "HEAD"], maxOutputBytes)).trim();
  } catch (error) {
    // git's own answer here is "ambiguous argument 'HEAD'", which says nothing
    // about the actual situation. An overflow is never a verdict about the
    // repo, so it is never re-diagnosed as one.
    if (error instanceof GitOutputCapError) throw error;
    const reason = await unusableRepoReason(root, maxOutputBytes);
    if (reason !== undefined) throw new GitError(reason);
    throw error;
  }
  // `rev-parse HEAD` carries no --verify, so an unresolvable HEAD is ECHOED
  // back and exits 0 — an empty bare repo answers the literal "HEAD". The
  // shape, not the exit code, is what says the revision resolved.
  if (!commitShaField.safeParse(head).success) {
    throw new GitError(
      (await unusableRepoReason(root, maxOutputBytes)) ??
        `git rev-parse HEAD in ${root} did not resolve to a commit (got ${JSON.stringify(head)})`,
    );
  }
  let dirty: string[];
  try {
    dirty = outputLines(await git(root, ["status", "--porcelain"], maxOutputBytes));
  } catch (error) {
    // A bare repo WITH commits resolves HEAD and only fails here, with git's
    // "must be run in a work tree" — name the reason a claim cannot work.
    if (!(error instanceof GitOutputCapError) && (await isBareRepo(root, maxOutputBytes))) {
      throw new GitError(bareRepoRefusal(root));
    }
    throw error;
  }
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
  maxOutputBytes: number = MAX_OUTPUT_BYTES,
): Promise<HandbackEvidence> {
  const valid = gitBaselineSchema.parse(baseline);
  const commits = outputLines(
    await git(root, ["rev-list", "--reverse", `${valid.head}..HEAD`], maxOutputBytes),
  );
  const diff = outputLines(
    await git(root, ["diff", "--numstat", valid.head, "HEAD"], maxOutputBytes),
  ).map(parseNumstatLine);
  const dirty = outputLines(await git(root, ["status", "--porcelain"], maxOutputBytes));
  return handbackEvidenceSchema.parse({
    baseline_head: valid.head,
    commits,
    diff,
    dirty,
    excluded_from_attribution: valid.dirty,
  });
}

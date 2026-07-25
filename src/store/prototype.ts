import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

/**
 * The prototype lane's git plumbing (PRD F5). Spawning `git` is store-layer
 * I/O — the same privilege baseline.ts holds — so the worktree machinery and
 * the never-merge ref scan live here, and the commands stay pure over the data
 * this module returns.
 *
 * Two jobs, one naming convention between them:
 *
 *   1. Seeding — a prototype item spawns N throwaway workspaces, each a real
 *      git worktree on its own branch with its mini-PRD already in it (F5.1).
 *   2. Recognition — `nahel validate` has to answer "did prototype code reach
 *      the default branch?" mechanically (F5.2), and it can only do that if a
 *      prototype ref is recognizable from its NAME. `prototype/<slug>/variant-<n>`
 *      is that name; everything downstream keys on the prefix.
 *
 * Everything read here is a deterministic function of repo state: plumbing
 * formats only (rev-parse, for-each-ref, merge-base), no locale-dependent or
 * relative-date output, and no network — a pushed ref is judged from the
 * remote-tracking refs already in the repo, never by asking the remote.
 */

const execFileAsync = promisify(execFile);

/** A prototype git operation failed, or was refused for safety. */
export class PrototypeError extends Error {}

/** Generous ceiling for ref listings on large repos. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git, returning its exit code instead of throwing (probe form). */
async function tryGit(root: string, args: readonly string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", root, ...args], {
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr:
        typeof failure.stderr === "string" && failure.stderr.trim() !== ""
          ? failure.stderr
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}

/** Run git, throwing PrototypeError with git's own reason on failure. */
async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await tryGit(root, args);
  if (result.code !== 0) {
    throw new PrototypeError(`git ${args.join(" ")} failed in ${root}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function outputLines(output: string): string[] {
  return output.split("\n").filter((line) => line !== "");
}

/** Is `candidate` the directory `parent`, or somewhere beneath it? */
function contains(parent: string, candidate: string): boolean {
  const from = resolve(parent);
  const to = resolve(candidate);
  return to === from || to.startsWith(from.endsWith(sep) ? from : from + sep);
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * The ref-name prefix that makes a prototype branch recognizable. This string
 * is the whole enforcement surface of F5.2: rename it and `validate` goes
 * blind, so it is defined once and imported everywhere.
 */
export const PROTOTYPE_BRANCH_PREFIX = "prototype/";

/** Repo-relative directory the mini-PRDs live in (POSIX form). */
export const PROTOTYPE_DOC_DIR = "docs/prototypes";

/** The branch one variant of a prototype runs on. */
export function prototypeBranch(slug: string, variant: number): string {
  return `${PROTOTYPE_BRANCH_PREFIX}${slug}/variant-${variant}`;
}

/**
 * The variant's mini-PRD path — repo-relative and traversal-free, so it passes
 * the work item's hardened `prd` field unchanged (ADR-0013, hard constraint 2).
 */
export function prototypeMiniPrdPath(slug: string, variant: number): string {
  return `${PROTOTYPE_DOC_DIR}/${slug}/variant-${variant}.md`;
}

function stripFirstSegment(ref: string): string {
  const slash = ref.indexOf("/");
  return slash === -1 ? ref : ref.slice(slash + 1);
}

/**
 * Is this ref a prototype ref? Accepts every form git prints it in: the plain
 * branch name, the short remote-tracking name (`origin/prototype/…`), and both
 * full ref paths. The match is on the leading path SEGMENT, never a substring —
 * `feature/prototype-ish` and `prototypes/x` are ordinary branches and stay
 * invisible to prototype enforcement.
 */
export function isPrototypeBranch(ref: string): boolean {
  let rest = ref;
  if (rest.startsWith("refs/heads/")) {
    rest = rest.slice("refs/heads/".length);
  } else if (rest.startsWith("refs/remotes/")) {
    rest = stripFirstSegment(rest.slice("refs/remotes/".length));
  } else if (!rest.startsWith(PROTOTYPE_BRANCH_PREFIX)) {
    // Possible short remote-tracking form: <remote>/<branch>.
    const stripped = stripFirstSegment(rest);
    if (stripped.startsWith(PROTOTYPE_BRANCH_PREFIX)) rest = stripped;
  }
  return rest.startsWith(PROTOTYPE_BRANCH_PREFIX);
}

/**
 * The repo's current HEAD commit — the base every variant of one spawn shares.
 * Read once, before any branch exists, so the journaled creation record can be
 * written write-ahead (see `seedVariant` on why the base is load-bearing).
 */
export async function headCommit(root: string): Promise<string> {
  return (await git(root, ["rev-parse", "HEAD"])).trim();
}

/** Everything one variant's workspace needs to exist. */
export interface VariantSeed {
  /** Branch to create, from `prototypeBranch`. */
  branch: string;
  /** Absolute path the worktree is created at. */
  worktree: string;
  /** Repo-relative mini-PRD path, from `prototypeMiniPrdPath`. */
  prd: string;
  /** The mini-PRD document, rendered by the caller. */
  content: string;
}

/**
 * Create one variant's workspace and return the BASE commit it branched from.
 *
 * The base is the load-bearing return value: a branch that has never been
 * committed to sits AT its base and is therefore trivially reachable from the
 * default branch, exactly like a branch that was merged into it. Recording the
 * base at creation is what lets the never-merge check tell those two apart
 * later (see `scanPrototypeRefs`).
 *
 * The mini-PRD is written to BOTH trees on purpose. The worktree copy is the
 * variant's working brief; the main-tree copy is the durable record that
 * outlives the throwaway — the prototype's code is disposed of, its stated
 * approach is what gets promoted (F5.3), and a document living only on a
 * never-merged branch would be disposed of with it.
 */
export async function seedVariant(root: string, seed: VariantSeed): Promise<string> {
  const branchExists = await tryGit(root, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${seed.branch}`,
  ]);
  if (branchExists.code === 0) {
    throw new PrototypeError(
      `branch ${seed.branch} already exists — delete it or pick a different prototype slug ` +
        "(nahel never reuses a branch it did not create)",
    );
  }
  if (await pathExists(seed.worktree)) {
    throw new PrototypeError(
      `worktree path ${seed.worktree} already exists — remove it or pass a different --worktree-dir`,
    );
  }
  // A worktree INSIDE the repo would put prototype code in the default branch's
  // working tree, one `git add -A` away from the exact merge the lane forbids.
  // Refused outright: never-merge is not a thing to be careful about.
  if (contains(root, seed.worktree)) {
    throw new PrototypeError(
      `worktree path ${seed.worktree} is inside the repo at ${root} — a prototype worktree there ` +
        "would stage prototype code onto the default branch; put it beside the repo instead",
    );
  }

  const base = (await git(root, ["rev-parse", "HEAD"])).trim();
  await git(root, ["worktree", "add", "-b", seed.branch, seed.worktree, base]);
  for (const tree of [seed.worktree, root]) {
    const path = join(tree, seed.prd);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, seed.content, "utf8");
  }
  return base;
}

/**
 * Remove a variant's worktree. The BRANCH deliberately survives: it is the
 * reference-only record a promotion may consult, and leaving it in place keeps
 * it visible to the never-merge scan rather than hiding the evidence. Refuses
 * a worktree with uncommitted work unless `force` — throwing away someone's
 * unsaved exploration is not disposal, it is data loss.
 */
export async function removeVariantWorktree(
  root: string,
  worktree: string,
  force: boolean,
): Promise<void> {
  const args = force
    ? ["worktree", "remove", "--force", worktree]
    : ["worktree", "remove", worktree];
  const result = await tryGit(root, args);
  if (result.code === 0) return;
  throw new PrototypeError(
    `git worktree remove failed for ${worktree}: ${result.stderr.trim()}` +
      (force
        ? ""
        : " — commit or discard the work in the worktree, or pass --force to dispose of it anyway"),
  );
}

/** One local prototype branch as the never-merge check sees it. */
export interface PrototypeBranchScan {
  /** Short branch name, e.g. `prototype/speed-count/variant-1`. */
  branch: string;
  /** The branch's current tip commit. */
  tip: string;
  /** True when the default branch's history contains this tip. */
  ancestorOfDefault: boolean;
  /**
   * Commits of this branch whose PATCH already exists in the default branch —
   * `git cherry`'s equivalence report, oldest first. This is how a cherry-pick
   * or a rebase-style copy is caught: the code landed as a NEW commit, so the
   * branch is an ancestor of nothing and ancestry alone sees an innocent
   * branch. Empty after a real merge (nothing is "not in upstream" then), so
   * the two signals complement rather than double-count.
   */
  copiedToDefault: string[];
}

/**
 * The read-only git evidence `nahel validate` judges never-merge from (F5.2).
 * Read-only by construction — nothing here writes a ref, checks anything out,
 * or talks to a remote.
 */
export interface PrototypeRefScan {
  /** The resolved default branch, when the repo makes one discoverable. */
  defaultBranch?: string;
  /** Every local prototype branch. */
  branches: PrototypeBranchScan[];
  /** Every remote-tracking prototype ref, short form (`origin/prototype/…`). */
  remoteRefs: string[];
  /** Git unavailable, or not a repo — the checks stay silent rather than guess. */
  error?: string;
}

/**
 * Resolve the default branch WITHOUT a network round-trip: `origin/HEAD` when
 * the clone recorded it, else the conventional names in order. Undefined when
 * none resolves — the merged check is skipped rather than guessed at.
 */
async function resolveDefaultBranch(root: string): Promise<string | undefined> {
  const symbolic = await tryGit(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (symbolic.code === 0) {
    const short = stripFirstSegment(symbolic.stdout.trim());
    if (short !== "") return short;
  }
  for (const name of ["main", "master"]) {
    const exists = await tryGit(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
    if (exists.code === 0) return name;
  }
  return undefined;
}

/**
 * Commits of `branch` whose patch already exists in `defaultBranch`, via
 * `git cherry <upstream> <head>`: each of head's commits not in upstream is
 * printed `+ <sha>` (no equivalent) or `- <sha>` (an equivalent patch IS
 * upstream). The minus lines are the copies — a cherry-pick, a rebase, or a
 * hand-applied diff that kept the patch identical.
 *
 * Read-only plumbing, no network, deterministic. Patch-id equivalence is
 * git's own comparison; nahel neither computes nor guesses at it.
 */
async function copiedToDefault(
  root: string,
  branch: string,
  defaultBranch: string,
): Promise<string[]> {
  const cherry = await tryGit(root, [
    "cherry",
    `refs/heads/${defaultBranch}`,
    `refs/heads/${branch}`,
  ]);
  if (cherry.code !== 0) return [];
  const copies: string[] = [];
  for (const line of outputLines(cherry.stdout)) {
    if (!line.startsWith("- ")) continue;
    const sha = line.slice(2).trim();
    if (sha !== "") copies.push(sha);
  }
  return copies;
}

/** Parse `<short-name>\t<sha>` lines from for-each-ref. */
function parseRefLines(output: string): { name: string; sha: string }[] {
  const refs: { name: string; sha: string }[] = [];
  for (const line of outputLines(output)) {
    const [name, sha] = line.split("\t");
    if (name === undefined || sha === undefined) continue;
    refs.push({ name, sha });
  }
  return refs;
}

/**
 * Scan the repo for prototype refs. Never throws: a missing git, a checkout
 * that is not a repo, or any plumbing failure comes back as `error`, and the
 * checks that read this treat "could not look" as "nothing to report" — the
 * store's tolerant-read discipline (validate must REPORT, never explode).
 */
export async function scanPrototypeRefs(root: string): Promise<PrototypeRefScan> {
  const heads = await tryGit(root, [
    "for-each-ref",
    "--format=%(refname:short)%09%(objectname)",
    "refs/heads",
  ]);
  if (heads.code !== 0) {
    return { branches: [], remoteRefs: [], error: heads.stderr.trim() };
  }

  const defaultBranch = await resolveDefaultBranch(root);
  const branches: PrototypeBranchScan[] = [];
  for (const ref of parseRefLines(heads.stdout)) {
    if (!isPrototypeBranch(ref.name)) continue;
    let ancestorOfDefault = false;
    let copies: string[] = [];
    if (defaultBranch !== undefined) {
      const contained = await tryGit(root, [
        "merge-base",
        "--is-ancestor",
        ref.sha,
        `refs/heads/${defaultBranch}`,
      ]);
      ancestorOfDefault = contained.code === 0;
      copies = await copiedToDefault(root, ref.name, defaultBranch);
    }
    branches.push({
      branch: ref.name,
      tip: ref.sha,
      ancestorOfDefault,
      copiedToDefault: copies,
    });
  }

  const remotes = await tryGit(root, [
    "for-each-ref",
    "--format=%(refname:short)%09%(objectname)",
    "refs/remotes",
  ]);
  const remoteRefs =
    remotes.code === 0
      ? parseRefLines(remotes.stdout)
          .map((ref) => ref.name)
          .filter(isPrototypeBranch)
      : [];

  return {
    ...(defaultBranch === undefined ? {} : { defaultBranch }),
    branches,
    remoteRefs,
  };
}

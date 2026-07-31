import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { isOutputCapExceeded, MAX_OUTPUT_BYTES, outputCapDetail } from "./exec";

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

/**
 * A prototype git call outran the output cap. Distinct from an ordinary git
 * failure because it is NOT a verdict about the repo, and the probe form must
 * never hand it back as a non-zero exit: every probe caller reads that as a
 * clean negative ("no equivalent commits", "no remote refs"), which is exactly
 * how a never-merge violation would vanish into a clean scan (F5.2).
 */
export class PrototypeOutputCapError extends PrototypeError {}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run git, returning its exit code instead of throwing (probe form). The ONE
 * failure it still throws on is an output-cap overflow: there is no exit code
 * that could carry "nahel refused to read this", and every code the probe
 * callers understand would be a lie about the repo.
 */
async function tryGit(
  root: string,
  args: readonly string[],
  maxOutputBytes: number = MAX_OUTPUT_BYTES,
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", root, ...args], {
      maxBuffer: maxOutputBytes,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (isOutputCapExceeded(error)) {
      throw new PrototypeOutputCapError(
        `git ${args.join(" ")} failed in ${root}: ${outputCapDetail(maxOutputBytes)}`,
      );
    }
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
async function git(
  root: string,
  args: readonly string[],
  maxOutputBytes: number = MAX_OUTPUT_BYTES,
): Promise<string> {
  const result = await tryGit(root, args, maxOutputBytes);
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
export async function headCommit(
  root: string,
  maxOutputBytes: number = MAX_OUTPUT_BYTES,
): Promise<string> {
  return (await git(root, ["rev-parse", "HEAD"], maxOutputBytes)).trim();
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
  /**
   * `git merge-base <default> <tip>` — the divergence point between this
   * branch and the default branch. For an honest variant this IS the recorded
   * creation base forever; it moves only when history crosses the fence in
   * either direction (a prototype commit merged into the default branch, or
   * the default branch merged into the variant — both forbidden by the lane).
   * This is the signal for the merge-then-advance shape the other two miss:
   * merge T1 into the default branch, keep committing to T2 — the tip is not
   * contained (ancestry silent) and T1 is genuinely reachable from the
   * default branch (`git cherry` silent), but the merge-base has drifted.
   * Undefined when there is no default branch or the call fails.
   */
  mergeBaseWithDefault?: string;
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
  /** Why the scan produced nothing: git unavailable, not a repo, or an abort. */
  error?: string;
  /**
   * The scan ABORTED inside a repo that demonstrably exists — nahel's output
   * cap, or git plumbing failing on a real checkout. Distinct from `error`
   * alone, which also covers "there is no repo here": with no repo there are
   * no prototype refs and nothing to judge, whereas an abort leaves refs that
   * MAY violate never-merge unjudged. Validate reports this; it cannot report
   * silence (PRODUCT.md HC6, ADR-0011).
   */
  scanFailed?: true;
}

/**
 * Resolve the default branch WITHOUT a network round-trip: `origin/HEAD` when
 * the clone recorded it, else the conventional names in order. Undefined when
 * none resolves — the merged check is skipped rather than guessed at.
 */
async function resolveDefaultBranch(
  root: string,
  maxOutputBytes: number,
): Promise<string | undefined> {
  // `symbolic-ref --quiet`: exit 1 is git's documented silent "not a symbolic
  // ref" — this clone simply never recorded origin/HEAD.
  const symbolic = await probeValue(
    root,
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    maxOutputBytes,
    [1],
  );
  if (symbolic !== undefined) {
    const short = stripFirstSegment(symbolic.trim());
    if (short !== "") return short;
  }
  for (const name of ["main", "master"]) {
    // `rev-parse --verify --quiet`: exit 1 is the documented silent "no such
    // ref" — that branch name does not exist here.
    const exists = await probeValue(
      root,
      ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`],
      maxOutputBytes,
      [1],
    );
    if (exists !== undefined) return name;
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
  maxOutputBytes: number,
): Promise<string[]> {
  // A listing with no documented negative: `git cherry` answers at exit 0 even
  // for unrelated histories, so any failure here is a scan that did not run.
  const cherry = await probeList(
    root,
    ["cherry", `refs/heads/${defaultBranch}`, `refs/heads/${branch}`],
    maxOutputBytes,
  );
  const copies: string[] = [];
  for (const line of outputLines(cherry)) {
    if (!line.startsWith("- ")) continue;
    const sha = line.slice(2).trim();
    if (sha !== "") copies.push(sha);
  }
  return copies;
}

/**
 * The scan hit a result git does not document as an answer. Thrown from the
 * probe helpers and converted to `scanFailed` by scanPrototypeRefs — the one
 * rule that makes "unverified" impossible to confuse with "verified clean".
 */
class ScanAbortError extends PrototypeError {}

/**
 * Run a probe whose answer is a LIST (ref listings, `git cherry`). Exit 0 is
 * the only answer, and it must be a COMPLETE one: git exits 0 while writing
 * "warning: ignoring broken ref …" to stderr and leaving that ref out, so any
 * stderr on a listing means the list is short and the scan cannot be trusted.
 */
async function probeList(
  root: string,
  args: readonly string[],
  maxOutputBytes: number,
): Promise<string> {
  const result = await tryGit(root, args, maxOutputBytes);
  if (result.code !== 0) {
    throw new ScanAbortError(`git ${args.join(" ")} failed in ${root}: ${result.stderr.trim()}`);
  }
  if (result.stderr.trim() !== "") {
    throw new ScanAbortError(
      `git ${args.join(" ")} in ${root} answered with a warning — ${result.stderr.trim()} — ` +
        "so the listing it returned is incomplete",
    );
  }
  return result.stdout;
}

/**
 * Run a probe whose answer is a VALUE or a documented "no". Exit 0 returns
 * stdout; an exit code git documents as a clean negative returns undefined;
 * anything else aborts. stderr is not consulted here: these probes answer with
 * an exit code or a single revision, so a warning cannot silently shorten them.
 */
async function probeValue(
  root: string,
  args: readonly string[],
  maxOutputBytes: number,
  negativeCodes: readonly number[],
): Promise<string | undefined> {
  const result = await tryGit(root, args, maxOutputBytes);
  if (result.code === 0) return result.stdout;
  if (negativeCodes.includes(result.code)) return undefined;
  throw new ScanAbortError(`git ${args.join(" ")} failed in ${root}: ${result.stderr.trim()}`);
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
 * that is not a repo, any plumbing failure, or nahel's own refusal to read
 * past the output cap comes back as `error`, and the checks that read this
 * treat "could not look" as "nothing to report" — the store's tolerant-read
 * discipline (validate must REPORT, never explode).
 *
 * An overflow ABORTS the whole scan rather than trimming one probe's answer:
 * a branch list carrying `copiedToDefault: []` because the probe was cut off
 * would be indistinguishable from an honest all-clear.
 */
export async function scanPrototypeRefs(
  root: string,
  maxOutputBytes: number = MAX_OUTPUT_BYTES,
): Promise<PrototypeRefScan> {
  try {
    return await collectPrototypeRefs(root, maxOutputBytes);
  } catch (error) {
    // Both aborts happen with a repo demonstrably in hand: nahel refusing to
    // read past the cap, and any probe result git does not document as an
    // answer. Neither may come back looking like a completed scan.
    if (error instanceof PrototypeOutputCapError || error instanceof ScanAbortError) {
      return { branches: [], remoteRefs: [], error: error.message, scanFailed: true };
    }
    throw error;
  }
}

async function collectPrototypeRefs(
  root: string,
  maxOutputBytes: number,
): Promise<PrototypeRefScan> {
  // The FIRST probe is the only one that may fail without a repo behind it,
  // so it is the one place "no repo here" is told apart from "the scan could
  // not run". Every probe after it has a working ref listing as proof.
  let heads: string;
  try {
    heads = await probeList(
      root,
      ["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads"],
      maxOutputBytes,
    );
  } catch (error) {
    if (!(error instanceof ScanAbortError)) throw error;
    const insideRepo = (await tryGit(root, ["rev-parse", "--git-dir"], maxOutputBytes)).code === 0;
    // No repo: no prototype refs exist, so nothing was left unjudged.
    if (!insideRepo) return { branches: [], remoteRefs: [], error: error.message };
    throw error;
  }

  const defaultBranch = await resolveDefaultBranch(root, maxOutputBytes);
  const branches: PrototypeBranchScan[] = [];
  for (const ref of parseRefLines(heads)) {
    if (!isPrototypeBranch(ref.name)) continue;
    let ancestorOfDefault = false;
    let copies: string[] = [];
    if (defaultBranch !== undefined) {
      // `merge-base --is-ancestor`: git documents exit 1 as "not an ancestor"
      // and every OTHER non-zero as an error, so 1 is the only silent no.
      const contained = await probeValue(
        root,
        ["merge-base", "--is-ancestor", ref.sha, `refs/heads/${defaultBranch}`],
        maxOutputBytes,
        [1],
      );
      ancestorOfDefault = contained !== undefined;
      copies = await copiedToDefault(root, ref.name, defaultBranch, maxOutputBytes);
    }
    let mergeBase: string | undefined;
    if (defaultBranch !== undefined) {
      // `merge-base`: exit 1 is the documented "no merge base" — unrelated
      // histories, a real answer, and the reason this field is optional.
      const mb = await probeValue(
        root,
        ["merge-base", `refs/heads/${defaultBranch}`, ref.sha],
        maxOutputBytes,
        [1],
      );
      mergeBase = mb?.trim();
    }
    branches.push({
      branch: ref.name,
      tip: ref.sha,
      ancestorOfDefault,
      copiedToDefault: copies,
      ...(mergeBase === undefined ? {} : { mergeBaseWithDefault: mergeBase }),
    });
  }

  // A repo with no remotes lists nothing at exit 0 — an empty listing is the
  // answer here, so there is no documented negative to allow.
  const remotes = await probeList(
    root,
    ["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/remotes"],
    maxOutputBytes,
  );
  const remoteRefs = parseRefLines(remotes)
    .map((ref) => ref.name)
    .filter(isPrototypeBranch);

  return {
    ...(defaultBranch === undefined ? {} : { defaultBranch }),
    branches,
    remoteRefs,
  };
}

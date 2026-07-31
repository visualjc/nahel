import { execFile } from "node:child_process";
import { lstat, mkdir, rm, stat, symlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { SkillsLockEntry } from "../schema/records";
import { gitSpawnEnv, isOutputCapExceeded, MAX_OUTPUT_BYTES, outputCapDetail } from "./exec";
import type { StoreLayout } from "./layout";

/**
 * Skill fetch/placement (PRD F7, ADR-0009). Spawning `git` (and the external
 * `skills` CLI) is store-layer I/O — the same privilege baseline.ts uses for
 * git, and for the same reason it lives here: the command stays pure over the
 * data these functions return. `resolveRef` and the clone touch the network by
 * nature (git talks to a remote); that is acceptable for environment setup,
 * exactly like doctor's healthcheck — but the parsing/normalization helpers
 * (`repoToUrl`) and all of validate's drift logic are deterministic and
 * network-free.
 */

const execFileAsync = promisify(execFile);

/** A git or skills-CLI invocation failed, or a repo spec was unusable. */
export class SkillsError extends Error {}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
/** owner/name shorthand: two path-safe segments, no scheme, no leading dot. */
const SHORTHAND_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Normalize a manifest `repo` spec into something git can clone / ls-remote.
 * Pure — no I/O — so it is unit-tested without the network:
 *   - an explicit URL (`scheme://…` or scp-style `git@host:…`) passes through;
 *   - a local filesystem path (absolute or `./`, `../`) passes through, and a
 *     relative one is anchored at the store root by the git runs below;
 *   - `owner/name` shorthand expands to a GitHub HTTPS URL;
 *   - anything else is a config mistake and throws.
 */
export function repoToUrl(repo: string): string {
  const trimmed = repo.trim();
  if (trimmed === "") throw new SkillsError("skills repo spec is empty");
  if (trimmed.includes("://") || trimmed.startsWith("git@")) return trimmed;
  if (isAbsolute(trimmed) || trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return trimmed;
  }
  if (SHORTHAND_PATTERN.test(trimmed)) return `https://github.com/${trimmed}.git`;
  throw new SkillsError(
    `unrecognized skills repo spec ${JSON.stringify(repo)} — use owner/name, a git URL, or a local path`,
  );
}

/** The gitignored cache of pinned clones, one directory per commit SHA. */
export function skillsCacheDir(layout: StoreLayout): string {
  return join(layout.root, ".nahel-skills");
}

/** Where restored markdown skills are symlinked for tools to discover. */
export function claudeSkillsDir(layout: StoreLayout): string {
  return join(layout.root, ".claude", "skills");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run git IN `cwd` — always the store root. A manifest may name a local repo
 * relatively (`./vendor/skill`, `../shared-skills`), which can only mean
 * "relative to the repo the manifest is committed in"; inheriting the process
 * cwd would resolve it from wherever the command happened to be launched.
 */
async function runGit(
  cwd: string,
  args: readonly string[],
  maxOutputBytes: number = MAX_OUTPUT_BYTES,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd,
      maxBuffer: maxOutputBytes,
      // `cwd` alone does not pin the repository: an inherited GIT_DIR would
      // redirect the clone/checkout to another one.
      env: gitSpawnEnv(),
    });
    return stdout;
  } catch (error) {
    if (isOutputCapExceeded(error)) {
      throw new SkillsError(`git ${args.join(" ")} failed: ${outputCapDetail(maxOutputBytes)}`);
    }
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail =
      typeof stderr === "string" && stderr.trim() !== ""
        ? stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new SkillsError(`git ${args.join(" ")} failed: ${detail}`);
  }
}

/**
 * Resolve a manifest `ref` (branch/tag) to an exact 40-hex commit SHA via
 * `git ls-remote`, run at the store root so a relative `repo` spec means what
 * the manifest says. A ref that is already a pinned SHA passes through
 * untouched (no round-trip). Network I/O by nature; isolated here so
 * `nahel skills lock` stays a thin verb over the returned SHA.
 */
export async function resolveRef(
  layout: StoreLayout,
  repo: string,
  ref: string,
  maxOutputBytes: number = MAX_OUTPUT_BYTES,
): Promise<string> {
  if (SHA_PATTERN.test(ref)) return ref;
  const url = repoToUrl(repo);
  const output = await runGit(layout.root, ["ls-remote", url, ref], maxOutputBytes);
  const line = output.split("\n").find((entry) => entry.trim() !== "");
  const sha = line?.split("\t")[0]?.trim();
  if (sha === undefined || !SHA_PATTERN.test(sha)) {
    throw new SkillsError(
      `could not resolve ref ${JSON.stringify(ref)} in ${repo} — no matching branch or tag`,
    );
  }
  return sha;
}

/**
 * Clone `url` at the pinned `sha` into the cache (once per SHA, reused on
 * later restores), checking out the exact commit. `--no-checkout` avoids a
 * throwaway checkout of the default branch before we move to the pinned one.
 */
async function ensureClone(layout: StoreLayout, url: string, sha: string): Promise<string> {
  const cacheDir = skillsCacheDir(layout);
  const dest = join(cacheDir, sha);
  if (await pathExists(join(dest, ".git"))) {
    await runGit(layout.root, ["-C", dest, "checkout", "--quiet", sha]);
    return dest;
  }
  await mkdir(cacheDir, { recursive: true });
  await rm(dest, { recursive: true, force: true });
  await runGit(layout.root, ["clone", "--no-checkout", "--quiet", url, dest]);
  await runGit(layout.root, ["-C", dest, "checkout", "--quiet", sha]);
  return dest;
}

/** Skill directories live at the repo root or under a conventional `skills/`. */
const SKILL_SUBDIRS = ["", "skills"] as const;

/** Locate a skill's directory within a clone; null when it is not present. */
async function locateSkill(cloneDir: string, name: string): Promise<string | null> {
  for (const sub of SKILL_SUBDIRS) {
    const candidate = join(cloneDir, sub, name);
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

/**
 * Symlink a located skill into .claude/skills/, replacing any stale nahel link.
 * A destination that is a symlink is nahel-managed by definition and is
 * replaced. A destination that is a real file or directory is USER content: we
 * refuse to touch it and throw SkillsError naming the path (Finding 5) rather
 * than erase it with a blind recursive rm. lstat, not stat, so an existing
 * symlink is recognized as a link (never followed to its target's type).
 */
async function placeSymlink(layout: StoreLayout, name: string, target: string): Promise<void> {
  const dir = claudeSkillsDir(layout);
  await mkdir(dir, { recursive: true });
  const link = join(dir, name);
  const info = await lstat(link).catch(() => null);
  if (info !== null) {
    if (!info.isSymbolicLink()) {
      throw new SkillsError(
        `refusing to place skill ${JSON.stringify(name)}: ${link} already exists and is not a ` +
          `nahel-managed symlink but a real ${info.isDirectory() ? "directory" : "file"} — ` +
          `move or remove it yourself, then re-run restore`,
      );
    }
    await rm(link, { force: true });
  }
  await symlink(target, link);
}

/**
 * The dumb clone-and-symlink fallback (ADR-0009 v1): clone the pinned commit,
 * then symlink each used skill into .claude/skills/. Returns the names placed.
 * Deterministic over repo state — the same lock entry restores the same tree.
 */
export async function restoreViaClone(
  layout: StoreLayout,
  entry: SkillsLockEntry,
): Promise<string[]> {
  const url = repoToUrl(entry.repo);
  const cloneDir = await ensureClone(layout, url, entry.sha);
  const placed: string[] = [];
  for (const name of entry.skills) {
    const dir = await locateSkill(cloneDir, name);
    if (dir === null) {
      throw new SkillsError(
        `skill ${JSON.stringify(name)} not found in ${entry.repo}@${entry.sha} ` +
          `(looked in the repo root and skills/)`,
      );
    }
    await placeSymlink(layout, name, dir);
    placed.push(name);
  }
  return placed;
}

/**
 * The external `skills` CLI as an ABSOLUTE path, or null when it is not on
 * PATH (then the clone fallback runs). Resolved FROM THE STORE ROOT — the
 * directory the CLI is then run in — and returned as a path rather than a
 * yes/no, because those are two different resolutions otherwise: a relative
 * PATH entry (`./tools/bin`) is resolved by the shell against ITS cwd but by
 * the spawn against the PARENT process's, so a boolean probe and the later
 * execution can disagree in both directions (a detected CLI that then fails
 * to spawn, or a missed one that silently falls back to cloning). Answering
 * once with the resolved path removes the second resolution entirely.
 */
export async function skillsCliPath(layout: StoreLayout): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("/bin/sh", ["-c", "command -v skills"], {
      cwd: layout.root,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    const found = stdout.trim();
    if (found === "") return null;
    return isAbsolute(found) ? found : resolve(layout.root, found);
  } catch {
    return null;
  }
}

/**
 * Delegate placement to the external `skills` CLI (ADR-0009: use the existing
 * ecosystem where possible): `skills add <url>@<sha> <name…>`. Returns the
 * names handed to the CLI. The CLI owns placement into .claude/skills/ —
 * relative to ITS cwd, so it is run in the store root exactly as the clone
 * fallback writes there: which tool is installed must not change where skills
 * land. Takes the layout for that reason, mirroring restoreViaClone, and the
 * `cli` path skillsCliPath already resolved from that same root.
 */
export async function restoreViaSkillsCli(
  layout: StoreLayout,
  entry: SkillsLockEntry,
  cli: string,
): Promise<string[]> {
  const url = repoToUrl(entry.repo);
  const args = ["add", `${url}@${entry.sha}`, ...entry.skills];
  try {
    await execFileAsync(cli, args, { cwd: layout.root, maxBuffer: MAX_OUTPUT_BYTES });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail =
      typeof stderr === "string" && stderr.trim() !== ""
        ? stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new SkillsError(`skills ${args.join(" ")} failed: ${detail}`);
  }
  return [...entry.skills];
}

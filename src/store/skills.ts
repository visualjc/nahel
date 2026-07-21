import { execFile } from "node:child_process";
import { lstat, mkdir, rm, stat, symlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { SkillsLockEntry } from "../schema/records";
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

/** Generous ceiling so chatty git output never trips maxBuffer. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** A git or skills-CLI invocation failed, or a repo spec was unusable. */
export class SkillsError extends Error {}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
/** owner/name shorthand: two path-safe segments, no scheme, no leading dot. */
const SHORTHAND_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Normalize a manifest `repo` spec into something git can clone / ls-remote.
 * Pure — no I/O — so it is unit-tested without the network:
 *   - an explicit URL (`scheme://…` or scp-style `git@host:…`) passes through;
 *   - a local filesystem path (absolute or `./`, `../`) passes through;
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

async function runGit(args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...args], { maxBuffer: MAX_OUTPUT_BYTES });
    return stdout;
  } catch (error) {
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
 * `git ls-remote`. A ref that is already a pinned SHA passes through untouched
 * (no round-trip). Network I/O by nature; isolated here so `nahel skills lock`
 * stays a thin verb over the returned SHA.
 */
export async function resolveRef(repo: string, ref: string): Promise<string> {
  if (SHA_PATTERN.test(ref)) return ref;
  const url = repoToUrl(repo);
  const output = await runGit(["ls-remote", url, ref]);
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
async function ensureClone(cacheDir: string, url: string, sha: string): Promise<string> {
  const dest = join(cacheDir, sha);
  if (await pathExists(join(dest, ".git"))) {
    await runGit(["-C", dest, "checkout", "--quiet", sha]);
    return dest;
  }
  await mkdir(cacheDir, { recursive: true });
  await rm(dest, { recursive: true, force: true });
  await runGit(["clone", "--no-checkout", "--quiet", url, dest]);
  await runGit(["-C", dest, "checkout", "--quiet", sha]);
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
  const cloneDir = await ensureClone(skillsCacheDir(layout), url, entry.sha);
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

/** True when the external `skills` CLI is on PATH (delegate to it when so). */
export async function skillsCliAvailable(): Promise<boolean> {
  try {
    await execFileAsync("/bin/sh", ["-c", "command -v skills"], { maxBuffer: MAX_OUTPUT_BYTES });
    return true;
  } catch {
    return false;
  }
}

/**
 * Delegate placement to the external `skills` CLI (ADR-0009: use the existing
 * ecosystem where possible): `skills add <url>@<sha> <name…>`. Returns the
 * names handed to the CLI. The CLI owns placement into .claude/skills/.
 */
export async function restoreViaSkillsCli(entry: SkillsLockEntry): Promise<string[]> {
  const url = repoToUrl(entry.repo);
  const args = ["add", `${url}@${entry.sha}`, ...entry.skills];
  try {
    await execFileAsync("skills", args, { maxBuffer: MAX_OUTPUT_BYTES });
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

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseFrontmatter, serializeFrontmatter, writeFileAtomic } from "./frontmatter";

/**
 * Read side of `nahel import --from-ccpm` (PRD F8): all filesystem access to
 * the SOURCE ccpm tree, plus the one write into the CURRENT repo's `docs/prds/`
 * for a relocated PRD. Kept in the store layer for the same reason skills.ts
 * keeps its git/clone I/O here — the command stays pure over the data these
 * functions return (see tests/store/purity). The source tree is READ-ONLY:
 * nothing under `sourceRoot` is ever written (hard constraint: the source repo
 * is not ours to mutate). Frontmatter here is arbitrary ccpm YAML, NOT a nahel
 * record — no schema validation happens on the way in; the command's pure
 * mapping layer interprets it.
 */

/** A ccpm markdown file split into its YAML frontmatter and prose body. */
export interface CcpmUnitFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** One ccpm task file `<n>.md`, where the stem `<n>` is its github issue number. */
export interface CcpmTask extends CcpmUnitFile {
  /** Filename stem — the ccpm task number / github issue number (e.g. "2"). */
  stem: string;
}

/** One ccpm epic: its own `epic.md`, its task files, and its github mapping. */
export interface CcpmEpic extends CcpmUnitFile {
  /** frontmatter.name if present, else the epic directory name. */
  name: string;
  /** Source-repo-relative directory (`.claude/epics/<name>`). */
  dir: string;
  tasks: CcpmTask[];
  /** Raw github-mapping.md text, null when the file is absent. */
  mappingText: string | null;
}

/** One ccpm PRD under `.claude/prds/`. */
export interface CcpmPrd extends CcpmUnitFile {
  /** frontmatter.name if present, else the filename stem. */
  name: string;
  /** Source-repo-relative path (`.claude/prds/<name>.md`). */
  sourcePath: string;
}

/** Everything the importer reads from one ccpm source tree. */
export interface CcpmSource {
  epics: CcpmEpic[];
  prds: CcpmPrd[];
}

/** A source path escaped its root or was otherwise unusable. */
export class CcpmSourceError extends Error {}

const TASK_FILE = /^\d+\.md$/;

async function readUnit(path: string): Promise<CcpmUnitFile> {
  const text = await readFile(path, "utf8");
  return parseFrontmatter(text);
}

async function listDir(path: string): Promise<string[]> {
  return readdir(path).catch(() => [] as string[]);
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

/** Read every PRD under `.claude/prds/` (skipping `.gitkeep` and non-markdown). */
async function readPrds(sourceRoot: string): Promise<CcpmPrd[]> {
  const prdsDir = join(sourceRoot, ".claude", "prds");
  const prds: CcpmPrd[] = [];
  for (const name of (await listDir(prdsDir)).sort()) {
    if (!name.endsWith(".md")) continue;
    const unit = await readUnit(join(prdsDir, name));
    const fmName = unit.frontmatter["name"];
    prds.push({
      ...unit,
      name: typeof fmName === "string" && fmName !== "" ? fmName : name.slice(0, -3),
      sourcePath: join(".claude", "prds", name),
    });
  }
  return prds;
}

/** Read one epic directory: its epic.md, its `<n>.md` tasks, its mapping. */
async function readEpic(sourceRoot: string, epicDirName: string): Promise<CcpmEpic | null> {
  const relDir = join(".claude", "epics", epicDirName);
  const absDir = join(sourceRoot, relDir);
  const epicPath = join(absDir, "epic.md");
  const hasEpic = await stat(epicPath).then(
    () => true,
    () => false,
  );
  if (!hasEpic) return null;

  const unit = await readUnit(epicPath);
  const tasks: CcpmTask[] = [];
  for (const name of (await listDir(absDir)).sort()) {
    if (!TASK_FILE.test(name)) continue; // excludes epic.md, github-mapping.md, <n>-analysis.md
    const taskUnit = await readUnit(join(absDir, name));
    tasks.push({ ...taskUnit, stem: name.slice(0, -3) });
  }
  // Stable numeric order so depends_on resolution and item creation are
  // deterministic regardless of readdir order.
  tasks.sort((a, b) => Number(a.stem) - Number(b.stem));

  const mappingText = await readFile(join(absDir, "github-mapping.md"), "utf8").catch(
    () => null,
  );
  const fmName = unit.frontmatter["name"];
  return {
    ...unit,
    name: typeof fmName === "string" && fmName !== "" ? fmName : epicDirName,
    dir: relDir,
    tasks,
    mappingText,
  };
}

/** Read the whole ccpm source tree (epics + PRDs). Missing dirs read empty. */
export async function readCcpmSource(sourceRoot: string): Promise<CcpmSource> {
  const epicsDir = join(sourceRoot, ".claude", "epics");
  const epics: CcpmEpic[] = [];
  for (const name of (await listDir(epicsDir)).sort()) {
    if (!(await isDirectory(join(epicsDir, name)))) continue;
    const epic = await readEpic(sourceRoot, name);
    if (epic !== null) epics.push(epic);
  }
  return { epics, prds: await readPrds(sourceRoot) };
}

/**
 * Read one source document by a source-repo-relative path (the epic's `prd:`
 * field). Returns null when the file does not exist; throws CcpmSourceError
 * when the path would escape the source root (absolute or `..`) — a poisoned
 * path must never read outside the tree we were pointed at.
 */
export async function readSourceDoc(
  sourceRoot: string,
  relPath: string,
): Promise<CcpmUnitFile | null> {
  if (relPath.startsWith("/") || relPath.split(/[/\\]/).includes("..")) {
    throw new CcpmSourceError(
      `refusing to read source doc ${JSON.stringify(relPath)} — path escapes the source root`,
    );
  }
  const abs = resolve(sourceRoot, relPath);
  const text = await readFile(abs, "utf8").catch((error) => {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  });
  if (text === null) return null;
  return parseFrontmatter(text);
}

/**
 * The repo-relative path a relocated PRD basename lands at (`docs/prds/<name>`).
 * Deterministic and I/O-free: the importer computes an epic item's `prd` field
 * from it BEFORE the file is actually written, so a crash between item creation
 * and relocation heals on re-run (the item already points at the eventual dest;
 * relocatePrd materializes it idempotently). See import.ts (PRD F8.3).
 */
export function prdRelocationDest(fileBasename: string): string {
  return join("docs", "prds", basename(fileBasename));
}

/**
 * Write a relocated PRD into the CURRENT repo's `docs/prds/` (ADR-0013). The
 * caller has already stripped the `status` field; this only materializes the
 * document. Idempotent: if `docs/prds/<basename>` already holds byte-identical
 * content, nothing is written and `wrote` is false — so a re-run adds no new
 * copy (PRD F8.3). Returns the repo-relative destination path for the owning
 * item's `prd` field.
 */
export async function relocatePrd(
  currentRoot: string,
  fileBasename: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<{ dest: string; wrote: boolean }> {
  const destRel = prdRelocationDest(fileBasename);
  const destAbs = resolve(currentRoot, destRel);
  const text = serializeFrontmatter(frontmatter, body);
  const existing = await readFile(destAbs, "utf8").catch(() => null);
  if (existing === text) return { dest: destRel, wrote: false };
  await writeFileAtomic(destAbs, text);
  return { dest: destRel, wrote: true };
}

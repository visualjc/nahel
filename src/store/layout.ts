import { mkdir, readdir, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import YAML from "yaml";
import {
  configSchema,
  observationFrontmatterSchema,
  runSchema,
  workItemFrontmatterSchema,
  type Config,
  type ObservationFrontmatter,
  type Run,
  type WorkItemFrontmatter,
} from "../schema/records";
import { requireValidId } from "../schema/id";
import { readFrontmatterFile, writeFileAtomic, writeFrontmatterFile } from "./frontmatter";

/**
 * The on-disk layout of a nahel-managed repo (PRD F1): all state machinery
 * under committed `nahel/` — config, items/, runs/, journal/, observations/ —
 * while knowledge stays at conventional paths recorded in config. This module
 * owns the paths and the typed record I/O over them; every read validates
 * against the schema layer and every write is validate-then-atomic-rename.
 */

export interface StoreLayout {
  root: string;
  nahelDir: string;
  configPath: string;
  itemsDir: string;
  runsDir: string;
  journalDir: string;
  journalArchiveDir: string;
  observationsDir: string;
}

/** Compute the layout paths for a repo root (no filesystem access). */
export function storeLayout(root: string): StoreLayout {
  const nahelDir = join(root, "nahel");
  const journalDir = join(nahelDir, "journal");
  return {
    root,
    nahelDir,
    configPath: join(nahelDir, "config"),
    itemsDir: join(nahelDir, "items"),
    runsDir: join(nahelDir, "runs"),
    journalDir,
    journalArchiveDir: join(journalDir, "archive"),
    observationsDir: join(nahelDir, "observations"),
  };
}

/** Create the full directory structure (idempotent — never clobbers). */
export async function ensureLayout(root: string): Promise<StoreLayout> {
  const layout = storeLayout(root);
  for (const dir of [
    layout.nahelDir,
    layout.itemsDir,
    layout.runsDir,
    layout.journalDir,
    layout.journalArchiveDir,
    layout.observationsDir,
  ]) {
    await mkdir(dir, { recursive: true });
  }
  return layout;
}

/** Path of a work-item record. The id is validated before any join. */
export function itemPath(layout: StoreLayout, id: string): string {
  return join(layout.itemsDir, `${requireValidId(id, "item")}.md`);
}

/** Directory a run's record and hot state live in. Id validated before join. */
export function runDir(layout: StoreLayout, id: string): string {
  return join(layout.runsDir, requireValidId(id, "run"));
}

/** Path of a run record. */
export function runRecordPath(layout: StoreLayout, id: string): string {
  return join(runDir(layout, id), "run.json");
}

/** Path of an observation record. The id is validated before any join. */
export function observationPath(layout: StoreLayout, id: string): string {
  return join(layout.observationsDir, `${requireValidId(id, "observation")}.md`);
}

/** Read and validate `nahel/config`. */
export async function readConfig(layout: StoreLayout): Promise<Config> {
  return configSchema.parse(YAML.parse(await readConfigText(layout)));
}

/**
 * Raw text of `nahel/config`, unvalidated — validate's tolerant read (PRD F8:
 * an invalid config must be REPORTED as a finding, which readConfig's
 * parse-or-throw cannot do).
 */
export async function readConfigText(layout: StoreLayout): Promise<string> {
  try {
    return await readFile(layout.configPath, "utf8");
  } catch {
    throw new Error(`nahel/config not found at ${layout.configPath} — run \`nahel init\``);
  }
}

/** Validate and atomically write `nahel/config`. */
export async function writeConfig(layout: StoreLayout, config: Config): Promise<void> {
  const valid = configSchema.parse(config);
  await writeFileAtomic(layout.configPath, YAML.stringify(valid));
}

/**
 * Canonicalize a path that may not fully exist yet: realpath the deepest
 * EXISTING ancestor (resolving every symlinked component), then re-join the
 * non-existing tail. This is what makes containment a statement about the
 * real filesystem location instead of the path's spelling.
 */
async function canonicalize(path: string): Promise<string> {
  let current = path;
  const tail: string[] = [];
  while (true) {
    try {
      const real = await realpath(current);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) {
        // Even the filesystem root failed to resolve — nothing left to
        // canonicalize; the lexical path is the best available truth.
        return join(current, ...tail);
      }
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve one knowledge path and prove it stays STRICTLY under the repo root
 * (hard constraint 2: nahel never writes outside the repo). Absolute paths
 * are refused outright; relative ones are resolved and their CANONICAL form
 * (every symlinked component resolved — see canonicalize) must land below the
 * canonical root directory — not at it (adr is a directory under the root,
 * not the root), not at a sibling whose name merely shares the root as a
 * string prefix, and not at a symlink target outside the repo. Both sides are
 * canonicalized (macOS /tmp is itself a symlink to /private/tmp — a
 * one-sided check breaks every legitimate path there). Returns the resolved
 * (non-canonical) path so callers keep root-relative spellings.
 */
async function containKnowledgePath(root: string, key: string, path: string): Promise<string> {
  if (isAbsolute(path)) {
    throw new Error(
      `knowledge path ${key} (${JSON.stringify(path)}) is absolute — ` +
        `knowledge paths must be repo-relative (hard constraint 2: nothing outside the repo)`,
    );
  }
  const rootResolved = resolve(root);
  const resolved = resolve(rootResolved, path);
  const rootCanonical = await canonicalize(rootResolved);
  const canonical = await canonicalize(resolved);
  if (canonical === rootCanonical || !canonical.startsWith(rootCanonical + sep)) {
    throw new Error(
      `knowledge path ${key} (${JSON.stringify(path)}) resolves to ${canonical}, ` +
        `which is not strictly under the repo root ${rootCanonical} (hard constraint 2)`,
    );
  }
  return resolved;
}

/**
 * Resolve the config's repo-relative knowledge paths against the root,
 * refusing any path that escapes the repo (see containKnowledgePath).
 */
export async function knowledgePaths(
  layout: StoreLayout,
  config: Config,
): Promise<{ product: string; context: string; adr: string }> {
  return {
    product: await containKnowledgePath(layout.root, "product", config.knowledge.product),
    context: await containKnowledgePath(layout.root, "context", config.knowledge.context),
    adr: await containKnowledgePath(layout.root, "adr", config.knowledge.adr),
  };
}

/**
 * Read a UTF-8 text file through the store; null when the file does not
 * exist. The first-class read-or-null primitive init.ts and snapshot.ts noted
 * as a store gap — brief (PRD F7) reads PRODUCT.md through it, because a
 * missing constitution is a finding in the brief, not an error.
 */
export async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

/** Directory of the canonical workflow docs (PRD F10): nahel/workflows. */
export function workflowsDir(layout: StoreLayout): string {
  return join(layout.nahelDir, "workflows");
}

/**
 * Sorted markdown file names in a directory ([] when it is missing). Additive
 * store export for `nahel install` (task #11): the workflow scan and the
 * shim-directory scan are directory listings the command layer may not do
 * itself — fs is the store's exclusive privilege (see tests/store/purity).
 */
export async function listMarkdownDocs(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.filter((name) => name.endsWith(".md")).sort();
}

/**
 * Delete one file; a missing file is a no-op. Additive store export for
 * `nahel install`'s stale-shim pruning — the store's only delete primitive,
 * deliberately file-scoped (nothing recursive).
 */
export async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
}

/** A work-item record: validated frontmatter plus its markdown body. */
export interface ItemRecord {
  frontmatter: WorkItemFrontmatter;
  body: string;
}

/** Read and validate one work-item record. */
export async function readItem(layout: StoreLayout, id: string): Promise<ItemRecord> {
  const { frontmatter, body } = await readFrontmatterFile(itemPath(layout, id));
  return { frontmatter: workItemFrontmatterSchema.parse(frontmatter), body };
}

/**
 * True when the item record exists on disk. The path is computed OUTSIDE the
 * try: an invalid id throws InvalidIdError instead of answering false —
 * "not found" would steer callers into misleading errors while hiding that
 * the id itself was never usable.
 */
export async function itemExists(layout: StoreLayout, id: string): Promise<boolean> {
  const path = itemPath(layout, id);
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Validate and atomically write one work-item record. */
export async function writeItem(
  layout: StoreLayout,
  frontmatter: WorkItemFrontmatter,
  body: string,
): Promise<void> {
  const valid = workItemFrontmatterSchema.parse(frontmatter);
  await writeFrontmatterFile(itemPath(layout, valid.id), valid, body);
}

/** Ids of every work-item record on disk. */
export async function listItems(layout: StoreLayout): Promise<string[]> {
  const entries = await readdir(layout.itemsDir).catch(() => [] as string[]);
  return entries.filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3));
}

/** Read and validate one run record. */
export async function readRun(layout: StoreLayout, id: string): Promise<Run> {
  return runSchema.parse(JSON.parse(await readRunRecordText(layout, id)));
}

/** Raw text of a run record, unvalidated — validate's tolerant read (PRD F8). */
export async function readRunRecordText(layout: StoreLayout, id: string): Promise<string> {
  // Path computed outside the try: an invalid id throws InvalidIdError
  // instead of masquerading as "run not found".
  const path = runRecordPath(layout, id);
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new Error(`run ${id} not found at ${path}`);
  }
}

/** Validate and atomically write one run record. */
export async function writeRun(layout: StoreLayout, run: Run): Promise<void> {
  const valid = runSchema.parse(run);
  await writeFileAtomic(runRecordPath(layout, valid.id), `${JSON.stringify(valid, null, 2)}\n`);
}

/** Ids of every run record on disk. */
export async function listRuns(layout: StoreLayout): Promise<string[]> {
  const entries = await readdir(layout.runsDir, { withFileTypes: true }).catch(
    () => [],
  );
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/** Ids of every observation record on disk. */
export async function listObservations(layout: StoreLayout): Promise<string[]> {
  const entries = await readdir(layout.observationsDir).catch(() => [] as string[]);
  return entries.filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3));
}

/** An observation record: validated frontmatter plus the fact it records. */
export interface ObservationRecord {
  frontmatter: ObservationFrontmatter;
  body: string;
}

/** Read and validate one observation record. */
export async function readObservation(
  layout: StoreLayout,
  id: string,
): Promise<ObservationRecord> {
  const { frontmatter, body } = await readFrontmatterFile(observationPath(layout, id));
  return { frontmatter: observationFrontmatterSchema.parse(frontmatter), body };
}

/** Validate and atomically write one observation record. */
export async function writeObservation(
  layout: StoreLayout,
  frontmatter: ObservationFrontmatter,
  body: string,
): Promise<void> {
  const valid = observationFrontmatterSchema.parse(frontmatter);
  await writeFrontmatterFile(observationPath(layout, valid.id), valid, body);
}

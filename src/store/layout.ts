import { mkdir, readdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import YAML from "yaml";
import {
  configSchema,
  distilledSchema,
  mapFrontmatterSchema,
  observationFrontmatterSchema,
  roadmapNodeFrontmatterSchema,
  runSchema,
  skillsLockSchema,
  skillsManifestSchema,
  ticketFrontmatterSchema,
  workItemFrontmatterSchema,
  type Config,
  type Distilled,
  type MapFrontmatter,
  type ObservationFrontmatter,
  type RoadmapNodeFrontmatter,
  type Run,
  type SkillsLock,
  type SkillsManifest,
  type TicketFrontmatter,
  type WorkItemFrontmatter,
} from "../schema/records";
import { ID_PATTERN, requireValidId } from "../schema/id";
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
  /**
   * `nahel/journal/distilled/` — one EMPTY marker file per fully distilled
   * archived segment, named exactly after it (PRD F6). The name is the datum.
   */
  distilledDir: string;
  observationsDir: string;
  /**
   * `nahel/roadmap/` — one markdown record per roadmap node (Phase 4 F1). A
   * directory of per-node files, exactly like items/ and observations/: node
   * creation touches one new file, so two worktrees charting different parts
   * of the roadmap merge as a directory union (ADR-0012 merge-safe state).
   */
  roadmapDir: string;
  /**
   * `nahel/maps/` — one markdown record per wayfinder map (Phase 4 F7), and
   * `nahel/tickets/` — one per decision ticket. Two directories rather than a
   * nest under `nahel/roadmap/`, for the same reason items and observations
   * have their own: a directory of per-record files is what makes concurrent
   * charting merge as a union, and every list/read helper stays a flat scan.
   */
  mapsDir: string;
  ticketsDir: string;
  /** `skills.yaml` — the pinned-skill manifest, at the repo root (PRD F7). */
  skillsManifestPath: string;
  /** `skills.lock` — the resolved manifest, at the repo root (PRD F7). */
  skillsLockPath: string;
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
    distilledDir: join(journalDir, "distilled"),
    observationsDir: join(nahelDir, "observations"),
    roadmapDir: join(nahelDir, "roadmap"),
    mapsDir: join(nahelDir, "maps"),
    ticketsDir: join(nahelDir, "tickets"),
    skillsManifestPath: join(root, "skills.yaml"),
    skillsLockPath: join(root, "skills.lock"),
  };
}

/** True when anything exists at `path` (a file, a directory, a symlink target). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/** The `.git` entry: a directory in a clone, a FILE in a worktree or submodule. */
const GIT_MARKER = ".git";

/**
 * Nearest ancestor of `from` (inclusive) holding a `.git` entry, or null when
 * `from` is not inside a git repository at all.
 */
async function findGitBoundary(from: string): Promise<string | null> {
  let dir = from;
  while (true) {
    if (await pathExists(join(dir, GIT_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the root of the store `cwd` sits in, the way git finds `.git`: walk
 * up to the nearest directory holding `nahel/config`. Every command over an
 * EXISTING store goes through this, so `nahel distill` works from
 * `nahel/journal/archive/` exactly as it does from the repo root.
 *
 * The walk is BOUNDED by the current git repository or worktree — the nearest
 * ancestor carrying a `.git` entry, which the walk may look at but never pass.
 * That boundary is what keeps checkouts isolated: a worktree's `.git` is a
 * file in its own checkout directory, so a worktree (or a nested repo, or a
 * submodule) can never adopt the store of a directory above it.
 *
 * Outside a git repository there is no boundary, and the deliberate choice is
 * the safer one: nothing is walked at all, cwd is the only candidate. Walking
 * to the filesystem root would let any command run anywhere under `$HOME`
 * silently adopt an unrelated store.
 *
 * The given cwd is CANONICALIZED before the walk (see canonicalize), so the
 * resolution — and the root every command then derives its paths and its
 * child processes' cwd from — is about the real filesystem location, not the
 * path's spelling: a shell may hand in a symlink pointing into the repo, and
 * walking its lexical parents would leave the repo through the link's own
 * parent and miss the store entirely.
 *
 * `nahel init` deliberately does NOT use this — it creates the store at cwd.
 */
export async function resolveStoreRoot(cwd: string): Promise<string> {
  const start = await canonicalize(resolve(cwd));
  const { root, boundary } = await searchStoreRoot(start);
  if (root !== null) return root;
  throw new Error(
    `nahel/config not found at ${join(start, "nahel", "config")}` +
      (boundary === start ? "" : ` or in any parent up to ${boundary}`) +
      " — run `nahel init`",
  );
}

/**
 * The walk itself: the nearest ancestor of `start` (inclusive, bounded — see
 * resolveStoreRoot) holding `nahel/config`, or null with the boundary it
 * stopped at, so both the strict and the tolerant open share one traversal.
 */
async function searchStoreRoot(start: string): Promise<{ root: string | null; boundary: string }> {
  const boundary = (await findGitBoundary(start)) ?? start;
  let dir = start;
  while (true) {
    if (await pathExists(join(dir, "nahel", "config"))) return { root: dir, boundary };
    const parent = dirname(dir);
    if (dir === boundary || parent === dir) return { root: null, boundary };
    dir = parent;
  }
}

/** Layout of the store `cwd` sits in — the walking read of storeLayout. */
export async function openStore(cwd: string): Promise<StoreLayout> {
  return storeLayout(await resolveStoreRoot(cwd));
}

/**
 * Layout of the store `cwd` sits in, falling back to cwd itself when the walk
 * finds none — the tolerant open, for the two commands that must still run on
 * an uninitialized directory: `nahel validate` REPORTS a missing config as a
 * finding rather than dying on it (PRD F8), and `nahel skills` operates on
 * skills.yaml / skills.lock, which stand on their own (PRD F7).
 */
export async function openStoreTolerant(cwd: string): Promise<StoreLayout> {
  const start = await canonicalize(resolve(cwd));
  const { root } = await searchStoreRoot(start);
  return storeLayout(root ?? start);
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
 * Directories are excluded even when named `*.md` — a directory is not a
 * doc, and unlinking one raises EISDIR (bug 33b2j3kq); symlinks pass, since
 * both consumers handle them (unlink removes the link, the doc reader
 * warns-and-skips anything unreadable).
 */
export async function listMarkdownDocs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.name.endsWith(".md") && !entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
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

/** Path of a roadmap node record. The id is validated before any join. */
export function roadmapNodePath(layout: StoreLayout, id: string): string {
  return join(layout.roadmapDir, `${requireValidId(id, "roadmap node")}.md`);
}

/**
 * `nahel/roadmap/failed/` — where a SUPERSEDED migration's node records go
 * (PR #26 follow-up C3), one directory per retired selection event.
 *
 * A subdirectory of the roadmap rather than a directory of its own, because
 * that is exactly what makes the records stop rendering with no reader
 * changing: listRecordIds scans one directory level and keeps only `*.md`
 * entries, so a directory named `failed` is skipped by every list, every view
 * and every check — while the files stay in the store, in git, and readable by
 * a human asking what the failed attempt had charted.
 */
export const FAILED_ROADMAP_DIR = "failed";

/** Path a superseded migration's node record is parked at. Both ids validated. */
export function failedRoadmapNodePath(
  layout: StoreLayout,
  selection: string,
  id: string,
): string {
  return join(
    layout.roadmapDir,
    FAILED_ROADMAP_DIR,
    requireValidId(selection, "migration selection"),
    `${requireValidId(id, "roadmap node")}.md`,
  );
}

/** A roadmap node record: validated frontmatter plus its intent prose. */
export interface RoadmapNodeRecord {
  frontmatter: RoadmapNodeFrontmatter;
  body: string;
}

/** Read and validate one roadmap node record. */
export async function readRoadmapNode(
  layout: StoreLayout,
  id: string,
): Promise<RoadmapNodeRecord> {
  const { frontmatter, body } = await readFrontmatterFile(roadmapNodePath(layout, id));
  return { frontmatter: roadmapNodeFrontmatterSchema.parse(frontmatter), body };
}

/** Validate and atomically write one roadmap node record. */
export async function writeRoadmapNode(
  layout: StoreLayout,
  frontmatter: RoadmapNodeFrontmatter,
  body: string,
): Promise<void> {
  const valid = roadmapNodeFrontmatterSchema.parse(frontmatter);
  await writeFrontmatterFile(roadmapNodePath(layout, valid.id), valid, body);
}

/**
 * Ids of every roadmap node record on disk, sorted; [] when the directory is
 * ABSENT (nothing charted yet — the dir appears with the first node, the same
 * on-demand shape `nahel/journal/distilled/` has).
 *
 * Absence means ENOENT and nothing else. A permission error, an I/O error, or
 * a non-directory sitting at `nahel/roadmap` all propagate: "no nodes" and
 * "could not look" are different facts and only the first is safe to render —
 * a swallowed failure would let the roadmap views state that a store has no
 * roadmap when it has one nahel could not read. (listDistilledMarkers also
 * treats ENOTDIR as absence, because there the missing directory may be an
 * ANCESTOR of the path; here the path itself is the store's own directory.)
 */
export async function listRoadmapNodes(layout: StoreLayout): Promise<string[]> {
  return listRecordIds(layout.roadmapDir);
}

/**
 * The scan listRoadmapNodes, listMaps and listTickets all are: the record ids
 * in one on-demand directory. Shared so the absence rule above is stated once
 * and cannot drift between the three directories that follow it.
 */
async function listRecordIds(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch((error) => {
    if ((error as { code?: unknown }).code === "ENOENT") return [] as string[];
    throw error;
  });
  return entries
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3))
    .sort();
}

/**
 * Every roadmap node record, in id order — the one deterministic read the
 * derived-status and view layers work over (they need the whole tree: parents,
 * sideways links, and lineage are all cross-node facts).
 */
export async function readRoadmapNodes(layout: StoreLayout): Promise<RoadmapNodeRecord[]> {
  const records: RoadmapNodeRecord[] = [];
  for (const id of await listRoadmapNodes(layout)) {
    records.push(await readRoadmapNode(layout, id));
  }
  return records;
}

/**
 * Resolve a node reference — a slug or an id — to its record, or null when
 * nothing matches. Both spellings address the same node (F1): an id is tried
 * as a record path first, and anything else (or a well-formed id with no
 * record) falls through to a name match. Duplicate slugs are refused at
 * creation and reported by `nahel validate`, so the id-ordered first match
 * here is deterministic even on a store where a merge produced two.
 */
export async function resolveRoadmapNode(
  layout: StoreLayout,
  ref: string,
): Promise<RoadmapNodeRecord | null> {
  if (ID_PATTERN.test(ref)) {
    const text = await readTextFile(roadmapNodePath(layout, ref));
    if (text !== null) return readRoadmapNode(layout, ref);
  }
  for (const record of await readRoadmapNodes(layout)) {
    if (record.frontmatter.name === ref) return record;
  }
  return null;
}

/** Path of a map record. The id is validated before any join. */
export function mapPath(layout: StoreLayout, id: string): string {
  return join(layout.mapsDir, `${requireValidId(id, "map")}.md`);
}

/** Path of a decision-ticket record. The id is validated before any join. */
export function ticketPath(layout: StoreLayout, id: string): string {
  return join(layout.ticketsDir, `${requireValidId(id, "ticket")}.md`);
}

/** A map record (Phase 4 F7): validated frontmatter plus its Notes prose. */
export interface MapRecord {
  frontmatter: MapFrontmatter;
  body: string;
}

/** A decision-ticket record: validated frontmatter plus the question itself. */
export interface TicketRecord {
  frontmatter: TicketFrontmatter;
  body: string;
}

/** Read and validate one map record. */
export async function readMap(layout: StoreLayout, id: string): Promise<MapRecord> {
  const { frontmatter, body } = await readFrontmatterFile(mapPath(layout, id));
  return { frontmatter: mapFrontmatterSchema.parse(frontmatter), body };
}

/** Validate and atomically write one map record. */
export async function writeMap(
  layout: StoreLayout,
  frontmatter: MapFrontmatter,
  body: string,
): Promise<void> {
  const valid = mapFrontmatterSchema.parse(frontmatter);
  await writeFrontmatterFile(mapPath(layout, valid.id), valid, body);
}

/** Read and validate one decision-ticket record. */
export async function readTicket(layout: StoreLayout, id: string): Promise<TicketRecord> {
  const { frontmatter, body } = await readFrontmatterFile(ticketPath(layout, id));
  return { frontmatter: ticketFrontmatterSchema.parse(frontmatter), body };
}

/** Validate and atomically write one decision-ticket record. */
export async function writeTicket(
  layout: StoreLayout,
  frontmatter: TicketFrontmatter,
  body: string,
): Promise<void> {
  const valid = ticketFrontmatterSchema.parse(frontmatter);
  await writeFrontmatterFile(ticketPath(layout, valid.id), valid, body);
}

/** Ids of every map record on disk, sorted; [] when nothing is charted yet. */
export async function listMaps(layout: StoreLayout): Promise<string[]> {
  return listRecordIds(layout.mapsDir);
}

/** Ids of every ticket record on disk, sorted; [] when none exist yet. */
export async function listTickets(layout: StoreLayout): Promise<string[]> {
  return listRecordIds(layout.ticketsDir);
}

/** Every map record, in id order. */
export async function readMaps(layout: StoreLayout): Promise<MapRecord[]> {
  const records: MapRecord[] = [];
  for (const id of await listMaps(layout)) records.push(await readMap(layout, id));
  return records;
}

/**
 * Every ticket record, in id order — what F8's frontier predicate and every
 * map view read, since a ticket's blocking edges name siblings and a map's
 * ticket list is a fact held by the tickets, not by the map.
 */
export async function readTickets(layout: StoreLayout): Promise<TicketRecord[]> {
  const records: TicketRecord[] = [];
  for (const id of await listTickets(layout)) records.push(await readTicket(layout, id));
  return records;
}

/** The tickets hanging off one map, in id order. */
export async function ticketsForMap(
  layout: StoreLayout,
  mapId: string,
): Promise<TicketRecord[]> {
  return (await readTickets(layout)).filter((record) => record.frontmatter.map === mapId);
}

/**
 * Resolve a map reference to its record, or null when nothing matches. A map
 * has no slug of its own — it IS the chart of one node — so three spellings
 * address it: the map's own id, and the node's id or slug. A node carries at
 * most one map (creation refuses a second, and `validate` reports any that
 * arrive by merge), so the node-side lookup is unambiguous; where a merge did
 * produce two, the id-ordered first match keeps this read deterministic.
 */
export async function resolveMap(layout: StoreLayout, ref: string): Promise<MapRecord | null> {
  if (ID_PATTERN.test(ref)) {
    const text = await readTextFile(mapPath(layout, ref));
    if (text !== null) return readMap(layout, ref);
  }
  const node = await resolveRoadmapNode(layout, ref);
  if (node === null) return null;
  return (await readMaps(layout)).find((map) => map.frontmatter.node === node.frontmatter.id) ?? null;
}

/**
 * Raw filenames in `nahel/journal/distilled/`, sorted; [] when the dir is
 * absent (nothing distilled yet — git cannot track an empty dir, so a fresh
 * clone has none). validate's tolerant read consumes this so a stray file is
 * REPORTED as a finding rather than crashing the read pass (PRD F6/F8).
 */
export async function listDistilledMarkers(layout: StoreLayout): Promise<string[]> {
  const entries = await readdir(layout.distilledDir).catch((error) => {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [] as string[];
    throw error;
  });
  return entries.sort();
}

/**
 * Read and validate the distilled segment list; [] when no markers exist.
 * Sorted — membership is the meaning (union semantics, ADR-0012), and each
 * member is its own marker FILE, so readdir is already a set.
 */
export async function readDistilled(layout: StoreLayout): Promise<Distilled> {
  return distilledSchema.parse(await listDistilledMarkers(layout));
}

/**
 * Mark segments distilled: validate the names, then create one EMPTY marker
 * file per NEW name under `nahel/journal/distilled/` (mkdir on demand — the
 * dir may not exist on a fresh clone, rotate.ts's archive-dir precedent).
 * Purely additive and per-segment: disjoint distills touch disjoint files, so
 * concurrent invocations cannot lose each other's marks and two worktrees
 * distilling different segments merge as a plain directory union (ADR-0012
 * merge-safe state). A re-run with no new names writes nothing at all (the
 * compaction acceptance bar: re-running changes nothing).
 */
export async function addDistilled(
  layout: StoreLayout,
  names: readonly string[],
): Promise<{ distilled: Distilled; added: string[] }> {
  const valid = distilledSchema.parse(names);
  const existing = new Set(await readDistilled(layout));
  const added = [...new Set(valid)].filter((name) => !existing.has(name)).sort();
  const distilled = [...existing, ...added].sort();
  if (added.length > 0) {
    await mkdir(layout.distilledDir, { recursive: true });
    for (const name of added) {
      // The marker is empty — the NAME is the datum, so creating a file that
      // already exists is byte-identical (idempotence at the file level).
      await writeFile(join(layout.distilledDir, name), "");
    }
  }
  return { distilled, added };
}

/**
 * Raw text of `skills.yaml`; null when absent (a repo may declare no skills).
 * validate's tolerant read consumes this so a malformed manifest is REPORTED
 * as a finding rather than crashing the read pass (PRD F7/F8).
 */
export async function readSkillsManifestText(layout: StoreLayout): Promise<string | null> {
  return readTextFile(layout.skillsManifestPath);
}

/** Read and validate `skills.yaml`; null when the manifest is absent. */
export async function readSkillsManifest(layout: StoreLayout): Promise<SkillsManifest | null> {
  const text = await readSkillsManifestText(layout);
  if (text === null) return null;
  return skillsManifestSchema.parse(YAML.parse(text));
}

/** Raw text of `skills.lock`; null when absent (validate's tolerant read). */
export async function readSkillsLockText(layout: StoreLayout): Promise<string | null> {
  return readTextFile(layout.skillsLockPath);
}

/** Read and validate `skills.lock`; null when the lockfile is absent. */
export async function readSkillsLock(layout: StoreLayout): Promise<SkillsLock | null> {
  const text = await readSkillsLockText(layout);
  if (text === null) return null;
  return skillsLockSchema.parse(JSON.parse(text));
}

/** Validate and atomically write `skills.lock`. */
export async function writeSkillsLock(layout: StoreLayout, lock: SkillsLock): Promise<void> {
  const valid = skillsLockSchema.parse(lock);
  await writeFileAtomic(layout.skillsLockPath, `${JSON.stringify(valid, null, 2)}\n`);
}

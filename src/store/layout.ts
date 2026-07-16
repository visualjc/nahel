import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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

/** Path of a work-item record. */
export function itemPath(layout: StoreLayout, id: string): string {
  return join(layout.itemsDir, `${id}.md`);
}

/** Directory a run's record and hot state live in. */
export function runDir(layout: StoreLayout, id: string): string {
  return join(layout.runsDir, id);
}

/** Path of a run record. */
export function runRecordPath(layout: StoreLayout, id: string): string {
  return join(runDir(layout, id), "run.json");
}

/** Path of an observation record. */
export function observationPath(layout: StoreLayout, id: string): string {
  return join(layout.observationsDir, `${id}.md`);
}

/** Read and validate `nahel/config`. */
export async function readConfig(layout: StoreLayout): Promise<Config> {
  let text: string;
  try {
    text = await readFile(layout.configPath, "utf8");
  } catch {
    throw new Error(`nahel/config not found at ${layout.configPath} — run \`nahel init\``);
  }
  return configSchema.parse(YAML.parse(text));
}

/** Validate and atomically write `nahel/config`. */
export async function writeConfig(layout: StoreLayout, config: Config): Promise<void> {
  const valid = configSchema.parse(config);
  await writeFileAtomic(layout.configPath, YAML.stringify(valid));
}

/** Resolve the config's repo-relative knowledge paths against the root. */
export function knowledgePaths(
  layout: StoreLayout,
  config: Config,
): { product: string; context: string; adr: string } {
  return {
    product: resolve(layout.root, config.knowledge.product),
    context: resolve(layout.root, config.knowledge.context),
    adr: resolve(layout.root, config.knowledge.adr),
  };
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

/** True when the item record exists on disk. */
export async function itemExists(layout: StoreLayout, id: string): Promise<boolean> {
  try {
    await readFile(itemPath(layout, id), "utf8");
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
  let text: string;
  try {
    text = await readFile(runRecordPath(layout, id), "utf8");
  } catch {
    throw new Error(`run ${id} not found at ${runRecordPath(layout, id)}`);
  }
  return runSchema.parse(JSON.parse(text));
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

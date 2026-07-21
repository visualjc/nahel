import { join } from "node:path";
import { ID_PATTERN } from "../schema/id";
import { workItemFrontmatterSchema } from "../schema/records";
import { readFrontmatterFile } from "../store/frontmatter";
import { hotStatePath, readHotStateOrNull } from "../store/hotstate";
import { scanSegments } from "../store/journal";
import {
  itemPath,
  listItems,
  listObservations,
  listRuns,
  observationPath,
  readConfigText,
  readDistilledText,
  readRunRecordText,
  readSkillsLockText,
  readSkillsManifestText,
  readTextFile,
  runRecordPath,
  type StoreLayout,
} from "../store/layout";
import {
  validate,
  type Finding,
  type RawFrontmatterRecord,
  type RawRunRecord,
  type ValidationInput,
} from "./checks";

/**
 * `nahel validate`'s library surface (PRD F8): collectValidationInput is the
 * ONE tolerant store read pass (every failure becomes data, never a throw —
 * one corrupt record must not hide the others), validate() is the pure check
 * battery over it, and validateStore composes the two. `brief` (#8) calls
 * validateStore(layout) for its warnings section.
 */

export {
  DEFAULT_COMPACTION_MAX_AGE_DAYS,
  DEFAULT_COMPACTION_MAX_EVENTS,
  DEFAULT_ROTATION_OVERDUE_SEGMENTS,
  validate,
} from "./checks";
export type {
  Finding,
  RawFrontmatterRecord,
  RawRunRecord,
  ValidationInput,
} from "./checks";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Tolerantly read one frontmatter record (item or observation). */
async function collectFrontmatterRecord(
  id: string,
  path: string,
): Promise<RawFrontmatterRecord> {
  try {
    const { frontmatter, body } = await readFrontmatterFile(path);
    return { id, path, frontmatter, body };
  } catch (error) {
    return { id, path, error: errorMessage(error) };
  }
}

/**
 * Existence on disk of every schema-valid document path the given item field
 * references, keyed by the path as written (repo-relative).
 */
async function collectDocPresence(
  layout: StoreLayout,
  input: ValidationInput,
  field: "prd" | "investigation",
): Promise<Record<string, boolean>> {
  const docField = workItemFrontmatterSchema.shape[field];
  const presence: Record<string, boolean> = {};
  for (const raw of input.items) {
    const parsed = docField.safeParse(raw.frontmatter?.[field]);
    if (!parsed.success || parsed.data === undefined || parsed.data in presence) continue;
    try {
      presence[parsed.data] = (await readTextFile(join(layout.root, parsed.data))) !== null;
    } catch {
      // Unreadable (e.g. the path names a directory): not a usable document.
      presence[parsed.data] = false;
    }
  }
  return presence;
}

/**
 * Collect everything validate checks in one tolerant store read pass:
 * raw config text, raw item/run/observation records, hot state, and the
 * per-line journal segment scan. Deterministically ordered (ids sorted).
 */
export async function collectValidationInput(
  layout: StoreLayout,
  options: ValidateOptions = {},
): Promise<ValidationInput> {
  const input: ValidationInput = {
    configPath: layout.configPath,
    items: [],
    runs: [],
    observations: [],
    segments: await scanSegments(layout),
    skillsManifestPath: layout.skillsManifestPath,
    skillsLockPath: layout.skillsLockPath,
    distilledPath: layout.distilledPath,
    ...(options.now === undefined ? {} : { now: options.now }),
  };

  try {
    input.configText = await readConfigText(layout);
  } catch (error) {
    input.configError = errorMessage(error);
  }

  // Skills manifest/lock are OPTIONAL: a null read means absent (no finding);
  // only a real read failure becomes an error the checks report (PRD F7).
  try {
    const text = await readSkillsManifestText(layout);
    if (text !== null) input.skillsManifestText = text;
  } catch (error) {
    input.skillsManifestError = errorMessage(error);
  }
  try {
    const text = await readSkillsLockText(layout);
    if (text !== null) input.skillsLockText = text;
  } catch (error) {
    input.skillsLockError = errorMessage(error);
  }
  // Distilled list is OPTIONAL too: a null read means nothing distilled yet.
  try {
    const text = await readDistilledText(layout);
    if (text !== null) input.distilledText = text;
  } catch (error) {
    input.distilledError = errorMessage(error);
  }

  // Ids below come from readdir (single path components — they cannot
  // traverse), but the hardened path helpers refuse anything failing
  // ID_PATTERN, and validate must REPORT a rogue filename, never throw
  // (PRD F8) — so malformed names are recorded as raw errors up front.
  for (const id of (await listItems(layout)).sort()) {
    if (!ID_PATTERN.test(id)) {
      input.items.push({
        id,
        path: join(layout.itemsDir, `${id}.md`),
        error: `filename ${JSON.stringify(id)} is not a well-formed nahel id — rename the file to <id>.md`,
      });
      continue;
    }
    input.items.push(await collectFrontmatterRecord(id, itemPath(layout, id)));
  }
  for (const id of (await listObservations(layout)).sort()) {
    if (!ID_PATTERN.test(id)) {
      input.observations.push({
        id,
        path: join(layout.observationsDir, `${id}.md`),
        error: `filename ${JSON.stringify(id)} is not a well-formed nahel id — rename the file to <id>.md`,
      });
      continue;
    }
    input.observations.push(await collectFrontmatterRecord(id, observationPath(layout, id)));
  }

  // Knowledge-document presence (prd: F1/ADR-0013; investigation: F5): stat
  // each schema-valid path once so the pure item.*-missing checks judge
  // existence from data. Only paths the schema field accepts are touched —
  // the hardened fields (repo-relative, no traversal) are what prove the
  // read stays inside the repo; anything else is already a schema.item
  // finding, not a path to probe.
  input.prdPresence = await collectDocPresence(layout, input, "prd");
  input.investigationPresence = await collectDocPresence(layout, input, "investigation");

  for (const id of (await listRuns(layout)).sort()) {
    if (!ID_PATTERN.test(id)) {
      input.runs.push({
        id,
        path: join(layout.runsDir, id, "run.json"),
        hotStatePath: join(layout.runsDir, id, "state.json"),
        error: `directory name ${JSON.stringify(id)} is not a well-formed nahel id — rename the run directory`,
      });
      continue;
    }
    const raw: RawRunRecord = {
      id,
      path: runRecordPath(layout, id),
      hotStatePath: hotStatePath(layout, id),
    };
    try {
      raw.text = await readRunRecordText(layout, id);
    } catch (error) {
      raw.error = errorMessage(error);
    }
    if (raw.text !== undefined) {
      // readHotStateOrNull needs the run record file present; without it
      // there is no hot state to judge (the missing record is the finding).
      try {
        raw.hotState = await readHotStateOrNull(layout, id);
      } catch (error) {
        raw.hotStateError = errorMessage(error);
      }
    }
    input.runs.push(raw);
  }

  return input;
}

/**
 * Collector knobs. `now` is the caller's clock reading (env.now() format),
 * threaded into the input as data — the compaction AGE threshold (PRD F6.2)
 * needs it and is skipped when absent; no check ever reads a clock itself.
 */
export interface ValidateOptions {
  now?: string;
}

/** One-call integrity check: collect the store scan, run every check. */
export async function validateStore(
  layout: StoreLayout,
  options: ValidateOptions = {},
): Promise<Finding[]> {
  return validate(await collectValidationInput(layout, options));
}

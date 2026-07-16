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
  readRunRecordText,
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
  DEFAULT_COMPACTION_OVERDUE_EVENTS,
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
 * Collect everything validate checks in one tolerant store read pass:
 * raw config text, raw item/run/observation records, hot state, and the
 * per-line journal segment scan. Deterministically ordered (ids sorted).
 */
export async function collectValidationInput(layout: StoreLayout): Promise<ValidationInput> {
  const input: ValidationInput = {
    configPath: layout.configPath,
    items: [],
    runs: [],
    observations: [],
    segments: await scanSegments(layout),
  };

  try {
    input.configText = await readConfigText(layout);
  } catch (error) {
    input.configError = errorMessage(error);
  }

  for (const id of (await listItems(layout)).sort()) {
    input.items.push(await collectFrontmatterRecord(id, itemPath(layout, id)));
  }
  for (const id of (await listObservations(layout)).sort()) {
    input.observations.push(await collectFrontmatterRecord(id, observationPath(layout, id)));
  }

  for (const id of (await listRuns(layout)).sort()) {
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

/** One-call integrity check: collect the store scan, run every check. */
export async function validateStore(layout: StoreLayout): Promise<Finding[]> {
  return validate(await collectValidationInput(layout));
}

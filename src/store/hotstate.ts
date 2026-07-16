import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./frontmatter";
import { runDir, runRecordPath, type StoreLayout } from "./layout";

/**
 * Hot state — `state.json` scoped to the run record (ADR-0012: run-scoped so
 * concurrent runs cannot clobber each other). Small, overwritten whole,
 * machine-read; the shape is workflow-owned, so the store constrains it only
 * to a JSON object. Both operations refuse to touch a run that has no record.
 */

export type HotState = Record<string, unknown>;

/** Path of a run's hot state file. */
export function hotStatePath(layout: StoreLayout, runId: string): string {
  return join(runDir(layout, runId), "state.json");
}

async function requireRun(layout: StoreLayout, runId: string): Promise<void> {
  try {
    await access(runRecordPath(layout, runId));
  } catch {
    throw new Error(
      `run ${runId} not found — hot state is scoped to the run record (${runRecordPath(layout, runId)})`,
    );
  }
}

/**
 * Read a run's hot state, or null when state.json does not exist yet (the
 * write-ahead crash window can leave a run without hot state). Still refuses
 * unknown runs and still throws on malformed content — that IS corrupt state.
 */
export async function readHotStateOrNull(
  layout: StoreLayout,
  runId: string,
): Promise<HotState | null> {
  await requireRun(layout, runId);
  let text: string;
  try {
    text = await readFile(hotStatePath(layout, runId), "utf8");
  } catch {
    return null;
  }
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`hot state for run ${runId} must be a JSON object`);
  }
  return parsed as HotState;
}

/** Read a run's hot state; refuses unknown runs and missing state. */
export async function readHotState(layout: StoreLayout, runId: string): Promise<HotState> {
  const state = await readHotStateOrNull(layout, runId);
  if (state === null) {
    throw new Error(`run ${runId} has no hot state yet at ${hotStatePath(layout, runId)}`);
  }
  return state;
}

/** Atomically overwrite a run's hot state; refuses unknown runs. */
export async function writeHotState(
  layout: StoreLayout,
  runId: string,
  state: HotState,
): Promise<void> {
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw new Error(`hot state for run ${runId} must be a JSON object`);
  }
  await requireRun(layout, runId);
  await writeFileAtomic(hotStatePath(layout, runId), `${JSON.stringify(state, null, 2)}\n`);
}

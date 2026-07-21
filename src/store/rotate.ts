import { access, rename } from "node:fs/promises";
import { join } from "node:path";
import { listSegments, readLastEvent, SESSION_CLOSED_EVENT_TYPE } from "./journal";
import { readRun, type StoreLayout } from "./layout";

/**
 * Journal rotation (PRD F1): archive CLOSED segments only — run segments
 * whose run has ended, session segments whose writer closed them — by moving
 * the file into journal/archive/. Active segments are never touched, and the
 * move preserves every line, so event ids stay stable across rotation and
 * observation provenance never rots (ADR-0012).
 */

export interface RotationResult {
  /** Filenames of the segments archived by this pass. */
  archived: string[];
}

const RUN_SEGMENT = /^run-([0-9a-z]{8})\.jsonl$/;
const SESSION_SEGMENT = /^session-([0-9a-z]{8})\.jsonl$/;

async function runSegmentIsClosed(layout: StoreLayout, runId: string): Promise<boolean> {
  try {
    return (await readRun(layout, runId)).status === "ended";
  } catch {
    // No run record — we cannot prove the segment closed, so leave it alone.
    return false;
  }
}

async function sessionSegmentIsClosed(path: string): Promise<boolean> {
  try {
    const lastEvent = await readLastEvent(path);
    return lastEvent !== null && lastEvent.type === SESSION_CLOSED_EVENT_TYPE;
  } catch {
    // Unparseable tail: not provably closed; validate reports it, we skip it.
    return false;
  }
}

/** Archive every provably-closed active segment; returns what moved. */
export async function rotateJournal(layout: StoreLayout): Promise<RotationResult> {
  const archived: string[] = [];
  const { active } = await listSegments(layout);
  for (const name of active.sort()) {
    const path = join(layout.journalDir, name);
    const runMatch = RUN_SEGMENT.exec(name);
    const sessionMatch = SESSION_SEGMENT.exec(name);
    const closed = runMatch
      ? await runSegmentIsClosed(layout, runMatch[1]!)
      : sessionMatch
        ? await sessionSegmentIsClosed(path)
        : false;
    if (closed) {
      const destination = join(layout.journalArchiveDir, name);
      try {
        await rename(path, destination);
      } catch (error) {
        // Concurrent sweepers race between listSegments() and rename(): the
        // loser's source is gone. That is only success if the segment really
        // reached the archive — otherwise the error is real and must surface.
        try {
          await access(destination);
        } catch {
          throw error;
        }
        continue;
      }
      archived.push(name);
    }
  }
  return { archived };
}

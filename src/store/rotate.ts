import { link, mkdir, unlink } from "node:fs/promises";
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

/**
 * Move one closed segment into the archive WITHOUT ever clobbering an
 * existing archive file (bug 7nzsz577, HC6). A same-name collision is
 * legitimate history meeting history: new events for an already-archived run
 * recreate a live segment under the run's canonical name, so the newcomer
 * takes the first free numbered name (`run-<id>.2.jsonl`, `.3`, …) and the
 * original is never touched. `link()` is the no-clobber primitive — it fails
 * EEXIST atomically where `rename()` silently overwrites — and the source is
 * unlinked only after its content provably exists in the archive.
 *
 * Returns the archived filename, or null when a concurrent sweeper archived
 * the segment first (its copy is already in place; a duplicate we linked in
 * the race window is removed, so every event lands in the archive exactly
 * once).
 */
async function archiveSegment(
  layout: StoreLayout,
  name: string,
  path: string,
): Promise<string | null> {
  const stem = name.slice(0, -".jsonl".length);
  for (let attempt = 1; ; attempt++) {
    const candidate = attempt === 1 ? name : `${stem}.${attempt}.jsonl`;
    const destination = join(layout.journalArchiveDir, candidate);
    try {
      await link(path, destination);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "EEXIST") continue; // taken — try the next numbered name
      if (code === "ENOENT") return null; // source gone: another sweeper won
      throw error;
    }
    try {
      await unlink(path);
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") {
        // Another sweeper linked and unlinked the source between our link and
        // unlink: its archive copy is the one that counts — ours would double
        // every event on the merged read, so it goes.
        await unlink(destination).catch(() => {});
        return null;
      }
      throw error;
    }
    return candidate;
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
      // Git never materializes empty directories, so a fresh clone made while
      // the archive was empty has no journal/archive/ at all.
      await mkdir(layout.journalArchiveDir, { recursive: true });
      const landed = await archiveSegment(layout, name, path);
      if (landed !== null) archived.push(landed);
    }
  }
  return { archived };
}

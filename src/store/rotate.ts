import { link, mkdir, rmdir, unlink } from "node:fs/promises";
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
 * The sweep is SERIALIZED across processes by an atomic mkdir lock: every
 * mutation-path command rotates, so concurrent sweepers are the norm, and a
 * lock-free multi-step move protocol demonstrably leaks duplicate archive
 * copies under that contention. One sweeper at a time makes the per-segment
 * move trivially race-free; waiting sweepers re-list under the lock, so the
 * "every closed segment gets archived" invariant survives whichever process
 * sweeps last. A sweep takes milliseconds, so a lock older than the retry
 * budget means a holder that died mid-sweep — it is stolen, and the
 * link-based no-clobber below keeps even a pathological double-sweep from
 * ever destroying history.
 */
const SWEEP_LOCK = ".rotate.lock";
const LOCK_RETRY_MS = 25;
const LOCK_RETRIES = 200; // ~5s budget before a holder is presumed dead

async function acquireSweepLock(layout: StoreLayout): Promise<() => Promise<void>> {
  const lockDir = join(layout.journalDir, SWEEP_LOCK);
  const release = async () => {
    await rmdir(lockDir).catch(() => {});
  };
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      await mkdir(lockDir);
      return release;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  // Budget exhausted: the holder died mid-sweep. Steal the lock and proceed —
  // the archive step's no-clobber guarantee holds even if the holder revives.
  await rmdir(lockDir).catch(() => {});
  await mkdir(lockDir).catch(() => {});
  return release;
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
 * Returns the archived filename, or null when the source is already gone (a
 * stolen-lock sweeper got here first — its copy is the one that counts).
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
    await unlink(path).catch(() => {
      // Source vanished between link and unlink: only a revived dead-lock
      // holder can do that, and the content is safely in the archive either
      // way — never remove an archive file to tidy up.
    });
    return candidate;
  }
}

/** Archive every provably-closed active segment; returns what moved. */
export async function rotateJournal(layout: StoreLayout): Promise<RotationResult> {
  const archived: string[] = [];
  const release = await acquireSweepLock(layout);
  try {
    // Listed UNDER the lock: a fresh view, so the last sweeper standing sees
    // (and archives) segments that closed while it waited.
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
        // Git never materializes empty directories, so a fresh clone made
        // while the archive was empty has no journal/archive/ at all.
        await mkdir(layout.journalArchiveDir, { recursive: true });
        const landed = await archiveSegment(layout, name, path);
        if (landed !== null) archived.push(landed);
      }
    }
  } finally {
    await release();
  }
  return { archived };
}

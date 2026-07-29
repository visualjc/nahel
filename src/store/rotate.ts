import { link, mkdir, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
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
 * sweeps last.
 *
 * OWNERSHIP is what makes the lock safe (codex round 2 on PR #19 proved a
 * time-based steal lets every timed-out waiter clear each other's lock and
 * sweep concurrently): the holder writes a `pid-<pid>` marker inside the
 * lock, staleness is decided by process LIVENESS (kill(pid, 0)) rather than
 * by a clock, and a steal removes exactly the dead holder's marker before
 * rmdir — a fresh lock with a live holder's marker makes the rmdir fail
 * ENOTEMPTY, so nobody can ever clear a lock they do not own. Entry is
 * granted ONLY by winning mkdir and claiming the dir with your own marker.
 */
const SWEEP_LOCK = ".rotate.lock";
const LOCK_RETRY_MS = 25;
/** Retries granted a fresh lock whose holder has not written its marker yet. */
const UNCLAIMED_GRACE_RETRIES = 8;
/** Overall acquisition budget (~10s); past it the sweep is skipped, not hung. */
const ACQUIRE_RETRIES = 400;

/** Whether the process holding the lock still exists (EPERM counts as alive). */
function holderIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code !== "ESRCH";
  }
}

/** The holder's pid marker, or null when the lock is unclaimed or gone. */
async function readHolderMarker(lockDir: string): Promise<string | null> {
  const entries = await readdir(lockDir).catch(() => null);
  return entries?.find((name) => name.startsWith("pid-")) ?? null;
}

/**
 * Acquire the sweep lock, or return null when a LIVE holder keeps it past
 * the budget — rotation is best-effort maintenance, so a contended sweep is
 * skipped (the next mutation rotates again), never hung.
 */
async function acquireSweepLock(layout: StoreLayout): Promise<(() => Promise<void>) | null> {
  const lockDir = join(layout.journalDir, SWEEP_LOCK);
  const ownMarkerPath = join(lockDir, `pid-${process.pid}`);
  const release = async () => {
    // Ownership-safe teardown: remove only our own marker, then the dir —
    // if the lock was stolen and re-claimed, both calls fail harmlessly.
    await unlink(ownMarkerPath).catch(() => {});
    await rmdir(lockDir).catch(() => {});
  };
  let unclaimedSightings = 0;
  for (let i = 0; i < ACQUIRE_RETRIES; i++) {
    try {
      await mkdir(lockDir);
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error;
      const marker = await readHolderMarker(lockDir);
      if (marker === null) {
        // Unclaimed: either the holder is between mkdir and marker write, or
        // it died in that window (or the lock dir was hand-made). Grace for
        // the former, then rmdir — which only ever succeeds on an EMPTY dir,
        // so a claimed lock can never be cleared by this path.
        unclaimedSightings += 1;
        if (unclaimedSightings > UNCLAIMED_GRACE_RETRIES) {
          await rmdir(lockDir).catch(() => {});
          continue;
        }
      } else {
        unclaimedSightings = 0;
        const holderPid = Number(marker.slice("pid-".length));
        if (Number.isInteger(holderPid) && !holderIsAlive(holderPid)) {
          // The holder died mid-sweep. Remove exactly ITS marker, then the
          // then-empty dir; if a new holder moved in meanwhile, the unlink
          // ENOENTs and the rmdir fails ENOTEMPTY — their lock stands.
          await unlink(join(lockDir, marker)).catch(() => {});
          await rmdir(lockDir).catch(() => {});
          continue;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      continue;
    }
    // mkdir won: claim the lock. A failed claim means the empty dir was
    // swept out from under us between mkdir and write — contend again.
    try {
      await writeFile(ownMarkerPath, "");
      return release;
    } catch {
      continue;
    }
  }
  return null;
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
  // A live holder kept the lock past the budget: skip this sweep rather than
  // hang the command — every mutation-path command rotates, so the closed
  // segments are the very next sweep's work.
  if (release === null) return { archived };
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

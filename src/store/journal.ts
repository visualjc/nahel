import { appendFile, open, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Env } from "../schema/env";
import { generateId, ID_PATTERN } from "../schema/id";
import { journalEventSchema, type Actor, type JournalEvent } from "../schema/records";
import type { StoreLayout } from "./layout";

/**
 * The journal: append-only JSONL segments (PRD F1, ADR-0012). Run events go
 * to that run's segment; non-run events go to a writer-scoped session segment
 * with a merge-safe random ID — no two writers ever share an active segment,
 * which is what makes parallel worktrees merge without conflict. Appends are
 * single-line O_APPEND writes carrying a per-segment monotonic `seq`; reads
 * are a streaming k-way merge ordered ts → seq → event id — a total order
 * identical on every machine, never a full-journal load.
 */

/** Event type appended by closeSession; rotation treats such segments as closed. */
export const SESSION_CLOSED_EVENT_TYPE = "session.closed";

const NEWLINE = 0x0a;

/** Mint the merge-safe random ID for a writer-scoped session segment. */
export function newSessionSegmentId(env: Env): string {
  return generateId(env);
}

/** Path of a run's journal segment. */
export function runSegmentPath(layout: StoreLayout, runId: string): string {
  return join(layout.journalDir, `run-${runId}.jsonl`);
}

/** Path of a writer-scoped session segment. */
export function sessionSegmentPath(layout: StoreLayout, sessionId: string): string {
  return join(layout.journalDir, `session-${sessionId}.jsonl`);
}

export interface AppendEventInput {
  type: string;
  actor: Actor;
  /** Run ref; when present the event is appended to that run's segment. */
  run?: string;
  /** Work-item ref carried on the event. */
  item?: string;
  payload: Record<string, unknown>;
  /** Session segment id for non-run events (see newSessionSegmentId). */
  session?: string;
}

function segmentPathFor(layout: StoreLayout, input: AppendEventInput): string {
  if (input.run !== undefined) {
    return runSegmentPath(layout, input.run);
  }
  if (input.session !== undefined) {
    if (!ID_PATTERN.test(input.session)) {
      throw new Error(
        `invalid session segment id ${JSON.stringify(input.session)} — mint one with newSessionSegmentId()`,
      );
    }
    return sessionSegmentPath(layout, input.session);
  }
  throw new Error(
    "non-run events need a writer-scoped session segment: pass `session` (mint one with newSessionSegmentId)",
  );
}

/**
 * Read the last complete line of a file without loading the whole file:
 * backwards chunked reads, byte-level newline scan (multibyte-safe — the
 * buffer is only decoded once the full line is in the window).
 */
async function readLastLine(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return null;
    const CHUNK = 8192;
    let end = size;
    const chunks: Buffer[] = [];
    while (end > 0) {
      const start = Math.max(0, end - CHUNK);
      const buffer = Buffer.alloc(end - start);
      await handle.read(buffer, 0, buffer.length, start);
      chunks.unshift(buffer);
      const window = Buffer.concat(chunks);
      const lineEnd = window[window.length - 1] === NEWLINE ? window.length - 1 : window.length;
      const priorNewline = window.subarray(0, lineEnd).lastIndexOf(NEWLINE);
      if (priorNewline !== -1) {
        return window.subarray(priorNewline + 1, lineEnd).toString("utf8");
      }
      if (start === 0) {
        return window.subarray(0, lineEnd).toString("utf8");
      }
      end = start;
    }
    return null;
  } finally {
    await handle.close();
  }
}

function parseEventLine(path: string, lineNumber: number, line: string): JournalEvent {
  try {
    return journalEventSchema.parse(JSON.parse(line));
  } catch (error) {
    throw new Error(
      `malformed journal event in segment ${basename(path)} line ${lineNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Read and validate a segment's final event via the tail reader (no full
 * load); null for a missing or empty segment. Used for seq derivation here
 * and closed-session detection in rotation.
 */
export async function readLastEvent(path: string): Promise<JournalEvent | null> {
  const lastLine = await readLastLine(path);
  if (lastLine === null) return null;
  return parseEventLine(path, -1, lastLine);
}

/** Next per-segment seq, derived from the segment's tail (survives restarts). */
async function nextSeq(path: string): Promise<number> {
  const lastEvent = await readLastEvent(path);
  return lastEvent === null ? 0 : lastEvent.seq + 1;
}

/**
 * Append one event: resolve the owning segment, derive the next seq, and
 * write the event as a single O_APPEND line. Returns the written event.
 */
export async function appendEvent(
  layout: StoreLayout,
  env: Env,
  input: AppendEventInput,
): Promise<JournalEvent> {
  const path = segmentPathFor(layout, input);
  const event = journalEventSchema.parse({
    id: generateId(env),
    ts: env.now(),
    seq: await nextSeq(path),
    type: input.type,
    actor: input.actor,
    ...(input.run === undefined ? {} : { run: input.run }),
    ...(input.item === undefined ? {} : { item: input.item }),
    payload: input.payload,
  });
  await appendFile(path, `${JSON.stringify(event)}\n`, { flag: "a" });
  return event;
}

/**
 * Close a writer-scoped session segment by appending the session.closed
 * marker as its final event; rotation may then archive the segment.
 */
export async function closeSession(
  layout: StoreLayout,
  env: Env,
  actor: Actor,
  sessionId: string,
): Promise<JournalEvent> {
  return appendEvent(layout, env, {
    type: SESSION_CLOSED_EVENT_TYPE,
    actor,
    payload: {},
    session: sessionId,
  });
}

/** Stream one segment's events in file order, validating every line. */
async function* readSegment(path: string): AsyncGenerator<JournalEvent> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let pending = Buffer.alloc(0);
    let lineNumber = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      let data = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
      let start = 0;
      while (true) {
        const newline = data.indexOf(NEWLINE, start);
        if (newline === -1) break;
        lineNumber += 1;
        const line = data.subarray(start, newline).toString("utf8");
        if (line.trim() !== "") yield parseEventLine(path, lineNumber, line);
        start = newline + 1;
      }
      pending = Buffer.from(data.subarray(start));
    }
    if (pending.length > 0) {
      lineNumber += 1;
      const line = pending.toString("utf8");
      if (line.trim() !== "") yield parseEventLine(path, lineNumber, line);
    }
  } finally {
    await handle.close();
  }
}

/** Total order over journal events: ts, then per-segment seq, then event id. */
function compareEvents(a: JournalEvent, b: JournalEvent): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * Streaming k-way merge over segment files. Each segment is read line-by-line
 * (never fully loaded); the result is the ts → seq → id total order and is
 * identical regardless of the order `paths` arrives in.
 */
export async function* mergeSegments(
  paths: readonly string[],
): AsyncGenerator<JournalEvent> {
  const iterators = paths.map((path) => readSegment(path));
  try {
    const heads: (JournalEvent | null)[] = [];
    for (const iterator of iterators) {
      const result = await iterator.next();
      heads.push(result.done ? null : result.value);
    }
    while (true) {
      let min = -1;
      for (let i = 0; i < heads.length; i++) {
        const head = heads[i];
        if (head !== null && head !== undefined && (min === -1 || compareEvents(head, heads[min]!) < 0)) {
          min = i;
        }
      }
      if (min === -1) return;
      yield heads[min]!;
      const result = await iterators[min]!.next();
      heads[min] = result.done ? null : result.value;
    }
  } finally {
    // If the consumer stops early, close every unfinished segment reader so
    // no file handles leak.
    for (const iterator of iterators) {
      await iterator.return(undefined);
    }
  }
}

/** Active and archived segment filenames. */
export async function listSegments(
  layout: StoreLayout,
): Promise<{ active: string[]; archived: string[] }> {
  const activeEntries = await readdir(layout.journalDir, { withFileTypes: true }).catch(
    () => [],
  );
  const archivedEntries = await readdir(layout.journalArchiveDir).catch(
    () => [] as string[],
  );
  return {
    active: activeEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name),
    archived: archivedEntries.filter((name) => name.endsWith(".jsonl")),
  };
}

/**
 * Stream the whole journal — active and archived segments — in the merged
 * total order (event ids are stable across rotation, so provenance holds).
 */
export async function* readJournal(layout: StoreLayout): AsyncGenerator<JournalEvent> {
  const segments = await listSegments(layout);
  const paths = [
    ...segments.active.map((name) => join(layout.journalDir, name)),
    ...segments.archived.map((name) => join(layout.journalArchiveDir, name)),
  ];
  yield* mergeSegments(paths);
}

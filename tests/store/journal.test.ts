import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { journalEventSchema, type JournalEvent } from "../../src/schema/records";
import {
  appendEvent,
  closeSession,
  listSegments,
  mergeSegments,
  newSessionSegmentId,
  readJournal,
  runSegmentPath,
  SESSION_CLOSED_EVENT_TYPE,
  sessionSegmentPath,
} from "../../src/store/journal";
import { ensureLayout, type StoreLayout } from "../../src/store/layout";
import { makeTempDir, seededEnv } from "./helpers";

const actor = { kind: "agent", id: "claude-code" } as const;

let dirs: string[] = [];

async function setup(): Promise<StoreLayout> {
  const root = await makeTempDir();
  dirs.push(root);
  return ensureLayout(root);
}

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

describe("appendEvent — segment resolution", () => {
  test("run events go to that run's segment: journal/run-{runId}.jsonl", async () => {
    const layout = await setup();
    const env = seededEnv();
    const event = await appendEvent(layout, env, {
      type: "run.started",
      actor,
      run: "aaaaaaaa",
      item: "bbbbbbbb",
      payload: { note: "off we go" },
    });
    expect(runSegmentPath(layout, "aaaaaaaa")).toBe(
      join(layout.journalDir, "run-aaaaaaaa.jsonl"),
    );
    const lines = (await readFile(runSegmentPath(layout, "aaaaaaaa"), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(event);
  });

  test("non-run events go to the writer-scoped session segment", async () => {
    const layout = await setup();
    const env = seededEnv();
    const session = newSessionSegmentId(env);
    const event = await appendEvent(layout, env, {
      type: "note",
      actor,
      item: "bbbbbbbb",
      payload: { text: "observed something" },
      session,
    });
    expect(sessionSegmentPath(layout, session)).toBe(
      join(layout.journalDir, `session-${session}.jsonl`),
    );
    const raw = await readFile(sessionSegmentPath(layout, session), "utf8");
    expect(JSON.parse(raw.trim())).toEqual(event);
  });

  // PR #12 review blocker 2: run ids are user input (nahel log --run, run
  // update argv) and were joined into the segment path unvalidated — a
  // traversal id put the segment file outside nahel/journal.
  test("runSegmentPath refuses ids failing ID_PATTERN before any join", async () => {
    const layout = await setup();
    for (const id of ["../../evil", "..", "/tmp/evil", "ABCDEFGH", "abc", ""]) {
      expect(() => runSegmentPath(layout, id)).toThrow(/invalid run id/);
    }
  });

  test("appendEvent with a traversal run ref refuses and writes nothing outside journal/", async () => {
    const layout = await setup();
    const env = seededEnv();
    expect(
      appendEvent(layout, env, {
        type: "note",
        actor,
        run: "../../../evil",
        payload: {},
      }),
    ).rejects.toThrow(/invalid run id/);
    // The escaped join (`run-../../../evil.jsonl` normalizes above journal/)
    // would have landed at nahel/evil.jsonl — must not exist.
    expect(existsSync(join(layout.nahelDir, "evil.jsonl"))).toBe(false);
    expect((await listSegments(layout)).active).toEqual([]);
  });

  test("a non-run event without a session is refused — every event needs a segment owner", async () => {
    const layout = await setup();
    const env = seededEnv();
    expect(
      appendEvent(layout, env, { type: "note", actor, payload: {} }),
    ).rejects.toThrow(/session/);
  });

  test("events are schema-valid with env-injected id and ts", async () => {
    const layout = await setup();
    const env = seededEnv({ now: "2026-07-16T09:00:00Z" });
    const session = newSessionSegmentId(env);
    const event = await appendEvent(layout, env, {
      type: "note",
      actor,
      payload: {},
      session,
    });
    expect(() => journalEventSchema.parse(event)).not.toThrow();
    expect(event.ts).toBe("2026-07-16T09:00:00Z");
    expect(event.id).toMatch(/^[0-9a-z]{8}$/);
  });
});

describe("appendEvent — per-segment monotonic seq", () => {
  test("seq starts at 0 and increments per segment, derived from the file (survives process restarts)", async () => {
    const layout = await setup();
    const env = seededEnv();
    const seqs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const event = await appendEvent(layout, env, {
        type: "run.updated",
        actor,
        run: "aaaaaaaa",
        payload: { i },
      });
      seqs.push(event.seq);
    }
    expect(seqs).toEqual([0, 1, 2, 3, 4]);
  });

  test("seq is per-segment: independent segments each count from 0", async () => {
    const layout = await setup();
    const env = seededEnv();
    const a = await appendEvent(layout, env, {
      type: "run.started",
      actor,
      run: "aaaaaaaa",
      payload: {},
    });
    const b = await appendEvent(layout, env, {
      type: "run.started",
      actor,
      run: "cccccccc",
      payload: {},
    });
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(0);
  });

  test("seq derivation reads only the segment tail, even past a very large event line", async () => {
    const layout = await setup();
    const env = seededEnv();
    // A payload far bigger than any single tail-read chunk.
    await appendEvent(layout, env, {
      type: "note",
      actor,
      run: "aaaaaaaa",
      payload: { blob: "x".repeat(256 * 1024) },
    });
    const event = await appendEvent(layout, env, {
      type: "note",
      actor,
      run: "aaaaaaaa",
      payload: {},
    });
    expect(event.seq).toBe(1);
  });

  test("appends are single lines: the segment is always parseable line-by-line", async () => {
    const layout = await setup();
    const env = seededEnv();
    for (let i = 0; i < 3; i++) {
      await appendEvent(layout, env, {
        type: "note",
        actor,
        run: "aaaaaaaa",
        payload: { multiline: "a\nb\nc", i },
      });
    }
    const raw = await readFile(runSegmentPath(layout, "aaaaaaaa"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => journalEventSchema.parse(JSON.parse(line))).not.toThrow();
    }
  });
});

describe("closeSession", () => {
  test("appends a session.closed event as the segment's last line", async () => {
    const layout = await setup();
    const env = seededEnv();
    const session = newSessionSegmentId(env);
    await appendEvent(layout, env, { type: "note", actor, payload: {}, session });
    await closeSession(layout, env, actor, session);
    const lines = (await readFile(sessionSegmentPath(layout, session), "utf8"))
      .trim()
      .split("\n");
    const last = JSON.parse(lines.at(-1)!) as JournalEvent;
    expect(last.type).toBe(SESSION_CLOSED_EVENT_TYPE);
    expect(last.seq).toBe(1);
  });
});

describe("readJournal — streaming merge", () => {
  test("merges run and session segments into one ts → seq → id total order", async () => {
    const layout = await setup();
    const env = seededEnv({ now: "2026-07-16T09:00:00Z", tickSeconds: 1 });
    const session = newSessionSegmentId(env);
    const written: JournalEvent[] = [];
    // Interleave appends across three segments; the ticking clock gives
    // strictly increasing timestamps, so merged order == append order.
    for (let i = 0; i < 12; i++) {
      const target = i % 3;
      written.push(
        await appendEvent(layout, env, {
          type: "note",
          actor,
          payload: { i },
          ...(target === 0
            ? { run: "aaaaaaaa" }
            : target === 1
              ? { run: "cccccccc" }
              : { session }),
        }),
      );
    }
    const merged = await Array.fromAsync(readJournal(layout));
    expect(merged.map((e) => e.id)).toEqual(written.map((e) => e.id));
  });

  test("ties on ts break by seq, then by event id", async () => {
    const layout = await setup();
    // Frozen clock: every event has the identical timestamp.
    const env = seededEnv({ now: "2026-07-16T09:00:00Z" });
    for (let i = 0; i < 4; i++) {
      await appendEvent(layout, env, { type: "note", actor, run: "aaaaaaaa", payload: { i } });
      await appendEvent(layout, env, { type: "note", actor, run: "cccccccc", payload: { i } });
    }
    const merged = await Array.fromAsync(readJournal(layout));
    expect(merged).toHaveLength(8);
    for (let i = 1; i < merged.length; i++) {
      const prev = merged[i - 1]!;
      const next = merged[i]!;
      const ordered =
        prev.ts < next.ts ||
        (prev.ts === next.ts &&
          (prev.seq < next.seq || (prev.seq === next.seq && prev.id < next.id)));
      expect(ordered).toBe(true);
    }
  });

  test("includes archived segments (event ids stable across rotation)", async () => {
    const layout = await setup();
    const env = seededEnv({ tickSeconds: 1 });
    const event = await appendEvent(layout, env, {
      type: "run.ended",
      actor,
      run: "aaaaaaaa",
      payload: {},
    });
    // Move the segment into archive/ the way rotation does.
    const { rename } = await import("node:fs/promises");
    await rename(
      runSegmentPath(layout, "aaaaaaaa"),
      join(layout.journalArchiveDir, "run-aaaaaaaa.jsonl"),
    );
    const merged = await Array.fromAsync(readJournal(layout));
    expect(merged.map((e) => e.id)).toEqual([event.id]);
  });

  test("empty journal yields nothing", async () => {
    const layout = await setup();
    expect(await Array.fromAsync(readJournal(layout))).toEqual([]);
  });

  test("a malformed journal line fails loudly, naming the segment", async () => {
    const layout = await setup();
    const env = seededEnv();
    await appendEvent(layout, env, { type: "note", actor, run: "aaaaaaaa", payload: {} });
    await appendFile(runSegmentPath(layout, "aaaaaaaa"), "this is not json\n");
    expect(Array.fromAsync(readJournal(layout))).rejects.toThrow(/run-aaaaaaaa/);
  });
});

describe("readJournal — property: order is independent of segment discovery order", () => {
  test("shuffled segment sets merge to the identical total order", async () => {
    const layout = await setup();
    // Six writers, timestamps drawn from a small pool so cross-segment ties
    // are common — the hard case for total ordering.
    const tsPool = [
      "2026-07-16T09:00:00Z",
      "2026-07-16T09:00:01Z",
      "2026-07-16T09:00:02Z",
    ];
    const rng = seededEnv({ seed: 7 });
    const paths: string[] = [];
    const all: JournalEvent[] = [];
    for (let s = 0; s < 6; s++) {
      const runId = String(s).repeat(8);
      let lastTs = 0;
      for (let seq = 0; seq < 20; seq++) {
        // Non-decreasing ts within a segment, as real appends are.
        lastTs = Math.max(lastTs, Math.floor(rng.random() * tsPool.length));
        const env = seededEnv({ seed: s * 1000 + seq, now: tsPool[lastTs] });
        const event = await appendEvent(layout, env, {
          type: "note",
          actor,
          run: runId,
          payload: { s, seq },
        });
        all.push(event);
      }
      paths.push(runSegmentPath(layout, runId));
    }
    const expected = [...all]
      .sort((a, b) =>
        a.ts !== b.ts ? (a.ts < b.ts ? -1 : 1) : a.seq !== b.seq ? a.seq - b.seq : a.id < b.id ? -1 : 1,
      )
      .map((e) => e.id);

    const shuffle = seededEnv({ seed: 99 });
    for (let round = 0; round < 25; round++) {
      const shuffled = [...paths];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(shuffle.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      const merged = await Array.fromAsync(mergeSegments(shuffled));
      expect(merged.map((e) => e.id)).toEqual(expected);
    }
  });
});

describe("listSegments", () => {
  test("separates active from archived segments", async () => {
    const layout = await setup();
    const env = seededEnv();
    await appendEvent(layout, env, { type: "note", actor, run: "aaaaaaaa", payload: {} });
    await appendEvent(layout, env, { type: "note", actor, run: "cccccccc", payload: {} });
    const { rename } = await import("node:fs/promises");
    await rename(
      runSegmentPath(layout, "cccccccc"),
      join(layout.journalArchiveDir, "run-cccccccc.jsonl"),
    );
    const segments = await listSegments(layout);
    expect(segments.active).toEqual(["run-aaaaaaaa.jsonl"]);
    expect(segments.archived).toEqual(["run-cccccccc.jsonl"]);
  });
});

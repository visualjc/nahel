import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, rm } from "node:fs/promises";
import { generateId } from "../../src/schema/id";
import type { JournalEvent } from "../../src/schema/records";
import { readJournal, runSegmentPath } from "../../src/store/journal";
import { ensureLayout } from "../../src/store/layout";
import { makeTempDir, seededEnv } from "./helpers";

let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

describe("journal read performance (PRD: <1s at thousands of events, streaming merge)", () => {
  test(
    "merge-reads 5000 events across 10 segments in under one second",
    async () => {
      const root = await makeTempDir();
      dirs.push(root);
      const layout = await ensureLayout(root);
      const env = seededEnv({ seed: 1234 });

      // Build 10 run segments of 500 events each, written in the on-disk
      // format (single JSON lines, monotonic per-segment seq, non-decreasing ts).
      const SEGMENTS = 10;
      const PER_SEGMENT = 500;
      for (let s = 0; s < SEGMENTS; s++) {
        const runId = generateId(env);
        const lines: string[] = [];
        for (let seq = 0; seq < PER_SEGMENT; seq++) {
          const minute = String(Math.floor(seq / 60)).padStart(2, "0");
          const second = String(seq % 60).padStart(2, "0");
          const event: JournalEvent = {
            id: generateId(env),
            ts: `2026-07-16T09:${minute}:${second}Z`,
            seq,
            type: "note",
            actor: { kind: "agent", id: `writer-${s}` },
            run: runId,
            payload: { s, seq, detail: "synthetic journal traffic for the perf gate" },
          };
          lines.push(JSON.stringify(event));
        }
        await appendFile(runSegmentPath(layout, runId), `${lines.join("\n")}\n`);
      }

      const started = performance.now();
      let count = 0;
      let lastKey = "";
      for await (const event of readJournal(layout)) {
        count += 1;
        // Verify total order while streaming — no post-hoc sort allowed.
        const key = `${event.ts}#${String(event.seq).padStart(10, "0")}#${event.id}`;
        expect(key > lastKey).toBe(true);
        lastKey = key;
      }
      const elapsedMs = performance.now() - started;

      expect(count).toBe(SEGMENTS * PER_SEGMENT);
      console.log(`readJournal merged ${count} events in ${elapsedMs.toFixed(1)}ms`);
      expect(elapsedMs).toBeLessThan(1000);
    },
    { timeout: 30_000 },
  );
});

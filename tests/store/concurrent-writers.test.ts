import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { JournalEvent } from "../../src/schema/records";
import { listSegments, readJournal, sessionSegmentPath } from "../../src/store/journal";
import { ensureLayout } from "../../src/store/layout";
import { makeTempDir } from "./helpers";

const WORKER = join(import.meta.dir, "workers", "session-writer.ts");

let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

describe("concurrent writers", () => {
  test(
    "two concurrent writer processes get distinct session segments and lose no events",
    async () => {
      const root = await makeTempDir();
      dirs.push(root);
      const layout = await ensureLayout(root);
      const COUNT = 50;

      const spawn = (actorId: string) =>
        Bun.spawn(["bun", "run", WORKER, root, actorId, String(COUNT)], {
          stdout: "pipe",
          stderr: "inherit",
        });
      const [a, b] = [spawn("writer-a"), spawn("writer-b")];
      const [outA, outB] = await Promise.all([
        new Response(a.stdout).text(),
        new Response(b.stdout).text(),
      ]);
      expect(await a.exited).toBe(0);
      expect(await b.exited).toBe(0);

      const sessionA = outA.trim();
      const sessionB = outB.trim();
      // No two writers ever share an active segment file.
      expect(sessionA).not.toBe(sessionB);
      const segments = await listSegments(layout);
      expect(segments.active.sort()).toEqual(
        [`session-${sessionA}.jsonl`, `session-${sessionB}.jsonl`].sort(),
      );

      // Each writer's segment holds exactly its own events with monotonic seq.
      for (const [session, writer] of [
        [sessionA, "writer-a"],
        [sessionB, "writer-b"],
      ] as const) {
        const lines = (await readFile(sessionSegmentPath(layout, session), "utf8"))
          .trim()
          .split("\n");
        expect(lines).toHaveLength(COUNT);
        const events = lines.map((line) => JSON.parse(line) as JournalEvent);
        expect(events.map((e) => e.seq)).toEqual([...Array(COUNT).keys()]);
        expect(new Set(events.map((e) => e.actor.id))).toEqual(new Set([writer]));
      }

      // The merged read sees every event from both writers exactly once.
      const merged = await Array.fromAsync(readJournal(layout));
      expect(merged).toHaveLength(COUNT * 2);
      expect(new Set(merged.map((e) => e.id)).size).toBe(COUNT * 2);
    },
    { timeout: 30_000 },
  );
});

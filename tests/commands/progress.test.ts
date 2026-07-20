import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, rm } from "node:fs/promises";
import type { CommandContext } from "../../src/cli";
import { logCommand } from "../../src/commands/log";
import { progressCommand } from "../../src/commands/progress";
import { generateId } from "../../src/schema/id";
import type { JournalEvent } from "../../src/schema/records";
import { listSegments, readJournal, runSegmentPath } from "../../src/store/journal";
import { ensureLayout, writeConfig } from "../../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";
import { buildPopulatedStore, FIXTURE_EVENT_TYPES, type PopulatedStore } from "../views/helpers";

/**
 * `nahel progress` (PRD F6, task #7): the merged journal timeline, newest
 * LAST, filterable with --item (subtree), --since, --limit. STRICTLY a view —
 * the output contains nothing that is not in the journal. Streaming: <1s
 * with thousands of events.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runProgress(args: string[], root: string): Promise<CommandResult> {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    env: seededEnv(),
    cwd: root,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  const code = await progressCommand.run(args, ctx);
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

async function allEvents(store: PopulatedStore): Promise<JournalEvent[]> {
  return Array.fromAsync(readJournal(store.layout));
}

describe("nahel progress — the full timeline", () => {
  test("renders every journal event in merged total order, newest last", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const result = await runProgress([], store.root);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const lines = result.stdout.split("\n");
    expect(lines).toHaveLength(FIXTURE_EVENT_TYPES.length);
    const events = await allEvents(store);
    for (const [index, event] of events.entries()) {
      expect(lines[index]).toContain(event.type);
      expect(lines[index]).toContain(event.ts);
    }
    // Newest last.
    expect(lines[lines.length - 1]).toContain("item.claimed");
  });

  test("contains NOTHING that is not in the journal — every output token traces to an event", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const result = await runProgress([], store.root);
    const events = await allEvents(store);
    // Reconstruct the set of strings the journal can justify; every line must
    // be exactly composed of its event's fields.
    for (const [index, line] of result.stdout.split("\n").entries()) {
      const event = events[index]!;
      const justified = [
        event.ts,
        event.type,
        `${event.actor.kind}:${event.actor.id}`,
        ...(event.actor.session === undefined ? [] : [event.actor.session]),
        ...(event.item === undefined ? [] : [`item=${event.item}`]),
        ...(event.run === undefined ? [] : [`run=${event.run}`]),
        ...(Object.keys(event.payload).length === 0 ? [] : [JSON.stringify(event.payload)]),
      ];
      let remainder = line;
      for (const token of justified) {
        remainder = remainder.replace(token, "");
      }
      expect(remainder.trim()).toBe("");
    }
  });

  test("an empty journal renders an explicit empty message with exit 0", async () => {
    const root = await makeTempDir("nahel-progress-empty-");
    tempDirs.push(root);
    await writeConfig(await ensureLayout(root), makeConfig());
    const result = await runProgress([], root);
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  test("byte-identical output across repeated invocations of the same state", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const first = await runProgress([], store.root);
    const second = await runProgress([], store.root);
    expect(first.stdout).toBe(second.stdout);
  });
});

describe("nahel progress — filters", () => {
  test("--item includes the item AND its descendants (epic covers its tasks' events)", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const result = await runProgress(["--item", store.epicId], store.root);
    expect(result.code).toBe(0);
    const lines = result.stdout.split("\n");
    // solo-chore's creation is outside the subtree, and the session.closed
    // markers carry no item or run ref; everything else is inside, including
    // the run-ref-only test.failed event.
    const excluded = FIXTURE_EVENT_TYPES.filter((type) => type === "session.closed").length + 1;
    expect(lines).toHaveLength(FIXTURE_EVENT_TYPES.length - excluded);
    expect(result.stdout).not.toContain(store.soloChoreId);
    expect(result.stdout).toContain("test.failed");
    expect(result.stdout).toContain("run.ended");
  });

  test("--item on a leaf shows only that item's events", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const result = await runProgress(["--item", store.soloChoreId], store.root);
    expect(result.code).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("item.created");
    expect(lines[0]).toContain(store.soloChoreId);
  });

  test("--since keeps only events at or after the instant", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const events = await allEvents(store);
    const pivot = events.find((event) => event.type === "run.ended")!;
    const result = await runProgress(["--since", pivot.ts], store.root);
    expect(result.code).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("run.ended");
    expect(lines[2]).toContain("session.closed");
    expect(lines[3]).toContain("test.failed");
    expect(lines[4]).toContain("item.claimed");
  });

  test("--limit keeps the newest n events (still newest-last)", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const result = await runProgress(["--limit", "2"], store.root);
    expect(result.code).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("test.failed");
    expect(lines[1]).toContain("item.claimed");
  });

  test("filters compose: --item --since --limit", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const events = await allEvents(store);
    const pivot = events.find((event) => event.type === "run.updated")!;
    const result = await runProgress(
      ["--item", store.epicId, "--since", pivot.ts, "--limit", "2"],
      store.root,
    );
    expect(result.code).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("test.failed");
    expect(lines[1]).toContain("item.claimed");
  });
});

describe("nahel progress — argument validation", () => {
  test("--item must reference an existing work item", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const result = await runProgress(["--item", "zzzzzzzz"], store.root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("zzzzzzzz");
  });

  test("--since must be an ISO-8601 UTC second-precision timestamp", async () => {
    const store = await buildPopulatedStore(tempDirs);
    for (const bad of ["yesterday", "2026-07-16", "2026-07-16 12:00:00"]) {
      const result = await runProgress(["--since", bad], store.root);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("--since");
    }
  });

  test("--limit must be a positive integer", async () => {
    const store = await buildPopulatedStore(tempDirs);
    for (const bad of ["0", "-3", "abc", "2.5"]) {
      const result = await runProgress(["--limit", bad], store.root);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("--limit");
    }
  });

  test("unexpected positionals and unknown flags are usage errors", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const positional = await runProgress(["surprise"], store.root);
    expect(positional.code).toBe(1);
    expect(positional.stderr).toContain("usage");

    const unknown = await runProgress(["--bogus"], store.root);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("usage");
  });

  test("an uninitialized directory is a hard error pointing at nahel init", async () => {
    const root = await makeTempDir("nahel-progress-bare-");
    tempDirs.push(root);
    const result = await runProgress([], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("nahel init");
  });

  test("exports a registration-ready Command: a description and a run function", () => {
    expect(typeof progressCommand.description).toBe("string");
    expect(progressCommand.description.length).toBeGreaterThan(0);
    expect(typeof progressCommand.run).toBe("function");
  });
});

describe("nahel progress — performance (PRD: <1s at thousands of events, streaming)", () => {
  test(
    "renders 5000 events across 10 segments in under one second — with and without --limit",
    async () => {
      const root = await makeTempDir("nahel-progress-perf-");
      tempDirs.push(root);
      const layout = await ensureLayout(root);
      await writeConfig(layout, makeConfig());
      const env = seededEnv({ seed: 4242 });

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

      const fullStart = performance.now();
      const full = await runProgress([], root);
      const fullMs = performance.now() - fullStart;
      expect(full.code).toBe(0);
      expect(full.stdout.split("\n")).toHaveLength(SEGMENTS * PER_SEGMENT);
      console.log(`nahel progress rendered ${SEGMENTS * PER_SEGMENT} events in ${fullMs.toFixed(1)}ms`);
      expect(fullMs).toBeLessThan(1000);

      const limitedStart = performance.now();
      const limited = await runProgress(["--limit", "25"], root);
      const limitedMs = performance.now() - limitedStart;
      expect(limited.code).toBe(0);
      expect(limited.stdout.split("\n")).toHaveLength(25);
      console.log(`nahel progress --limit 25 over ${SEGMENTS * PER_SEGMENT} events in ${limitedMs.toFixed(1)}ms`);
      expect(limitedMs).toBeLessThan(1000);
    },
    { timeout: 30_000 },
  );
});

describe("nahel progress — rotated segments (PRD F1)", () => {
  test("the timeline still shows events whose segments were rotated into journal/archive/", async () => {
    const root = await makeTempDir("nahel-progress-rotated-");
    tempDirs.push(root);
    const layout = await ensureLayout(root);
    await writeConfig(layout, makeConfig());
    const env = seededEnv({ tickSeconds: 1 });

    for (const text of ["first-note", "second-note"]) {
      const ctx: CommandContext = {
        env,
        cwd: root,
        stdout: () => {},
        stderr: () => {},
      };
      expect(await logCommand.run(["note", "--data", `text=${text}`], ctx)).toBe(0);
    }

    // log closed + archived its own segments: nothing active remains…
    const segments = await listSegments(layout);
    expect(segments.active).toEqual([]);
    expect(segments.archived).toHaveLength(2);

    // …and the timeline still carries every event, in order.
    const result = await runProgress([], root);
    expect(result.code).toBe(0);
    const noteLines = result.stdout.split("\n").filter((line) => line.includes("note"));
    expect(noteLines[0]).toContain("first-note");
    expect(noteLines[1]).toContain("second-note");
  });
});

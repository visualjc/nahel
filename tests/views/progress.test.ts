import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { JournalEvent } from "../../src/schema/records";
import { readJournal } from "../../src/store/journal";
import { collectProgress, eventMatchesQuery, renderProgress } from "../../src/views/progress";
import { descendantIds, loadSnapshot } from "../../src/views/snapshot";
import { buildPopulatedStore, FIXTURE_EVENT_TYPES, type PopulatedStore } from "./helpers";

/**
 * The progress view (PRD F6): the merged journal timeline as a PURE renderer
 * events → string (newest LAST), plus the streaming collector the command
 * (and later brief, #8) uses — since/item/limit filters applied while
 * streaming, never a full-journal load into a rendered superset.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function allEvents(store: PopulatedStore): Promise<JournalEvent[]> {
  return Array.fromAsync(readJournal(store.layout));
}

describe("renderProgress — pure renderer, newest last", () => {
  test("renders one line per event in the given order — the newest event is the LAST line", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const events = await allEvents(store);
    expect(events.map((event) => event.type)).toEqual([...FIXTURE_EVENT_TYPES]);

    const lines = renderProgress(events).split("\n");
    expect(lines).toHaveLength(events.length);
    expect(lines[0]).toContain("item.created");
    expect(lines[lines.length - 1]).toContain("item.claimed");
    // Timestamps ascend down the page: newest last.
    const stamps = lines.map((line) => line.slice(0, 20));
    expect([...stamps].sort()).toEqual(stamps);
  });

  test("each line carries ts, type, actor, refs, and the payload — nothing that is not on the event", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const events = await allEvents(store);
    const note = events.find((event) => event.type === "note")!;
    const line = renderProgress([note]);
    expect(line).toContain(note.ts);
    expect(line).toContain("note");
    expect(line).toContain(`${note.actor.kind}:${note.actor.id}`);
    expect(line).toContain(`item=${store.taskAlphaId}`);
    expect(line).toContain("observed a thing");

    const failed = events.find((event) => event.type === "test.failed")!;
    const failedLine = renderProgress([failed]);
    expect(failedLine).toContain(`run=${store.activeRunId}`);
    expect(failedLine).toContain("merge");
  });

  test("no events renders an explicit empty message", () => {
    expect(renderProgress([]).length).toBeGreaterThan(0);
    expect(renderProgress([])).not.toContain("undefined");
  });

  test("same events → byte-identical output", async () => {
    const a = await buildPopulatedStore(tempDirs, 13);
    const b = await buildPopulatedStore(tempDirs, 13);
    expect(renderProgress(await allEvents(a))).toBe(renderProgress(await allEvents(b)));
  });
});

describe("collectProgress — streaming filters", () => {
  test("no query returns the full merged timeline in total order", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const events = await collectProgress(store.layout, {});
    expect(events.map((event) => event.type)).toEqual([...FIXTURE_EVENT_TYPES]);
  });

  test("since keeps only events at or after the given instant", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const events = await allEvents(store);
    const pivot = events.find((event) => event.type === "run.ended")!;
    const filtered = await collectProgress(store.layout, { since: pivot.ts });
    expect(filtered.map((event) => event.type)).toEqual([
      "run.ended",
      "note",
      "test.failed",
      "item.claimed",
    ]);
  });

  test("limit keeps the NEWEST n events, still oldest-first for rendering", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const filtered = await collectProgress(store.layout, { limit: 3 });
    expect(filtered.map((event) => event.type)).toEqual(["note", "test.failed", "item.claimed"]);
  });

  test("item filtering covers the subtree AND run-ref-only events of the subtree's runs", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const snapshot = await loadSnapshot(store.layout);
    const itemIds = descendantIds(snapshot.items, store.epicId);
    const runIds = new Set(
      snapshot.runs
        .filter((entry) => itemIds.has(entry.run.item))
        .map((entry) => entry.run.id),
    );
    const filtered = await collectProgress(store.layout, { itemIds, runIds });

    // Everything except solo-chore's item.created is inside the epic subtree —
    // including test.failed, which carries only a run ref.
    expect(filtered.map((event) => event.type)).toEqual([
      "item.created", // demo-epic
      "item.created", // task-alpha
      "item.created", // task-beta
      "item.updated",
      "run.started",
      "run.updated",
      "run.started",
      "run.ended",
      "note",
      "test.failed",
      "item.claimed", // task-alpha claimed by jim — inside the subtree
    ]);
    for (const event of filtered) {
      expect(event.item === undefined || event.item !== store.soloChoreId).toBe(true);
    }
  });

  test("filters compose: item + since + limit", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const snapshot = await loadSnapshot(store.layout);
    const itemIds = descendantIds(snapshot.items, store.epicId);
    const runIds = new Set(
      snapshot.runs
        .filter((entry) => itemIds.has(entry.run.item))
        .map((entry) => entry.run.id),
    );
    const events = await allEvents(store);
    const pivot = events.find((event) => event.type === "run.updated")!;
    const filtered = await collectProgress(store.layout, {
      itemIds,
      runIds,
      since: pivot.ts,
      limit: 2,
    });
    expect(filtered.map((event) => event.type)).toEqual(["test.failed", "item.claimed"]);
  });
});

describe("eventMatchesQuery — pure predicate", () => {
  test("an item-scoped query rejects events with neither a covered item nor a covered run", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const events = await allEvents(store);
    const soloCreated = events.find(
      (event) => event.type === "item.created" && event.item === store.soloChoreId,
    )!;
    const query = { itemIds: new Set([store.epicId]), runIds: new Set<string>() };
    expect(eventMatchesQuery(soloCreated, query)).toBe(false);

    const epicCreated = events.find((event) => event.item === store.epicId)!;
    expect(eventMatchesQuery(epicCreated, query)).toBe(true);
  });

  test("the empty query matches everything", async () => {
    const store = await buildPopulatedStore(tempDirs);
    for (const event of await allEvents(store)) {
      expect(eventMatchesQuery(event, {})).toBe(true);
    }
  });
});

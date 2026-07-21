import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CORE_EVENT_TYPES } from "../../src/schema/events";
import type { WorkItemFrontmatter } from "../../src/schema/records";
import { appendEvent, newSessionSegmentId } from "../../src/store/journal";
import { readItem, writeItem } from "../../src/store/layout";
import { mutate, replayPending } from "../../src/store/mutate";
import { validateStore } from "../../src/validate";
import {
  createItem,
  findingsFor,
  healItemWrites,
  rawEventLine,
  sabotageItemWrites,
  setupFixture,
  type ValidateFixture,
} from "./helpers";

let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

describe("validate — journal-ahead divergence and --repair (kill-injected crash window)", () => {
  test("detect → repair → clean: a record behind its latest mutation event is found, replayed, and revalidates silently", async () => {
    const fixture = await setupFixture(dirs);
    const v1 = await createItem(fixture, {}, "version one\n");

    // Kill-inject the crash window: journal the update, lose the record write.
    await sabotageItemWrites(fixture.layout.itemsDir);
    const v2 = { ...v1, status: "in-progress" as const, updated: fixture.env.now() };
    expect(
      mutate(fixture.agent, {
        target: "item",
        eventType: CORE_EVENT_TYPES.itemUpdated,
        frontmatter: v2,
        body: "version two\n",
      }),
    ).rejects.toThrow();
    await healItemWrites(fixture.layout.itemsDir);

    // Detect: the divergence is an error pointing at --repair.
    const findings = findingsFor(await validateStore(fixture.layout), "journal.divergence");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain(v1.id);
    expect(findings[0]!.fix).toContain("--repair");

    // Detection alone never mutates: the record is still v1 on disk.
    const before = await readItem(fixture.layout, v1.id);
    expect(before.frontmatter).toEqual(v1);
    expect(before.body).toBe("version one\n");

    // Repair replays the store's journaled mutation; the store is then clean.
    const repaired = await replayPending(fixture.layout);
    expect(repaired.map((r) => `${r.target}:${r.id}`)).toEqual([`item:${v1.id}`]);
    const after = await readItem(fixture.layout, v1.id);
    expect(after.frontmatter).toEqual(v2);
    expect(after.body).toBe("version two\n");
    expect(await validateStore(fixture.layout)).toEqual([]);
  });

  test("a record that was never materialized at all (crash on create) is divergent", async () => {
    const fixture = await setupFixture(dirs);
    await sabotageItemWrites(fixture.layout.itemsDir);
    const { makeFrontmatter } = await import("../store/helpers");
    const v1 = makeFrontmatter(fixture.env);
    expect(
      mutate(fixture.agent, {
        target: "item",
        eventType: CORE_EVENT_TYPES.itemCreated,
        frontmatter: v1,
        body: "born in the journal\n",
      }),
    ).rejects.toThrow();
    await healItemWrites(fixture.layout.itemsDir);

    const findings = findingsFor(await validateStore(fixture.layout), "journal.divergence");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain(v1.id);
  });

  test("repair also heals a SCHEMA-CORRUPT record whose truth the journal holds (found by driving)", async () => {
    const fixture = await setupFixture(dirs);
    const item = await createItem(fixture, {}, "the journaled truth\n");

    // Hand-corrupt the on-disk record: an invalid status the schema rejects.
    const { readFile, writeFile } = await import("node:fs/promises");
    const { itemPath } = await import("../../src/store/layout");
    const path = itemPath(fixture.layout, item.id);
    await writeFile(path, (await readFile(path, "utf8")).replace("status: backlog", "status: cooking"));

    // Detected as both a schema error and a divergence from the journal.
    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, "schema.item")).toHaveLength(1);
    expect(findingsFor(findings, "journal.divergence")).toHaveLength(1);

    // replayPending must not choke on the corrupt current record — the
    // journal already records the truth, so repair restores it.
    const repaired = await replayPending(fixture.layout);
    expect(repaired.map((r) => `${r.target}:${r.id}`)).toEqual([`item:${item.id}`]);
    const healed = await readItem(fixture.layout, item.id);
    expect(healed.frontmatter).toEqual(item);
    expect(healed.body).toBe("the journaled truth\n");
    expect(await validateStore(fixture.layout)).toEqual([]);
  });

  test("a mutation event whose payload cannot be replayed is reported, never thrown", async () => {
    const fixture = await setupFixture(dirs);
    await appendEvent(fixture.layout, fixture.env, {
      type: CORE_EVENT_TYPES.itemUpdated,
      actor: fixture.agent.actor,
      item: "zzzzzzzz",
      payload: { target: "item", record: { id: "not a valid record" }, body: 42 },
      session: newSessionSegmentId(fixture.env),
    });

    const findings = findingsFor(await validateStore(fixture.layout), "journal.payload");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain("replay");
  });
});

/**
 * Same-second cross-segment ties (found by driving the CLI at real-clock
 * speed, task #11's E2E proofs): every CLI invocation mints its own session
 * segment, and timestamps are second-precision — so `item new` followed by
 * `item update` within one second yields two mutation events with EQUAL ts
 * and seq in DIFFERENT segments, ordered only by their random event ids.
 * Cross-segment causality within one second is genuinely unknowable, so the
 * causal "latest" is a candidate SET: each segment's final mutation event
 * (seq is causal within a segment) that carries the maximal ts. A record
 * matching ANY candidate is in sync; divergence/repair fire only when it
 * matches none.
 */
describe("validate/repair — same-second cross-segment mutation ties", () => {
  const TS = "2026-07-16T12:00:00Z";

  /** Two records: created (backlog) and its same-second update (in-progress). */
  function tiedRecords(): { v1: WorkItemFrontmatter; v2: WorkItemFrontmatter } {
    const v1: WorkItemFrontmatter = {
      id: "ka1ka1ka",
      name: "tied-item",
      type: "feature",
      status: "backlog",
      lane: "direct",
      depends_on: [],
      external_refs: [],
      created: TS,
      updated: TS,
    };
    return { v1, v2: { ...v1, status: "in-progress" } };
  }

  /** Seed created/updated as seq-0 events of two separate session segments. */
  async function seedTiedSegments(
    fixture: ValidateFixture,
    createdEventId: string,
    updatedEventId: string,
  ): Promise<{ v1: WorkItemFrontmatter; v2: WorkItemFrontmatter }> {
    const { v1, v2 } = tiedRecords();
    await writeFile(
      join(fixture.layout.journalDir, "session-aaaaaaaa.jsonl"),
      rawEventLine({
        id: createdEventId,
        ts: TS,
        seq: 0,
        type: CORE_EVENT_TYPES.itemCreated,
        item: v1.id,
        payload: { target: "item", record: v1, body: "" },
      }),
    );
    await writeFile(
      join(fixture.layout.journalDir, "session-bbbbbbbb.jsonl"),
      rawEventLine({
        id: updatedEventId,
        ts: TS,
        seq: 0,
        type: CORE_EVENT_TYPES.itemUpdated,
        item: v1.id,
        payload: { target: "item", record: v2, body: "" },
      }),
    );
    return { v1, v2 };
  }

  test("record matching the causally-final update is in sync even when the update's event id sorts FIRST", async () => {
    const fixture = await setupFixture(dirs);
    // Total order (ts, seq, id) puts updated ("11111111") BEFORE created
    // ("zzzzzzzz") — the adverse coin flip: naive latest = the created event.
    const { v2 } = await seedTiedSegments(fixture, "zzzzzzzz", "11111111");
    await writeItem(fixture.layout, v2, "");

    expect(await validateStore(fixture.layout)).toEqual([]);
    // Repair must not REGRESS the record to the created payload.
    expect(await replayPending(fixture.layout)).toEqual([]);
    expect((await readItem(fixture.layout, v2.id)).frontmatter).toEqual(v2);
  });

  test("record matching the update is in sync in the favorable id order too", async () => {
    const fixture = await setupFixture(dirs);
    const { v2 } = await seedTiedSegments(fixture, "11111111", "zzzzzzzz");
    await writeItem(fixture.layout, v2, "");

    expect(await validateStore(fixture.layout)).toEqual([]);
    expect(await replayPending(fixture.layout)).toEqual([]);
  });

  test("a genuinely missing record with tied candidates is still divergent and repairs deterministically to the total-order latest", async () => {
    const fixture = await setupFixture(dirs);
    const { v1 } = await seedTiedSegments(fixture, "zzzzzzzz", "11111111");
    // No record write at all — the true crash window.

    const findings = findingsFor(await validateStore(fixture.layout), "journal.divergence");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain(v1.id);

    const repaired = await replayPending(fixture.layout);
    expect(repaired.map((r) => `${r.target}:${r.id}:${r.eventId}`)).toEqual([
      `item:${v1.id}:zzzzzzzz`, // ties break by event id — identical on every machine
    ]);
    expect((await readItem(fixture.layout, v1.id)).frontmatter).toEqual(v1);
  });

  test("same-SEGMENT same-second supersession still detects and repairs: seq is causal within a segment", async () => {
    const fixture = await setupFixture(dirs);
    const { v1, v2 } = tiedRecords();
    await writeFile(
      join(fixture.layout.journalDir, "session-aaaaaaaa.jsonl"),
      rawEventLine({
        id: "zzzzzzzz",
        ts: TS,
        seq: 0,
        type: CORE_EVENT_TYPES.itemCreated,
        item: v1.id,
        payload: { target: "item", record: v1, body: "" },
      }) +
        rawEventLine({
          id: "11111111",
          ts: TS,
          seq: 1,
          type: CORE_EVENT_TYPES.itemUpdated,
          item: v1.id,
          payload: { target: "item", record: v2, body: "" },
        }),
    );
    // Disk matches the seq-0 event: superseded WITHIN the segment — behind.
    await writeItem(fixture.layout, v1, "");

    const findings = findingsFor(await validateStore(fixture.layout), "journal.divergence");
    expect(findings).toHaveLength(1);

    const repaired = await replayPending(fixture.layout);
    expect(repaired.map((r) => `${r.target}:${r.id}:${r.eventId}`)).toEqual([
      `item:${v1.id}:11111111`,
    ]);
    expect((await readItem(fixture.layout, v1.id)).frontmatter).toEqual(v2);
  });

  test("a strictly-later update (next second, other segment) still makes the created-state record divergent", async () => {
    const fixture = await setupFixture(dirs);
    const { v1, v2 } = tiedRecords();
    const later = { ...v2, updated: "2026-07-16T12:00:01Z" };
    await writeFile(
      join(fixture.layout.journalDir, "session-aaaaaaaa.jsonl"),
      rawEventLine({
        id: "zzzzzzzz",
        ts: TS,
        seq: 0,
        type: CORE_EVENT_TYPES.itemCreated,
        item: v1.id,
        payload: { target: "item", record: v1, body: "" },
      }),
    );
    await writeFile(
      join(fixture.layout.journalDir, "session-bbbbbbbb.jsonl"),
      rawEventLine({
        id: "11111111",
        ts: "2026-07-16T12:00:01Z",
        seq: 0,
        type: CORE_EVENT_TYPES.itemUpdated,
        item: v1.id,
        payload: { target: "item", record: later, body: "" },
      }),
    );
    await writeItem(fixture.layout, v1, "");

    const findings = findingsFor(await validateStore(fixture.layout), "journal.divergence");
    expect(findings).toHaveLength(1);

    const repaired = await replayPending(fixture.layout);
    expect(repaired.map((r) => `${r.target}:${r.id}:${r.eventId}`)).toEqual([
      `item:${v1.id}:11111111`,
    ]);
    expect((await readItem(fixture.layout, v1.id)).frontmatter).toEqual(later);
  });
});

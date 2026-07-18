import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CORE_EVENT_TYPES } from "../../src/schema/events";
import { generateId } from "../../src/schema/id";
import { hotStatePath } from "../../src/store/hotstate";
import { appendEvent, newSessionSegmentId, sessionSegmentPath } from "../../src/store/journal";
import {
  itemPath,
  runRecordPath,
  writeItem,
  writeObservation,
  writeRun,
} from "../../src/store/layout";
import { mutate } from "../../src/store/mutate";
import { validateStore } from "../../src/validate";
import {
  createItem,
  createRun,
  findingsFor,
  rawEventLine,
  setupFixture,
} from "./helpers";

let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

describe("validate — clean store", () => {
  test("a store built entirely through the write surface produces zero findings", async () => {
    const fixture = await setupFixture(dirs);
    const epic = await createItem(fixture, { name: "clean-epic", type: "plan" });
    const task = await createItem(fixture, { name: "clean-task", parent: epic.id });
    await createRun(fixture, task.id);

    // An ended run, hot state mirroring the closed record.
    const done = await createRun(fixture, epic.id);
    const closed = { ...done, status: "ended" as const, ended: fixture.env.now() };
    await mutate(fixture.agent, {
      target: "run",
      eventType: CORE_EVENT_TYPES.runEnded,
      run: closed,
    });
    const { writeHotState } = await import("../../src/store/hotstate");
    await writeHotState(fixture.layout, done.id, {
      phase: closed.phase,
      status: closed.status,
      updated: fixture.env.now(),
    });

    // A logged event plus an observation whose provenance points at it.
    const note = await appendEvent(fixture.layout, fixture.env, {
      type: "note",
      actor: fixture.agent.actor,
      item: task.id,
      payload: { text: "observed a thing" },
      session: fixture.agent.session,
    });
    await writeObservation(
      fixture.layout,
      {
        id: generateId(fixture.env),
        created: fixture.env.now(),
        tags: ["clean"],
        sources: [note.id],
      },
      "a durable fact\n",
    );

    expect(await validateStore(fixture.layout)).toEqual([]);
  });
});

describe("validate — schema validity of every record", () => {
  test("an item with an invalid status is reported with file path, field, and fix hint", async () => {
    const fixture = await setupFixture(dirs);
    const path = itemPath(fixture.layout, "badbadb1");
    await writeFile(
      path,
      [
        "---",
        "id: badbadb1",
        "name: broken-item",
        "type: feature",
        "status: cooking",
        "lane: direct",
        "depends_on: []",
        "external_refs: []",
        "created: 2026-07-16T12:00:00Z",
        "updated: 2026-07-16T12:00:00Z",
        "---",
        "",
      ].join("\n"),
    );

    const findings = findingsFor(await validateStore(fixture.layout), "schema.item");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.path).toBe(path);
    expect(findings[0]!.message).toContain("status");
    expect(findings[0]!.fix).toBeDefined();
  });

  test("an item whose frontmatter id does not match its filename is a schema error", async () => {
    const fixture = await setupFixture(dirs);
    const item = await createItem(fixture);
    // Copy the valid record under a different filename — a botched merge/rename.
    const path = itemPath(fixture.layout, "wr0ngnam");
    const { readFile } = await import("node:fs/promises");
    await writeFile(path, await readFile(itemPath(fixture.layout, item.id), "utf8"));

    const findings = findingsFor(await validateStore(fixture.layout), "schema.item");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toBe(path);
    expect(findings[0]!.message).toContain(item.id);
    expect(findings[0]!.message).toContain("wr0ngnam");
  });

  test("an item file without frontmatter at all is a schema error, not a crash", async () => {
    const fixture = await setupFixture(dirs);
    const path = itemPath(fixture.layout, "n0fr0ntm");
    await writeFile(path, "just some prose, no frontmatter\n");

    const findings = findingsFor(await validateStore(fixture.layout), "schema.item");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain("frontmatter");
  });

  test("a rogue filename that is not a well-formed id is a finding, not a crash", async () => {
    const fixture = await setupFixture(dirs);
    // Hand-dropped files whose names the hardened path helpers would refuse
    // (PR #12 review, blocker 2) - validate must still REPORT them (PRD F8).
    await writeFile(join(fixture.layout.itemsDir, "README.md"), "# stray notes\n");
    await mkdir(join(fixture.layout.runsDir, "not-an-id"), { recursive: true });
    await writeFile(join(fixture.layout.observationsDir, "NOTES.md"), "stray\n");

    const findings = await validateStore(fixture.layout);
    const item = findingsFor(findings, "schema.item");
    expect(item).toHaveLength(1);
    expect(item[0]!.message).toContain("README");
    const run = findingsFor(findings, "schema.run");
    expect(run).toHaveLength(1);
    expect(run[0]!.message).toContain("not-an-id");
    const observation = findingsFor(findings, "schema.observation");
    expect(observation).toHaveLength(1);
    expect(observation[0]!.message).toContain("NOTES");
  });

  test("a run record with unparseable JSON and one with a bad field are both reported", async () => {
    const fixture = await setupFixture(dirs);
    const item = await createItem(fixture);
    const run = await createRun(fixture, item.id);

    // Corrupt the existing run record's JSON.
    await writeFile(runRecordPath(fixture.layout, run.id), "{ not json");
    // A second run directory with a schema-invalid record.
    await mkdir(join(fixture.layout.runsDir, "badr7n01"), { recursive: true });
    await writeFile(
      runRecordPath(fixture.layout, "badr7n01"),
      JSON.stringify({ ...run, id: "badr7n01", status: "flying" }),
    );

    const findings = findingsFor(await validateStore(fixture.layout), "schema.run");
    expect(findings).toHaveLength(2);
    const unparseable = findings.find((f) => f.path === runRecordPath(fixture.layout, run.id));
    expect(unparseable).toBeDefined();
    expect(unparseable!.severity).toBe("error");
    const badField = findings.find((f) => f.path === runRecordPath(fixture.layout, "badr7n01"));
    expect(badField).toBeDefined();
    expect(badField!.message).toContain("status");
  });

  test("an observation with invalid frontmatter is reported with path and field", async () => {
    const fixture = await setupFixture(dirs);
    const path = join(fixture.layout.observationsDir, "bad0bs01.md");
    await writeFile(
      path,
      ["---", "id: bad0bs01", "created: 2026-07-16T12:00:00Z", "tags: nope", "sources: []", "---", "fact", ""].join(
        "\n",
      ),
    );

    const findings = findingsFor(await validateStore(fixture.layout), "schema.observation");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.path).toBe(path);
    expect(findings[0]!.message).toContain("tags");
  });

  test("an invalid config is reported; a missing config points at nahel init", async () => {
    const fixture = await setupFixture(dirs);
    await writeFile(fixture.layout.configPath, "actor: 5\n");
    const invalid = findingsFor(await validateStore(fixture.layout), "schema.config");
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.severity).toBe("error");
    expect(invalid[0]!.path).toBe(fixture.layout.configPath);

    await rm(fixture.layout.configPath);
    const missing = findingsFor(await validateStore(fixture.layout), "schema.config");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.fix).toContain("nahel init");
  });

  test("malformed journal lines are reported with segment and line number", async () => {
    const fixture = await setupFixture(dirs);
    const segment = sessionSegmentPath(fixture.layout, "s0s0s0s0");
    // Line 1: not JSON. Line 2: JSON but no actor (F9: absent actor is flagged).
    const noActor = JSON.parse(rawEventLine()) as Record<string, unknown>;
    delete noActor["actor"];
    await writeFile(segment, `not json at all\n${JSON.stringify(noActor)}\n`);

    const findings = findingsFor(await validateStore(fixture.layout), "schema.event");
    expect(findings).toHaveLength(2);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.path).toBe(segment);
    expect(findings[0]!.message).toContain("line 1");
    expect(findings[1]!.message).toContain("line 2");
    expect(findings[1]!.message).toContain("actor");
  });

  test("malformed hot state (non-object state.json) is a schema error", async () => {
    const fixture = await setupFixture(dirs);
    const item = await createItem(fixture);
    const run = await createRun(fixture, item.id);
    await writeFile(hotStatePath(fixture.layout, run.id), "[1, 2, 3]\n");

    const findings = findingsFor(await validateStore(fixture.layout), "schema.hotstate");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.path).toBe(hotStatePath(fixture.layout, run.id));
  });
});

describe("validate — referential integrity", () => {
  test("a dangling parent ref is an error naming both ids", async () => {
    const fixture = await setupFixture(dirs);
    const orphan = await createItem(fixture);
    // Seed the dangling ref below the choke point (mutate would refuse nothing
    // here, but writeItem is how a merge delivers a record whose parent
    // never arrived).
    await writeItem(fixture.layout, { ...orphan, parent: "zzzzzzzz" }, "");

    const findings = findingsFor(await validateStore(fixture.layout), "refs.parent");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain(orphan.id);
    expect(findings[0]!.message).toContain("zzzzzzzz");
    expect(findings[0]!.fix).toBeDefined();
  });

  test("a dangling depends_on ref is an error", async () => {
    const fixture = await setupFixture(dirs);
    const item = await createItem(fixture);
    await writeItem(fixture.layout, { ...item, depends_on: ["zzzzzzzz"] }, "");

    const findings = findingsFor(await validateStore(fixture.layout), "refs.depends-on");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("zzzzzzzz");
  });

  test("a run pointing at a missing item is an error", async () => {
    const fixture = await setupFixture(dirs);
    const { makeRun } = await import("../store/helpers");
    await writeRun(fixture.layout, makeRun(fixture.env, "zzzzzzzz"));

    const findings = findingsFor(await validateStore(fixture.layout), "refs.run-item");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain("zzzzzzzz");
  });

  test("events with dangling run and item refs are errors", async () => {
    const fixture = await setupFixture(dirs);
    await appendEvent(fixture.layout, fixture.env, {
      type: "note",
      actor: fixture.agent.actor,
      item: "zzzzzzzz",
      payload: {},
      session: fixture.agent.session,
    });
    await appendEvent(fixture.layout, fixture.env, {
      type: "note",
      actor: fixture.agent.actor,
      run: "yyyyyyyy",
      payload: {},
    });

    const findings = await validateStore(fixture.layout);
    const itemRef = findingsFor(findings, "refs.event-item");
    expect(itemRef).toHaveLength(1);
    expect(itemRef[0]!.message).toContain("zzzzzzzz");
    const runRef = findingsFor(findings, "refs.event-run");
    expect(runRef).toHaveLength(1);
    expect(runRef[0]!.message).toContain("yyyyyyyy");
  });

  test("an observation whose sources name unknown event ids is an error", async () => {
    const fixture = await setupFixture(dirs);
    await writeObservation(
      fixture.layout,
      {
        id: generateId(fixture.env),
        created: fixture.env.now(),
        tags: [],
        sources: ["zzzzzzzz"],
      },
      "a fact with broken provenance\n",
    );

    const findings = findingsFor(await validateStore(fixture.layout), "refs.observation-sources");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain("zzzzzzzz");
  });
});

describe("validate — circular references", () => {
  test("a parent cycle is detected and reported once with the cycle path", async () => {
    const fixture = await setupFixture(dirs);
    const a = await createItem(fixture, { name: "cycle-a" });
    const b = await createItem(fixture, { name: "cycle-b", parent: a.id });
    await writeItem(fixture.layout, { ...a, parent: b.id }, "");

    const findings = findingsFor(await validateStore(fixture.layout), "cycle.parent");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain(a.id);
    expect(findings[0]!.message).toContain(b.id);
  });

  test("a depends_on cycle is detected and reported once", async () => {
    const fixture = await setupFixture(dirs);
    const a = await createItem(fixture, { name: "dep-a" });
    const b = await createItem(fixture, { name: "dep-b", depends_on: [a.id] });
    await writeItem(fixture.layout, { ...a, depends_on: [b.id] }, "");

    const findings = findingsFor(await validateStore(fixture.layout), "cycle.depends-on");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain(a.id);
    expect(findings[0]!.message).toContain(b.id);
  });
});

describe("validate — claim checks over the journaled history", () => {
  test("a journaled agent mutation on an item claimed at event time is a violation", async () => {
    const fixture = await setupFixture(dirs);
    const item = await createItem(fixture);

    // Human claims the item (through the choke point — humans pass).
    const claimed = { ...item, claimed_by: "jim", updated: fixture.env.now() };
    await mutate(fixture.human, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemClaimed,
      frontmatter: claimed,
      body: "",
    });

    // A merge delivers an agent mutation journaled in another worktree that
    // could not see the claim: event + record arrive together via git.
    const stomped = { ...claimed, status: "in-progress" as const, updated: fixture.env.now() };
    await appendEvent(fixture.layout, fixture.env, {
      type: CORE_EVENT_TYPES.itemUpdated,
      actor: { kind: "agent", id: "codex" },
      item: item.id,
      payload: { target: "item", record: stomped, body: "" },
      session: newSessionSegmentId(fixture.env),
    });
    await writeItem(fixture.layout, stomped, "");

    const findings = findingsFor(await validateStore(fixture.layout), "claims.violation");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain(item.id);
    expect(findings[0]!.message).toContain("jim");
    expect(findings[0]!.message).toContain("codex");
  });

  test("claim coverage extends to descendants: an agent mutation on a child of a claimed parent is a violation", async () => {
    const fixture = await setupFixture(dirs);
    const parent = await createItem(fixture, { name: "claimed-parent" });
    const child = await createItem(fixture, { name: "covered-child", parent: parent.id });

    const claimed = { ...parent, claimed_by: "jim", updated: fixture.env.now() };
    await mutate(fixture.human, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemClaimed,
      frontmatter: claimed,
      body: "",
    });

    const stomped = { ...child, status: "in-progress" as const, updated: fixture.env.now() };
    await appendEvent(fixture.layout, fixture.env, {
      type: CORE_EVENT_TYPES.itemUpdated,
      actor: { kind: "agent", id: "codex" },
      item: child.id,
      payload: { target: "item", record: stomped, body: "" },
      session: newSessionSegmentId(fixture.env),
    });
    await writeItem(fixture.layout, stomped, "");

    const findings = findingsFor(await validateStore(fixture.layout), "claims.violation");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain(child.id);
    expect(findings[0]!.message).toContain(parent.id);
  });

  test("conflicting claims after a merge — same item, different claimed_by, no handback — is an error", async () => {
    const fixture = await setupFixture(dirs);
    const item = await createItem(fixture);

    const jims = { ...item, claimed_by: "jim", updated: fixture.env.now() };
    await mutate(fixture.human, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemClaimed,
      frontmatter: jims,
      body: "",
    });

    // Bob's worktree claimed the same item before seeing jim's claim; the
    // merge brings bob's event and record in.
    const bobs = { ...item, claimed_by: "bob", updated: fixture.env.now() };
    await appendEvent(fixture.layout, fixture.env, {
      type: CORE_EVENT_TYPES.itemClaimed,
      actor: { kind: "human", id: "bob" },
      item: item.id,
      payload: { target: "item", record: bobs, body: "" },
      session: newSessionSegmentId(fixture.env),
    });
    await writeItem(fixture.layout, bobs, "");

    const findings = findingsFor(await validateStore(fixture.layout), "claims.conflict");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain(item.id);
    expect(findings[0]!.message).toContain("jim");
    expect(findings[0]!.message).toContain("bob");
  });

  test("a claim released by handback is no conflict: re-claiming by someone else is clean", async () => {
    const fixture = await setupFixture(dirs);
    const item = await createItem(fixture);

    const jims = { ...item, claimed_by: "jim", updated: fixture.env.now() };
    await mutate(fixture.human, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemClaimed,
      frontmatter: jims,
      body: "",
    });
    const released = { ...item, updated: fixture.env.now() };
    await mutate(fixture.human, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemHandback,
      frontmatter: released,
      body: "",
    });
    const bobs = { ...item, claimed_by: "bob", updated: fixture.env.now() };
    await appendEvent(fixture.layout, fixture.env, {
      type: CORE_EVENT_TYPES.itemClaimed,
      actor: { kind: "human", id: "bob" },
      item: item.id,
      payload: { target: "item", record: bobs, body: "" },
      session: newSessionSegmentId(fixture.env),
    });
    await writeItem(fixture.layout, bobs, "");

    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, "claims.conflict")).toEqual([]);
    expect(findingsFor(findings, "claims.violation")).toEqual([]);
  });
});

describe("validate — journal well-formedness", () => {
  test("a non-monotonic seq within a segment is an error naming the segment", async () => {
    const fixture = await setupFixture(dirs);
    const segment = sessionSegmentPath(fixture.layout, "s1s1s1s1");
    await writeFile(
      segment,
      rawEventLine({ id: "e1e1e1e1", seq: 1, ts: "2026-07-16T12:00:01Z" }) +
        rawEventLine({ id: "e2e2e2e2", seq: 0, ts: "2026-07-16T12:00:02Z" }),
    );

    const findings = findingsFor(await validateStore(fixture.layout), "journal.seq");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.path).toBe(segment);
    expect(findings[0]!.message).toContain("e2e2e2e2");
  });

  test("a duplicate event id across segments is an error naming both segments", async () => {
    const fixture = await setupFixture(dirs);
    await writeFile(
      sessionSegmentPath(fixture.layout, "s2s2s2s2"),
      rawEventLine({ id: "d0d0d0d0", ts: "2026-07-16T12:00:01Z" }),
    );
    await writeFile(
      sessionSegmentPath(fixture.layout, "s3s3s3s3"),
      rawEventLine({ id: "d0d0d0d0", ts: "2026-07-16T12:00:02Z" }),
    );

    const findings = findingsFor(await validateStore(fixture.layout), "journal.duplicate-id");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain("d0d0d0d0");
    expect(findings[0]!.message).toContain("session-s2s2s2s2.jsonl");
    expect(findings[0]!.message).toContain("session-s3s3s3s3.jsonl");
  });
});

describe("validate — hot-state staleness (warnings)", () => {
  test("a run without state.json is a warning (write-ahead crash window)", async () => {
    const fixture = await setupFixture(dirs);
    const item = await createItem(fixture);
    // A run journaled + written through the choke point, but hot state never
    // materialized (crash between mutate() and writeHotState).
    const { makeRun } = await import("../store/helpers");
    const run = makeRun(fixture.env, item.id);
    await mutate(fixture.agent, {
      target: "run",
      eventType: CORE_EVENT_TYPES.runStarted,
      run,
    });

    const findings = findingsFor(await validateStore(fixture.layout), "hotstate.stale");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.message).toContain(run.id);
  });

  test("hot state contradicting the run record's phase or status is a warning", async () => {
    const fixture = await setupFixture(dirs);
    const item = await createItem(fixture);
    const run = await createRun(fixture, item.id);
    const { writeHotState } = await import("../../src/store/hotstate");
    await writeHotState(fixture.layout, run.id, {
      phase: "somewhere-else",
      status: run.status,
      updated: fixture.env.now(),
    });

    const findings = findingsFor(await validateStore(fixture.layout), "hotstate.stale");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.message).toContain(run.id);
    expect(findings[0]!.message).toContain("phase");
  });
});

describe("validate — rotation and compaction overdue (warnings, thresholds from config)", () => {
  test("closed-but-unarchived segments at or past the configured threshold warn", async () => {
    const fixture = await setupFixture(dirs, {
      validate: { rotation_overdue_segments: 1 },
    });
    const item = await createItem(fixture);
    const run = await createRun(fixture, item.id);
    const closed = { ...run, status: "ended" as const, ended: fixture.env.now() };
    await mutate(fixture.agent, {
      target: "run",
      eventType: CORE_EVENT_TYPES.runEnded,
      run: closed,
    });
    const { writeHotState } = await import("../../src/store/hotstate");
    await writeHotState(fixture.layout, run.id, {
      phase: closed.phase,
      status: closed.status,
      updated: fixture.env.now(),
    });

    const findings = findingsFor(await validateStore(fixture.layout), "rotation.overdue");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.fix).toBeDefined();
  });

  test("journal growth past the configured compaction threshold warns (ADR-0004 semantic-maintenance debt)", async () => {
    const fixture = await setupFixture(dirs, {
      validate: { compaction_overdue_events: 1 },
    });
    await createItem(fixture);

    const findings = findingsFor(await validateStore(fixture.layout), "compaction.overdue");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.fix).toBeDefined();
  });

  test("sane defaults: a small clean store warns about neither", async () => {
    const fixture = await setupFixture(dirs);
    const item = await createItem(fixture);
    const run = await createRun(fixture, item.id);
    const closed = { ...run, status: "ended" as const, ended: fixture.env.now() };
    await mutate(fixture.agent, {
      target: "run",
      eventType: CORE_EVENT_TYPES.runEnded,
      run: closed,
    });
    const { writeHotState } = await import("../../src/store/hotstate");
    await writeHotState(fixture.layout, run.id, {
      phase: closed.phase,
      status: closed.status,
      updated: fixture.env.now(),
    });

    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, "rotation.overdue")).toEqual([]);
    expect(findingsFor(findings, "compaction.overdue")).toEqual([]);
  });
});

describe("validate — finding shape and determinism", () => {
  test("findings order errors before warnings and is identical across calls", async () => {
    const fixture = await setupFixture(dirs, {
      validate: { compaction_overdue_events: 1 },
    });
    const orphan = await createItem(fixture);
    await writeItem(fixture.layout, { ...orphan, parent: "zzzzzzzz" }, "");

    const first = await validateStore(fixture.layout);
    const second = await validateStore(fixture.layout);
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThanOrEqual(2);
    // Every error sorts before every warning.
    const severities = first.map((f) => f.severity);
    expect(severities.lastIndexOf("error")).toBeLessThan(severities.indexOf("warning"));
    for (const finding of first) {
      expect(["error", "warning"]).toContain(finding.severity);
      expect(finding.check.length).toBeGreaterThan(0);
      expect(finding.message.length).toBeGreaterThan(0);
    }
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CORE_EVENT_TYPES } from "../../src/schema/events";
import { generateId } from "../../src/schema/id";
import { hotStatePath } from "../../src/store/hotstate";
import {
  appendEvent,
  listSegments,
  newSessionSegmentId,
  sessionSegmentPath,
} from "../../src/store/journal";
import {
  addDistilled,
  itemPath,
  runRecordPath,
  writeItem,
  writeObservation,
  writeRun,
} from "../../src/store/layout";
import { closeStoreContext, mutate } from "../../src/store/mutate";
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

  test("a malformed run contract is reported as a schema.config error (PRD F2.1)", async () => {
    const fixture = await setupFixture(dirs);
    // A contract missing the required `seed` command is malformed.
    await writeFile(
      fixture.layout.configPath,
      [
        "knowledge:",
        "  product: PRODUCT.md",
        "  context: CONTEXT.md",
        "  adr: docs/adr",
        "actor:",
        "  kind: agent",
        "  id: claude-code",
        "contract:",
        "  launch: bun run dev",
        "  test: bun test",
        "",
      ].join("\n"),
    );
    const findings = findingsFor(await validateStore(fixture.layout), "schema.config");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain("contract.seed");
  });

  test("a routing section with a non-enum responsibility is a schema.config error (PRD F3.1)", async () => {
    const fixture = await setupFixture(dirs);
    await writeFile(
      fixture.layout.configPath,
      [
        "knowledge:",
        "  product: PRODUCT.md",
        "  context: CONTEXT.md",
        "  adr: docs/adr",
        "actor:",
        "  kind: agent",
        "  id: claude-code",
        "routing:",
        "  testing:",
        "    agent: codex",
        "",
      ].join("\n"),
    );
    const findings = findingsFor(await validateStore(fixture.layout), "schema.config");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain("testing");
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

  // PR #12 review HIGH 4: mutate() checks BOTH parent chains (current and
  // incoming), so replay must too — a journaled agent reparent INTO a claimed
  // subtree was evading claims.violation because checkClaims evaluated
  // coverage only on the pre-update chain.
  test("a journaled agent reparent INTO a claimed subtree is a violation (incoming-chain parity)", async () => {
    const fixture = await setupFixture(dirs);
    const claimedRoot = await createItem(fixture, { name: "claimed-root" });
    const stray = await createItem(fixture, { name: "stray" });

    const claimed = { ...claimedRoot, claimed_by: "jim", updated: fixture.env.now() };
    await mutate(fixture.human, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemClaimed,
      frontmatter: claimed,
      body: "",
    });

    // A merge delivers an agent mutation journaled in another worktree that
    // moves the stray item UNDER the claimed root (event + record via git).
    const reparented = { ...stray, parent: claimedRoot.id, updated: fixture.env.now() };
    await appendEvent(fixture.layout, fixture.env, {
      type: CORE_EVENT_TYPES.itemUpdated,
      actor: { kind: "agent", id: "codex" },
      item: stray.id,
      payload: { target: "item", record: reparented, body: "" },
      session: newSessionSegmentId(fixture.env),
    });
    await writeItem(fixture.layout, reparented, "");

    const findings = findingsFor(await validateStore(fixture.layout), "claims.violation");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain(stray.id);
    expect(findings[0]!.message).toContain(claimedRoot.id);
    expect(findings[0]!.message).toContain("codex");
    expect(findings[0]!.message).toContain("jim");
  });

  test("the reverse order — claim AFTER the reparent — stays clean", async () => {
    const fixture = await setupFixture(dirs);
    const futureRoot = await createItem(fixture, { name: "future-claimed-root" });
    const stray = await createItem(fixture, { name: "stray" });

    // Agent reparents first, while nothing is claimed (legitimate, mutate
    // allows it locally too).
    const reparented = { ...stray, parent: futureRoot.id, updated: fixture.env.now() };
    await mutate(fixture.agent, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemUpdated,
      frontmatter: reparented,
      body: "",
    });

    // THEN the human claims the root.
    const claimed = { ...futureRoot, claimed_by: "jim", updated: fixture.env.now() };
    await mutate(fixture.human, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemClaimed,
      frontmatter: claimed,
      body: "",
    });

    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, "claims.violation")).toEqual([]);
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

describe("validate — claim/pause coherence over current state (claims.active-run)", () => {
  // PR #12 review HIGH 3: claim journals claimed_by, then pauses covered runs
  // in a second loop. A crash between the two leaves a claimed subtree with
  // ACTIVE runs, and replay does not heal run status - validate must surface
  // it.
  test("an active run on an item covered by a claim is an error naming run, item, and claim", async () => {
    const fixture = await setupFixture(dirs);
    const parent = await createItem(fixture, { name: "claimed-parent" });
    const child = await createItem(fixture, { name: "covered-child", parent: parent.id });
    const run = await createRun(fixture, child.id); // active

    // The claim lands (journal + record)...
    const claimed = { ...parent, claimed_by: "jim", updated: fixture.env.now() };
    await mutate(fixture.human, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemClaimed,
      frontmatter: claimed,
      body: "",
    });
    // ...and the process dies before the pause loop: the run stays active.

    const findings = findingsFor(await validateStore(fixture.layout), "claims.active-run");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain(run.id);
    expect(findings[0]!.message).toContain(child.id);
    expect(findings[0]!.message).toContain(parent.id);
    expect(findings[0]!.message).toContain("jim");
    expect(findings[0]!.fix).toContain(`nahel pause ${run.id}`);
  });

  test("a directly-claimed item with its own active run is an error too", async () => {
    const fixture = await setupFixture(dirs);
    const item = await createItem(fixture);
    const run = await createRun(fixture, item.id);
    const claimed = { ...item, claimed_by: "jim", updated: fixture.env.now() };
    await mutate(fixture.human, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemClaimed,
      frontmatter: claimed,
      body: "",
    });

    const findings = findingsFor(await validateStore(fixture.layout), "claims.active-run");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain(run.id);
  });

  test("a completed claim (covered runs paused) reports nothing", async () => {
    const fixture = await setupFixture(dirs);
    const parent = await createItem(fixture, { name: "claimed-parent" });
    const child = await createItem(fixture, { name: "covered-child", parent: parent.id });
    const run = await createRun(fixture, child.id);

    const claimed = { ...parent, claimed_by: "jim", updated: fixture.env.now() };
    await mutate(fixture.human, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemClaimed,
      frontmatter: claimed,
      body: "",
    });
    // The pause loop completed: the covered run is paused, hot state follows.
    const paused = { ...run, status: "paused" as const };
    await mutate(fixture.human, {
      target: "run",
      eventType: CORE_EVENT_TYPES.runPaused,
      run: paused,
    });
    const { writeHotState } = await import("../../src/store/hotstate");
    await writeHotState(fixture.layout, run.id, {
      phase: paused.phase,
      status: paused.status,
      updated: fixture.env.now(),
    });

    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, "claims.active-run")).toEqual([]);
  });

  test("an ended run under a claim reports nothing, and active runs elsewhere stay clean", async () => {
    const fixture = await setupFixture(dirs);
    const claimedItem = await createItem(fixture, { name: "claimed" });
    const freeItem = await createItem(fixture, { name: "free" });
    // Ended run under the claim; active run OUTSIDE the claim.
    const endedRun = await createRun(fixture, claimedItem.id);
    const closed = { ...endedRun, status: "ended" as const, ended: fixture.env.now() };
    await mutate(fixture.agent, {
      target: "run",
      eventType: CORE_EVENT_TYPES.runEnded,
      run: closed,
    });
    const { writeHotState } = await import("../../src/store/hotstate");
    await writeHotState(fixture.layout, endedRun.id, {
      phase: closed.phase,
      status: closed.status,
      updated: fixture.env.now(),
    });
    await createRun(fixture, freeItem.id);

    const claimed = { ...claimedItem, claimed_by: "jim", updated: fixture.env.now() };
    await mutate(fixture.human, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemClaimed,
      frontmatter: claimed,
      body: "",
    });

    const findings = findingsFor(await validateStore(fixture.layout), "claims.active-run");
    expect(findings).toEqual([]);
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

  test("un-distilled archived events at or past compaction.max_events warn, naming the compact workflow (F6.2)", async () => {
    const fixture = await setupFixture(dirs, { compaction: { max_events: 1 } });
    await createItem(fixture);
    // Close this invocation's session segment and let the sweep archive it.
    await closeStoreContext(fixture.agent);
    expect((await listSegments(fixture.layout)).archived).toHaveLength(1);

    const findings = findingsFor(await validateStore(fixture.layout), "compaction.overdue");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.message).toContain("un-distilled");
    expect(findings[0]!.fix).toContain("nahel/workflows/compact.md");
    expect(findings[0]!.fix).toContain("nahel observe");
    expect(findings[0]!.fix).toContain("nahel distill");
  });

  test("segments listed in distilled.json stop counting: marking the archive distilled clears the warning", async () => {
    const fixture = await setupFixture(dirs, { compaction: { max_events: 1 } });
    await createItem(fixture);
    await closeStoreContext(fixture.agent);
    const { archived } = await listSegments(fixture.layout);
    await addDistilled(fixture.layout, archived);

    const findings = findingsFor(await validateStore(fixture.layout), "compaction.overdue");
    expect(findings).toEqual([]);
  });

  test("active-segment events are never compaction debt (only the archive is distillable)", async () => {
    const fixture = await setupFixture(dirs, { compaction: { max_events: 1 } });
    await createItem(fixture); // events sit in the still-active session segment

    const findings = findingsFor(await validateStore(fixture.layout), "compaction.overdue");
    expect(findings).toEqual([]);
  });

  test("age past compaction.max_age_days warns even when the count is small — and distilling clears it", async () => {
    const fixture = await setupFixture(dirs, { compaction: { max_age_days: 30 } });
    await createItem(fixture); // events at 2026-07-16
    await closeStoreContext(fixture.agent);

    // 35 days later: over the 30-day threshold.
    const overdue = findingsFor(
      await validateStore(fixture.layout, { now: "2026-08-20T12:00:00Z" }),
      "compaction.overdue",
    );
    expect(overdue).toHaveLength(1);
    expect(overdue[0]!.severity).toBe("warning");
    expect(overdue[0]!.message).toContain("day");
    expect(overdue[0]!.fix).toContain("nahel/workflows/compact.md");

    // 4 days later: quiet.
    const fresh = findingsFor(
      await validateStore(fixture.layout, { now: "2026-07-20T12:00:00Z" }),
      "compaction.overdue",
    );
    expect(fresh).toEqual([]);

    // Distilled: quiet regardless of age.
    await addDistilled(fixture.layout, (await listSegments(fixture.layout)).archived);
    const distilled = findingsFor(
      await validateStore(fixture.layout, { now: "2026-08-20T12:00:00Z" }),
      "compaction.overdue",
    );
    expect(distilled).toEqual([]);
  });

  test("without an injected now the age check is skipped; the count threshold still enforces", async () => {
    const fixture = await setupFixture(dirs, { compaction: { max_age_days: 1 } });
    await createItem(fixture);
    await closeStoreContext(fixture.agent);

    expect(findingsFor(await validateStore(fixture.layout), "compaction.overdue")).toEqual([]);
  });

  test("shipped defaults: 200 un-distilled archived events or 30 days of age (PRD F6.2)", async () => {
    const fixture = await setupFixture(dirs);
    // Raw-seed one archived segment with exactly 199 valid note events.
    const lines: string[] = [];
    for (let seq = 0; seq < 199; seq++) {
      lines.push(rawEventLine({ id: generateId(fixture.env), seq }).trimEnd());
    }
    const name = `session-${generateId(fixture.env)}.jsonl`;
    await writeFile(join(fixture.layout.journalArchiveDir, name), `${lines.join("\n")}\n`);

    const now = "2026-07-20T12:00:00Z"; // 4 days after the seeded events
    const under = findingsFor(
      await validateStore(fixture.layout, { now }),
      "compaction.overdue",
    );
    expect(under).toEqual([]);

    // One more event tips the count to 200.
    await writeFile(
      join(fixture.layout.journalArchiveDir, name),
      `${lines.join("\n")}\n${rawEventLine({ id: generateId(fixture.env), seq: 199 })}`,
    );
    const atCount = findingsFor(
      await validateStore(fixture.layout, { now }),
      "compaction.overdue",
    );
    expect(atCount).toHaveLength(1);
    expect(atCount[0]!.message).toContain("200");

    // Age alone: 31 days after the oldest event, count back under threshold.
    await writeFile(
      join(fixture.layout.journalArchiveDir, name),
      `${rawEventLine({ id: generateId(fixture.env), seq: 0 })}`,
    );
    const aged = findingsFor(
      await validateStore(fixture.layout, { now: "2026-08-16T12:00:01Z" }),
      "compaction.overdue",
    );
    expect(aged).toHaveLength(1);
    expect(aged[0]!.message).toContain("30");
  });

  test("a malformed distilled.json is a schema error and mutes the compaction check (no double report)", async () => {
    const fixture = await setupFixture(dirs, { compaction: { max_events: 1 } });
    await createItem(fixture);
    await closeStoreContext(fixture.agent);
    await writeFile(fixture.layout.distilledPath, "not json\n");

    const findings = await validateStore(fixture.layout);
    const schema = findingsFor(findings, "schema.distilled");
    expect(schema).toHaveLength(1);
    expect(schema[0]!.severity).toBe("error");
    expect(schema[0]!.path).toBe(fixture.layout.distilledPath);
    expect(findingsFor(findings, "compaction.overdue")).toEqual([]);
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

describe("validate — mutation detection keys on event type, not payload shape", () => {
  // PR #12 review blocker: checkDivergence/checkClaims duck-typed any event
  // whose payload carried target+record as a mutation, so `nahel log note
  // --data '{"target":"item",...}'` (or a rogue writer's hand-appended JSONL
  // line) forged a "latest mutation" — validate flagged journal.divergence
  // and --repair overwrote the real record with the forged payload. Only
  // core mutation event types are mutations; a mutation-shaped payload under
  // any other type is inert data.
  test("a hand-appended note event with a forged item payload: no divergence, repair is a no-op", async () => {
    const fixture = await setupFixture(dirs);
    const item = await createItem(fixture, {}, "the real body\n");

    // Rogue writer: the raw JSONL line lands directly in a session segment,
    // one wall-clock second AFTER the real creation — shape-keyed detection
    // would crown it the latest mutation for this item.
    const forged = { ...item, status: "done" as const, updated: "2026-07-16T12:30:00Z" };
    await writeFile(
      sessionSegmentPath(fixture.layout, "f0f0f0f0"),
      rawEventLine({
        id: "f1f1f1f1",
        ts: "2026-07-16T12:30:00Z",
        type: "note",
        item: item.id,
        payload: { target: "item", record: forged, body: "forged body\n" },
      }),
    );

    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, "journal.divergence")).toEqual([]);
    expect(findingsFor(findings, "journal.payload")).toEqual([]);

    // --repair path: nothing pending, the real record survives untouched.
    const { replayPending } = await import("../../src/store/mutate");
    expect(await replayPending(fixture.layout)).toEqual([]);
    const { readItem } = await import("../../src/store/layout");
    const disk = await readItem(fixture.layout, item.id);
    expect(disk.frontmatter).toEqual(item);
    expect(disk.body).toBe("the real body\n");
  });

  test("a forged run payload under an open-extension type is no divergence either", async () => {
    const fixture = await setupFixture(dirs);
    const item = await createItem(fixture);
    const run = await createRun(fixture, item.id);

    const forged = { ...run, status: "ended" as const, ended: "2026-07-16T12:30:00Z" };
    await writeFile(
      sessionSegmentPath(fixture.layout, "f2f2f2f2"),
      rawEventLine({
        id: "f3f3f3f3",
        ts: "2026-07-16T12:30:00Z",
        type: "deploy.finished",
        item: item.id,
        payload: { target: "run", record: forged },
      }),
    );

    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, "journal.divergence")).toEqual([]);
    const { replayPending } = await import("../../src/store/mutate");
    expect(await replayPending(fixture.layout)).toEqual([]);
  });

  test("an agent note with a mutation-shaped payload registers no claim and violates none", async () => {
    const fixture = await setupFixture(dirs);
    const item = await createItem(fixture);

    // Human claims the item through the choke point.
    const claimed = { ...item, claimed_by: "jim", updated: fixture.env.now() };
    await mutate(fixture.human, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemClaimed,
      frontmatter: claimed,
      body: "",
    });

    // An agent's note carries a mutation-shaped payload echoing the item with
    // a DIFFERENT claimant. It is not a mutation: it neither trips
    // claims.violation (agent "mutating" a claimed item) nor registers
    // mallory's claim for claims.conflict.
    const forged = { ...claimed, claimed_by: "mallory", updated: "2026-07-16T12:30:00Z" };
    await writeFile(
      sessionSegmentPath(fixture.layout, "f4f4f4f4"),
      rawEventLine({
        id: "f5f5f5f5",
        ts: "2026-07-16T12:30:00Z",
        type: "note",
        item: item.id,
        payload: { target: "item", record: forged, body: "" },
      }),
    );

    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, "claims.violation")).toEqual([]);
    expect(findingsFor(findings, "claims.conflict")).toEqual([]);
    expect(findingsFor(findings, "journal.divergence")).toEqual([]);
  });
});

describe("validate — finding shape and determinism", () => {
  test("findings order errors before warnings and is identical across calls", async () => {
    const fixture = await setupFixture(dirs, { compaction: { max_events: 1 } });
    const orphan = await createItem(fixture);
    await closeStoreContext(fixture.agent); // archived events: the compaction warning
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

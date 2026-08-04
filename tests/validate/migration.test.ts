import { afterEach, describe, expect, test } from "bun:test";
import {
  CORE_EVENT_TYPES,
  MIGRATION_ATTRIBUTION_PAYLOAD_KEY,
  MIGRATION_SELECTED_EVENT_TYPE,
} from "../../src/schema/events";
import { generateId } from "../../src/schema/id";
import type { JournalEvent, RoadmapNodeFrontmatter } from "../../src/schema/records";
import { appendEvent } from "../../src/store/journal";
import { mutate } from "../../src/store/mutate";
import { validateStore } from "../../src/validate";
import {
  createItem,
  findingsFor,
  setupFixture,
  signConstitution,
  type ValidateFixture,
} from "./helpers";

/**
 * The migration audit (PR #26 follow-up C2). A migration is the one act whose
 * whole value is that it can be read back, and until now nothing in the store
 * joined the journaled SELECTION to the nodes that were supposed to cover it —
 * a reviewer had to eyeball two lists. The audit does the join, and it fires
 * only in a store that has a selection event at all: a store that never
 * migrated has nothing to audit and earns no finding.
 *
 * Attribution is what makes the join possible: a migration-created node's
 * `roadmap.node-created` event carries `migration=<selection-event-id>`, and
 * ordinary charting afterwards carries nothing — so later nodes are invisible
 * to the audit by construction rather than by a date heuristic.
 */

const CHECK = "roadmap.migration-audit";

let dirs: string[] = [];

afterEach(async () => {
  dirs = [];
});

async function setup(): Promise<ValidateFixture> {
  const fixture = await setupFixture(dirs);
  await signConstitution(fixture);
  return fixture;
}

/** Journal a selection set exactly as `nahel log` does (an open-extension type). */
async function selection(
  fixture: ValidateFixture,
  included: readonly string[],
  excluded: readonly { id: string; reason: string }[] = [],
): Promise<JournalEvent> {
  return appendEvent(fixture.layout, fixture.env, {
    type: MIGRATION_SELECTED_EVENT_TYPE,
    actor: fixture.agent.actor,
    session: fixture.agent.session,
    payload: { included, excluded },
  });
}

/**
 * Create a node through the choke point. `migration` attributes it to a
 * selection — the ONE thing that makes it the migration's node rather than a
 * later charting act's.
 */
async function createNode(
  fixture: ValidateFixture,
  overrides: Partial<RoadmapNodeFrontmatter> = {},
  migration?: string,
): Promise<RoadmapNodeFrontmatter> {
  const ts = fixture.env.now();
  const frontmatter: RoadmapNodeFrontmatter = {
    id: generateId(fixture.env),
    name: `node-${overrides.epic ?? "x"}`,
    kind: "feature",
    horizon: "now",
    adrs: [],
    features: [],
    created: ts,
    updated: ts,
    ...overrides,
  };
  await mutate(fixture.agent, {
    target: "roadmap-node",
    eventType: CORE_EVENT_TYPES.roadmapNodeCreated,
    frontmatter,
    body: "intent\n",
    ...(migration === undefined
      ? {}
      : { extraPayload: { [MIGRATION_ATTRIBUTION_PAYLOAD_KEY]: migration } }),
  });
  return frontmatter;
}

async function findings(fixture: ValidateFixture) {
  return findingsFor(await validateStore(fixture.layout), CHECK);
}

/** A migration that covered exactly what it declared: two ids, two nodes. */
async function cleanMigration(fixture: ValidateFixture) {
  const covered = await createItem(fixture, { name: "one" });
  const alsoCovered = await createItem(fixture, { name: "two" });
  const nearMiss = await createItem(fixture, { name: "a-defect", type: "bug" });
  const event = await selection(
    fixture,
    [covered.id, alsoCovered.id],
    [{ id: nearMiss.id, reason: "a defect in shipped behaviour is work, not roadmap intent" }],
  );
  const first = await createNode(fixture, { epic: covered.id, name: "one" }, event.id);
  const second = await createNode(fixture, { epic: alsoCovered.id, name: "two" }, event.id);
  return { event, covered, alsoCovered, nearMiss, first, second };
}

describe("the migration audit fires only where a migration happened (C2)", () => {
  test("a store that never migrated earns no finding at all", async () => {
    const fixture = await setup();
    const item = await createItem(fixture, { name: "unmigrated" });
    await createNode(fixture, { epic: item.id });
    expect(await findings(fixture)).toEqual([]);
  });

  test("a migration whose nodes cover its declared set exactly is clean", async () => {
    const fixture = await setup();
    await cleanMigration(fixture);
    expect(await findings(fixture)).toEqual([]);
  });

  test("nodes charted LATER, carrying no attribution, are ignored entirely", async () => {
    const fixture = await setup();
    await cleanMigration(fixture);
    // Ordinary charting after the migration: a node for an item the selection
    // never named. It is not the migration's, so the audit says nothing.
    const later = await createItem(fixture, { name: "charted-later" });
    await createNode(fixture, { epic: later.id, name: "later" });
    expect(await findings(fixture)).toEqual([]);
  });
});

describe("coverage: the declared set and the attributed nodes must match exactly (C2)", () => {
  test("an included id with no attributed node is an error naming the id", async () => {
    const fixture = await setup();
    const covered = await createItem(fixture, { name: "one" });
    const uncovered = await createItem(fixture, { name: "two" });
    const event = await selection(fixture, [covered.id, uncovered.id]);
    await createNode(fixture, { epic: covered.id, name: "one" }, event.id);
    const found = await findings(fixture);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("error");
    expect(found[0]!.message).toContain(uncovered.id);
    expect(found[0]!.message).toContain(event.id);
  });

  test("two attributed nodes covering one included id is an error naming both", async () => {
    const fixture = await setup();
    const covered = await createItem(fixture, { name: "one" });
    const event = await selection(fixture, [covered.id]);
    const first = await createNode(fixture, { epic: covered.id, name: "one" }, event.id);
    const second = await createNode(fixture, { epic: covered.id, name: "one-again" }, event.id);
    const found = await findings(fixture);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("error");
    expect(found[0]!.message).toContain(first.id);
    expect(found[0]!.message).toContain(second.id);
  });

  test("an attributed node covering an EXCLUDED id is an error — the near-miss was ruled out", async () => {
    const fixture = await setup();
    const covered = await createItem(fixture, { name: "one" });
    const nearMiss = await createItem(fixture, { name: "a-chore", type: "chore" });
    const event = await selection(
      fixture,
      [covered.id],
      [{ id: nearMiss.id, reason: "a chore is work, not roadmap intent" }],
    );
    await createNode(fixture, { epic: covered.id, name: "one" }, event.id);
    const stray = await createNode(fixture, { epic: nearMiss.id, name: "stray" }, event.id);
    const found = await findings(fixture);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("error");
    expect(found[0]!.message).toContain(stray.id);
    expect(found[0]!.message).toContain(nearMiss.id);
    expect(found[0]!.message).toContain("excluded");
  });

  test("an attributed node covering an id the set never listed is an error", async () => {
    const fixture = await setup();
    const covered = await createItem(fixture, { name: "one" });
    const unlisted = await createItem(fixture, { name: "invented" });
    const event = await selection(fixture, [covered.id]);
    await createNode(fixture, { epic: covered.id, name: "one" }, event.id);
    const stray = await createNode(fixture, { epic: unlisted.id, name: "stray" }, event.id);
    const found = await findings(fixture);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain(stray.id);
    expect(found[0]!.message).toContain(unlisted.id);
  });

  test("an attributed node naming NO epic covers nothing, and is reported as itself", async () => {
    const fixture = await setup();
    const covered = await createItem(fixture, { name: "one" });
    const event = await selection(fixture, [covered.id]);
    const orphan = await createNode(fixture, { name: "orphan" }, event.id);
    const found = await findings(fixture);
    // Two facts: the node covers nothing, and the included id has no node.
    expect(found).toHaveLength(2);
    expect(found.map((finding) => finding.message).join("\n")).toContain(orphan.id);
    expect(found.map((finding) => finding.message).join("\n")).toContain(covered.id);
  });

  test("an attributed node that is not a FEATURE is an error — a product node covers no epic", async () => {
    const fixture = await setup();
    const covered = await createItem(fixture, { name: "one" });
    const event = await selection(fixture, [covered.id]);
    const wrongKind = await createNode(
      fixture,
      { epic: covered.id, name: "one", kind: "product" },
      event.id,
    );
    const found = await findings(fixture);
    // Two facts again: the node is the wrong kind, and — because a product
    // node covers no item — the included id is left with no node at all.
    expect(found).toHaveLength(2);
    const messages = found.map((finding) => finding.message).join("\n");
    expect(messages).toContain(wrongKind.id);
    expect(messages).toContain("product");
    expect(messages).toContain(covered.id);
  });
});

describe("the ordering the migration rests on is audited, not assumed (C2)", () => {
  test("a node created in the SAME SECOND as the selection fails — a tie proves nothing", async () => {
    // A frozen clock: every act shares one timestamp, exactly the same-second
    // tie the workflow says fails a migration (rendered order breaks on the
    // random event id, so it renders correctly about half the time).
    const fixture = await setupFixture(dirs);
    await signConstitution(fixture);
    // The store context carries its OWN env — the one every journal event's ts
    // comes from — so freezing the fixture's alone would leave the events
    // ticking a second apart and prove nothing.
    const env = { ...fixture.env, now: () => "2026-07-16T12:00:00Z" };
    const frozen = { ...fixture, env, agent: { ...fixture.agent, env } };
    const covered = await createItem(frozen, { name: "one" });
    const event = await selection(frozen, [covered.id]);
    const node = await createNode(frozen, { epic: covered.id, name: "one" }, event.id);
    const found = await findings(fixture);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("error");
    expect(found[0]!.message).toContain(node.id);
    expect(found[0]!.message).toContain("same second");
  });
});

describe("the selection payload itself is audited (C2)", () => {
  test("a duplicated included id is an error — the set is a set", async () => {
    const fixture = await setup();
    const covered = await createItem(fixture, { name: "one" });
    const event = await selection(fixture, [covered.id, covered.id]);
    await createNode(fixture, { epic: covered.id, name: "one" }, event.id);
    const found = await findings(fixture);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain(covered.id);
    expect(found[0]!.message).toContain("more than once");
  });

  test("an id both included and excluded is an error — the call contradicts itself", async () => {
    const fixture = await setup();
    const covered = await createItem(fixture, { name: "one" });
    const event = await selection(fixture, [covered.id], [{ id: covered.id, reason: "unsure" }]);
    await createNode(fixture, { epic: covered.id, name: "one" }, event.id);
    const found = await findings(fixture);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain(covered.id);
    expect(found[0]!.message).toContain("both included and excluded");
  });

  test("a near-miss with a blank reason is an error — an omission nobody can argue with", async () => {
    const fixture = await setup();
    const covered = await createItem(fixture, { name: "one" });
    const nearMiss = await createItem(fixture, { name: "two" });
    const event = await selection(fixture, [covered.id], [{ id: nearMiss.id, reason: "   " }]);
    await createNode(fixture, { epic: covered.id, name: "one" }, event.id);
    const found = await findings(fixture);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain(nearMiss.id);
    expect(found[0]!.message).toContain("reason");
  });

  test("a payload that carries no included list at all is an error", async () => {
    const fixture = await setup();
    await appendEvent(fixture.layout, fixture.env, {
      type: MIGRATION_SELECTED_EVENT_TYPE,
      actor: fixture.agent.actor,
      session: fixture.agent.session,
      payload: { excluded: [] },
    });
    const found = await findings(fixture);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("error");
    expect(found[0]!.message).toContain("included");
  });
});

describe("two active selections suspend the coverage audit (C2)", () => {
  test("exactly one error, and the uncovered ids of neither attempt are reported", async () => {
    const fixture = await setup();
    const covered = await createItem(fixture, { name: "one" });
    const uncovered = await createItem(fixture, { name: "two" });
    const first = await selection(fixture, [covered.id, uncovered.id]);
    await createNode(fixture, { epic: covered.id, name: "one" }, first.id);
    const second = await selection(fixture, [covered.id]);
    const found = await findings(fixture);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("error");
    expect(found[0]!.message).toContain(first.id);
    expect(found[0]!.message).toContain(second.id);
    // The suspended half: the first attempt's uncovered id is NOT reported,
    // because which attempt owns it is exactly what is ambiguous.
    expect(found[0]!.message).not.toContain(uncovered.id);
  });

  test("a superseded selection is not active, so one supersession restores the audit", async () => {
    const fixture = await setup();
    const covered = await createItem(fixture, { name: "one" });
    const first = await selection(fixture, [covered.id]);
    const second = await selection(fixture, [covered.id]);
    await appendEvent(fixture.layout, fixture.env, {
      type: CORE_EVENT_TYPES.migrationSuperseded,
      actor: fixture.agent.actor,
      session: fixture.agent.session,
      payload: { selection: first.id, reason: "the first attempt was tainted", nodes: [] },
    });
    await createNode(fixture, { epic: covered.id, name: "one" }, second.id);
    expect(await findings(fixture)).toEqual([]);
  });
});

/**
 * The compatibility rule (C2's legacy clause), pinned against the shape this
 * repo's OWN live migration has: a `roadmap.migration-selected` event whose
 * nodes were created BEFORE attribution existed, so not one of them carries a
 * `migration` payload.
 *
 * Codex's rule — unattributed nodes are ignored — would report every included
 * id as uncovered and turn a real, correct migration permanently red. The
 * deliberate answer is that ZERO attributed nodes is not evidence of a broken
 * migration at all: it is either an attempt that predates attribution, or one
 * whose nodes have not been created yet (the workflow journals the set FIRST).
 * Both earn one advisory warning and no errors, and neither is repaired by
 * re-migrating.
 */
describe("a migration that predates attribution is history, not a failure (C2)", () => {
  test("a selection with no attributed node anywhere: one warning, zero errors", async () => {
    const fixture = await setup();
    const covered = await createItem(fixture, { name: "one" });
    const alsoCovered = await createItem(fixture, { name: "two" });
    const event = await selection(fixture, [covered.id, alsoCovered.id]);
    // Nodes exactly as the live migration made them — no attribution payload.
    await createNode(fixture, { epic: covered.id, name: "one" });
    await createNode(fixture, { epic: alsoCovered.id, name: "two" });
    const found = await findings(fixture);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("warning");
    expect(found[0]!.message).toContain(event.id);
    expect(found[0]!.message).toContain("attribut");
  });

  test("the whole store still validates: a legacy migration fails nothing", async () => {
    const fixture = await setup();
    const covered = await createItem(fixture, { name: "one" });
    await selection(fixture, [covered.id]);
    await createNode(fixture, { epic: covered.id, name: "one" });
    const errors = (await validateStore(fixture.layout)).filter(
      (finding) => finding.severity === "error",
    );
    expect(errors).toEqual([]);
  });

  test("but a PARTIALLY attributed attempt is audited in full — one node is attribution", async () => {
    const fixture = await setup();
    const covered = await createItem(fixture, { name: "one" });
    const uncovered = await createItem(fixture, { name: "two" });
    const event = await selection(fixture, [covered.id, uncovered.id]);
    await createNode(fixture, { epic: covered.id, name: "one" }, event.id);
    await createNode(fixture, { epic: uncovered.id, name: "two" });
    const found = await findings(fixture);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("error");
    expect(found[0]!.message).toContain(uncovered.id);
  });
});

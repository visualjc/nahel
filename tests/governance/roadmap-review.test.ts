import { describe, expect, test } from "bun:test";
import {
  AWAITING_ROADMAP_NODE_CAP,
  awaitingRoadmapReview,
} from "../../src/governance/roadmap-review";
import { CORE_EVENT_TYPES, ROADMAP_ACKED_EVENT_TYPE } from "../../src/schema/events";
import type { Actor, Governance, JournalEvent } from "../../src/schema/records";

/**
 * Awaiting-your-eyes (Phase 4 F5): agent-attributed roadmap acts the human has
 * not looked at yet. Visibility, not enforcement — nothing here refuses
 * anything; it decides what `nahel brief` says.
 *
 * Four rules the rest of the codebase must never answer twice:
 *   1. Under `governance.product: agent` — and for an AGENT reader — there is
 *      NO surface at all: the agent-as-PO owns the roadmap outright (ADR-0008
 *      as amended 2026-08-01), and the line is for a human's eyes.
 *   2. The window opens at the READER's last recorded act of any type — they
 *      were here then — and advances to any later human-attributed roadmap act
 *      by anyone (a node created or updated, or `nahel roadmap ack`). A reader
 *      with no recorded activity at all has no window, and so no line.
 *   3. Provenance is read from the journal, exactly as merge authority reads
 *      it: an ack run under an agent actor clears nothing.
 *   4. Same-second acts fail SAFE, and safe here means visible: a human act
 *      and an agent act in the same second are ordered by a lottery (each CLI
 *      invocation mints its own session segment), so the agent act stays
 *      raised rather than being hidden by an order nobody chose.
 */

const HUMAN: Actor = { kind: "human", id: "jim" };
const AGENT: Actor = { kind: "agent", id: "claude-code" };

let counter = 0;

/** One roadmap-node mutation, carrying the record payload mutate() journals. */
function nodeEvent(
  ts: string,
  actor: Actor,
  node: { id: string; name: string },
  type: string = CORE_EVENT_TYPES.roadmapNodeUpdated,
): JournalEvent {
  counter += 1;
  return {
    id: `evnt${String(counter).padStart(4, "0")}`,
    ts,
    seq: 0,
    type,
    actor,
    payload: { target: "roadmap-node", record: { id: node.id, name: node.name }, body: "x\n" },
  };
}

/** One `nahel roadmap ack` act — no node payload at all. */
function ackEvent(ts: string, actor: Actor): JournalEvent {
  counter += 1;
  return {
    id: `ackev${String(counter).padStart(4, "0")}`,
    ts,
    seq: 0,
    type: ROADMAP_ACKED_EVENT_TYPE,
    actor,
    payload: {},
  };
}

const HUMAN_MODES: Governance["product"][] = ["human", "delegated"];

describe("awaitingRoadmapReview — the surface exists only where a human owns product", () => {
  test("under governance.product: agent there is NO surface, however much the agent moved", () => {
    const events = [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:00Z", AGENT, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:01Z", AGENT, { id: "n2", name: "beta" }),
    ];
    expect(
      awaitingRoadmapReview({ product: "agent", architecture: "human" }, HUMAN, events),
    ).toBeUndefined();
  });

  test.each(HUMAN_MODES)("under governance.product: %s the agent's acts await the human", (product) => {
    const events = [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:00Z", AGENT, { id: "n1", name: "alpha" }),
    ];
    const status = awaitingRoadmapReview({ product, architecture: "human" }, HUMAN, events)!;
    expect(status).toBeDefined();
    expect(status.changes).toBe(1);
    expect(status.nodes).toEqual([{ id: "n1", name: "alpha" }]);
    expect(status.more).toBe(0);
    expect(status.since).toBe("2026-08-01T10:00:00Z");
  });

  test("no governance config resolves to delegated on product — the surface is on by default", () => {
    const events = [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:00Z", AGENT, { id: "n1", name: "alpha" }),
    ];
    expect(awaitingRoadmapReview(undefined, HUMAN, events)!.changes).toBe(1);
  });

  test("an AGENT reader gets no surface at all — the line is for a human's eyes", () => {
    const events = [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:00Z", AGENT, { id: "n1", name: "alpha" }),
    ];
    expect(awaitingRoadmapReview(undefined, AGENT, events)).toBeUndefined();
  });
});

/**
 * The baseline is the READER's (F5: "for the reading actor … since that
 * actor's last recorded activity"). A human who has been working in this repo —
 * on items, on runs, on anything — was HERE at their last act, so agent roadmap
 * work after it is work they have not seen, whether or not they have ever
 * touched a roadmap node. Requiring a prior ROADMAP act would hide exactly the
 * case the surface exists for: a human returning to twenty nodes agents built
 * AFK.
 */
describe("awaitingRoadmapReview — the reader's own last act opens the window", () => {
  /** One act by the reader that has nothing to do with the roadmap. */
  function otherEvent(ts: string, actor: Actor, type = "item.updated"): JournalEvent {
    counter += 1;
    return {
      id: `othr${String(counter).padStart(4, "0")}`,
      ts,
      seq: 0,
      type,
      actor,
      payload: { target: "item" },
    };
  }

  test("a human with only NON-roadmap activity sees what agents built after it", () => {
    const events = [
      otherEvent("2026-08-01T09:00:00Z", HUMAN),
      nodeEvent("2026-08-01T10:00:00Z", AGENT, { id: "n1", name: "alpha" }, CORE_EVENT_TYPES.roadmapNodeCreated),
      nodeEvent("2026-08-01T10:00:01Z", AGENT, { id: "n2", name: "beta" }, CORE_EVENT_TYPES.roadmapNodeCreated),
    ];
    const status = awaitingRoadmapReview(undefined, HUMAN, events)!;
    expect(status.changes).toBe(2);
    expect(status.nodes.map((node) => node.name)).toEqual(["alpha", "beta"]);
    expect(status.since).toBe("2026-08-01T09:00:00Z");
  });

  test("a reader with NO recorded activity at all sees nothing — the true first touch", () => {
    // Another human's roadmap act is not this reader's baseline: they have
    // never been here, so there is no "since your last touch" to state.
    const newcomer: Actor = { kind: "human", id: "newcomer" };
    const events = [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:00Z", AGENT, { id: "n1", name: "alpha" }),
    ];
    expect(awaitingRoadmapReview(undefined, newcomer, events)).toBeUndefined();
  });

  test("the reader is matched by identity, not by kind — another human's acts are not theirs", () => {
    const ana: Actor = { kind: "human", id: "ana" };
    const events = [
      otherEvent("2026-08-01T09:00:00Z", ana),
      nodeEvent("2026-08-01T10:00:00Z", AGENT, { id: "n1", name: "alpha" }),
    ];
    expect(awaitingRoadmapReview(undefined, HUMAN, events)).toBeUndefined();
    expect(awaitingRoadmapReview(undefined, ana, events)!.changes).toBe(1);
  });

  test("ANY human's roadmap act advances the baseline — clearing stays everyone's act", () => {
    const ana: Actor = { kind: "human", id: "ana" };
    const events = [
      otherEvent("2026-08-01T09:00:00Z", HUMAN),
      nodeEvent("2026-08-01T10:00:00Z", AGENT, { id: "n1", name: "alpha" }),
      // Ana looks at the roadmap and re-horizons the node jim never saw move.
      nodeEvent("2026-08-01T11:00:00Z", ana, { id: "n1", name: "alpha" }),
    ];
    expect(awaitingRoadmapReview(undefined, HUMAN, events)).toBeUndefined();

    const status = awaitingRoadmapReview(undefined, HUMAN, [
      ...events,
      nodeEvent("2026-08-01T12:00:00Z", AGENT, { id: "n2", name: "beta" }),
    ])!;
    expect(status.changes).toBe(1);
    expect(status.since).toBe("2026-08-01T11:00:00Z");
  });

  test("the baseline never moves BACKWARD: an older act of the reader's cannot undo a clear", () => {
    const events = [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:00Z", AGENT, { id: "n1", name: "alpha" }),
      ackEvent("2026-08-01T12:00:00Z", HUMAN),
      // Out of order on purpose: the LATEST of the reader's acts is the ack.
      otherEvent("2026-08-01T09:00:00Z", HUMAN),
    ];
    expect(awaitingRoadmapReview(undefined, HUMAN, events)).toBeUndefined();
  });

  test("the same-second inversion holds against the reader's own baseline too", () => {
    const events = [
      otherEvent("2026-08-01T09:00:00Z", HUMAN),
      nodeEvent("2026-08-01T09:00:00Z", AGENT, { id: "n1", name: "alpha" }),
    ];
    expect(awaitingRoadmapReview(undefined, HUMAN, events)!.changes).toBe(1);
  });
});

describe("awaitingRoadmapReview — any human's roadmap act clears it", () => {
  test("a reader who has never acted at all sees nothing — absent, not an empty header", () => {
    // Agents built the whole roadmap and this human has never been here, so
    // there is no "your last touch" to measure `since` against.
    const events = [
      nodeEvent("2026-08-01T10:00:00Z", AGENT, { id: "n1", name: "alpha" }, CORE_EVENT_TYPES.roadmapNodeCreated),
      nodeEvent("2026-08-01T10:00:01Z", AGENT, { id: "n2", name: "beta" }, CORE_EVENT_TYPES.roadmapNodeCreated),
    ];
    expect(awaitingRoadmapReview(undefined, HUMAN, events)).toBeUndefined();
  });

  test("with nothing agent-authored since the human's act, there is no line", () => {
    const events = [
      nodeEvent("2026-08-01T10:00:00Z", AGENT, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
    ];
    expect(awaitingRoadmapReview(undefined, HUMAN, events)).toBeUndefined();
  });

  test("any human-attributed roadmap mutation clears it, and the next agent act re-raises", () => {
    const cleared = [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:00Z", AGENT, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T12:00:00Z", HUMAN, { id: "n2", name: "beta" }),
    ];
    expect(awaitingRoadmapReview(undefined, HUMAN, cleared)).toBeUndefined();

    const reraised = [
      ...cleared,
      nodeEvent("2026-08-01T13:00:00Z", AGENT, { id: "n3", name: "gamma" }),
    ];
    const status = awaitingRoadmapReview(undefined, HUMAN, reraised)!;
    expect(status.changes).toBe(1);
    expect(status.nodes).toEqual([{ id: "n3", name: "gamma" }]);
    // The window opens after the CLEAR, not after the original first touch.
    expect(status.since).toBe("2026-08-01T12:00:00Z");
  });

  test("`nahel roadmap ack` clears it too — and it is not itself a change", () => {
    const cleared = [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:00Z", AGENT, { id: "n1", name: "alpha" }),
      ackEvent("2026-08-01T12:00:00Z", HUMAN),
    ];
    expect(awaitingRoadmapReview(undefined, HUMAN, cleared)).toBeUndefined();

    const status = awaitingRoadmapReview(undefined, HUMAN, [
      ...cleared,
      nodeEvent("2026-08-01T13:00:00Z", AGENT, { id: "n1", name: "alpha" }),
    ])!;
    expect(status.changes).toBe(1);
    expect(status.since).toBe("2026-08-01T12:00:00Z");
  });

  test("an ack under an AGENT actor does NOT clear — and adds no change of its own", () => {
    const events = [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:00Z", AGENT, { id: "n1", name: "alpha" }),
      ackEvent("2026-08-01T12:00:00Z", AGENT),
    ];
    const status = awaitingRoadmapReview(undefined, HUMAN, events)!;
    expect(status.changes).toBe(1);
    expect(status.nodes).toEqual([{ id: "n1", name: "alpha" }]);
    expect(status.since).toBe("2026-08-01T10:00:00Z");
  });

  test("an agent act in the SAME SECOND as the clearing act stays raised (fail safe = visible)", () => {
    // Cross-session acts in one second are ordered by the random event id, so
    // letting the order decide would hide a change on a coin flip.
    const events = [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:00Z", AGENT, { id: "n2", name: "beta" }),
      ackEvent("2026-08-01T11:00:00Z", HUMAN),
    ];
    const status = awaitingRoadmapReview(undefined, HUMAN, events)!;
    expect(status.changes).toBe(1);
    expect(status.nodes).toEqual([{ id: "n2", name: "beta" }]);
    expect(status.since).toBe("2026-08-01T11:00:00Z");
  });
});

describe("awaitingRoadmapReview — what the count and the node list mean", () => {
  test("counts ACTS but lists NODES: two acts on one node are one node, twice touched", () => {
    const status = awaitingRoadmapReview(undefined, HUMAN, [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:00Z", AGENT, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:01Z", AGENT, { id: "n1", name: "alpha" }),
    ])!;
    expect(status.changes).toBe(2);
    expect(status.nodes).toEqual([{ id: "n1", name: "alpha" }]);
  });

  test("a renamed node is listed under the name its LATEST act carries", () => {
    const status = awaitingRoadmapReview(undefined, HUMAN, [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:00Z", AGENT, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:01Z", AGENT, { id: "n1", name: "alpha-renamed" }),
    ])!;
    expect(status.nodes).toEqual([{ id: "n1", name: "alpha-renamed" }]);
  });

  test(`nodes are listed in first-touch order and capped at ${AWAITING_ROADMAP_NODE_CAP}, the rest counted`, () => {
    const events: JournalEvent[] = [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n0", name: "seed" }),
    ];
    const total = AWAITING_ROADMAP_NODE_CAP + 2;
    for (let i = 0; i < total; i += 1) {
      events.push(
        nodeEvent(`2026-08-01T11:00:${String(i).padStart(2, "0")}Z`, AGENT, {
          id: `n${i + 1}`,
          name: `node-${i}`,
        }),
      );
    }
    const status = awaitingRoadmapReview(undefined, HUMAN, events)!;
    expect(status.changes).toBe(total);
    expect(status.nodes).toHaveLength(AWAITING_ROADMAP_NODE_CAP);
    expect(status.nodes[0]).toEqual({ id: "n1", name: "node-0" });
    expect(status.nodes[AWAITING_ROADMAP_NODE_CAP - 1]).toEqual({
      id: `n${AWAITING_ROADMAP_NODE_CAP}`,
      name: `node-${AWAITING_ROADMAP_NODE_CAP - 1}`,
    });
    expect(status.more).toBe(2);
  });

  test("only roadmap MUTATION types count — a note carrying a node payload is inert data", () => {
    const events = [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:00Z", AGENT, { id: "n2", name: "beta" }, "note"),
      nodeEvent("2026-08-01T11:00:01Z", AGENT, { id: "n3", name: "gamma" }, "item.updated"),
    ];
    expect(awaitingRoadmapReview(undefined, HUMAN, events)).toBeUndefined();
  });

  test("ANOTHER human's `note` carrying a node payload clears nothing — types, not payload shapes", () => {
    // The reader's OWN acts move their baseline whatever the type — they were
    // here. Somebody else's act only clears when it is a real roadmap act, so
    // a note dressed up as one advances nothing.
    const ana: Actor = { kind: "human", id: "ana" };
    const events = [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:00Z", AGENT, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T12:00:00Z", ana, { id: "n1", name: "alpha" }, "note"),
    ];
    const status = awaitingRoadmapReview(undefined, HUMAN, events)!;
    expect(status.changes).toBe(1);
    expect(status.since).toBe("2026-08-01T10:00:00Z");
  });

  test("an act with an unreadable payload is still surfaced, keyed by its own act id", () => {
    // Events are data: a malformed payload is a change the human must still
    // see, so it is named rather than silently dropped (HC6).
    const malformed: JournalEvent = {
      id: "brokenev",
      ts: "2026-08-01T11:00:00Z",
      seq: 0,
      type: CORE_EVENT_TYPES.roadmapNodeUpdated,
      actor: AGENT,
      payload: { target: "roadmap-node" },
    };
    const status = awaitingRoadmapReview(undefined, HUMAN, [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      malformed,
    ])!;
    expect(status.changes).toBe(1);
    expect(status.nodes).toEqual([{ id: "brokenev", name: "brokenev" }]);
  });
});

/**
 * Retraction (PR #26 follow-up A1): withdrawing a lifecycle fact CHANGES what
 * every roadmap surface derives — a feature can drop from `released` back to
 * `built` without a single record write — so under a human-owned product it is
 * a roadmap act the human should see, exactly like a node edit.
 *
 * It names no node, though, and cannot: the fact it withdraws covers an epic
 * SUBTREE, and this function reads governance and journal events only. So the
 * act is COUNTED and no node is invented for it — the alternative, keying it by
 * its own act id like a malformed node payload, would print an event id in a
 * list of node slugs and read as a node that does not exist.
 */
describe("awaitingRoadmapReview — a retracted lifecycle fact is a roadmap act", () => {
  const COLUMN_RETRACTED = "roadmap.column-retracted";

  /** One retraction, as `nahel log` writes it: no record payload at all. */
  function retractionEvent(ts: string, actor: Actor, target: string): JournalEvent {
    counter += 1;
    return {
      id: `retr${String(counter).padStart(4, "0")}`,
      ts,
      seq: 0,
      type: COLUMN_RETRACTED,
      actor,
      payload: { event: target, reason: "logged against the wrong epic" },
    };
  }

  test.each(HUMAN_MODES)("under governance.product: %s an agent retraction raises the surface", (product) => {
    const events = [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      retractionEvent("2026-08-01T11:00:00Z", AGENT, "swp00001"),
    ];
    const status = awaitingRoadmapReview({ product, architecture: "human" }, HUMAN, events)!;
    expect(status).toBeDefined();
    expect(status.changes).toBe(1);
    // It touched no node, and none is invented for it.
    expect(status.nodes).toEqual([]);
    expect(status.more).toBe(0);
  });

  test("it is counted ALONGSIDE the node acts, which still name their nodes", () => {
    const events = [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:00Z", AGENT, { id: "n1", name: "alpha" }),
      retractionEvent("2026-08-01T11:30:00Z", AGENT, "swp00001"),
    ];
    const status = awaitingRoadmapReview(undefined, HUMAN, events)!;
    expect(status.changes).toBe(2);
    expect(status.nodes).toEqual([{ id: "n1", name: "alpha" }]);
  });

  test("under governance.product: agent it raises nothing, like every other roadmap act", () => {
    const events = [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      retractionEvent("2026-08-01T11:00:00Z", AGENT, "swp00001"),
    ];
    expect(
      awaitingRoadmapReview({ product: "agent", architecture: "human" }, HUMAN, events),
    ).toBeUndefined();
  });

  test("a HUMAN retraction clears the window — a human who corrects the roadmap has seen it", () => {
    const events = [
      nodeEvent("2026-08-01T09:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T10:00:00Z", AGENT, { id: "n1", name: "alpha" }),
      retractionEvent("2026-08-01T11:00:00Z", HUMAN, "swp00001"),
    ];
    expect(awaitingRoadmapReview(undefined, HUMAN, events)).toBeUndefined();
  });
});

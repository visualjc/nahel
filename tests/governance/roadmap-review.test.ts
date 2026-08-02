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
 * Three rules the rest of the codebase must never answer twice:
 *   1. Under `governance.product: agent` there is NO surface at all — the
 *      agent-as-PO owns the roadmap outright (ADR-0008 as amended 2026-08-01).
 *   2. The window opens after the last HUMAN-attributed roadmap act (a node
 *      created or updated, or `nahel roadmap ack`). Provenance is read from
 *      the journal, exactly as merge authority reads it — an ack run under an
 *      agent actor clears nothing.
 *   3. Same-second acts fail SAFE, and safe here means visible: a human act
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
      awaitingRoadmapReview({ product: "agent", architecture: "human" }, events),
    ).toBeUndefined();
  });

  test.each(HUMAN_MODES)("under governance.product: %s the agent's acts await the human", (product) => {
    const events = [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:00Z", AGENT, { id: "n1", name: "alpha" }),
    ];
    const status = awaitingRoadmapReview({ product, architecture: "human" }, events)!;
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
    expect(awaitingRoadmapReview(undefined, events)!.changes).toBe(1);
  });
});

describe("awaitingRoadmapReview — the window opens after the last HUMAN roadmap act", () => {
  test("a first-touch human sees nothing: no window exists to measure `since` against", () => {
    // Agents built the whole roadmap and no human has ever touched it — there
    // is no "your last touch", so the line is ABSENT, not an empty header.
    const events = [
      nodeEvent("2026-08-01T10:00:00Z", AGENT, { id: "n1", name: "alpha" }, CORE_EVENT_TYPES.roadmapNodeCreated),
      nodeEvent("2026-08-01T10:00:01Z", AGENT, { id: "n2", name: "beta" }, CORE_EVENT_TYPES.roadmapNodeCreated),
    ];
    expect(awaitingRoadmapReview(undefined, events)).toBeUndefined();
  });

  test("with nothing agent-authored since the human's act, there is no line", () => {
    const events = [
      nodeEvent("2026-08-01T10:00:00Z", AGENT, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
    ];
    expect(awaitingRoadmapReview(undefined, events)).toBeUndefined();
  });

  test("any human-attributed roadmap mutation clears it, and the next agent act re-raises", () => {
    const cleared = [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:00Z", AGENT, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T12:00:00Z", HUMAN, { id: "n2", name: "beta" }),
    ];
    expect(awaitingRoadmapReview(undefined, cleared)).toBeUndefined();

    const reraised = [
      ...cleared,
      nodeEvent("2026-08-01T13:00:00Z", AGENT, { id: "n3", name: "gamma" }),
    ];
    const status = awaitingRoadmapReview(undefined, reraised)!;
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
    expect(awaitingRoadmapReview(undefined, cleared)).toBeUndefined();

    const status = awaitingRoadmapReview(undefined, [
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
    const status = awaitingRoadmapReview(undefined, events)!;
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
    const status = awaitingRoadmapReview(undefined, events)!;
    expect(status.changes).toBe(1);
    expect(status.nodes).toEqual([{ id: "n2", name: "beta" }]);
    expect(status.since).toBe("2026-08-01T11:00:00Z");
  });
});

describe("awaitingRoadmapReview — what the count and the node list mean", () => {
  test("counts ACTS but lists NODES: two acts on one node are one node, twice touched", () => {
    const status = awaitingRoadmapReview(undefined, [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:00Z", AGENT, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:01Z", AGENT, { id: "n1", name: "alpha" }),
    ])!;
    expect(status.changes).toBe(2);
    expect(status.nodes).toEqual([{ id: "n1", name: "alpha" }]);
  });

  test("a renamed node is listed under the name its LATEST act carries", () => {
    const status = awaitingRoadmapReview(undefined, [
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
    const status = awaitingRoadmapReview(undefined, events)!;
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
    expect(awaitingRoadmapReview(undefined, events)).toBeUndefined();
  });

  test("a human `note` carrying a node payload clears nothing — types, not payload shapes", () => {
    const events = [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T11:00:00Z", AGENT, { id: "n1", name: "alpha" }),
      nodeEvent("2026-08-01T12:00:00Z", HUMAN, { id: "n1", name: "alpha" }, "note"),
    ];
    expect(awaitingRoadmapReview(undefined, events)!.changes).toBe(1);
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
    const status = awaitingRoadmapReview(undefined, [
      nodeEvent("2026-08-01T10:00:00Z", HUMAN, { id: "n1", name: "alpha" }),
      malformed,
    ])!;
    expect(status.changes).toBe(1);
    expect(status.nodes).toEqual([{ id: "brokenev", name: "brokenev" }]);
  });
});

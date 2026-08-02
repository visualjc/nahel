import { describe, expect, test } from "bun:test";
import {
  DECISION_TICKET_STATES,
  DECISION_TICKET_TYPES,
} from "../../src/schema/enums";
import {
  CORE_EVENT_TYPES,
  MUTATION_EVENT_TYPES,
  SELF_RECORDED_EVENT_TYPES,
} from "../../src/schema/events";
import { mapFrontmatterSchema, ticketFrontmatterSchema } from "../../src/schema/records";

/**
 * The wayfinder record layer (Phase 4 F7): the map attached to a roadmap node
 * and the decision tickets hanging off it. These tests pin the vocabulary (four
 * ticket types, four lifecycle states), the record shapes, and the event types
 * every transition journals — the layer F8's frontier reads back.
 */

const MAP = {
  id: "kqm3vx7t",
  node: "9m38trg4",
  destination: "a deploy story a fresh agent can drive end to end",
  decisions: [],
  fog: [],
  out_of_scope: [],
  created: "2026-08-01T12:00:00Z",
  updated: "2026-08-01T12:00:00Z",
};

const TICKET = {
  id: "x1rr51c4",
  map: "kqm3vx7t",
  type: "research" as const,
  state: "open" as const,
  blockers: [],
  created: "2026-08-01T12:00:00Z",
  updated: "2026-08-01T12:00:00Z",
};

describe("decision-ticket vocabulary (F7)", () => {
  test("ticket types are exactly research|prototype|grilling|task", () => {
    expect([...DECISION_TICKET_TYPES]).toEqual(["research", "prototype", "grilling", "task"]);
  });

  test("ticket states are exactly open|claimed|resolved|closed", () => {
    expect([...DECISION_TICKET_STATES]).toEqual(["open", "claimed", "resolved", "closed"]);
  });

  test("the enums ARE the ticket record's type and state value sets", () => {
    expect([...ticketFrontmatterSchema.shape.type.options]).toEqual([...DECISION_TICKET_TYPES]);
    expect([...ticketFrontmatterSchema.shape.state.options]).toEqual([...DECISION_TICKET_STATES]);
  });
});

describe("map record shape (F7)", () => {
  test("a minimal map — node, destination, three empty sections — is valid", () => {
    expect(mapFrontmatterSchema.parse(MAP)).toEqual(MAP);
  });

  test("the three list sections are REQUIRED keys: an omitted one is a schema error", () => {
    // Unlike a roadmap node's per-kind links (soft, so optional), every map
    // carries all five sections — the CLI writes them on every mutation, so an
    // absent key means a hand-edited record, not an un-charted section.
    for (const key of ["decisions", "fog", "out_of_scope"]) {
      const { [key as keyof typeof MAP]: _dropped, ...without } = MAP;
      expect(mapFrontmatterSchema.safeParse(without).success).toBe(false);
    }
  });

  test("a destination is required and must say something — an empty one charts nothing", () => {
    expect(mapFrontmatterSchema.safeParse({ ...MAP, destination: "" }).success).toBe(false);
    const { destination: _dropped, ...without } = MAP;
    expect(mapFrontmatterSchema.safeParse(without).success).toBe(false);
  });

  test("a decision index entry names its ticket and carries the one-liner", () => {
    const parsed = mapFrontmatterSchema.parse({
      ...MAP,
      decisions: [{ ticket: "x1rr51c4", decision: "ship the shim generator unchanged" }],
    });
    expect(parsed.decisions[0]).toEqual({
      ticket: "x1rr51c4",
      decision: "ship the shim generator unchanged",
    });
    // The ticket ref is an id, and the line must say something.
    expect(
      mapFrontmatterSchema.safeParse({ ...MAP, decisions: [{ ticket: "nope", decision: "x" }] })
        .success,
    ).toBe(false);
    expect(
      mapFrontmatterSchema.safeParse({
        ...MAP,
        decisions: [{ ticket: "x1rr51c4", decision: "" }],
      }).success,
    ).toBe(false);
  });

  test("an out-of-scope entry carries its reason; the ticket that earned it is optional", () => {
    // Charting rules things out of scope before any ticket exists (the fog
    // sketch), and `ticket close` adds one with the ticket named.
    expect(
      mapFrontmatterSchema.parse({ ...MAP, out_of_scope: [{ reason: "no tracker mirrors" }] })
        .out_of_scope[0],
    ).toEqual({ reason: "no tracker mirrors" });
    expect(
      mapFrontmatterSchema.parse({
        ...MAP,
        out_of_scope: [{ reason: "no tracker mirrors", ticket: "x1rr51c4" }],
      }).out_of_scope[0],
    ).toEqual({ reason: "no tracker mirrors", ticket: "x1rr51c4" });
  });

  test("there is no status, progress, or count field on a map — nothing to hand-set", () => {
    expect(mapFrontmatterSchema.safeParse({ ...MAP, status: "charted" }).success).toBe(false);
  });
});

describe("ticket record shape (F7)", () => {
  test("a minimal ticket — map, type, state, no blockers — is valid", () => {
    expect(ticketFrontmatterSchema.parse(TICKET)).toEqual(TICKET);
  });

  test("state, claimant and blockers are all present on the record — F8's predicate reads them", () => {
    const claimed = ticketFrontmatterSchema.parse({
      ...TICKET,
      state: "claimed",
      claimant: "agent:codex",
      blockers: ["9m38trg4"],
    });
    expect(claimed.state).toBe("claimed");
    expect(claimed.claimant).toBe("agent:codex");
    expect(claimed.blockers).toEqual(["9m38trg4"]);
  });

  test("resolve's decision and close's reason are optional fields, blank refused", () => {
    expect(
      ticketFrontmatterSchema.parse({
        ...TICKET,
        state: "resolved",
        decision: "one shim generator, no second path",
        resolution: "kqm3vx7t",
      }).decision,
    ).toBe("one shim generator, no second path");
    expect(ticketFrontmatterSchema.safeParse({ ...TICKET, decision: "" }).success).toBe(false);
    expect(ticketFrontmatterSchema.safeParse({ ...TICKET, reason: "" }).success).toBe(false);
    // The resolution ref is the journal event id the decision observation cites.
    expect(ticketFrontmatterSchema.safeParse({ ...TICKET, resolution: "nope" }).success).toBe(
      false,
    );
  });

  test("blockers is a REQUIRED list of ids — an unwired ticket carries an empty one", () => {
    const { blockers: _dropped, ...without } = TICKET;
    expect(ticketFrontmatterSchema.safeParse(without).success).toBe(false);
    expect(ticketFrontmatterSchema.safeParse({ ...TICKET, blockers: ["nope"] }).success).toBe(
      false,
    );
  });

  test("unknown keys are rejected — a typo'd field is an error, never silent state", () => {
    expect(ticketFrontmatterSchema.safeParse({ ...TICKET, priority: 1 }).success).toBe(false);
  });
});

describe("wayfinder event types (F7)", () => {
  test("every transition in the lifecycle table has its own core event type", () => {
    expect(CORE_EVENT_TYPES.mapCreated).toBe("roadmap.map-created");
    expect(CORE_EVENT_TYPES.mapUpdated).toBe("roadmap.map-updated");
    expect(CORE_EVENT_TYPES.ticketCreated).toBe("roadmap.ticket-created");
    expect(CORE_EVENT_TYPES.ticketUpdated).toBe("roadmap.ticket-updated");
    expect(CORE_EVENT_TYPES.ticketClaimed).toBe("roadmap.ticket-claimed");
    expect(CORE_EVENT_TYPES.ticketReleased).toBe("roadmap.ticket-released");
    expect(CORE_EVENT_TYPES.ticketResolved).toBe("roadmap.ticket-resolved");
    expect(CORE_EVENT_TYPES.ticketClosed).toBe("roadmap.ticket-closed");
    expect(CORE_EVENT_TYPES.ticketDistilled).toBe("roadmap.ticket-distilled");
  });

  test("all nine are mutation types — they ride the choke point and replay", () => {
    for (const type of [
      CORE_EVENT_TYPES.mapCreated,
      CORE_EVENT_TYPES.mapUpdated,
      CORE_EVENT_TYPES.ticketCreated,
      CORE_EVENT_TYPES.ticketUpdated,
      CORE_EVENT_TYPES.ticketClaimed,
      CORE_EVENT_TYPES.ticketReleased,
      CORE_EVENT_TYPES.ticketResolved,
      CORE_EVENT_TYPES.ticketClosed,
      CORE_EVENT_TYPES.ticketDistilled,
    ]) {
      expect(MUTATION_EVENT_TYPES.has(type)).toBe(true);
      // Self-recorded: `nahel log` refuses them, so no agent can hand-append a
      // resolution (or a distill) that readers would trust by type alone.
      expect(SELF_RECORDED_EVENT_TYPES.get(type)).toContain("nahel roadmap");
    }
  });
});

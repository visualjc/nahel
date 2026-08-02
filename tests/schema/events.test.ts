import { describe, expect, test } from "bun:test";
import {
  CORE_EVENT_TYPES,
  MUTATION_EVENT_TYPES,
  SELF_RECORDED_EVENT_TYPES,
} from "../../src/schema/events";
import { journalEventSchema } from "../../src/schema/records";

const baseEvent = {
  id: "kqm3vx7t",
  ts: "2026-07-16T12:00:00Z",
  seq: 0,
  type: "note",
  actor: { kind: "human", id: "jim" },
  payload: {},
};

describe("schema/events", () => {
  test("defines the core mutation and intervention event types", () => {
    expect(CORE_EVENT_TYPES).toEqual({
      itemCreated: "item.created",
      itemUpdated: "item.updated",
      // Phase 4 F8: the write-ahead event of a deliberately blocked start. A
      // CORE mutation type, because it REPLACES `item.updated` for that one
      // transition rather than annotating one after the fact.
      itemStartedBlocked: "item.started-with-open-blocker",
      runStarted: "run.started",
      runUpdated: "run.updated",
      runEnded: "run.ended",
      runPaused: "run.paused",
      itemClaimed: "item.claimed",
      itemHandback: "item.handback",
      observationCreated: "observation.created",
      roadmapNodeCreated: "roadmap.node-created",
      roadmapNodeUpdated: "roadmap.node-updated",
      mapCreated: "roadmap.map-created",
      mapUpdated: "roadmap.map-updated",
      ticketCreated: "roadmap.ticket-created",
      ticketUpdated: "roadmap.ticket-updated",
      ticketClaimed: "roadmap.ticket-claimed",
      ticketReleased: "roadmap.ticket-released",
      ticketResolved: "roadmap.ticket-resolved",
      ticketClosed: "roadmap.ticket-closed",
      ticketDistilled: "roadmap.ticket-distilled",
      note: "note",
    });
  });

  test("the roadmap node mutations are self-recorded by their own verb — `nahel log` cannot forge them", () => {
    // Same reservation as every other mutation type: readers trust these by
    // TYPE alone (F4 reads the event that set a node's horizon, F5 its actor),
    // so a type an agent could hand-append through `log` is a type it could
    // forge. The label names the verb, not `nahel item`/`nahel run`.
    expect(SELF_RECORDED_EVENT_TYPES.get(CORE_EVENT_TYPES.roadmapNodeCreated)).toBe(
      "`nahel roadmap node`",
    );
    expect(SELF_RECORDED_EVENT_TYPES.get(CORE_EVENT_TYPES.roadmapNodeUpdated)).toBe(
      "`nahel roadmap node`",
    );
  });

  test("the mutation subset is exactly the core types minus the note observation type", () => {
    const { note, ...mutations } = CORE_EVENT_TYPES;
    expect(MUTATION_EVENT_TYPES).toEqual(new Set(Object.values(mutations)));
    expect(MUTATION_EVENT_TYPES.has(note)).toBe(false);
  });

  test("every core event type is accepted by the journal event schema", () => {
    for (const type of Object.values(CORE_EVENT_TYPES)) {
      const result = journalEventSchema.safeParse({ ...baseEvent, type });
      expect(result.success).toBe(true);
    }
  });

  test("unknown event types are accepted (open extension, no code change needed)", () => {
    const result = journalEventSchema.safeParse({
      ...baseEvent,
      type: "my-workflow.custom-checkpoint",
    });
    expect(result.success).toBe(true);
  });

  test("the empty string is not a valid event type", () => {
    const result = journalEventSchema.safeParse({ ...baseEvent, type: "" });
    expect(result.success).toBe(false);
  });
});

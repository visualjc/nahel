import { describe, expect, test } from "bun:test";
import { CORE_EVENT_TYPES, MUTATION_EVENT_TYPES } from "../../src/schema/events";
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
      runStarted: "run.started",
      runUpdated: "run.updated",
      runEnded: "run.ended",
      runPaused: "run.paused",
      itemClaimed: "item.claimed",
      itemHandback: "item.handback",
      observationCreated: "observation.created",
      note: "note",
    });
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

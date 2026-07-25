import { describe, expect, test } from "bun:test";
import {
  ACTOR_KINDS,
  DISPATCH_AGENT_KINDS,
  GOVERNANCE_MODES,
  INCEPTION_TIERS,
  LANES,
  ROUTING_RESPONSIBILITIES,
  RUN_STATUSES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TYPES,
} from "../../src/schema/enums";
import { dispatchSchema, routingSchema } from "../../src/schema/records";

describe("schema/enums (CONTEXT.md glossary is normative)", () => {
  test("work item types are exactly feature|bug|chore|plan|prototype|qa", () => {
    expect([...WORK_ITEM_TYPES]).toEqual([
      "feature",
      "bug",
      "chore",
      "plan",
      "prototype",
      "qa",
    ]);
  });

  test("work item statuses are exactly backlog|in-progress|blocked|in-review|done|dropped", () => {
    expect([...WORK_ITEM_STATUSES]).toEqual([
      "backlog",
      "in-progress",
      "blocked",
      "in-review",
      "done",
      "dropped",
    ]);
  });

  test("lanes are exactly direct|epic-lite|full", () => {
    expect([...LANES]).toEqual(["direct", "epic-lite", "full"]);
  });

  test("actor kinds are exactly human|agent", () => {
    expect([...ACTOR_KINDS]).toEqual(["human", "agent"]);
  });

  test("run statuses cover the run lifecycle: active|paused|ended", () => {
    expect([...RUN_STATUSES]).toEqual(["active", "paused", "ended"]);
  });

  test("inception tiers are exactly seed|standard|full (full recorded now, workflow deferred)", () => {
    expect([...INCEPTION_TIERS]).toEqual(["seed", "standard", "full"]);
  });

  test("governance modes are exactly human|delegated", () => {
    expect([...GOVERNANCE_MODES]).toEqual(["human", "delegated"]);
  });

  test("responsibilities are exactly architecture|implementation|review (ADR-0015)", () => {
    expect([...ROUTING_RESPONSIBILITIES]).toEqual(["architecture", "implementation", "review"]);
  });

  test("the responsibility enum IS the routing schema's key set, plus default", () => {
    // The enum is what `nahel dispatch <responsibility>` accepts; the schema is
    // what config may carry. Drift between them would let dispatch accept a
    // responsibility config can't express (or vice versa).
    expect(Object.keys(routingSchema.shape)).toEqual([...ROUTING_RESPONSIBILITIES, "default"]);
  });

  test("dispatch agent kinds are exactly claude|codex|cursor-agent (F1.3)", () => {
    expect([...DISPATCH_AGENT_KINDS]).toEqual(["claude", "codex", "cursor-agent"]);
  });

  test("the agent-kind enum IS the dispatch config's key set — a new kind is a schema change", () => {
    expect(Object.keys(dispatchSchema.shape)).toEqual([...DISPATCH_AGENT_KINDS]);
  });
});

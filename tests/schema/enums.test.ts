import { describe, expect, test } from "bun:test";
import {
  ACTOR_KINDS,
  DISPATCH_AGENT_KINDS,
  FOUNDING_MODES,
  GOVERNANCE_MODES,
  INCEPTION_TIERS,
  LANES,
  MERGE_AUTHORITIES,
  ROUTING_RESPONSIBILITIES,
  RUN_STATUSES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TYPES,
} from "../../src/schema/enums";
import { dispatchSchema, mergeSchema, routingSchema } from "../../src/schema/records";

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

  test("founding modes are exactly guided|hands-off — interaction modes of ONE workflow (F9.4)", () => {
    // Not two workflows and not two mining procedures: inception mines first
    // in both, and the mode only decides who answers the questions.
    expect([...FOUNDING_MODES]).toEqual(["guided", "hands-off"]);
  });

  test("merge authorities are exactly human|on-approve (F3.4, HC6 as amended)", () => {
    expect([...MERGE_AUTHORITIES]).toEqual(["human", "on-approve"]);
  });

  test("the merge-authority enum IS the merge section's value set", () => {
    // The section carries exactly one key; a third authority would have to be
    // a deliberate enum change, never a stray config string.
    expect(Object.keys(mergeSchema.shape)).toEqual(["authority"]);
    expect([...mergeSchema.shape.authority.options]).toEqual([...MERGE_AUTHORITIES]);
  });

  test("responsibilities are exactly architecture|implementation|review (ADR-0015)", () => {
    expect([...ROUTING_RESPONSIBILITIES]).toEqual(["architecture", "implementation", "review"]);
  });

  test("the responsibility enum IS the routing schema's key set, plus the two slot keys", () => {
    // The enum is what `nahel dispatch <responsibility>` accepts; the schema is
    // what config may carry. Drift between them would let dispatch accept a
    // responsibility config can't express (or vice versa). The two extra keys
    // are deliberately NOT responsibilities: `default` is what an unrouted
    // responsibility falls back to, and `review2` (F3.1) names the review
    // loop's second reviewer slot — a slot its driver fills under its own
    // actor, so nothing ever spawns it.
    expect(Object.keys(routingSchema.shape)).toEqual([
      ...ROUTING_RESPONSIBILITIES,
      "review2",
      "default",
    ]);
  });

  test("dispatch agent kinds are exactly claude|codex|cursor-agent (F1.3)", () => {
    expect([...DISPATCH_AGENT_KINDS]).toEqual(["claude", "codex", "cursor-agent"]);
  });

  test("the agent-kind enum IS the dispatch config's key set — a new kind is a schema change", () => {
    expect(Object.keys(dispatchSchema.shape)).toEqual([...DISPATCH_AGENT_KINDS]);
  });
});

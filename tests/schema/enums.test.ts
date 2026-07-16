import { describe, expect, test } from "bun:test";
import {
  ACTOR_KINDS,
  LANES,
  RUN_STATUSES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TYPES,
} from "../../src/schema/enums";

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
});

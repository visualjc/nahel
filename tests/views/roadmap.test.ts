import { describe, expect, test } from "bun:test";
import type { Env } from "../../src/schema/env";
import { generateId } from "../../src/schema/id";
import type { RoadmapNodeFrontmatter, WorkItemFrontmatter } from "../../src/schema/records";
import { featureDevStatus } from "../../src/views/roadmap";
import { makeFrontmatter, seededEnv } from "../store/helpers";

/**
 * Roadmap derived status (Phase 4 F2): PURE derivations over store facts —
 * work-item records and journal events in, a status word or a rendered column
 * out. Every row of the PRD's truth table and of its render table gets its own
 * case, because the point of those tables is that two implementations reading
 * identical facts cannot disagree.
 */

/** A roadmap node record; id and timestamps from the seeded env. */
function makeNode(
  env: Env,
  overrides: Partial<RoadmapNodeFrontmatter> = {},
): RoadmapNodeFrontmatter {
  const ts = env.now();
  return {
    id: generateId(env),
    name: "a-feature",
    kind: "feature",
    horizon: "now",
    created: ts,
    updated: ts,
    ...overrides,
  };
}

/**
 * An epic item plus one child per status given, in order. Returns the items
 * and the epic id — the two things every dev-status case needs.
 */
function epicWith(
  env: Env,
  statuses: readonly WorkItemFrontmatter["status"][],
): { epic: WorkItemFrontmatter; items: WorkItemFrontmatter[] } {
  const epic = makeFrontmatter(env, { name: "demo-epic", type: "plan", lane: "full" });
  const items = [epic];
  statuses.forEach((status, index) => {
    items.push(makeFrontmatter(env, { name: `child-${index}`, status, parent: epic.id }));
  });
  return { epic, items };
}

describe("featureDevStatus — the F2 truth table, row by row", () => {
  test("no epic id recorded on the node → planned, and nothing to warn about", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const node = makeNode(env);
    const { items } = epicWith(env, ["backlog"]);

    expect(featureDevStatus(node, items)).toEqual({ status: "planned" });
  });

  test("epic id recorded but no such item record → unknown, flagged epic-missing", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const node = makeNode(env, { epic: "aaaaaaaa" });

    expect(featureDevStatus(node, [])).toEqual({ status: "unknown", anomaly: "epic-missing" });
  });

  test("epic exists with zero children → planned, and no all-dropped warning (none existed)", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = epicWith(env, []);
    const node = makeNode(env, { epic: epic.id });

    expect(featureDevStatus(node, items)).toEqual({ status: "planned" });
  });

  test("every child dropped → planned, flagged all-dropped (children existed)", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = epicWith(env, ["dropped", "dropped"]);
    const node = makeNode(env, { epic: epic.id });

    expect(featureDevStatus(node, items)).toEqual({ status: "planned", anomaly: "all-dropped" });
  });

  test("every non-dropped child done → built", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = epicWith(env, ["done", "done"]);
    const node = makeNode(env, { epic: epic.id });

    expect(featureDevStatus(node, items)).toEqual({ status: "built" });
  });

  test("every non-dropped child backlog → planned", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = epicWith(env, ["backlog", "backlog"]);
    const node = makeNode(env, { epic: epic.id });

    expect(featureDevStatus(node, items)).toEqual({ status: "planned" });
  });

  test("an in-progress child → in-flight", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = epicWith(env, ["in-progress"]);
    const node = makeNode(env, { epic: epic.id });

    expect(featureDevStatus(node, items)).toEqual({ status: "in-flight" });
  });

  test("a blocked-only epic → in-flight: blocking is advisory, never its own status", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = epicWith(env, ["blocked"]);
    const node = makeNode(env, { epic: epic.id });

    expect(featureDevStatus(node, items)).toEqual({ status: "in-flight" });
  });

  test("an in-review-only epic → in-flight: review is started work, not a node state", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = epicWith(env, ["in-review"]);
    const node = makeNode(env, { epic: epic.id });

    expect(featureDevStatus(node, items)).toEqual({ status: "in-flight" });
  });

  test("a done + backlog mix → in-flight", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = epicWith(env, ["done", "backlog"]);
    const node = makeNode(env, { epic: epic.id });

    expect(featureDevStatus(node, items)).toEqual({ status: "in-flight" });
  });
});

describe("featureDevStatus — dropped work is not work", () => {
  test("done + dropped → built: the dropped child is excluded, not counted as unfinished", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = epicWith(env, ["done", "dropped"]);
    const node = makeNode(env, { epic: epic.id });

    expect(featureDevStatus(node, items)).toEqual({ status: "built" });
  });

  test("backlog + dropped → planned, with no all-dropped warning (one child survives)", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = epicWith(env, ["backlog", "dropped"]);
    const node = makeNode(env, { epic: epic.id });

    expect(featureDevStatus(node, items)).toEqual({ status: "planned" });
  });
});

describe("featureDevStatus — the rollup reads the whole subtree under the epic", () => {
  test("a grandchild counts: epic → child done, grandchild backlog reads in-flight", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = epicWith(env, ["done"]);
    const child = items[1]!;
    items.push(makeFrontmatter(env, { name: "grandchild", status: "backlog", parent: child.id }));
    const node = makeNode(env, { epic: epic.id });

    expect(featureDevStatus(node, items)).toEqual({ status: "in-flight" });
  });

  test("flipping the leaf grandchild to done is what makes the feature built", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = epicWith(env, ["done"]);
    const child = items[1]!;
    const grandchild = makeFrontmatter(env, {
      name: "grandchild",
      status: "backlog",
      parent: child.id,
    });
    const node = makeNode(env, { epic: epic.id });

    expect(featureDevStatus(node, [...items, grandchild]).status).toBe("in-flight");
    expect(
      featureDevStatus(node, [...items, { ...grandchild, status: "done" as const }]).status,
    ).toBe("built");
  });

  test("the epic item's OWN status is not part of the rollup — only the work under it", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = epicWith(env, ["done"]);
    const node = makeNode(env, { epic: epic.id });
    // The epic itself still sits at backlog while its only child is done.
    expect(epic.status).toBe("backlog");

    expect(featureDevStatus(node, items)).toEqual({ status: "built" });
  });

  test("an item outside the epic's subtree never joins the rollup", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = epicWith(env, ["done"]);
    const node = makeNode(env, { epic: epic.id });
    const stranger = makeFrontmatter(env, { name: "solo-chore", status: "backlog" });

    expect(featureDevStatus(node, [...items, stranger])).toEqual({ status: "built" });
  });
});

describe("featureDevStatus — purity", () => {
  test("two calls over the same facts return equal results and mutate no input", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = epicWith(env, ["done", "backlog", "dropped"]);
    const node = makeNode(env, { epic: epic.id });
    const itemsBefore = JSON.stringify(items);
    const nodeBefore = JSON.stringify(node);

    const first = featureDevStatus(node, items);
    const second = featureDevStatus(node, items);

    expect(first).toEqual(second);
    expect(JSON.stringify(items)).toBe(itemsBefore);
    expect(JSON.stringify(node)).toBe(nodeBefore);
  });

  test("input order does not change the answer: the same items shuffled derive the same status", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = epicWith(env, ["done", "backlog"]);
    const node = makeNode(env, { epic: epic.id });

    expect(featureDevStatus(node, [...items].reverse())).toEqual(featureDevStatus(node, items));
  });
});

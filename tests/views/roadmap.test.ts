import { describe, expect, test } from "bun:test";
import type { Env } from "../../src/schema/env";
import { generateId } from "../../src/schema/id";
import {
  DEPLOY_COMPLETED_EVENT_TYPE,
  QA_SWEEP_EVENT_TYPE,
  RELEASE_ANNOUNCED_EVENT_TYPE,
} from "../../src/schema/events";
import type {
  JournalEvent,
  RoadmapNodeFrontmatter,
  WorkItemFrontmatter,
} from "../../src/schema/records";
import type { RoadmapNodeRecord } from "../../src/store/layout";
import {
  featureDevStatus,
  featureStatus,
  productFeatureNodes,
  renderProductStatus,
} from "../../src/views/roadmap";
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

/** A node record (frontmatter + intent body) — what readRoadmapNodes returns. */
function makeRecord(
  env: Env,
  overrides: Partial<RoadmapNodeFrontmatter> = {},
): RoadmapNodeRecord {
  return { frontmatter: makeNode(env, overrides), body: "intent\n" };
}

describe("productFeatureNodes — which nodes a product rolls up", () => {
  test("its feature children, in the id order readRoadmapNodes returns", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const product = makeRecord(env, { kind: "product", name: "nahel" });
    const alpha = makeRecord(env, { name: "feature-alpha", parent: product.frontmatter.id });
    const beta = makeRecord(env, { name: "feature-beta", parent: product.frontmatter.id });
    const nodes = [alpha, beta, product].sort((a, b) =>
      a.frontmatter.id < b.frontmatter.id ? -1 : 1,
    );

    const children = productFeatureNodes(nodes, product.frontmatter.id);
    expect(children.map((child) => child.frontmatter.name)).toEqual(
      [alpha, beta]
        .sort((a, b) => (a.frontmatter.id < b.frontmatter.id ? -1 : 1))
        .map((child) => child.frontmatter.name),
    );
  });

  test("an initiative child is not a feature child — it links sideways, it does not roll up", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const product = makeRecord(env, { kind: "product", name: "nahel" });
    const feature = makeRecord(env, { name: "feature-alpha", parent: product.frontmatter.id });
    const initiative = makeRecord(env, {
      kind: "initiative",
      name: "an-initiative",
      parent: product.frontmatter.id,
    });

    const children = productFeatureNodes([product, feature, initiative], product.frontmatter.id);
    expect(children.map((child) => child.frontmatter.name)).toEqual(["feature-alpha"]);
  });

  test("a feature under ANOTHER product is not this product's child", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const one = makeRecord(env, { kind: "product", name: "product-one" });
    const two = makeRecord(env, { kind: "product", name: "product-two" });
    const feature = makeRecord(env, { name: "feature-alpha", parent: two.frontmatter.id });

    expect(productFeatureNodes([one, two, feature], one.frontmatter.id)).toEqual([]);
  });
});

describe("renderProductStatus — the count distribution, never one word", () => {
  test("the full distribution in a fixed order: built, in-flight, planned, unknown", () => {
    const statuses = [
      ...Array<"built">(3).fill("built"),
      ...Array<"in-flight">(2).fill("in-flight"),
      ...Array<"planned">(6).fill("planned"),
      "unknown" as const,
    ];

    expect(renderProductStatus(statuses)).toBe("3 built · 2 in-flight · 6 planned · 1 unknown");
  });

  test("every bucket is printed even at zero — the shape of the roll-up is the point", () => {
    expect(renderProductStatus(["planned"])).toBe(
      "0 built · 0 in-flight · 1 planned · 0 unknown",
    );
  });

  test("the unknown count is never hidden", () => {
    expect(renderProductStatus(["unknown", "unknown"])).toContain("2 unknown");
  });

  test("no feature children renders `no features`, not a row of zeros", () => {
    expect(renderProductStatus([])).toBe("no features");
  });

  test("the order the statuses arrive in does not change the rendering", () => {
    expect(renderProductStatus(["unknown", "built", "planned", "built"])).toBe(
      renderProductStatus(["built", "planned", "built", "unknown"]),
    );
  });
});

/** A journal event; every field a covering-event case needs to control. */
function makeEvent(overrides: Partial<JournalEvent> = {}): JournalEvent {
  return {
    id: "aaaaaaa1",
    ts: "2026-07-16T12:00:00Z",
    seq: 0,
    type: QA_SWEEP_EVENT_TYPE,
    actor: { kind: "agent", id: "codex" },
    payload: {},
    ...overrides,
  };
}

/** A feature node over an epic with one done child and one grandchild under it. */
function featureOverEpic(env: Env) {
  const { epic, items } = epicWith(env, ["done"]);
  const child = items[1]!;
  const grandchild = makeFrontmatter(env, { name: "grandchild", status: "done", parent: child.id });
  items.push(grandchild);
  return { epic, child, grandchild, items, node: makeNode(env, { epic: epic.id }) };
}

describe("featureStatus — the association rule: which events cover a feature", () => {
  test("an event whose item IS the feature's epic covers it", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items, node } = featureOverEpic(env);
    const event = makeEvent({ item: epic.id, payload: { failed: 0 } });

    expect(featureStatus(node, items, [event]).qa).toBe("tested 2026-07-16T12:00:00Z");
  });

  test("an event whose item is a GRANDCHILD of the epic covers it too", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { grandchild, items, node } = featureOverEpic(env);
    const event = makeEvent({ item: grandchild.id, payload: { failed: 0 } });

    expect(featureStatus(node, items, [event]).qa).toBe("tested 2026-07-16T12:00:00Z");
  });

  test("an event with NO item ref covers no feature node — it stays store-wide", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { items, node } = featureOverEpic(env);
    const event = makeEvent({ payload: { failed: 0 } });

    expect(featureStatus(node, items, [event]).qa).toBe("—");
  });

  test("an event on an item outside every subtree covers nothing", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { items, node } = featureOverEpic(env);
    const stranger = makeFrontmatter(env, { name: "solo-chore" });
    const event = makeEvent({ item: stranger.id, payload: { failed: 0 } });

    expect(featureStatus(node, [...items, stranger], [event]).qa).toBe("—");
  });

  test("an event in ANOTHER feature's subtree changes only the owning feature", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const subject = featureOverEpic(env);
    const other = featureOverEpic(env);
    const items = [...subject.items, ...other.items];
    const event = makeEvent({ item: other.epic.id, payload: { failed: 0 } });

    expect(featureStatus(subject.node, items, [event]).qa).toBe("—");
    expect(featureStatus(other.node, items, [event]).qa).toBe("tested 2026-07-16T12:00:00Z");
  });

  test("a node with no epic id is covered by nothing, however the events are attributed", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = featureOverEpic(env);
    const node = makeNode(env, { name: "uncharted" });
    const event = makeEvent({ item: epic.id, payload: { failed: 0 } });

    expect(featureStatus(node, items, [event]).qa).toBe("—");
  });

  test("a dangling epic id still associates by ref: dev unknown, QA column filled", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const node = makeNode(env, { epic: "aaaaaaaa" });
    const event = makeEvent({ item: "aaaaaaaa", payload: { failed: 0 } });

    const status = featureStatus(node, [], [event]);
    expect(status.dev).toBe("unknown");
    expect(status.qa).toBe("tested 2026-07-16T12:00:00Z");
  });

  test("only the whole-sweep type feeds the QA column — a per-case qa.result does not", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items, node } = featureOverEpic(env);
    const event = makeEvent({ item: epic.id, type: "qa.result", payload: { failed: 0 } });

    expect(featureStatus(node, items, [event]).qa).toBe("—");
  });
});

describe("featureStatus — the winning event: last in the store's total order", () => {
  test("a later ts wins", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items, node } = featureOverEpic(env);
    const older = makeEvent({ id: "aaaaaaa1", item: epic.id, ts: "2026-07-16T12:00:00Z", payload: { failed: 1 } });
    const newer = makeEvent({ id: "aaaaaaa2", item: epic.id, ts: "2026-07-16T13:00:00Z", payload: { failed: 2 } });

    expect(featureStatus(node, items, [older, newer]).qa).toBe("tested 2026-07-16T13:00:00Z (2 failed)");
  });

  test("same second: the higher seq wins", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items, node } = featureOverEpic(env);
    const first = makeEvent({ id: "aaaaaaa1", item: epic.id, seq: 0, payload: { failed: 1 } });
    const second = makeEvent({ id: "aaaaaaa2", item: epic.id, seq: 7, payload: { failed: 2 } });

    expect(featureStatus(node, items, [first, second]).qa).toBe("tested 2026-07-16T12:00:00Z (2 failed)");
  });

  test("same second, same seq: the higher id wins — the same winner on every machine", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items, node } = featureOverEpic(env);
    const lower = makeEvent({ id: "aaaaaaa1", item: epic.id, payload: { failed: 1 } });
    const higher = makeEvent({ id: "bbbbbbb2", item: epic.id, payload: { failed: 2 } });

    expect(featureStatus(node, items, [lower, higher]).qa).toBe("tested 2026-07-16T12:00:00Z (2 failed)");
  });

  test("the order the events arrive in does not change the winner", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items, node } = featureOverEpic(env);
    const events = [
      makeEvent({ id: "aaaaaaa1", item: epic.id, ts: "2026-07-16T12:00:00Z", payload: { failed: 1 } }),
      makeEvent({ id: "aaaaaaa2", item: epic.id, ts: "2026-07-16T13:00:00Z", payload: { failed: 2 } }),
      makeEvent({ id: "aaaaaaa3", item: epic.id, ts: "2026-07-16T11:00:00Z", payload: { failed: 3 } }),
    ];

    expect(featureStatus(node, items, [...events].reverse()).qa).toBe(
      featureStatus(node, items, events).qa,
    );
  });

  test("each column resolves its own winner independently", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items, node } = featureOverEpic(env);
    const events = [
      makeEvent({ id: "aaaaaaa1", item: epic.id, ts: "2026-07-16T12:00:00Z", payload: { failed: 0 } }),
      makeEvent({
        id: "aaaaaaa2",
        item: epic.id,
        ts: "2026-07-16T13:00:00Z",
        type: DEPLOY_COMPLETED_EVENT_TYPE,
        payload: { environment: "staging" },
      }),
      makeEvent({
        id: "aaaaaaa3",
        item: epic.id,
        ts: "2026-07-16T14:00:00Z",
        type: RELEASE_ANNOUNCED_EVENT_TYPE,
        payload: { version: "0.3.0" },
      }),
    ];

    const status = featureStatus(node, items, events);
    expect(status.qa).toBe("tested 2026-07-16T12:00:00Z");
    expect(status.deploy).toBe("deployed staging 2026-07-16T13:00:00Z");
    expect(status.release).toBe("released 0.3.0 2026-07-16T14:00:00Z");
  });
});

describe("featureStatus — every row of the F2 render table", () => {
  function columns(events: readonly JournalEvent[]) {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items, node } = featureOverEpic(env);
    return featureStatus(
      node,
      items,
      events.map((event) => ({ ...event, item: epic.id })),
    );
  }

  test("QA, no covering sweep → —", () => {
    expect(columns([]).qa).toBe("—");
  });

  test("QA, failed = 0 → tested <ts>", () => {
    expect(columns([makeEvent({ payload: { failed: 0 } })]).qa).toBe("tested 2026-07-16T12:00:00Z");
  });

  test("QA, failed > 0 → tested <ts> (N failed)", () => {
    expect(columns([makeEvent({ payload: { failed: 3 } })]).qa).toBe(
      "tested 2026-07-16T12:00:00Z (3 failed)",
    );
  });

  test("QA, failed absent → tested <ts> (? failed)", () => {
    expect(columns([makeEvent({ payload: { cases_run: 9 } })]).qa).toBe(
      "tested 2026-07-16T12:00:00Z (? failed)",
    );
  });

  test("QA, failed non-numeric → tested <ts> (? failed)", () => {
    expect(columns([makeEvent({ payload: { failed: "two" } })]).qa).toBe(
      "tested 2026-07-16T12:00:00Z (? failed)",
    );
  });

  test("QA, failed null → tested <ts> (? failed)", () => {
    expect(columns([makeEvent({ payload: { failed: null } })]).qa).toBe(
      "tested 2026-07-16T12:00:00Z (? failed)",
    );
  });

  test("deploy, no covering event → —", () => {
    expect(columns([]).deploy).toBe("—");
  });

  test("deploy, with environment → deployed <environment> <ts>", () => {
    expect(
      columns([makeEvent({ type: DEPLOY_COMPLETED_EVENT_TYPE, payload: { environment: "prod" } })])
        .deploy,
    ).toBe("deployed prod 2026-07-16T12:00:00Z");
  });

  test("deploy, environment absent → deployed ? <ts>", () => {
    expect(
      columns([makeEvent({ type: DEPLOY_COMPLETED_EVENT_TYPE, payload: { ref: "abc123" } })]).deploy,
    ).toBe("deployed ? 2026-07-16T12:00:00Z");
  });

  test("deploy, environment blank → deployed ? <ts>", () => {
    expect(
      columns([makeEvent({ type: DEPLOY_COMPLETED_EVENT_TYPE, payload: { environment: "  " } })])
        .deploy,
    ).toBe("deployed ? 2026-07-16T12:00:00Z");
  });

  test("release, no covering event → —", () => {
    expect(columns([]).release).toBe("—");
  });

  test("release, with version → released <version> <ts>", () => {
    expect(
      columns([makeEvent({ type: RELEASE_ANNOUNCED_EVENT_TYPE, payload: { version: "0.3.0" } })])
        .release,
    ).toBe("released 0.3.0 2026-07-16T12:00:00Z");
  });

  test("release, version absent → released ? <ts>", () => {
    expect(
      columns([makeEvent({ type: RELEASE_ANNOUNCED_EVENT_TYPE, payload: { channel: "stable" } })])
        .release,
    ).toBe("released ? 2026-07-16T12:00:00Z");
  });

  test("release, version blank → released ? <ts>", () => {
    expect(
      columns([makeEvent({ type: RELEASE_ANNOUNCED_EVENT_TYPE, payload: { version: "" } })]).release,
    ).toBe("released ? 2026-07-16T12:00:00Z");
  });

  test("the ts is the winning event's own, verbatim", () => {
    expect(columns([makeEvent({ ts: "2031-01-02T03:04:05Z", payload: { failed: 0 } })]).qa).toBe(
      "tested 2031-01-02T03:04:05Z",
    );
  });
});

describe("featureStatus — the dev rollup it carries", () => {
  test("dev and anomaly are exactly what featureDevStatus derives", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = epicWith(env, ["dropped"]);
    const node = makeNode(env, { epic: epic.id });

    const status = featureStatus(node, items, []);
    expect(status.dev).toBe("planned");
    expect(status.anomaly).toBe("all-dropped");
  });

  test("mutates none of its inputs", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items, node } = featureOverEpic(env);
    const events = [makeEvent({ item: epic.id, payload: { failed: 0 } })];
    const before = JSON.stringify({ items, events, node });

    featureStatus(node, items, events);
    featureStatus(node, items, events);

    expect(JSON.stringify({ items, events, node })).toBe(before);
  });
});

describe("featureStatus — the stage, by precedence (F9's table, F2's machinery)", () => {
  /** A feature over an epic whose children hold `statuses`, plus the events given. */
  function stageOf(
    statuses: readonly WorkItemFrontmatter["status"][],
    types: readonly string[],
  ): string {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = epicWith(env, statuses);
    const node = makeNode(env, { epic: epic.id });
    const events = types.map((type, index) =>
      makeEvent({
        id: `aaaaaaa${index}`,
        item: epic.id,
        type,
        ts: `2026-07-1${index + 1}T12:00:00Z`,
        payload: { failed: 0, environment: "prod", version: "0.3.0" },
      }),
    );
    return featureStatus(node, items, events).stage;
  }

  test("a covering release wins over everything below it", () => {
    expect(
      stageOf(["done"], [QA_SWEEP_EVENT_TYPE, DEPLOY_COMPLETED_EVENT_TYPE, RELEASE_ANNOUNCED_EVENT_TYPE]),
    ).toBe("released");
  });

  test("no release, a covering deploy → deployed", () => {
    expect(stageOf(["done"], [QA_SWEEP_EVENT_TYPE, DEPLOY_COMPLETED_EVENT_TYPE])).toBe("deployed");
  });

  test("no release or deploy, a covering sweep → tested", () => {
    expect(stageOf(["done"], [QA_SWEEP_EVENT_TYPE])).toBe("tested");
  });

  test("no covering events, dev built → built", () => {
    expect(stageOf(["done"], [])).toBe("built");
  });

  test("no covering events, dev in-flight → in-flight", () => {
    expect(stageOf(["done", "backlog"], [])).toBe("in-flight");
  });

  test("no covering events, dev planned → planned", () => {
    expect(stageOf(["backlog"], [])).toBe("planned");
  });

  test("no covering events, dev unknown → unknown", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const node = makeNode(env, { epic: "aaaaaaaa" });

    expect(featureStatus(node, [], []).stage).toBe("unknown");
  });

  test("a deploy recorded AFTER a release leaves the stage at released — precedence, not recency", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = epicWith(env, ["done"]);
    const node = makeNode(env, { epic: epic.id });
    const release = makeEvent({
      id: "aaaaaaa1",
      item: epic.id,
      type: RELEASE_ANNOUNCED_EVENT_TYPE,
      ts: "2026-07-16T12:00:00Z",
      payload: { version: "0.3.0" },
    });
    const laterDeploy = makeEvent({
      id: "aaaaaaa2",
      item: epic.id,
      type: DEPLOY_COMPLETED_EVENT_TYPE,
      ts: "2026-07-17T12:00:00Z",
      payload: { environment: "prod" },
    });

    expect(featureStatus(node, items, [release, laterDeploy]).stage).toBe("released");
  });

  test("a sweep covering a DIFFERENT feature does not lift this one past its dev status", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const subject = featureOverEpic(env);
    const other = featureOverEpic(env);
    const event = makeEvent({ item: other.epic.id, payload: { failed: 0 } });

    expect(featureStatus(subject.node, [...subject.items, ...other.items], [event]).stage).toBe(
      "built",
    );
  });

  test("dev unknown WITH a covering sweep still reads tested — the events are the higher rows", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const node = makeNode(env, { epic: "aaaaaaaa" });
    const event = makeEvent({ item: "aaaaaaaa", payload: { failed: 0 } });

    const status = featureStatus(node, [], [event]);
    expect(status.dev).toBe("unknown");
    expect(status.stage).toBe("tested");
  });

  test("a failing sweep still reaches tested — the stage says a sweep ran, not that it passed", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = epicWith(env, ["done"]);
    const node = makeNode(env, { epic: epic.id });
    const event = makeEvent({ item: epic.id, payload: { failed: 4 } });

    const status = featureStatus(node, items, [event]);
    expect(status.qa).toBe("tested 2026-07-16T12:00:00Z (4 failed)");
    expect(status.stage).toBe("tested");
  });
});

describe("featureStatus — the epic's subtree is walked once", () => {
  /**
   * Wrap each item so reading `parent` is counted. The subtree walk is the
   * only thing in this layer that reads `parent`, so the counter measures
   * WALKS without patching or mocking any function: the real code path runs
   * untouched over ordinary records that happen to keep a tally.
   */
  function countingItems(items: readonly WorkItemFrontmatter[]): {
    items: WorkItemFrontmatter[];
    reads: () => number;
  } {
    let reads = 0;
    const counted = items.map((item) => {
      const { parent, ...rest } = item;
      return Object.defineProperty({ ...rest } as WorkItemFrontmatter, "parent", {
        enumerable: true,
        get() {
          reads += 1;
          return parent;
        },
      });
    });
    return { items: counted, reads: () => reads };
  }

  test("featureStatus reads the item tree no more than the dev rollup alone does", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = epicWith(env, ["done", "backlog", "dropped"]);
    const child = items[1]!;
    items.push(makeFrontmatter(env, { name: "grandchild", status: "done", parent: child.id }));
    const node = makeNode(env, { epic: epic.id });
    const events = [makeEvent({ item: epic.id, payload: { failed: 0 } })];

    // The unit is one walk, whatever a walk costs — the comparison pins the
    // COUNT of walks without asserting anything about how one is performed.
    const rollup = countingItems(items);
    featureDevStatus(node, rollup.items);
    const full = countingItems(items);
    featureStatus(node, full.items, events);

    expect(rollup.reads()).toBeGreaterThan(0);
    expect(full.reads()).toBe(rollup.reads());
  });

  test("a node with no epic walks nothing at all", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { items } = epicWith(env, ["done"]);
    const node = makeNode(env);
    const counted = countingItems(items);

    featureStatus(node, counted.items, [makeEvent({ payload: { failed: 0 } })]);

    expect(counted.reads()).toBe(0);
  });

  test("a dangling epic id still walks once — coverage is by ref, so events still associate", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { items } = epicWith(env, ["done"]);
    const node = makeNode(env, { epic: "aaaaaaaa" });
    const counted = countingItems(items);

    const status = featureStatus(node, counted.items, [
      makeEvent({ item: "aaaaaaaa", payload: { failed: 0 } }),
    ]);

    expect(status.dev).toBe("unknown");
    expect(status.qa).toBe("tested 2026-07-16T12:00:00Z");
    expect(counted.reads()).toBeGreaterThan(0);
  });
});

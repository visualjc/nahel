import { describe, expect, test } from "bun:test";
import type { Env } from "../../src/schema/env";
import { generateId } from "../../src/schema/id";
import {
  CORE_EVENT_TYPES,
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
  BRIEF_ROADMAP_MAX_LINES,
  BRIEF_ROADMAP_NOW_CAP,
  featureDevStatus,
  featureStatus,
  productFeatureNodes,
  renderBriefRoadmap,
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

  /**
   * Changed with the Phase 4 epic review, which SUPERSEDES the earlier reading
   * (coverage by ref, so a dangling epic still associated). F2 states the rule
   * as RESOLUTION — an event covers a node iff its `item` resolves to that
   * node's epic item or to a descendant of it — and an id no record carries
   * resolves to nothing. The dev status still reads `unknown` and `validate`
   * still names the missing epic; what no longer happens is a logged deploy or
   * release carrying such a node to `deployed`/`released`, which crossed into
   * F9's stage and F10's archival precondition.
   */
  test("a dangling epic id covers NOTHING: dev unknown, every event column empty", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const node = makeNode(env, { epic: "aaaaaaaa" });
    const event = makeEvent({ item: "aaaaaaaa", payload: { failed: 0 } });

    const status = featureStatus(node, [], [event]);
    expect(status.dev).toBe("unknown");
    expect(status.qa).toBe("—");
    expect(status.stage).toBe("unknown");
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

  /**
   * Changed with the Phase 4 epic review, which SUPERSEDES the earlier reading
   * this case was written against ("the events are the higher rows, so a sweep
   * aimed at a dangling epic lifts the stage to tested"). Under the resolution
   * rule, dev `unknown` and a covering event are mutually exclusive: `unknown`
   * IS "the epic record is not there", and an id no record carries resolves to
   * nothing, so it covers nothing. The precedence table's last row —
   * "dev status `unknown`, no covering events" — is the only row a missing epic
   * can reach, exactly as the PRD spells it.
   */
  test("dev unknown reaches the table's last row: events aimed at the missing epic cover nothing", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const node = makeNode(env, { epic: "aaaaaaaa" });
    const event = makeEvent({ item: "aaaaaaaa", payload: { failed: 0 } });

    const status = featureStatus(node, [], [event]);
    expect(status.dev).toBe("unknown");
    expect(status.qa).toBe("—");
    expect(status.stage).toBe("unknown");
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

/**
 * Retraction (PR #26 follow-up A1): a lifecycle fact recorded in error is
 * withdrawn by a LATER event naming it, never by deleting the journal line —
 * the journal is append-only, so the correction is itself an act.
 *
 * The edge is the EVENT ID and nothing else: not the retraction's timestamp,
 * not its `item` ref, not who wrote it. A retracted fact leaves the
 * column-winner computation entirely and the winner is recomputed from the
 * survivors, so retracting the latest sweep promotes the one before it rather
 * than emptying the column.
 *
 * Only the three lifecycle facts may be retracted. A retraction naming
 * anything else — an item mutation, another retraction, an id no event carries
 * — is structurally invalid: `validate` warns, and the derivation ignores it
 * rather than guessing what was meant.
 */
describe("featureStatus — retracted lifecycle facts", () => {
  const COLUMN_RETRACTED = "roadmap.column-retracted";

  /** One retraction naming `target`, with the reason every retraction carries. */
  function retraction(id: string, target: string, ts = "2026-07-20T12:00:00Z"): JournalEvent {
    return makeEvent({
      id,
      ts,
      type: COLUMN_RETRACTED,
      payload: { event: target, reason: "logged against the wrong epic" },
    });
  }

  /** A feature over an epic with one done child, deriving over the events given. */
  function statusOf(build: (epic: string) => readonly JournalEvent[]) {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = epicWith(env, ["done"]);
    const node = makeNode(env, { epic: epic.id });
    return featureStatus(node, items, build(epic.id));
  }

  test("the winner is recomputed from the SURVIVORS, not emptied", () => {
    const status = statusOf((epic) => [
      makeEvent({ id: "aaaaaaa1", item: epic, ts: "2026-07-16T12:00:00Z", payload: { failed: 0 } }),
      makeEvent({ id: "aaaaaaa2", item: epic, ts: "2026-07-17T12:00:00Z", payload: { failed: 9 } }),
      retraction("aaaaaaa3", "aaaaaaa2"),
    ]);

    expect(status.qa).toBe("tested 2026-07-16T12:00:00Z");
    expect(status.stage).toBe("tested");
  });

  test("retracting the ONLY covering sweep empties the column and drops back to the rollup", () => {
    const status = statusOf((epic) => [
      makeEvent({ id: "aaaaaaa1", item: epic, payload: { failed: 0 } }),
      retraction("aaaaaaa3", "aaaaaaa1"),
    ]);

    expect(status.qa).toBe("—");
    expect(status.stage).toBe("built");
  });

  test("retracting the release drops the stage to the deploy below it", () => {
    const status = statusOf((epic) => [
      makeEvent({
        id: "aaaaaaa1",
        item: epic,
        type: DEPLOY_COMPLETED_EVENT_TYPE,
        payload: { environment: "prod" },
      }),
      makeEvent({
        id: "aaaaaaa2",
        item: epic,
        type: RELEASE_ANNOUNCED_EVENT_TYPE,
        payload: { version: "0.3.0" },
      }),
      retraction("aaaaaaa3", "aaaaaaa2"),
    ]);

    expect(status.release).toBe("—");
    expect(status.deploy).toBe("deployed prod 2026-07-16T12:00:00Z");
    expect(status.stage).toBe("deployed");
  });

  test("a retraction naming a NON-lifecycle event is ignored — the fact stands", () => {
    const status = statusOf((epic) => [
      makeEvent({
        id: "aaaaaaa0",
        item: epic,
        type: CORE_EVENT_TYPES.itemUpdated,
        payload: { target: "item" },
      }),
      makeEvent({ id: "aaaaaaa1", item: epic, payload: { failed: 0 } }),
      retraction("aaaaaaa3", "aaaaaaa0"),
    ]);

    expect(status.qa).toBe("tested 2026-07-16T12:00:00Z");
  });

  test("a retraction naming ANOTHER retraction is ignored; the first one still applies", () => {
    const status = statusOf((epic) => [
      makeEvent({ id: "aaaaaaa1", item: epic, payload: { failed: 0 } }),
      retraction("aaaaaaa3", "aaaaaaa1"),
      retraction("aaaaaaa4", "aaaaaaa3"),
    ]);

    expect(status.qa).toBe("—");
  });

  test("a retraction naming an id no event carries changes nothing at all", () => {
    const status = statusOf((epic) => [
      makeEvent({ id: "aaaaaaa1", item: epic, payload: { failed: 0 } }),
      retraction("aaaaaaa3", "zzzzzzzz"),
    ]);

    expect(status.qa).toBe("tested 2026-07-16T12:00:00Z");
  });

  test("two identical retractions are one — retraction is idempotent", () => {
    const status = statusOf((epic) => [
      makeEvent({ id: "aaaaaaa1", item: epic, ts: "2026-07-16T12:00:00Z", payload: { failed: 0 } }),
      makeEvent({ id: "aaaaaaa2", item: epic, ts: "2026-07-17T12:00:00Z", payload: { failed: 9 } }),
      retraction("aaaaaaa3", "aaaaaaa2"),
      retraction("aaaaaaa4", "aaaaaaa2"),
    ]);

    expect(status.qa).toBe("tested 2026-07-16T12:00:00Z");
  });

  test("a retraction recorded BEFORE the fact it names still removes it — the id is the edge", () => {
    const status = statusOf((epic) => [
      retraction("aaaaaaa3", "aaaaaaa1", "2026-01-01T00:00:00Z"),
      makeEvent({ id: "aaaaaaa1", item: epic, payload: { failed: 0 } }),
    ]);

    expect(status.qa).toBe("—");
  });

  test("a retraction carrying no item ref of its own still removes the fact it names", () => {
    const status = statusOf((epic) => [
      makeEvent({ id: "aaaaaaa1", item: epic, payload: { failed: 0 } }),
      // No `item` on the retraction — coverage is the FACT's business.
      retraction("aaaaaaa3", "aaaaaaa1"),
    ]);

    expect(status.qa).toBe("—");
  });

  test("a retraction whose payload names no event is ignored, not read as a wildcard", () => {
    const status = statusOf((epic) => [
      makeEvent({ id: "aaaaaaa1", item: epic, payload: { failed: 0 } }),
      makeEvent({
        id: "aaaaaaa3",
        type: COLUMN_RETRACTED,
        payload: { reason: "no target recorded" },
      }),
      makeEvent({ id: "aaaaaaa4", type: COLUMN_RETRACTED, payload: { event: "  ", reason: "x" } }),
    ]);

    expect(status.qa).toBe("tested 2026-07-16T12:00:00Z");
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

  test("a dangling epic walks NOTHING — there is no subtree to walk", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { items } = epicWith(env, ["done"]);
    const node = makeNode(env, { epic: "aaaaaaaa" });
    const counted = countingItems(items);

    const status = featureStatus(node, counted.items, [
      makeEvent({ item: "aaaaaaaa", payload: { failed: 0 } }),
    ]);

    // Superseded by the epic review: an id no record carries resolves to
    // nothing, so it covers nothing (see the association test above) — and the
    // walk that used to seed itself with that id does not happen at all.
    expect(status.dev).toBe("unknown");
    expect(status.qa).toBe("—");
    expect(counted.reads()).toBe(0);
  });
});

/**
 * The brief's roadmap block (Phase 4 F4): DETERMINISTIC ELISION, not a
 * completeness promise the cap cannot keep. Many parallel `now`s are doctrine
 * (F8), so the block degrades predictably — at most ten `now` nodes in
 * horizon-entry order, the remainder counted, and one summary line per further
 * horizon, inside a hard thirteen-line budget.
 */

/** A node RECORD (frontmatter plus its intent prose) for the block renderer. */
function makeNodeRecord(
  env: Env,
  overrides: Partial<RoadmapNodeFrontmatter> = {},
): RoadmapNodeRecord {
  return { frontmatter: makeNode(env, overrides), body: "" };
}

/**
 * A `roadmap.node-created` / `roadmap.node-updated` event carrying the node
 * record, exactly as mutate() journals one (`{target, record, body}`).
 */
function nodeEvent(
  env: Env,
  node: RoadmapNodeFrontmatter,
  type: string,
  ts: string,
  seq = 0,
): JournalEvent {
  return {
    id: generateId(env),
    ts,
    seq,
    type,
    actor: { kind: "agent", id: "claude-code" },
    payload: { target: "roadmap-node", record: node, body: "" },
  };
}

/** The creation event that put a node on its (unchanged) horizon. */
function created(env: Env, node: RoadmapNodeFrontmatter, ts: string): JournalEvent {
  return nodeEvent(env, node, CORE_EVENT_TYPES.roadmapNodeCreated, ts);
}

/** A re-horizoning event: the same node, recorded carrying a new horizon. */
function rehorizoned(
  env: Env,
  node: RoadmapNodeFrontmatter,
  horizon: RoadmapNodeFrontmatter["horizon"],
  ts: string,
): JournalEvent {
  return nodeEvent(env, { ...node, horizon }, CORE_EVENT_TYPES.roadmapNodeUpdated, ts);
}

/** A timestamp n seconds into 2026-07-16T12:00:00Z, the fixtures' epoch. */
function at(second: number): string {
  return `2026-07-16T12:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(
    second % 60,
  ).padStart(2, "0")}Z`;
}

describe("renderBriefRoadmap — the block's presence", () => {
  test("a store with no nodes renders NOTHING — absent, not empty scaffolding", () => {
    expect(renderBriefRoadmap([], [], [])).toBeNull();
  });

  test("a store whose only nodes sit on later still renders: the horizons speak", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const node = makeNodeRecord(env, { name: "someday", horizon: "later" });

    const block = renderBriefRoadmap([node], [], [created(env, node.frontmatter, at(1))]);

    expect(block).not.toBeNull();
    expect(block!.split("\n")).toEqual(["now: none", "next: none", "later: 1 node"]);
  });
});

describe("renderBriefRoadmap — deterministic elision at the cap", () => {
  /** `count` now-nodes, each created one second later than the last. */
  function manyNow(count: number): { nodes: RoadmapNodeRecord[]; events: JournalEvent[] } {
    const env = seededEnv({ tickSeconds: 1 });
    const nodes: RoadmapNodeRecord[] = [];
    const events: JournalEvent[] = [];
    for (let i = 0; i < count; i += 1) {
      const node = makeNodeRecord(env, { name: `feature-${String(i).padStart(2, "0")}` });
      nodes.push(node);
      events.push(created(env, node.frontmatter, at(i)));
    }
    return { nodes, events };
  }

  test("40 now nodes → exactly 10 lines, a +30 more line, and the two summaries", () => {
    const { nodes, events } = manyNow(40);

    const lines = renderBriefRoadmap(nodes, [], events)!.split("\n");

    expect(lines.length).toBe(13);
    expect(lines.length).toBeLessThanOrEqual(BRIEF_ROADMAP_MAX_LINES);
    expect(lines.slice(0, 10).map((line) => line.split("  ")[0])).toEqual([
      "feature-00",
      "feature-01",
      "feature-02",
      "feature-03",
      "feature-04",
      "feature-05",
      "feature-06",
      "feature-07",
      "feature-08",
      "feature-09",
    ]);
    expect(lines[10]).toBe("+30 more — nahel roadmap");
    expect(lines[11]).toBe("next: none");
    expect(lines[12]).toBe("later: none");
  });

  test("re-rendering after an unrelated mutation returns the same 10 in the same order", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { nodes, events } = manyNow(40);
    const first = renderBriefRoadmap(nodes, [], events);

    const unrelated: JournalEvent = {
      id: generateId(env),
      ts: at(300),
      seq: 0,
      type: "item.created",
      actor: { kind: "agent", id: "claude-code" },
      payload: { target: "item", record: makeFrontmatter(env), body: "" },
    };

    expect(renderBriefRoadmap(nodes, [], [...events, unrelated])).toBe(first!);
  });

  test("exactly at the cap there is no remainder line at all", () => {
    const { nodes, events } = manyNow(10);

    const lines = renderBriefRoadmap(nodes, [], events)!.split("\n");

    expect(lines.length).toBe(12);
    expect(lines.some((line) => line.includes("more — nahel roadmap"))).toBe(false);
  });

  test("one over the cap counts the one", () => {
    const { nodes, events } = manyNow(11);

    expect(renderBriefRoadmap(nodes, [], events)!.split("\n")[10]).toBe(
      "+1 more — nahel roadmap",
    );
  });
});

describe("renderBriefRoadmap — horizon-entry order", () => {
  test("oldest entry first, and it is the act that set the CURRENT horizon", () => {
    const env = seededEnv({ tickSeconds: 1 });
    // Charted first, but re-horizoned away and back: it entered `now` LAST.
    const returned = makeNodeRecord(env, { name: "returned" });
    const steady = makeNodeRecord(env, { name: "steady" });
    const events = [
      created(env, returned.frontmatter, at(1)),
      rehorizoned(env, returned.frontmatter, "next", at(2)),
      created(env, steady.frontmatter, at(3)),
      rehorizoned(env, returned.frontmatter, "now", at(4)),
    ];

    const lines = renderBriefRoadmap([returned, steady], [], events)!.split("\n");

    expect(lines.slice(0, 2).map((line) => line.split("  ")[0])).toEqual(["steady", "returned"]);
  });

  test("an update that leaves the horizon alone does not restart the clock", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const renamed = makeNodeRecord(env, { name: "renamed" });
    const later = makeNodeRecord(env, { name: "later-chartered" });
    const events = [
      created(env, renamed.frontmatter, at(1)),
      created(env, later.frontmatter, at(2)),
      // Same horizon, new intent — the node never left `now`.
      nodeEvent(env, renamed.frontmatter, CORE_EVENT_TYPES.roadmapNodeUpdated, at(9)),
    ];

    const lines = renderBriefRoadmap([renamed, later], [], events)!.split("\n");

    expect(lines.slice(0, 2).map((line) => line.split("  ")[0])).toEqual([
      "renamed",
      "later-chartered",
    ]);
  });

  test("same-second entries fall through to seq, then to the event id", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const second = makeNodeRecord(env, { name: "zzz-second" });
    const first = makeNodeRecord(env, { name: "aaa-first" });
    const events = [
      nodeEvent(env, first.frontmatter, CORE_EVENT_TYPES.roadmapNodeCreated, at(1), 0),
      nodeEvent(env, second.frontmatter, CORE_EVENT_TYPES.roadmapNodeCreated, at(1), 1),
    ];

    // seq decides, NOT the slug: the journal's own total order is the rule.
    const lines = renderBriefRoadmap([second, first], [], events)!.split("\n");
    expect(lines.slice(0, 2).map((line) => line.split("  ")[0])).toEqual([
      "aaa-first",
      "zzz-second",
    ]);
  });

  test("a node no journaled act explains sorts LAST, and those tie by slug", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const journaled = makeNodeRecord(env, { name: "journaled" });
    const orphanB = makeNodeRecord(env, { name: "b-orphan" });
    const orphanA = makeNodeRecord(env, { name: "a-orphan" });

    const lines = renderBriefRoadmap(
      [orphanB, orphanA, journaled],
      [],
      [created(env, journaled.frontmatter, at(5))],
    )!.split("\n");

    expect(lines.slice(0, 3).map((line) => line.split("  ")[0])).toEqual([
      "journaled",
      "a-orphan",
      "b-orphan",
    ]);
  });

  test("a record whose horizon the journal never reached is unexplained, not misdated", () => {
    const env = seededEnv({ tickSeconds: 1 });
    // The record says `now`; the journal only ever recorded it on `next` — a
    // hand-edit or a compacted history. No act set THIS horizon.
    const drifted = makeNodeRecord(env, { name: "drifted" });
    const explained = makeNodeRecord(env, { name: "explained" });
    const events = [
      nodeEvent(
        env,
        { ...drifted.frontmatter, horizon: "next" },
        CORE_EVENT_TYPES.roadmapNodeCreated,
        at(1),
      ),
      created(env, explained.frontmatter, at(9)),
    ];

    const lines = renderBriefRoadmap([drifted, explained], [], events)!.split("\n");

    expect(lines.slice(0, 2).map((line) => line.split("  ")[0])).toEqual([
      "explained",
      "drifted",
    ]);
  });
});

describe("renderBriefRoadmap — what each line says", () => {
  test("a feature carries F2's single-word stage; a product carries its distribution", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { epic, items } = epicWith(env, ["done"]);
    const product = makeNodeRecord(env, { name: "nahel", kind: "product" });
    const feature = makeNodeRecord(env, {
      name: "detached-state-repo",
      parent: product.frontmatter.id,
      epic: epic.id,
    });
    const events = [
      created(env, product.frontmatter, at(1)),
      created(env, feature.frontmatter, at(2)),
    ];

    const lines = renderBriefRoadmap([product, feature], items, events)!.split("\n");

    expect(lines[0]).toBe(
      `nahel  product  1 built · 0 in-flight · 0 planned · 0 unknown  id=${product.frontmatter.id}`,
    );
    expect(lines[1]).toBe(
      `detached-state-repo  feature  built  id=${feature.frontmatter.id}`,
    );
  });

  test("an initiative claims no derived status — the layer refuses to invent one", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const initiative = makeNodeRecord(env, { name: "q3-push", kind: "initiative" });

    const lines = renderBriefRoadmap(
      [initiative],
      [],
      [created(env, initiative.frontmatter, at(1))],
    )!.split("\n");

    expect(lines[0]).toBe(`q3-push  initiative  id=${initiative.frontmatter.id}`);
  });

  test("the summary lines count the other two horizons, singular and plural", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const nodes = [
      makeNodeRecord(env, { name: "a-now" }),
      makeNodeRecord(env, { name: "b-next", horizon: "next" }),
      makeNodeRecord(env, { name: "c-next", horizon: "next" }),
      makeNodeRecord(env, { name: "d-later", horizon: "later" }),
    ];
    const events = nodes.map((node, i) => created(env, node.frontmatter, at(i)));

    const lines = renderBriefRoadmap(nodes, [], events)!.split("\n");

    expect(lines[1]).toBe("next: 2 nodes");
    expect(lines[2]).toBe("later: 1 node");
  });

  test("the block never exceeds its budget, whatever the store holds", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const nodes: RoadmapNodeRecord[] = [];
    const events: JournalEvent[] = [];
    for (let i = 0; i < 60; i += 1) {
      const horizon = (["now", "next", "later"] as const)[i % 3]!;
      const node = makeNodeRecord(env, { name: `node-${String(i).padStart(2, "0")}`, horizon });
      nodes.push(node);
      events.push(created(env, node.frontmatter, at(i)));
    }

    expect(renderBriefRoadmap(nodes, [], events)!.split("\n").length).toBeLessThanOrEqual(
      BRIEF_ROADMAP_MAX_LINES,
    );
    expect(BRIEF_ROADMAP_NOW_CAP).toBe(10);
  });
});

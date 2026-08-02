import { describe, expect, test } from "bun:test";
import type { Env } from "../../src/schema/env";
import {
  CORE_EVENT_TYPES,
  DEPLOY_COMPLETED_EVENT_TYPE,
  QA_SWEEP_EVENT_TYPE,
  RELEASE_ANNOUNCED_EVENT_TYPE,
} from "../../src/schema/events";
import { generateId } from "../../src/schema/id";
import type {
  JournalEvent,
  RoadmapNodeFrontmatter,
  WorkItemFrontmatter,
} from "../../src/schema/records";
import type { RoadmapNodeRecord } from "../../src/store/layout";
import { renderStandup, resolveSince } from "../../src/views/standup";
import { makeFrontmatter, makeRun, seededEnv } from "../store/helpers";

/**
 * `nahel standup --since` (Phase 4 F4): a CURATED read over the journal for a
 * time window — what moved, what shipped, what parked, what got blocked —
 * grouped by roadmap node and item. Zero new state, one rendered line per
 * journal act, and every line traceable back to the act by its id.
 */

const NOW = "2026-08-02T09:15:00Z";

/** A node record; id and timestamps from the seeded env. */
function makeNode(env: Env, overrides: Partial<RoadmapNodeFrontmatter> = {}): RoadmapNodeRecord {
  const ts = env.now();
  return {
    frontmatter: {
      id: generateId(env),
      name: "a-feature",
      kind: "feature",
      horizon: "now",
      created: ts,
      updated: ts,
      ...overrides,
    },
    body: "",
  };
}

/** A mutation event carrying an item record, as mutate() journals one. */
function itemEvent(
  env: Env,
  item: WorkItemFrontmatter,
  ts: string,
  type: string = CORE_EVENT_TYPES.itemUpdated,
): JournalEvent {
  return {
    id: generateId(env),
    ts,
    seq: 0,
    type,
    actor: { kind: "agent", id: "claude-code" },
    item: item.id,
    payload: { target: "item", record: item, body: "" },
  };
}

/** An open-extension event (qa/deploy/release), as `nahel log` writes one. */
function logged(
  env: Env,
  type: string,
  item: string | undefined,
  payload: Record<string, unknown>,
  ts: string,
): JournalEvent {
  return {
    id: generateId(env),
    ts,
    seq: 0,
    type,
    actor: { kind: "agent", id: "claude-code" },
    ...(item === undefined ? {} : { item }),
    payload,
  };
}

/** An epic, one child, and a feature node covering the epic. */
function charted(env: Env) {
  const epic = makeFrontmatter(env, { name: "demo-epic", type: "plan", lane: "full" });
  const child = makeFrontmatter(env, { name: "leaf-work", parent: epic.id });
  const node = makeNode(env, { name: "detached-state-repo", epic: epic.id });
  return { epic, child, node, items: [epic, child] };
}

describe("resolveSince — relative windows off the injected clock, never a Date", () => {
  test("a day window subtracts whole days from the injected now", () => {
    expect(resolveSince("7d", NOW)).toBe("2026-07-26T09:15:00Z");
    expect(resolveSince("1d", NOW)).toBe("2026-08-01T09:15:00Z");
  });

  test("an hour window subtracts whole hours", () => {
    expect(resolveSince("24h", NOW)).toBe("2026-08-01T09:15:00Z");
    expect(resolveSince("2h", NOW)).toBe("2026-08-02T07:15:00Z");
  });

  test("a relative window and its equivalent absolute timestamp resolve identically", () => {
    expect(resolveSince("7d", NOW)).toBe(resolveSince("2026-07-26T09:15:00Z", NOW));
  });

  test("an absolute timestamp in the journal's own format passes through unchanged", () => {
    expect(resolveSince("2026-01-01T00:00:00Z", NOW)).toBe("2026-01-01T00:00:00Z");
  });

  test("a zero window is the instant itself, not an error", () => {
    expect(resolveSince("0d", NOW)).toBe(NOW);
  });

  test("anything else is undefined — the caller says what the accepted forms are", () => {
    for (const bad of ["", "7", "d", "7w", "-1d", "7 d", "7D", "yesterday", "2026-08-02"]) {
      expect(resolveSince(bad, NOW)).toBeUndefined();
    }
  });
});

describe("renderStandup — the window's honest empty output", () => {
  test("nothing moved → the window is stated and the emptiness is explicit", () => {
    expect(
      renderStandup({ since: "2026-07-26T09:15:00Z", nodes: [], items: [], runs: [], events: [] }),
    ).toBe("standup since 2026-07-26T09:15:00Z\n\nno movement in this window");
  });

  test("acts BEFORE the cutoff are not movement — they only set the baseline", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const { child, node, items } = charted(env);

    const out = renderStandup({
      since: "2026-07-26T09:15:00Z",
      nodes: [node],
      items,
      runs: [],
      events: [itemEvent(env, { ...child, status: "in-progress" }, "2026-07-20T08:00:00Z")],
    });

    expect(out).toContain("no movement in this window");
  });
});

describe("renderStandup — the verbs, one per journaled act", () => {
  /** Render one window over the given events, with the charted fixture. */
  function standupOf(
    env: Env,
    fixture: ReturnType<typeof charted>,
    events: readonly JournalEvent[],
  ): string {
    return renderStandup({
      since: "2026-07-26T09:15:00Z",
      nodes: [fixture.node],
      items: fixture.items,
      runs: [],
      events,
    });
  }

  test("a status transition to done reads `closed`, with where it came from", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const fixture = charted(env);
    const started = itemEvent(
      env,
      { ...fixture.child, status: "in-progress" },
      "2026-07-20T08:00:00Z",
    );
    const closed = itemEvent(env, { ...fixture.child, status: "done" }, "2026-07-30T09:00:00Z");

    const out = standupOf(env, fixture, [started, closed]);

    expect(out).toContain(
      `    2026-07-30T09:00:00Z  closed  in-progress → done  act=${closed.id}`,
    );
  });

  test("blocked, dropped and ordinary moves each get their own word", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const fixture = charted(env);
    const moved = itemEvent(
      env,
      { ...fixture.child, status: "in-progress" },
      "2026-07-27T08:00:00Z",
    );
    const blocked = itemEvent(env, { ...fixture.child, status: "blocked" }, "2026-07-28T08:00:00Z");
    const parked = itemEvent(env, { ...fixture.child, status: "dropped" }, "2026-07-29T08:00:00Z");

    const out = standupOf(env, fixture, [moved, blocked, parked]);

    expect(out).toContain(`moved  backlog → in-progress  act=${moved.id}`);
    expect(out).toContain(`blocked  in-progress → blocked  act=${blocked.id}`);
    expect(out).toContain(`parked  blocked → dropped  act=${parked.id}`);
  });

  test("an item created inside the window reads `opened`, with the status it started at", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const fixture = charted(env);
    const opened = itemEvent(
      env,
      fixture.child,
      "2026-07-28T08:00:00Z",
      CORE_EVENT_TYPES.itemCreated,
    );

    expect(standupOf(env, fixture, [opened])).toContain(`opened  backlog  act=${opened.id}`);
  });

  test("an act that moved no status is not movement — a claim is not a transition", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const fixture = charted(env);
    const created = itemEvent(
      env,
      fixture.child,
      "2026-07-20T08:00:00Z",
      CORE_EVENT_TYPES.itemCreated,
    );
    const claimed = itemEvent(
      env,
      { ...fixture.child, claimed_by: "jim" },
      "2026-07-28T08:00:00Z",
      CORE_EVENT_TYPES.itemClaimed,
    );

    expect(standupOf(env, fixture, [created, claimed])).toContain("no movement in this window");
  });

  test("a paused run reads `parked`, naming the run", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const fixture = charted(env);
    const run = makeRun(env, fixture.child.id, { status: "paused" });
    const paused: JournalEvent = {
      id: generateId(env),
      ts: "2026-07-29T08:00:00Z",
      seq: 0,
      type: CORE_EVENT_TYPES.runPaused,
      actor: { kind: "agent", id: "claude-code" },
      item: fixture.child.id,
      run: run.id,
      payload: { target: "run", record: run },
    };

    const out = renderStandup({
      since: "2026-07-26T09:15:00Z",
      nodes: [fixture.node],
      items: fixture.items,
      runs: [{ run, hotState: null }],
      events: [paused],
    });

    expect(out).toContain(`parked  run ${run.id}  act=${paused.id}`);
  });

  test("a sweep reads `tested`; a deploy and a release both read `shipped`", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const fixture = charted(env);
    const sweep = logged(
      env,
      QA_SWEEP_EVENT_TYPE,
      fixture.child.id,
      { cases_run: 12, failed: 2 },
      "2026-07-28T08:00:00Z",
    );
    const deploy = logged(
      env,
      DEPLOY_COMPLETED_EVENT_TYPE,
      fixture.child.id,
      { environment: "staging" },
      "2026-07-29T08:00:00Z",
    );
    const release = logged(
      env,
      RELEASE_ANNOUNCED_EVENT_TYPE,
      fixture.child.id,
      { version: "0.3.0" },
      "2026-07-30T08:00:00Z",
    );

    const out = standupOf(env, fixture, [sweep, deploy, release]);

    expect(out).toContain(`tested  2 failed  act=${sweep.id}`);
    expect(out).toContain(`shipped  deployed staging  act=${deploy.id}`);
    expect(out).toContain(`shipped  released 0.3.0  act=${release.id}`);
  });

  test("a lifecycle payload missing its one rendered key degrades visibly, never silently", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const fixture = charted(env);
    const deploy = logged(
      env,
      DEPLOY_COMPLETED_EVENT_TYPE,
      fixture.child.id,
      {},
      "2026-07-29T08:00:00Z",
    );

    expect(standupOf(env, fixture, [deploy])).toContain(`shipped  deployed ?  act=${deploy.id}`);
  });

  test("an ordinary note is not movement — the read is CURATED, not the timeline", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const fixture = charted(env);
    const note = logged(
      env,
      CORE_EVENT_TYPES.note,
      fixture.child.id,
      { text: "thinking out loud" },
      "2026-07-28T08:00:00Z",
    );

    expect(standupOf(env, fixture, [note])).toContain("no movement in this window");
  });
});

describe("renderStandup — grouping by node and item", () => {
  test("movement groups under the node whose epic covers the item, then under the item", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const fixture = charted(env);
    const closed = itemEvent(env, { ...fixture.child, status: "done" }, "2026-07-30T09:00:00Z");

    const out = renderStandup({
      since: "2026-07-26T09:15:00Z",
      nodes: [fixture.node],
      items: fixture.items,
      runs: [],
      events: [closed],
    });

    expect(out.split("\n")).toEqual([
      "standup since 2026-07-26T09:15:00Z",
      "",
      `detached-state-repo  feature  built  id=${fixture.node.frontmatter.id}`,
      `  leaf-work  id=${fixture.child.id}`,
      `    2026-07-30T09:00:00Z  closed  backlog → done  act=${closed.id}`,
    ]);
  });

  test("movement no node covers is grouped, never dropped", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const fixture = charted(env);
    const solo = makeFrontmatter(env, { name: "solo-chore", type: "chore" });
    const moved = itemEvent(env, { ...solo, status: "in-progress" }, "2026-07-30T09:00:00Z");

    const out = renderStandup({
      since: "2026-07-26T09:15:00Z",
      nodes: [fixture.node],
      items: [...fixture.items, solo],
      runs: [],
      events: [moved],
    });

    expect(out).toContain("outside the roadmap");
    expect(out).toContain(`  solo-chore  id=${solo.id}`);
    expect(out).toContain(`moved  backlog → in-progress  act=${moved.id}`);
  });

  test("an act carrying no item ref is still shown, under its own bucket", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const release = logged(
      env,
      RELEASE_ANNOUNCED_EVENT_TYPE,
      undefined,
      { version: "0.3.0" },
      "2026-07-30T09:00:00Z",
    );

    const out = renderStandup({
      since: "2026-07-26T09:15:00Z",
      nodes: [],
      items: [],
      runs: [],
      events: [release],
    });

    expect(out).toContain("outside the roadmap");
    expect(out).toContain("  (no item ref)");
    expect(out).toContain(`shipped  released 0.3.0  act=${release.id}`);
  });

  test("nested epics: both covering nodes report the act, the way F2's columns do", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const outer = makeFrontmatter(env, { name: "outer-epic", type: "plan", lane: "full" });
    const inner = makeFrontmatter(env, {
      name: "inner-epic",
      type: "plan",
      lane: "full",
      parent: outer.id,
    });
    const leaf = makeFrontmatter(env, { name: "leaf-work", parent: inner.id });
    const outerNode = makeNode(env, { name: "a-outer", epic: outer.id });
    const innerNode = makeNode(env, { name: "b-inner", epic: inner.id });
    const closed = itemEvent(env, { ...leaf, status: "done" }, "2026-07-30T09:00:00Z");

    const out = renderStandup({
      since: "2026-07-26T09:15:00Z",
      nodes: [outerNode, innerNode],
      items: [outer, inner, leaf],
      runs: [],
      events: [closed],
    });

    expect(out).toContain(`a-outer  feature  built  id=${outerNode.frontmatter.id}`);
    expect(out).toContain(`b-inner  feature  built  id=${innerNode.frontmatter.id}`);
    expect(out.split(`act=${closed.id}`).length - 1).toBe(2);
  });

  test("a node with no movement is silent — a standup lists what moved", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const fixture = charted(env);
    const quiet = makeNode(env, { name: "quiet-node" });
    const closed = itemEvent(env, { ...fixture.child, status: "done" }, "2026-07-30T09:00:00Z");

    const out = renderStandup({
      since: "2026-07-26T09:15:00Z",
      nodes: [fixture.node, quiet],
      items: fixture.items,
      runs: [],
      events: [closed],
    });

    expect(out).not.toContain("quiet-node");
  });
});

describe("renderStandup — determinism", () => {
  test("acts arriving in any order render in the store's canonical order", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const fixture = charted(env);
    const first = itemEvent(
      env,
      { ...fixture.child, status: "in-progress" },
      "2026-07-27T08:00:00Z",
    );
    const second = itemEvent(env, { ...fixture.child, status: "done" }, "2026-07-30T09:00:00Z");
    const inputs = {
      since: "2026-07-26T09:15:00Z",
      nodes: [fixture.node],
      items: fixture.items,
      runs: [],
    };

    const forwards = renderStandup({ ...inputs, events: [first, second] });
    const backwards = renderStandup({ ...inputs, events: [second, first] });

    expect(backwards).toBe(forwards);
    expect(forwards.indexOf(first.id)).toBeLessThan(forwards.indexOf(second.id));
  });

  test("rendering twice over the same facts is byte-identical", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const fixture = charted(env);
    const inputs = {
      since: "2026-07-26T09:15:00Z",
      nodes: [fixture.node],
      items: fixture.items,
      runs: [],
      events: [itemEvent(env, { ...fixture.child, status: "done" }, "2026-07-30T09:00:00Z")],
    };

    expect(renderStandup(inputs)).toBe(renderStandup(inputs));
  });
});

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
import { compareEvents } from "../../src/store/journal";
import type { RoadmapNodeRecord } from "../../src/store/layout";
import {
  collectStandupWindow,
  isStandupEvent,
  renderStandup,
  resolveSince,
} from "../../src/views/standup";
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

/**
 * An epic, one child, and a feature node covering the epic. `items` carries the
 * child at `status` — the RECORD state the node's derived stage reads — while
 * `birth` is the child's creation act, journaled before the window, which is
 * what a transition inside the window is measured against.
 */
function charted(env: Env, status: WorkItemFrontmatter["status"] = "backlog") {
  const epic = makeFrontmatter(env, { name: "demo-epic", type: "plan", lane: "full" });
  const child = makeFrontmatter(env, { name: "leaf-work", parent: epic.id });
  const node = makeNode(env, { name: "detached-state-repo", epic: epic.id });
  const birth = itemEvent(env, child, "2026-07-01T08:00:00Z", CORE_EVENT_TYPES.itemCreated);
  return { epic, child, node, birth, items: [epic, { ...child, status }] };
}

/** The resolved cutoff, failing the test loudly when the spec was refused. */
function since(spec: string, now = NOW): string {
  const resolved = resolveSince(spec, now);
  if ("error" in resolved) throw new Error(`expected ${spec} to resolve: ${resolved.error}`);
  return resolved.since;
}

/** The refusal reason, failing the test loudly when the spec resolved. */
function refusal(spec: string, now = NOW): string {
  const resolved = resolveSince(spec, now);
  if (!("error" in resolved)) throw new Error(`expected ${spec} to be refused`);
  return resolved.error;
}

describe("resolveSince — relative windows off the injected clock, never a Date", () => {
  test("a day window subtracts whole days from the injected now", () => {
    expect(since("7d")).toBe("2026-07-26T09:15:00Z");
    expect(since("1d")).toBe("2026-08-01T09:15:00Z");
  });

  test("an hour window subtracts whole hours", () => {
    expect(since("24h")).toBe("2026-08-01T09:15:00Z");
    expect(since("2h")).toBe("2026-08-02T07:15:00Z");
  });

  test("a relative window and its equivalent absolute timestamp resolve identically", () => {
    expect(since("7d")).toBe(since("2026-07-26T09:15:00Z"));
  });

  test("an absolute timestamp in the journal's own format passes through unchanged", () => {
    expect(since("2026-01-01T00:00:00Z")).toBe("2026-01-01T00:00:00Z");
  });

  test("a zero window is the instant itself, not an error", () => {
    expect(since("0d")).toBe(NOW);
  });

  test("an unrecognized spelling is refused, and the reason names both accepted forms", () => {
    for (const bad of ["", "7", "d", "7w", "-1d", "7 d", "7D", "yesterday", "2026-08-02"]) {
      const reason = refusal(bad);
      expect(reason).toContain("7d");
      expect(reason).toContain("24h");
      expect(reason).toContain("timestamp");
    }
  });
});

/**
 * A window is a question about time, and some strings that LOOK like one name
 * no time at all (codex review, F4). Each is refused with its own sentence,
 * because "February 30th is not a date" and "a billion days reaches past the
 * calendar" are different mistakes and only a named one is fixable.
 */
describe("resolveSince — specs that name no instant", () => {
  test("a timestamp of the right shape but an impossible date is refused, and SAID so", () => {
    for (const bad of [
      "2026-02-30T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2023-02-29T00:00:00Z",
    ]) {
      const reason = refusal(bad);
      expect(reason).toContain(bad);
      expect(reason).toContain("no real instant");
    }
  });

  test("a window reaching past the representable calendar is refused, never rendered", () => {
    for (const huge of ["999999999d", "800000d", "99999999999h"]) {
      const reason = refusal(huge);
      expect(reason).toContain(huge);
      // The bug this replaces: a malformed year rendered as if it were a date.
      expect(reason).not.toMatch(/^standup/);
    }
    // The boundary holds on the other side: a large but reachable window works,
    // and lands on the same day the platform's own calendar puts it (checked
    // independently, 274 years back through the Gregorian century rules).
    expect(since("100000d")).toBe("1752-10-17T09:15:00Z");
  });

  test("a window whose digits exceed a safe integer is refused, not silently rounded", () => {
    expect(refusal("99999999999999999999999d")).toContain("too large");
  });

  test("a clock reading that names no instant refuses rather than dating the window", () => {
    expect(refusal("7d", "2026-02-30T00:00:00Z")).toContain("clock reading");
  });
});

describe("renderStandup — the window's honest empty output", () => {
  test("nothing moved → the window is stated and the emptiness is explicit", () => {
    expect(
      renderStandup({
        since: "2026-07-26T09:15:00Z",
        nodes: [],
        items: [],
        runs: [],
        events: [],
        baseline: new Map(),
      }),
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
      baseline: new Map(),
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
      baseline: new Map(),
      events,
    });
  }

  test("a status transition to done reads `closed`, with where it came from", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const fixture = charted(env, "done");
    const started = itemEvent(
      env,
      { ...fixture.child, status: "in-progress" },
      "2026-07-20T08:00:00Z",
    );
    const closed = itemEvent(env, { ...fixture.child, status: "done" }, "2026-07-30T09:00:00Z");

    const out = standupOf(env, fixture, [fixture.birth, started, closed]);

    expect(out).toContain(
      `    2026-07-30T09:00:00Z  closed  in-progress → done  act=${closed.id}`,
    );
  });

  test("a transition whose earlier history the journal does not carry says so", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const fixture = charted(env, "done");
    // No creation act — a compacted archive, or work that predates this journal.
    const closed = itemEvent(env, { ...fixture.child, status: "done" }, "2026-07-30T09:00:00Z");

    expect(standupOf(env, fixture, [closed])).toContain(`closed  → done  act=${closed.id}`);
  });

  test("blocked, dropped and ordinary moves each get their own word", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const fixture = charted(env, "dropped");
    const moved = itemEvent(
      env,
      { ...fixture.child, status: "in-progress" },
      "2026-07-27T08:00:00Z",
    );
    const blocked = itemEvent(env, { ...fixture.child, status: "blocked" }, "2026-07-28T08:00:00Z");
    const parked = itemEvent(env, { ...fixture.child, status: "dropped" }, "2026-07-29T08:00:00Z");

    const out = standupOf(env, fixture, [fixture.birth, moved, blocked, parked]);

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
      baseline: new Map(),
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
    const fixture = charted(env, "done");
    const closed = itemEvent(env, { ...fixture.child, status: "done" }, "2026-07-30T09:00:00Z");

    const out = renderStandup({
      since: "2026-07-26T09:15:00Z",
      nodes: [fixture.node],
      items: fixture.items,
      runs: [],
      baseline: new Map(),
      events: [fixture.birth, closed],
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
    const born = itemEvent(env, solo, "2026-07-01T08:00:00Z", CORE_EVENT_TYPES.itemCreated);
    const moved = itemEvent(env, { ...solo, status: "in-progress" }, "2026-07-30T09:00:00Z");

    const out = renderStandup({
      since: "2026-07-26T09:15:00Z",
      nodes: [fixture.node],
      items: [...fixture.items, solo],
      runs: [],
      baseline: new Map(),
      events: [born, moved],
    });

    expect(out).toContain("outside the roadmap");
    expect(out).toContain(`  solo-chore  id=${solo.id}`);
    expect(out).toContain(`moved  backlog → in-progress  act=${moved.id}`);
  });

  /**
   * The association rule is RESOLUTION (Phase 4 epic review): a node whose epic
   * id no record carries covers NOTHING — including the orphans still naming
   * that dead id as their parent. Grouping them under the node would report a
   * release beneath a feature whose work nobody can find; they belong in the
   * section that already exists for movement no node covers.
   */
  test("a node whose epic no record carries groups nothing — its orphans are outside the roadmap", () => {
    const env = seededEnv({ tickSeconds: 1 });
    // The epic record is gone (a merge dropped it, a hand deletion). Its child
    // survives, still naming the dead id as its parent, and it shipped.
    const orphan = makeFrontmatter(env, { name: "orphan-work", parent: "aaaaaaaa" });
    const ghost = makeNode(env, { name: "ghost-feature", epic: "aaaaaaaa" });
    const shipped = logged(
      env,
      RELEASE_ANNOUNCED_EVENT_TYPE,
      orphan.id,
      { version: "1.0.0" },
      "2026-07-30T09:00:00Z",
    );

    const out = renderStandup({
      since: "2026-07-26T09:15:00Z",
      nodes: [ghost],
      items: [orphan],
      runs: [],
      baseline: new Map(),
      events: [shipped],
    });

    expect(out).not.toContain("ghost-feature");
    expect(out).toContain("outside the roadmap");
    expect(out).toContain(`  orphan-work  id=${orphan.id}`);
    expect(out).toContain(`shipped  released 1.0.0  act=${shipped.id}`);
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
      baseline: new Map(),
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
      items: [outer, inner, { ...leaf, status: "done" }],
      runs: [],
      baseline: new Map(),
      events: [closed],
    });

    // The outer node also covers the still-backlog inner epic item, so its own
    // rollup reads in-flight — each node's header is ITS derivation, not a copy.
    expect(out).toContain(`a-outer  feature  in-flight  id=${outerNode.frontmatter.id}`);
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
      baseline: new Map(),
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
      baseline: new Map(),
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
      baseline: new Map(),
      events: [itemEvent(env, { ...fixture.child, status: "done" }, "2026-07-30T09:00:00Z")],
    };

    expect(renderStandup(inputs)).toBe(renderStandup(inputs));
  });
});

/**
 * Retraction (PR #26 follow-up A1, corrected by the codex review). A standup's
 * group header carries the node's derived stage — the SAME derivation `nahel
 * roadmap` renders — so a retracted lifecycle fact has to reach this view, or
 * the header would claim a stage the roadmap no longer shows.
 *
 * A retraction is also MOVEMENT in its own right. Treating it as derivation-only
 * left two lies in the window: a window whose only act was a retraction reported
 * "no movement", and a release retracted in the SAME window rendered `shipped
 * released 0.3.0` under a header reading `built`, with nothing on the page
 * reconciling them.
 *
 * So both lines print. The original act line is untouched — the journal is
 * append-only and a standup reports what happened, naming each act by id — and
 * a `retracted` line follows it, grouped under the WITHDRAWN fact's item (the
 * retraction carries no item ref of its own; the event-id edge is what ties it
 * there), naming what was withdrawn and by which act. A retraction that
 * withdraws nothing — an unknown target, a non-lifecycle target, an incomplete
 * payload — prints nothing, exactly as it derives nothing.
 */
describe("renderStandup — a retracted lifecycle fact", () => {
  const COLUMN_RETRACTED = "roadmap.column-retracted";

  test("the retraction type is standup input — the header derives over it", () => {
    expect(
      isStandupEvent({
        id: "retr0001",
        ts: "2026-07-30T09:00:00Z",
        seq: 0,
        type: COLUMN_RETRACTED,
        actor: { kind: "agent", id: "claude-code" },
        payload: { event: "aaaaaaa1", reason: "wrong epic" },
      }),
    ).toBe(true);
  });

  test("the node header drops back to the rollup while the announced act still shows", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const fixture = charted(env, "done");
    const closed = itemEvent(env, { ...fixture.child, status: "done" }, "2026-07-30T09:00:00Z");
    const release = logged(
      env,
      RELEASE_ANNOUNCED_EVENT_TYPE,
      fixture.epic.id,
      { version: "0.3.0" },
      "2026-07-31T09:00:00Z",
    );
    const retraction = logged(
      env,
      COLUMN_RETRACTED,
      undefined,
      { event: release.id, reason: "announced against the wrong epic" },
      "2026-07-31T10:00:00Z",
    );

    const out = renderStandup({
      since: "2026-07-26T09:15:00Z",
      nodes: [fixture.node],
      items: fixture.items,
      runs: [],
      baseline: new Map(),
      events: [fixture.birth, closed, release, retraction],
    });

    // The header reads the rollup, not the withdrawn release.
    expect(out).toContain(
      `detached-state-repo  feature  built  id=${fixture.node.frontmatter.id}`,
    );
    expect(out).not.toContain("feature  released");
    // The act itself is still reported — nothing is erased from the journal.
    expect(out).toContain(`shipped  released 0.3.0  act=${release.id}`);
    // …and the withdrawal is reported too, so the page is not a release line
    // under a header that silently disagrees with it.
    expect(out).toContain(
      `    2026-07-31T10:00:00Z  retracted  shipped released 0.3.0 (act ${release.id})  act=${retraction.id}`,
    );
    // Both under the item the WITHDRAWN fact named, in journal order.
    expect(out.indexOf(`act=${release.id}`)).toBeLessThan(out.indexOf(`act=${retraction.id}`));
  });

  test("a retraction-only window is MOVEMENT, not silence", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const fixture = charted(env, "done");
    // The release is older than the window; only its withdrawal happened here.
    const release = logged(
      env,
      RELEASE_ANNOUNCED_EVENT_TYPE,
      fixture.epic.id,
      { version: "0.3.0" },
      "2026-07-20T09:00:00Z",
    );
    const retraction = logged(
      env,
      COLUMN_RETRACTED,
      undefined,
      { event: release.id, reason: "announced against the wrong epic" },
      "2026-07-30T10:00:00Z",
    );

    const out = renderStandup({
      since: "2026-07-26T09:15:00Z",
      nodes: [fixture.node],
      items: fixture.items,
      runs: [],
      baseline: new Map(),
      events: [fixture.birth, release, retraction],
    });

    expect(out).not.toContain("no movement in this window");
    expect(out).toContain(
      `detached-state-repo  feature  built  id=${fixture.node.frontmatter.id}`,
    );
    expect(out).toContain(`  ${fixture.epic.name}  id=${fixture.epic.id}`);
    expect(out).toContain(
      `    2026-07-30T10:00:00Z  retracted  shipped released 0.3.0 (act ${release.id})  act=${retraction.id}`,
    );
    // The older release is NOT re-reported: it did not happen in this window.
    expect(out).not.toContain(`shipped  released 0.3.0  act=${release.id}`);
  });

  test("a withdrawn sweep and deploy read back in the words their own lines used", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const fixture = charted(env, "done");
    const sweep = logged(env, QA_SWEEP_EVENT_TYPE, fixture.child.id, { failed: 2 }, "2026-07-30T08:00:00Z");
    const deploy = logged(
      env,
      DEPLOY_COMPLETED_EVENT_TYPE,
      fixture.child.id,
      { environment: "staging" },
      "2026-07-30T08:30:00Z",
    );
    const events = [fixture.birth, sweep, deploy];
    for (const withdrawn of [sweep, deploy]) {
      events.push(
        logged(
          env,
          COLUMN_RETRACTED,
          undefined,
          { event: withdrawn.id, reason: "summarised from the wrong run" },
          "2026-07-30T09:00:00Z",
        ),
      );
    }

    const out = renderStandup({
      since: "2026-07-26T09:15:00Z",
      nodes: [fixture.node],
      items: fixture.items,
      runs: [],
      baseline: new Map(),
      events,
    });

    expect(out).toContain(`retracted  tested 2 failed (act ${sweep.id})`);
    expect(out).toContain(`retracted  shipped deployed staging (act ${deploy.id})`);
  });

  test("a retraction that withdraws NOTHING prints nothing — it derives nothing either", () => {
    const env = seededEnv({ tickSeconds: 1 });
    const fixture = charted(env, "done");
    const release = logged(
      env,
      RELEASE_ANNOUNCED_EVENT_TYPE,
      fixture.epic.id,
      { version: "0.3.0" },
      "2026-07-20T09:00:00Z",
    );
    const inert = [
      // an id no event carries
      { event: "zzzzzzzz", reason: "wrong epic" },
      // a target that is not a lifecycle fact — the child's own creation act
      { event: fixture.birth.id, reason: "wrong epic" },
      // complete target, no reason at all
      { event: release.id },
      // complete target, blank reason
      { event: release.id, reason: "   " },
    ];

    for (const payload of inert) {
      const out = renderStandup({
        since: "2026-07-26T09:15:00Z",
        nodes: [fixture.node],
        items: fixture.items,
        runs: [],
        baseline: new Map(),
        events: [
          fixture.birth,
          release,
          logged(env, COLUMN_RETRACTED, undefined, payload, "2026-07-30T10:00:00Z"),
        ],
      });
      expect(out).toContain("no movement in this window");
      expect(out).not.toContain("retracted");
    }
  });
});

/**
 * collectStandupWindow (PR #26 review, follow-up E): the journal STREAMED into
 * the window instead of held in it.
 *
 * The earlier reading kept every standup-relevant act of the whole journal and
 * sorted a copy, so a `--since 24h` read cost the project's age. What it needed
 * history for is small: a status per item, the surviving lifecycle facts the
 * group headers derive their stage from, the facts an in-window retraction has
 * to quote, and the withdrawn set itself.
 *
 * The contract is byte-identity — the collected slice must render exactly what
 * the whole journal renders — so that is what the first case asserts directly,
 * over a journal carrying every awkward shape at once.
 */
describe("collectStandupWindow — the journal streamed, never held", () => {
  const COLUMN_RETRACTED = "roadmap.column-retracted";
  const SINCE = "2026-07-26T09:15:00Z";

  /**
   * The events as a journal hands them over: the store's canonical total order,
   * streamed. readJournal's own guarantee, and the one the collector reads the
   * baseline under — the LAST pre-window status per item is only the last if
   * the stream is ordered.
   */
  function streamed(events: readonly JournalEvent[]): () => AsyncIterable<JournalEvent> {
    const ordered = [...events].sort(compareEvents);
    return async function* stream() {
      for (const event of ordered) yield event;
    };
  }

  /** One retraction of `target`, stated with a reason, at `ts`. */
  function retracts(env: Env, target: string, ts: string): JournalEvent {
    return logged(env, COLUMN_RETRACTED, undefined, { event: target, reason: "wrong epic" }, ts);
  }

  /**
   * A journal with a past, carrying every shape the collector has to get right
   * at once: pre-window facts that survive, one withdrawn before the window and
   * never mentioned again, one withdrawn from INSIDE it (the correction has to
   * quote it), one withdrawn by a retraction journaled BEFORE the fact itself —
   * legal, because a retraction is decided by id and not by when it was written
   * — and the window's own movement.
   */
  function historied(env: Env) {
    const fixture = charted(env, "done");
    const item = fixture.child.id;
    const started = itemEvent(env, { ...fixture.child, status: "in-progress" }, "2026-07-20T08:00:00Z");
    const deploy = logged(env, DEPLOY_COMPLETED_EVENT_TYPE, item, { environment: "staging" }, "2026-07-21T08:00:00Z");
    const stale = logged(env, RELEASE_ANNOUNCED_EVENT_TYPE, item, { version: "0.2.0" }, "2026-07-22T08:00:00Z");
    const sweep = logged(env, QA_SWEEP_EVENT_TYPE, item, { failed: 1 }, "2026-07-23T08:00:00Z");
    // The LAST pre-window sweep, and withdrawn before the window opened: it
    // elects nothing and renders nothing, so nothing needs to remember it.
    const doomed = logged(env, QA_SWEEP_EVENT_TYPE, item, { failed: 0 }, "2026-07-25T08:00:00Z");
    const closed = itemEvent(env, { ...fixture.child, status: "done" }, "2026-07-30T09:00:00Z");
    const early = logged(env, RELEASE_ANNOUNCED_EVENT_TYPE, item, { version: "0.4.0" }, "2026-07-29T08:00:00Z");
    const release = logged(env, RELEASE_ANNOUNCED_EVENT_TYPE, item, { version: "0.3.0" }, "2026-07-31T08:00:00Z");
    return {
      fixture,
      deploy,
      stale,
      doomed,
      sweep,
      closed,
      early,
      release,
      events: [
        fixture.birth,
        started,
        deploy,
        stale,
        sweep,
        // Written BEFORE the release it withdraws: the derivation must still
        // ignore that release, so this one outlives the window it predates.
        retracts(env, early.id, "2026-07-24T08:00:00Z"),
        doomed,
        retracts(env, doomed.id, "2026-07-25T09:00:00Z"),
        early,
        closed,
        release,
        // Withdrawn from inside the window: one names a fact older than the
        // window, one a fact inside it.
        retracts(env, stale.id, "2026-07-30T10:00:00Z"),
        retracts(env, release.id, "2026-07-31T09:00:00Z"),
      ],
    };
  }

  test("the collected slice renders EXACTLY what the whole journal renders", async () => {
    const env = seededEnv({ tickSeconds: 1 });
    const history = historied(env);
    const fixture = history.fixture;
    const facts = { since: SINCE, nodes: [fixture.node], items: fixture.items, runs: [] };

    const window = await collectStandupWindow(SINCE, streamed(history.events));
    const collected = renderStandup({ ...facts, events: window.events, baseline: window.baseline });

    expect(collected).toBe(renderStandup({ ...facts, events: history.events, baseline: new Map() }));
    // …and what the two agree on is a real page: the header's stage comes off a
    // deploy older than the window, the transition names where it came from,
    // and the correction quotes a release the window never saw announced.
    expect(collected).toContain(`  feature  deployed  id=${fixture.node.frontmatter.id}`);
    expect(collected).toContain(`closed  in-progress → done  act=${history.closed.id}`);
    expect(collected).toContain(`retracted  shipped released 0.2.0 (act ${history.stale.id})`);
    // The release withdrawn by an act older than itself still reports as the act
    // it was, under a header that does not count it.
    expect(collected).toContain(`shipped  released 0.4.0  act=${history.early.id}`);
  });

  test("what it keeps of the past: the baseline, the survivors, the quoted facts", async () => {
    const env = seededEnv({ tickSeconds: 1 });
    const history = historied(env);

    const window = await collectStandupWindow(SINCE, streamed(history.events));
    const kept = new Set(window.events.map((event: JournalEvent) => event.id));

    // One word per item, not the acts that produced it.
    expect(window.baseline).toEqual(new Map([[history.fixture.child.id, "in-progress"]]));
    // The surviving winner of each pre-window column type, and no other.
    expect(kept.has(history.deploy.id)).toBe(true);
    expect(kept.has(history.sweep.id)).toBe(true);
    expect(kept.has(history.doomed.id)).toBe(false);
    // The withdrawn fact a line inside the window has to quote.
    expect(kept.has(history.stale.id)).toBe(true);
    // Never the acts the baseline replaced.
    expect(kept.has(history.fixture.birth.id)).toBe(false);
  });

  test("the surviving fact is per ITEM — one node's history is not another's", async () => {
    const env = seededEnv({ tickSeconds: 1 });
    const here = charted(env, "done");
    const epic = makeFrontmatter(env, { name: "other-epic", type: "plan", lane: "full" });
    const child = makeFrontmatter(env, { name: "other-work", parent: epic.id, status: "done" });
    const node = makeNode(env, { name: "other-feature", epic: epic.id });
    // One deploy each, both older than the window: whichever is later must not
    // stand in for the other, or one feature would read its neighbour's stage.
    const mine = logged(env, DEPLOY_COMPLETED_EVENT_TYPE, here.child.id, { environment: "staging" }, "2026-07-21T08:00:00Z");
    const theirs = logged(env, DEPLOY_COMPLETED_EVENT_TYPE, child.id, { environment: "prod" }, "2026-07-22T08:00:00Z");
    const events = [
      here.birth,
      mine,
      theirs,
      itemEvent(env, { ...here.child, status: "done" }, "2026-07-30T09:00:00Z"),
      itemEvent(env, child, "2026-07-30T09:30:00Z"),
    ];
    const facts = {
      since: SINCE,
      nodes: [here.node, node],
      items: [...here.items, epic, child],
      runs: [],
    };

    const window = await collectStandupWindow(SINCE, streamed(events));
    const collected = renderStandup({ ...facts, events: window.events, baseline: window.baseline });

    expect(collected).toBe(renderStandup({ ...facts, events, baseline: new Map() }));
    expect(collected).toContain(`detached-state-repo  feature  deployed  id=${here.node.frontmatter.id}`);
    expect(collected).toContain(`other-feature  feature  deployed  id=${node.frontmatter.id}`);
  });

  test("what it keeps does not grow with the journal's length", async () => {
    const env = seededEnv({ tickSeconds: 1 });
    const fixture = charted(env, "done");
    /** A store with `depth` acts of movement and lifecycle history behind it. */
    const journal = (depth: number): JournalEvent[] => {
      const events: JournalEvent[] = [fixture.birth];
      for (let index = 0; index < depth; index += 1) {
        const day = 10 + (index % 10);
        events.push(
          itemEvent(env, { ...fixture.child, status: "in-progress" }, `2026-07-${day}T08:00:00Z`),
          logged(env, QA_SWEEP_EVENT_TYPE, fixture.child.id, { failed: 0 }, `2026-07-${day}T09:00:00Z`),
        );
      }
      events.push(itemEvent(env, { ...fixture.child, status: "done" }, "2026-07-30T09:00:00Z"));
      return events;
    };

    const shallow = await collectStandupWindow(SINCE, streamed(journal(5)));
    const deep = await collectStandupWindow(SINCE, streamed(journal(500)));

    // One in-window act, one surviving pre-window sweep, one status baseline —
    // whether the item moved five times before the window or five hundred.
    expect(shallow.events.length).toBe(2);
    expect(deep.events.length).toBe(2);
    expect(deep.baseline.size).toBe(1);
  });
});

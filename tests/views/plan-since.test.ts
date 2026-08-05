import { describe, expect, test } from "bun:test";
import { CORE_EVENT_TYPES } from "../../src/schema/events";
import type { Actor, JournalEvent } from "../../src/schema/records";
import { planSince } from "../../src/views/plan-since";

/**
 * Since your last session (planning-partner F2 / DD1): the window of subject
 * events a node's briefing debriefs the reader on.
 *
 * Four rules these tests pin, because nothing else in the codebase answers them:
 *
 *   1. The SUBJECT set is node-scoped, not store-global: roadmap acts on THIS
 *      node, map acts on ITS map, ticket acts on that map's tickets, and
 *      journal notes carrying `ticket=<id>` for one of them. Everything else in
 *      the journal — another node, another map's ticket, a note naming a
 *      foreign ticket — is invisible here, however recent.
 *   2. The BASELINE is the READER's latest subject act, and the default reader
 *      is the store's human side (the `awaitingRoadmapReview` reader
 *      semantics): the debrief exists to catch the human up, so AFK agent work
 *      must always land INSIDE the window. `--reader <actor>` overrides, and an
 *      agent's own prior acts drop out of the window only when it names itself.
 *   3. The window is everything STRICTLY AFTER the baseline in the store's
 *      total order (`ts` → `seq` → `id`), so the baseline act itself is never
 *      re-reported and same-second acts split deterministically rather than by
 *      a lottery.
 *   4. A reader with no subject act at all falls back to the map's creation —
 *      everything charted since the map existed is new to them.
 *
 * Pure throughout: synthetic events in, a structured window out. No store, no
 * clock, no rendering.
 */

const HUMAN: Actor = { kind: "human", id: "jim" };
const OTHER_HUMAN: Actor = { kind: "human", id: "sam" };
const AGENT: Actor = { kind: "agent", id: "claude-code" };
const OTHER_AGENT: Actor = { kind: "agent", id: "afk-worker" };

/** The subject: one node, its map, and two tickets hanging off that map. */
const NODE = "nd000001";
const MAP = "mp000001";
const TICKET_A = "tk00000a";
const TICKET_B = "tk00000b";

/** The decoys: a second node, a second map, and a ticket on that other map. */
const OTHER_NODE = "nd000002";
const OTHER_MAP = "mp000002";
const OTHER_TICKET = "tk00000c";

const TICKETS = [
  { id: TICKET_A, map: MAP },
  { id: TICKET_B, map: MAP },
  { id: OTHER_TICKET, map: OTHER_MAP },
];

const CREATED_TS = "2026-08-01T08:00:00Z";

let counter = 0;

/** Mint the next synthetic event id; overridable where an id must be pinned. */
function nextId(): string {
  counter += 1;
  return `ev${String(counter).padStart(6, "0")}`;
}

/** The knobs every builder shares: the total-order fields and the event type. */
interface EventOptions {
  type?: string;
  seq?: number;
  id?: string;
  /** Record fields overriding the builder's defaults. */
  fields?: Record<string, unknown>;
}

function makeEvent(
  ts: string,
  actor: Actor,
  type: string,
  payload: Record<string, unknown>,
  options: EventOptions,
): JournalEvent {
  return {
    id: options.id ?? nextId(),
    ts,
    seq: options.seq ?? 0,
    type,
    actor,
    payload,
  };
}

/**
 * One roadmap-node act, carrying the record payload mutate() journals. `body` is
 * the node's INTENT — `--intent` writes prose, never a frontmatter field — so an
 * intent-only edit is a case only this knob can build.
 */
function nodeEvent(
  ts: string,
  actor: Actor,
  options: EventOptions & { node?: string; body?: string } = {},
): JournalEvent {
  return makeEvent(
    ts,
    actor,
    options.type ?? CORE_EVENT_TYPES.roadmapNodeUpdated,
    {
      target: "roadmap-node",
      record: {
        id: options.node ?? NODE,
        name: "planning-partner",
        kind: "feature",
        horizon: "now",
        created: CREATED_TS,
        updated: ts,
        ...options.fields,
      },
      body: options.body ?? "intent\n",
    },
    options,
  );
}

/** One map act — the wayfinder chart attached to the node; `body` is its notes. */
function mapEvent(
  ts: string,
  actor: Actor,
  options: EventOptions & { map?: string; body?: string } = {},
): JournalEvent {
  return makeEvent(
    ts,
    actor,
    options.type ?? CORE_EVENT_TYPES.mapUpdated,
    {
      target: "map",
      record: {
        id: options.map ?? MAP,
        node: NODE,
        destination: "a planning partner that briefs before it asks",
        fog: ["how the briefing degrades bare-bash"],
        out_of_scope: [],
        created: CREATED_TS,
        updated: ts,
        ...options.fields,
      },
      body: options.body ?? "notes\n",
    },
    options,
  );
}

/**
 * One ticket act, in the shape the CLI actually writes: `resolve` and `close`
 * are SEQUENCE mutations carrying the ticket and its distilled observation
 * under one event, while the rest are single-record payloads. A derivation that
 * only reads `payload.record` would miss every decision.
 */
function ticketEvent(
  ts: string,
  actor: Actor,
  ticket: string,
  options: EventOptions = {},
): JournalEvent {
  const type = options.type ?? CORE_EVENT_TYPES.ticketCreated;
  const record = {
    id: ticket,
    map: ticket === OTHER_TICKET ? OTHER_MAP : MAP,
    type: "decision",
    state: "open",
    blockers: [],
    created: CREATED_TS,
    updated: ts,
    ...options.fields,
  };
  const sequence =
    type === CORE_EVENT_TYPES.ticketResolved || type === CORE_EVENT_TYPES.ticketClosed;
  const payload = sequence
    ? {
        target: "sequence",
        records: [
          { target: "ticket", record, body: "the question?\n" },
          {
            target: "observation",
            record: { id: "ob000001", created: ts, updated: ts },
            body: "distilled\n",
          },
        ],
      }
    : { target: "ticket", record, body: "the question?\n" };
  return makeEvent(ts, actor, type, payload, options);
}

/** A research note carrying the `ticket=<id>` data key the workflows write. */
function noteEvent(
  ts: string,
  actor: Actor,
  ticket: string,
  options: EventOptions = {},
): JournalEvent {
  return makeEvent(
    ts,
    actor,
    options.type ?? CORE_EVENT_TYPES.note,
    { ticket, text: "found the answer", ...options.fields },
    options,
  );
}

/** The standard call: the subject wired up, events in whatever order. */
function since(events: readonly JournalEvent[], reader?: Actor) {
  return planSince({
    node: NODE,
    map: MAP,
    tickets: TICKETS,
    events,
    ...(reader === undefined ? {} : { reader }),
  });
}

describe("planSince — the subject event set (DD1)", () => {
  const KINDS: [string, (ts: string, actor: Actor) => JournalEvent][] = [
    ["a roadmap act on this node", (ts, actor) => nodeEvent(ts, actor)],
    ["a map act on its map", (ts, actor) => mapEvent(ts, actor)],
    ["a ticket act on one of the map's tickets", (ts, actor) => ticketEvent(ts, actor, TICKET_A)],
    ["a note carrying ticket=<id>", (ts, actor) => noteEvent(ts, actor, TICKET_A)],
  ];

  test.each(KINDS)("%s seeds the reader's baseline", (_label, build) => {
    const seed = build("2026-08-02T09:00:00Z", HUMAN);
    const later = ticketEvent("2026-08-02T10:00:00Z", AGENT, TICKET_B);
    const window = since([seed, later]);
    expect(window.baseline).toBeDefined();
    expect(window.baseline!.event.id).toBe(seed.id);
    expect(window.baseline!.kind).toBe("reader");
    expect(window.created.map((act) => act.id)).toEqual([TICKET_B]);
  });

  test("acts on another node, another map, and another map's ticket are not subject events", () => {
    const mine = mapEvent("2026-08-02T09:00:00Z", HUMAN);
    const events = [
      mine,
      nodeEvent("2026-08-02T11:00:00Z", AGENT, { node: OTHER_NODE }),
      mapEvent("2026-08-02T11:01:00Z", AGENT, { map: OTHER_MAP }),
      ticketEvent("2026-08-02T11:02:00Z", AGENT, OTHER_TICKET),
      noteEvent("2026-08-02T11:03:00Z", AGENT, OTHER_TICKET),
    ];
    const window = since(events);
    expect(window.baseline!.event.id).toBe(mine.id);
    expect(window.empty).toBe(true);
    expect(window.created).toEqual([]);
    expect(window.notes).toEqual([]);
    expect(window.node).toBeUndefined();
    expect(window.map).toBeUndefined();
  });

  test("a note naming no ticket at all is not a subject event", () => {
    const seed = mapEvent("2026-08-02T09:00:00Z", HUMAN);
    const bare = makeEvent("2026-08-02T10:00:00Z", AGENT, CORE_EVENT_TYPES.note, {
      text: "unlinked thinking",
    }, {});
    const window = since([seed, bare]);
    expect(window.notes).toEqual([]);
    expect(window.empty).toBe(true);
  });

  test("a ticket= key on a SELF-RECORDED type is inert data, not a research note", () => {
    // `nahel log` refuses the reserved types, so a `ticket` key on one could
    // only be a coincidence of payload shape — never a note somebody wrote.
    const seed = mapEvent("2026-08-02T09:00:00Z", HUMAN);
    const forged = makeEvent(
      "2026-08-02T10:00:00Z",
      AGENT,
      CORE_EVENT_TYPES.itemUpdated,
      { ticket: TICKET_A, target: "item", record: { id: "it000001" }, body: "" },
      {},
    );
    const window = since([seed, forged]);
    expect(window.notes).toEqual([]);
    expect(window.empty).toBe(true);
  });

  test("an open-extension research type carrying ticket=<id> IS a note", () => {
    const seed = mapEvent("2026-08-02T09:00:00Z", HUMAN);
    const finding = noteEvent("2026-08-02T10:00:00Z", AGENT, TICKET_A, {
      type: "research.finding",
    });
    const window = since([seed, finding]);
    expect(window.notes.map((note) => [note.ticket, note.event.id])).toEqual([
      [TICKET_A, finding.id],
    ]);
    expect(window.empty).toBe(false);
  });
});

describe("planSince — the baseline and the strictly-after window", () => {
  test("falls back to the map's creation when the reader has never touched the subject", () => {
    const created = mapEvent("2026-08-01T09:00:00Z", AGENT, {
      type: CORE_EVENT_TYPES.mapCreated,
    });
    const later = ticketEvent("2026-08-02T09:00:00Z", AGENT, TICKET_A);
    const window = since([created, later]);
    expect(window.baseline!.event.id).toBe(created.id);
    expect(window.baseline!.kind).toBe("map-created");
    expect(window.created.map((act) => act.id)).toEqual([TICKET_A]);
  });

  test("the reader's own act wins over the map's creation", () => {
    const created = mapEvent("2026-08-01T09:00:00Z", AGENT, {
      type: CORE_EVENT_TYPES.mapCreated,
    });
    const mine = ticketEvent("2026-08-01T10:00:00Z", HUMAN, TICKET_A);
    const later = ticketEvent("2026-08-02T09:00:00Z", AGENT, TICKET_B);
    const window = since([created, mine, later]);
    expect(window.baseline!.event.id).toBe(mine.id);
    expect(window.baseline!.kind).toBe("reader");
    expect(window.created.map((act) => act.id)).toEqual([TICKET_B]);
  });

  test("the baseline act itself is excluded from the window it opens", () => {
    const mine = ticketEvent("2026-08-02T09:00:00Z", HUMAN, TICKET_A);
    const window = since([mine]);
    expect(window.baseline!.event.id).toBe(mine.id);
    expect(window.created).toEqual([]);
    expect(window.empty).toBe(true);
  });

  test("with no reader act and no map creation, the whole subject set is new", () => {
    const first = ticketEvent("2026-08-02T09:00:00Z", AGENT, TICKET_A);
    const second = ticketEvent("2026-08-02T10:00:00Z", OTHER_AGENT, TICKET_B);
    const window = since([first, second]);
    expect(window.baseline).toBeUndefined();
    expect(window.created.map((act) => act.id)).toEqual([TICKET_A, TICKET_B]);
  });

  test("an empty window reports nothing new rather than an absent answer", () => {
    const window = since([mapEvent("2026-08-02T09:00:00Z", HUMAN)]);
    expect(window.empty).toBe(true);
    expect(window.resolved).toEqual([]);
    expect(window.closed).toEqual([]);
    expect(window.created).toEqual([]);
    expect(window.notes).toEqual([]);
    expect(window.node).toBeUndefined();
    expect(window.map).toBeUndefined();
  });

  test("same-timestamp edge: seq and id split the window at the baseline, not the second", () => {
    // Four acts share the baseline's exact timestamp. Only the total order
    // (`ts` → `seq` → `id`) can say which two are after it.
    const ts = "2026-08-02T09:00:00Z";
    const baseline = ticketEvent(ts, HUMAN, TICKET_A, { seq: 5, id: "ev000500" });
    const earlierSeq = ticketEvent(ts, AGENT, TICKET_B, { seq: 4, id: "ev000900" });
    const earlierId = ticketEvent(ts, AGENT, TICKET_B, { seq: 5, id: "ev000100" });
    const laterId = ticketEvent(ts, AGENT, TICKET_B, { seq: 5, id: "ev000700" });
    const laterSeq = ticketEvent(ts, AGENT, TICKET_B, { seq: 6, id: "ev000200" });
    const window = since([laterSeq, earlierId, baseline, laterId, earlierSeq]);
    expect(window.baseline!.event.id).toBe("ev000500");
    // In total order: the id-later act (same seq) precedes the seq-later one.
    expect(window.created.map((act) => act.event.id)).toEqual(["ev000700", "ev000200"]);
  });

  test("the derivation does not depend on the order events arrive in", () => {
    const events = [
      mapEvent("2026-08-01T09:00:00Z", HUMAN, { type: CORE_EVENT_TYPES.mapCreated }),
      ticketEvent("2026-08-02T09:00:00Z", AGENT, TICKET_A),
      ticketEvent("2026-08-02T10:00:00Z", AGENT, TICKET_B, {
        type: CORE_EVENT_TYPES.ticketResolved,
        fields: { state: "resolved", decision: "ship the derivation first" },
      }),
      noteEvent("2026-08-02T11:00:00Z", OTHER_AGENT, TICKET_A),
      nodeEvent("2026-08-02T12:00:00Z", AGENT, { fields: { horizon: "next" } }),
    ];
    const forward = since(events);
    const backward = since([...events].reverse());
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
  });
});

describe("planSince — who is reading (DD1's reader rule)", () => {
  test("the default reader is the store's human side: AFK agent work lands inside the window", () => {
    const human = mapEvent("2026-08-01T09:00:00Z", HUMAN);
    const agentEarlier = ticketEvent("2026-08-01T10:00:00Z", AGENT, TICKET_A);
    const agentLater = ticketEvent("2026-08-01T11:00:00Z", AGENT, TICKET_B);
    const window = since([human, agentEarlier, agentLater]);
    expect(window.baseline!.event.id).toBe(human.id);
    expect(window.created.map((act) => act.id)).toEqual([TICKET_A, TICKET_B]);
  });

  test("the default reader is the LATEST human act, whichever human made it", () => {
    const mine = mapEvent("2026-08-01T09:00:00Z", HUMAN);
    const theirs = mapEvent("2026-08-01T10:00:00Z", OTHER_HUMAN);
    const agentAct = ticketEvent("2026-08-01T11:00:00Z", AGENT, TICKET_A);
    const window = since([mine, theirs, agentAct]);
    expect(window.baseline!.event.id).toBe(theirs.id);
    expect(window.created.map((act) => act.id)).toEqual([TICKET_A]);
  });

  test("an agent's own prior acts drop out of the window only when it names itself", () => {
    const human = mapEvent("2026-08-01T09:00:00Z", HUMAN);
    const mine = ticketEvent("2026-08-01T10:00:00Z", AGENT, TICKET_A);
    const theirs = ticketEvent("2026-08-01T11:00:00Z", OTHER_AGENT, TICKET_B);
    const events = [human, mine, theirs];

    const defaulted = since(events);
    expect(defaulted.created.map((act) => act.id)).toEqual([TICKET_A, TICKET_B]);

    const named = since(events, AGENT);
    expect(named.baseline!.event.id).toBe(mine.id);
    expect(named.baseline!.kind).toBe("reader");
    expect(named.created.map((act) => act.id)).toEqual([TICKET_B]);
  });

  test("one reader's acts do not advance another's baseline", () => {
    const first = ticketEvent("2026-08-01T09:00:00Z", AGENT, TICKET_A);
    const second = ticketEvent("2026-08-01T10:00:00Z", OTHER_AGENT, TICKET_B);
    const third = noteEvent("2026-08-01T11:00:00Z", AGENT, TICKET_A);
    const events = [first, second, third];

    const forAgent = since(events, AGENT);
    expect(forAgent.baseline!.event.id).toBe(third.id);
    expect(forAgent.created).toEqual([]);
    expect(forAgent.notes).toEqual([]);

    const forOther = since(events, OTHER_AGENT);
    expect(forOther.baseline!.event.id).toBe(second.id);
    expect(forOther.notes.map((note) => note.event.id)).toEqual([third.id]);
    expect(forOther.created).toEqual([]);
  });

  test("a named reader with no subject act falls back to the map's creation", () => {
    const created = mapEvent("2026-08-01T09:00:00Z", HUMAN, {
      type: CORE_EVENT_TYPES.mapCreated,
    });
    const agentAct = ticketEvent("2026-08-01T10:00:00Z", AGENT, TICKET_A);
    const window = since([created, agentAct], OTHER_AGENT);
    expect(window.baseline!.event.id).toBe(created.id);
    expect(window.baseline!.kind).toBe("map-created");
    expect(window.created.map((act) => act.id)).toEqual([TICKET_A]);
  });

  test("a reader matched by id alone would be wrong: kind is part of the identity", () => {
    // A human sharing the agent's id acts AFTER it. Matched by id alone the
    // human's act would open the agent's window and swallow it.
    const agentAct = ticketEvent("2026-08-01T10:00:00Z", AGENT, TICKET_A);
    const namesake = ticketEvent(
      "2026-08-01T11:00:00Z",
      { kind: "human", id: "claude-code" },
      TICKET_B,
    );
    const window = since([agentAct, namesake], AGENT);
    expect(window.baseline!.event.id).toBe(agentAct.id);
    expect(window.created.map((act) => act.id)).toEqual([TICKET_B]);
  });
});

describe("planSince — what the window reports (DD5's debrief)", () => {
  const seed = () => mapEvent("2026-08-01T09:00:00Z", HUMAN);

  test("a resolved ticket carries the one-line decision the sequence act recorded", () => {
    const resolved = ticketEvent("2026-08-02T09:00:00Z", AGENT, TICKET_A, {
      type: CORE_EVENT_TYPES.ticketResolved,
      fields: { state: "resolved", decision: "derive the window, render it later" },
    });
    const window = since([seed(), resolved]);
    expect(window.resolved).toEqual([
      { id: TICKET_A, line: "derive the window, render it later", event: resolved },
    ]);
    expect(window.closed).toEqual([]);
    expect(window.created).toEqual([]);
    expect(window.empty).toBe(false);
  });

  test("a closed ticket carries the reason that ruled it away", () => {
    const closed = ticketEvent("2026-08-02T09:00:00Z", AGENT, TICKET_B, {
      type: CORE_EVENT_TYPES.ticketClosed,
      fields: { state: "closed", reason: "beyond this delta's destination" },
    });
    const window = since([seed(), closed]);
    expect(window.closed).toEqual([
      { id: TICKET_B, line: "beyond this delta's destination", event: closed },
    ]);
    expect(window.resolved).toEqual([]);
  });

  test("tickets created in the window are reported with no line of their own yet", () => {
    const first = ticketEvent("2026-08-02T09:00:00Z", AGENT, TICKET_A);
    const second = ticketEvent("2026-08-02T10:00:00Z", AGENT, TICKET_B);
    const window = since([seed(), first, second]);
    expect(window.created).toEqual([
      { id: TICKET_A, line: undefined, event: first },
      { id: TICKET_B, line: undefined, event: second },
    ]);
  });

  test("a ticket claim moves nothing the debrief reports — the frontier already shows it", () => {
    const claimed = ticketEvent("2026-08-02T09:00:00Z", AGENT, TICKET_A, {
      type: CORE_EVENT_TYPES.ticketClaimed,
      fields: { state: "claimed", claimant: "claude-code" },
    });
    const window = since([seed(), claimed]);
    expect(window.empty).toBe(true);
    expect(window.created).toEqual([]);
    expect(window.resolved).toEqual([]);
    expect(window.closed).toEqual([]);
  });

  test("a claim still ADVANCES its actor's baseline: it is a subject act", () => {
    const claimed = ticketEvent("2026-08-02T09:00:00Z", AGENT, TICKET_A, {
      type: CORE_EVENT_TYPES.ticketClaimed,
      fields: { state: "claimed", claimant: "claude-code" },
    });
    const later = ticketEvent("2026-08-02T10:00:00Z", OTHER_AGENT, TICKET_B);
    const window = since([seed(), claimed, later], AGENT);
    expect(window.baseline!.event.id).toBe(claimed.id);
    expect(window.created.map((act) => act.id)).toEqual([TICKET_B]);
  });

  test("fog changes: what the map's lists gained and lost across the whole window", () => {
    const before = mapEvent("2026-08-01T09:00:00Z", HUMAN, {
      fields: { fog: ["how it degrades bare-bash", "who owns the frontier"] },
    });
    const first = mapEvent("2026-08-02T09:00:00Z", AGENT, {
      fields: { fog: ["who owns the frontier"], out_of_scope: ["PM-tool adapters"] },
    });
    const second = mapEvent("2026-08-02T10:00:00Z", AGENT, {
      fields: {
        fog: ["who owns the frontier", "what the AFK lane may resolve alone"],
        out_of_scope: ["PM-tool adapters"],
      },
    });
    const window = since([before, first, second]);
    expect(window.map).toBeDefined();
    expect(window.map!.created).toBe(false);
    expect(window.map!.events.map((event) => event.id)).toEqual([first.id, second.id]);
    expect(window.map!.lists).toEqual([
      {
        field: "fog",
        added: ["what the AFK lane may resolve alone"],
        removed: ["how it degrades bare-bash"],
      },
      { field: "out_of_scope", added: ["PM-tool adapters"], removed: [] },
    ]);
    expect(window.map!.fields).toEqual([]);
    expect(window.map!.body).toBe(false);
  });

  test("a map destination rewritten in the window is a field change", () => {
    const before = mapEvent("2026-08-01T09:00:00Z", HUMAN);
    const after = mapEvent("2026-08-02T09:00:00Z", AGENT, {
      fields: { destination: "a partner that plans, not just records" },
    });
    const window = since([before, after]);
    expect(window.map!.fields).toEqual([
      {
        field: "destination",
        from: "a planning partner that briefs before it asks",
        to: "a partner that plans, not just records",
      },
    ]);
    expect(window.map!.lists).toEqual([]);
  });

  test("node field changes are reported, and untouched fields are not", () => {
    const before = nodeEvent("2026-08-01T09:00:00Z", HUMAN);
    const after = nodeEvent("2026-08-02T09:00:00Z", AGENT, {
      fields: { horizon: "next", prd: "docs/prds/planning-partner.md" },
    });
    const window = since([before, after]);
    expect(window.node).toBeDefined();
    expect(window.node!.created).toBe(false);
    expect(window.node!.fields).toEqual([
      { field: "horizon", from: "now", to: "next" },
      { field: "prd", from: undefined, to: "docs/prds/planning-partner.md" },
    ]);
    expect(window.node!.lists).toEqual([]);
    expect(window.node!.body).toBe(false);
    expect(window.map).toBeUndefined();
  });

  test("an act that changed no field at all reports the act and no changes", () => {
    const before = nodeEvent("2026-08-01T09:00:00Z", HUMAN);
    const after = nodeEvent("2026-08-02T09:00:00Z", AGENT);
    const window = since([before, after]);
    expect(window.node!.events.map((event) => event.id)).toEqual([after.id]);
    expect(window.node!.fields).toEqual([]);
    expect(window.node!.body).toBe(false);
    expect(window.empty).toBe(false);
  });

  test("a map created inside the window is flagged, with every charted line as new", () => {
    const seedAct = nodeEvent("2026-08-01T09:00:00Z", HUMAN);
    const created = mapEvent("2026-08-02T09:00:00Z", AGENT, {
      type: CORE_EVENT_TYPES.mapCreated,
      fields: { fog: ["how it degrades bare-bash"], out_of_scope: [] },
    });
    const window = since([seedAct, created]);
    expect(window.map!.created).toBe(true);
    expect(window.map!.lists).toEqual([
      { field: "fog", added: ["how it degrades bare-bash"], removed: [] },
    ]);
    expect(window.map!.fields.map((change) => change.field)).toEqual(["destination", "node"]);
    // Its notes are new for the same reason every field above is.
    expect(window.map!.body).toBe(true);
  });

  test("a record charted with no prose at all changed no prose", () => {
    const seedAct = nodeEvent("2026-08-01T09:00:00Z", HUMAN);
    const created = mapEvent("2026-08-02T09:00:00Z", AGENT, {
      type: CORE_EVENT_TYPES.mapCreated,
      body: "",
    });
    const window = since([seedAct, created]);
    expect(window.map!.created).toBe(true);
    expect(window.map!.body).toBe(false);
  });

  test("a node whose INTENT alone was re-worded is a change the window reports", () => {
    // The gap this pins: `--intent` writes the record's BODY and moves no
    // frontmatter field, so a window that diffed frontmatter alone would call
    // real shaping work (D2: at roadmap altitude the node mutations ARE the
    // record) nothing at all.
    const before = nodeEvent("2026-08-01T09:00:00Z", HUMAN);
    const after = nodeEvent("2026-08-02T09:00:00Z", AGENT, {
      body: "Take a payment without a queue, and charge for it.\n",
    });
    const window = since([before, after]);
    expect(window.node!.body).toBe(true);
    // THAT it changed, never WHAT it says: the prose is a paragraph, and the
    // debrief's job is to send the reader to it, not to reprint it.
    expect(JSON.stringify(window.node)).not.toContain("charge for it");
    expect(window.node!.fields).toEqual([]);
    expect(window.node!.lists).toEqual([]);
    expect(window.empty).toBe(false);
  });

  test("an intent restated word for word is no change at all", () => {
    const before = nodeEvent("2026-08-01T09:00:00Z", HUMAN);
    const after = nodeEvent("2026-08-02T09:00:00Z", AGENT, { body: "intent\n" });
    expect(since([before, after]).node!.body).toBe(false);
  });

  test("prose re-worded and put back inside one window is net nothing", () => {
    // The lists' rule, applied to the prose: a window reports its NET effect,
    // not the keystrokes that reached it.
    const before = nodeEvent("2026-08-01T09:00:00Z", HUMAN);
    const edited = nodeEvent("2026-08-02T09:00:00Z", AGENT, { body: "a sharper intent\n" });
    const reverted = nodeEvent("2026-08-02T10:00:00Z", AGENT, { body: "intent\n" });
    const window = since([before, edited, reverted]);
    expect(window.node!.body).toBe(false);
    expect(window.node!.events.map((event) => event.id)).toEqual([edited.id, reverted.id]);
  });

  test("a map's NOTES are prose too, and change the same way", () => {
    const before = mapEvent("2026-08-01T09:00:00Z", HUMAN);
    const after = mapEvent("2026-08-02T09:00:00Z", AGENT, { body: "notes, rewritten\n" });
    const window = since([before, after]);
    expect(window.map!.body).toBe(true);
    expect(window.map!.fields).toEqual([]);
    expect(window.map!.lists).toEqual([]);
  });

  test("research notes are reported with the ticket they name, in total order", () => {
    const first = noteEvent("2026-08-02T09:00:00Z", AGENT, TICKET_A);
    const second = noteEvent("2026-08-02T10:00:00Z", OTHER_AGENT, TICKET_B);
    const window = since([seed(), second, first]);
    expect(window.notes).toEqual([
      { ticket: TICKET_A, event: first },
      { ticket: TICKET_B, event: second },
    ]);
  });

  test("a node with no map yet: ticket and map acts cannot belong to it", () => {
    const events = [
      nodeEvent("2026-08-01T09:00:00Z", HUMAN),
      mapEvent("2026-08-02T09:00:00Z", AGENT),
      ticketEvent("2026-08-02T10:00:00Z", AGENT, TICKET_A),
      noteEvent("2026-08-02T11:00:00Z", AGENT, TICKET_A),
    ];
    const window = planSince({ node: NODE, map: undefined, tickets: TICKETS, events });
    expect(window.empty).toBe(true);
    expect(window.map).toBeUndefined();
    expect(window.created).toEqual([]);
    expect(window.notes).toEqual([]);
  });

  test("an act whose payload cannot be read as its record is skipped, not guessed at", () => {
    const seedAct = mapEvent("2026-08-01T09:00:00Z", HUMAN);
    const unreadable = makeEvent(
      "2026-08-02T09:00:00Z",
      AGENT,
      CORE_EVENT_TYPES.ticketCreated,
      { target: "ticket", record: "not an object", body: "" },
      {},
    );
    const window = since([seedAct, unreadable]);
    expect(window.created).toEqual([]);
    expect(window.empty).toBe(true);
  });
});

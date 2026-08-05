import { CORE_EVENT_TYPES, SELF_RECORDED_EVENT_TYPES } from "../schema/events";
import type { Actor, JournalEvent } from "../schema/records";
import { compareEvents } from "../store/journal";

/**
 * "Since your last session" (planning-partner F2 / DD1): the window of acts a
 * roadmap node's planning briefing debriefs its reader on. A PURE derivation
 * over events already read from the store — no I/O, no clock, no randomness —
 * so the same journal always yields the same window, and the briefing that
 * renders it (F1) is byte-identical under replay.
 *
 * Deliberately NOT a reuse of `awaitingRoadmapReview`, which answers a
 * different question: that surface is store-global, roadmap-node-only, and
 * human-only, and it fails SAFE by staying raised. This one is SUBJECT-scoped
 * (one node, its map, that map's tickets, and the research notes linked to
 * them) and cuts the window exactly, because a debrief that re-reports the
 * reader's own last act reads as news that is not new.
 *
 * Three rules the rest of the codebase must never answer twice:
 *
 *   1. **The subject set.** Roadmap acts on THIS node, map acts on ITS map,
 *      ticket acts on that map's tickets, and journal notes carrying a
 *      `ticket=<id>` data key naming one of those tickets — the linkage the
 *      F3/F5 workflows write when researching a claimed ticket. Membership is
 *      decided by event TYPE plus the record the payload carries, never by
 *      payload shape alone: a `ticket` key on a self-recorded type could only
 *      be a coincidence, since `nahel log` refuses those types outright.
 *
 *   2. **The reader.** The baseline is the READER's latest subject act, and the
 *      default reader is the store's human side — the latest HUMAN-attributed
 *      subject event, the same reader semantics `awaitingRoadmapReview` uses.
 *      The debrief exists to catch the human up, so AFK agent work must always
 *      land inside the window; an AFK lane sharing the session's agent id would
 *      otherwise bury its own findings. An explicit reader (the `--reader`
 *      override, for agent-as-PO sessions) is matched by kind AND id: another
 *      actor's work says nothing about where THIS reader last was. When the
 *      reader has no subject act at all, the baseline falls back to the map's
 *      creation — everything charted since the map existed is new to them — and
 *      with neither anchor the whole subject set is new.
 *
 *   3. **The cut.** The window is every subject event STRICTLY AFTER the
 *      baseline in the store's canonical total order (`ts` → `seq` → `id`,
 *      compareEvents), so same-second acts split deterministically instead of
 *      by a lottery, and the baseline act itself is excluded.
 *
 * What the window REPORTS is DD5's debrief list and nothing more: tickets
 * resolved and closed with their one-liners, tickets created, the map's
 * changes, the node's field changes, and the linked research notes. A claim or
 * a release is a subject act — it advances its actor's baseline, because they
 * were HERE then — but it is not reported: the briefing's frontier section
 * already shows every ticket's current claim, and a debrief that repeated it
 * would spend its most-read lines on state the reader is about to see anyway.
 *
 * Nothing here formats: every field is the fact, and the briefing verb decides
 * how it reads.
 */

/** A ticket as the caller holds it — its own id and the map it hangs off. */
export interface PlanSinceTicketRef {
  id: string;
  map: string;
}

/** What the derivation needs: the subject, the journal, and who is reading. */
export interface PlanSinceInput {
  /** The roadmap node being briefed. */
  node: string;
  /** Its map, or undefined when nothing charts the node yet (F1's no-map case). */
  map: string | undefined;
  /**
   * The store's ticket records. The map join is made HERE rather than by the
   * caller: which tickets belong to the subject is part of the derivation, and
   * a caller that filtered wrongly would produce a window nothing could detect.
   */
  tickets: readonly PlanSinceTicketRef[];
  /** The journal, in any order; read once. */
  events: Iterable<JournalEvent>;
  /** The `--reader` override; absent means the store's human side (DD1). */
  reader?: Actor;
}

/** The act the window opens strictly after, and why that act anchors it. */
export interface PlanSinceBaseline {
  event: JournalEvent;
  /** `reader` — the reader's own latest subject act; `map-created` — the fallback. */
  kind: "reader" | "map-created";
}

/** One ticket the window moved, with the one-liner the act recorded. */
export interface PlanSinceTicketAct {
  id: string;
  /**
   * The line the act wrote: a resolve's `decision`, a close's `reason`, and
   * nothing at all for a creation — a fresh question has earned no answer yet.
   */
  line: string | undefined;
  event: JournalEvent;
}

/** One scalar field the window changed, as the acts recorded it. */
export interface PlanSinceFieldChange {
  field: string;
  /** Its value before the window; absent when the field was unset then. */
  from: string | undefined;
  /** Its value at the window's end; absent when the window unset it. */
  to: string | undefined;
}

/** One LIST field the window changed, diffed as a set (a map's fog, a node's adrs). */
export interface PlanSinceListChange {
  field: string;
  added: string[];
  removed: string[];
}

/**
 * What the window did to one record — the node, or its map. Changes are the
 * NET effect across the whole window: a fog line raised and struck again inside
 * one window is not a change the reader needs to hear about, and the acts are
 * carried alongside so the briefing can cite what happened.
 */
export interface PlanSinceRecordChange {
  /** True when the record was CREATED inside the window (so all of it is new). */
  created: boolean;
  /** Scalar changes in field-name order — deterministic across both records. */
  fields: PlanSinceFieldChange[];
  /** List changes in field-name order. */
  lists: PlanSinceListChange[];
  /** The acts themselves, in the store's total order. */
  events: JournalEvent[];
}

/** One research note linking a journal entry to a ticket on the map. */
export interface PlanSinceNote {
  /** The ticket its `ticket=<id>` data key names. */
  ticket: string;
  event: JournalEvent;
}

/** The debrief: what happened to this node's subject since the reader last was here. */
export interface PlanSinceWindow {
  /** The act the window opens after; absent when nothing anchors it. */
  baseline: PlanSinceBaseline | undefined;
  resolved: PlanSinceTicketAct[];
  closed: PlanSinceTicketAct[];
  created: PlanSinceTicketAct[];
  /** What the window did to the node's own record; absent when it touched none. */
  node: PlanSinceRecordChange | undefined;
  /** What it did to the map — fog, out of scope, destination. */
  map: PlanSinceRecordChange | undefined;
  notes: PlanSinceNote[];
  /** True when there is NOTHING to report: the briefing says "nothing new". */
  empty: boolean;
}

/** The two acts that can move a roadmap node's record. */
const NODE_EVENT_TYPES: ReadonlySet<string> = new Set([
  CORE_EVENT_TYPES.roadmapNodeCreated,
  CORE_EVENT_TYPES.roadmapNodeUpdated,
]);

/** The two that can move a map's. */
const MAP_EVENT_TYPES: ReadonlySet<string> = new Set([
  CORE_EVENT_TYPES.mapCreated,
  CORE_EVENT_TYPES.mapUpdated,
]);

/**
 * Every act that touches a ticket record — the whole set, not just the three
 * the debrief reports, because ALL of them prove the actor was here (rule 2).
 */
const TICKET_EVENT_TYPES: ReadonlySet<string> = new Set([
  CORE_EVENT_TYPES.ticketCreated,
  CORE_EVENT_TYPES.ticketUpdated,
  CORE_EVENT_TYPES.ticketClaimed,
  CORE_EVENT_TYPES.ticketReleased,
  CORE_EVENT_TYPES.ticketResolved,
  CORE_EVENT_TYPES.ticketClosed,
  CORE_EVENT_TYPES.ticketDistilled,
]);

/** The `--data` key a research note links itself to a ticket by (DD1). */
const NOTE_TICKET_PAYLOAD_KEY = "ticket";

/**
 * The record fields a change list never reports: the identity every act
 * repeats, and the two clocks. `updated` moves on EVERY mutation, so reporting
 * it would make "changed nothing" impossible to say.
 */
const UNREPORTED_RECORD_FIELDS: ReadonlySet<string> = new Set(["id", "created", "updated"]);

/**
 * The records of one kind a mutation event carries, read defensively — events
 * are data, the rule every journal reader in the codebase follows.
 *
 * Both payload shapes mutate() writes are read: the single-record
 * `{target, record, body}`, and a sequence's `records` list — which is not an
 * edge case here but the main path, since `resolve` and `close` are both
 * two-record sequences (the ticket and its distilled observation). A reader
 * that only looked at `payload.record` would miss every decision the window
 * exists to report.
 */
function recordedRecords(event: JournalEvent, target: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const consider = (step: unknown): void => {
    if (typeof step !== "object" || step === null) return;
    const fields = step as Record<string, unknown>;
    if (fields["target"] !== target) return;
    const record = fields["record"];
    if (typeof record !== "object" || record === null) return;
    if (typeof (record as Record<string, unknown>)["id"] !== "string") return;
    found.push(record as Record<string, unknown>);
  };
  consider(event.payload);
  const records = event.payload["records"];
  if (Array.isArray(records)) for (const step of records) consider(step);
  return found;
}

/** The one record of `target` an act carries, or undefined when it carries none. */
function recordedRecord(
  event: JournalEvent,
  target: string,
): Record<string, unknown> | undefined {
  return recordedRecords(event, target)[0];
}

/** A record field as a change list reports it: a string, or absent. */
function scalar(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** A list field's entries; anything that is not an array of strings is not a list. */
function list(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => typeof entry === "string") ? [...(value as string[])] : undefined;
}

/**
 * What the window did to one record: its acts, and the NET change between the
 * state the last pre-window act left and the state the last in-window act did.
 *
 * A record with no pre-window act at all (created inside the window, or a
 * history compacted past its earlier acts) diffs against nothing, so every
 * field it carries reads as new — which is exactly what a reader meeting the
 * record for the first time needs. Fields are compared in NAME order so the
 * result does not depend on the key order two payloads happened to be written
 * in.
 */
function recordChange(
  target: string,
  createdType: string,
  before: JournalEvent | undefined,
  acts: readonly JournalEvent[],
): PlanSinceRecordChange | undefined {
  if (acts.length === 0) return undefined;
  const priorState = before === undefined ? {} : (recordedRecord(before, target) ?? {});
  // The LAST act that carries a readable record decides the end state; an act
  // whose payload cannot be read moves nothing and is left to the acts list.
  let endState: Record<string, unknown> = priorState;
  for (const act of acts) {
    const record = recordedRecord(act, target);
    if (record !== undefined) endState = record;
  }

  const fields: PlanSinceFieldChange[] = [];
  const lists: PlanSinceListChange[] = [];
  const names = [...new Set([...Object.keys(priorState), ...Object.keys(endState)])].sort();
  for (const field of names) {
    if (UNREPORTED_RECORD_FIELDS.has(field)) continue;
    const wasList = list(priorState[field]);
    const isList = list(endState[field]);
    if (wasList !== undefined || isList !== undefined) {
      const was = wasList ?? [];
      const is = isList ?? [];
      const added = is.filter((entry) => !was.includes(entry));
      const removed = was.filter((entry) => !is.includes(entry));
      if (added.length > 0 || removed.length > 0) lists.push({ field, added, removed });
      continue;
    }
    const from = scalar(priorState[field]);
    const to = scalar(endState[field]);
    if (from !== to) fields.push({ field, from, to });
  }

  return {
    created: acts.some((act) => act.type === createdType),
    fields,
    lists,
    events: [...acts],
  };
}

/**
 * Derive the window. `events` may arrive in any order and is read once; only
 * subject events are retained, so memory stays proportional to this node's
 * history rather than to the journal.
 */
export function planSince(input: PlanSinceInput): PlanSinceWindow {
  const ticketIds = new Set(
    input.tickets.filter((ticket) => ticket.map === input.map).map((ticket) => ticket.id),
  );

  // Which subject each act belongs to is decided ONCE, here, so the window walk
  // below never re-reads a payload to ask the same question twice.
  const nodeActs: JournalEvent[] = [];
  const mapActs: JournalEvent[] = [];
  const ticketActs: { ticket: string; event: JournalEvent }[] = [];
  const noteActs: PlanSinceNote[] = [];
  const subject: JournalEvent[] = [];

  for (const event of input.events) {
    if (NODE_EVENT_TYPES.has(event.type)) {
      if (recordedRecord(event, "roadmap-node")?.["id"] !== input.node) continue;
      nodeActs.push(event);
    } else if (input.map !== undefined && MAP_EVENT_TYPES.has(event.type)) {
      if (recordedRecord(event, "map")?.["id"] !== input.map) continue;
      mapActs.push(event);
    } else if (TICKET_EVENT_TYPES.has(event.type)) {
      const id = recordedRecord(event, "ticket")?.["id"];
      if (typeof id !== "string" || !ticketIds.has(id)) continue;
      ticketActs.push({ ticket: id, event });
    } else if (!SELF_RECORDED_EVENT_TYPES.has(event.type)) {
      // A logged note: the only events an agent hand-writes, and so the only
      // ones whose `ticket=` key is a link somebody meant rather than a payload
      // field that happens to be spelled that way.
      const ticket = event.payload[NOTE_TICKET_PAYLOAD_KEY];
      if (typeof ticket !== "string" || !ticketIds.has(ticket)) continue;
      noteActs.push({ ticket, event });
    } else {
      continue;
    }
    subject.push(event);
  }

  subject.sort(compareEvents);
  const baseline = resolveBaseline(subject, input.reader);
  const after = (event: JournalEvent): boolean =>
    baseline === undefined || compareEvents(event, baseline.event) > 0;

  const resolved: PlanSinceTicketAct[] = [];
  const closed: PlanSinceTicketAct[] = [];
  const created: PlanSinceTicketAct[] = [];
  for (const { ticket, event } of [...ticketActs].sort((a, b) => compareEvents(a.event, b.event))) {
    if (!after(event)) continue;
    const record = recordedRecord(event, "ticket") ?? {};
    if (event.type === CORE_EVENT_TYPES.ticketResolved) {
      resolved.push({ id: ticket, line: scalar(record["decision"]), event });
    } else if (event.type === CORE_EVENT_TYPES.ticketClosed) {
      closed.push({ id: ticket, line: scalar(record["reason"]), event });
    } else if (event.type === CORE_EVENT_TYPES.ticketCreated) {
      created.push({ id: ticket, line: undefined, event });
    }
    // Every other ticket act moved the reader's baseline and nothing else — see
    // the header on why a claim is not debrief material.
  }

  const notes = noteActs
    .filter(({ event }) => after(event))
    .sort((a, b) => compareEvents(a.event, b.event));

  return {
    baseline,
    resolved,
    closed,
    created,
    node: windowChange("roadmap-node", CORE_EVENT_TYPES.roadmapNodeCreated, nodeActs, after),
    map: windowChange("map", CORE_EVENT_TYPES.mapCreated, mapActs, after),
    notes,
    empty:
      resolved.length === 0 &&
      closed.length === 0 &&
      created.length === 0 &&
      notes.length === 0 &&
      nodeActs.every((event) => !after(event)) &&
      mapActs.every((event) => !after(event)),
  };
}

/**
 * One record's change across the window: its in-window acts diffed against the
 * state its last PRE-window act left. The pre-window act is needed even though
 * it is not reported — without it a field change has no `from`, and the whole
 * record would read as new.
 */
function windowChange(
  target: string,
  createdType: string,
  acts: readonly JournalEvent[],
  after: (event: JournalEvent) => boolean,
): PlanSinceRecordChange | undefined {
  const ordered = [...acts].sort(compareEvents);
  const inWindow = ordered.filter(after);
  const before = ordered.filter((event) => !after(event)).at(-1);
  return recordChange(target, createdType, before, inWindow);
}

/**
 * The act the window opens after (rule 2): the reader's own latest subject act,
 * or the map's creation when they have none.
 *
 * The default reader is the store's HUMAN side rather than the invoking actor,
 * and the difference is the whole point: an AFK lane running under the
 * session's agent id would otherwise open its window after its own last act and
 * bury the findings the human came back to read.
 *
 * `subject` arrives in ascending total order, so the last match is the latest.
 */
function resolveBaseline(
  subject: readonly JournalEvent[],
  reader: Actor | undefined,
): PlanSinceBaseline | undefined {
  const isReader = (event: JournalEvent): boolean =>
    reader === undefined
      ? event.actor.kind === "human"
      : event.actor.kind === reader.kind && event.actor.id === reader.id;

  for (let index = subject.length - 1; index >= 0; index -= 1) {
    const event = subject[index]!;
    if (isReader(event)) return { event, kind: "reader" };
  }
  // The fallback is the map's CREATION, not its latest act: a map updated by
  // somebody else since the reader last looked is exactly the news they are owed.
  const created = subject.find((event) => event.type === CORE_EVENT_TYPES.mapCreated);
  return created === undefined ? undefined : { event: created, kind: "map-created" };
}

import {
  CORE_EVENT_TYPES,
  DEPLOY_COMPLETED_EVENT_TYPE,
  DEPLOY_ENVIRONMENT_PAYLOAD_KEY,
  QA_SWEEP_EVENT_TYPE,
  RELEASE_ANNOUNCED_EVENT_TYPE,
  RELEASE_VERSION_PAYLOAD_KEY,
  ROADMAP_COLUMN_RETRACTED_EVENT_TYPE,
} from "../schema/events";
import type { JournalEvent, WorkItemFrontmatter } from "../schema/records";
import { epochSeconds, timestampFromEpochSeconds, TIMESTAMP_PATTERN } from "../schema/time";
import { compareEvents } from "../store/journal";
import type { RoadmapNodeRecord } from "../store/layout";
import {
  payloadText,
  roadmapNodeSummary,
  ROADMAP_COLUMN_FACT_TYPES,
  withdrawnEventId,
} from "./roadmap";
import { epicCoverage, type RunSnapshot } from "./snapshot";

/**
 * `nahel standup --since <when>` (Phase 4 F4): a CURATED read over the journal
 * for a time window — what moved, what shipped, what parked, what got blocked —
 * grouped by roadmap node and item.
 *
 * It creates ZERO new state: no records, no events, no config. Everything it
 * says comes off journal acts already written, and every rendered line names
 * the act it came from, so a reader can go back to the journal and check it.
 *
 * PURE, like every other view: facts in, a string out. The window's lower edge
 * is resolved by the command from the injected `Env` (resolveSince below) and
 * arrives here as data — nothing on this path reads a clock.
 *
 * MEMORY is bounded by the store, never by its history (PR #26 follow-up E).
 * collectStandupWindow below streams the journal into a small baseline plus the
 * window's own acts, so what a render holds is
 *
 *   O(items) statuses + O(retractions) + O(acts inside the window)
 *
 * — plus the k-way merge's one head per segment, which is the streaming reader's
 * own cost. Nothing here retains, or sorts, a lifetime of movement. The
 * retraction term is the store's correction log and nothing else: a retraction
 * is decided by id alone, whenever it was written, so the set of withdrawn ids
 * is the one fact a window cannot derive from its own slice.
 */

/** The relative window forms `--since` accepts: whole days or whole hours. */
const RELATIVE_SINCE = /^([0-9]+)([dh])$/;

/** How many seconds each relative unit is worth. */
const RELATIVE_UNIT_SECONDS: Record<string, number> = { d: 86400, h: 3600 };

/**
 * A resolved window, or the reason it is not one. A discriminated result rather
 * than `undefined`, because the ways a `--since` can fail are different
 * mistakes with different repairs — a misspelling, a date the calendar does not
 * have, a duration reaching past every year the format can spell — and a single
 * "invalid" would never tell the reader which of the three it was.
 */
export type SinceResolution = { since: string } | { error: string };

/** What the flag accepts, spelled the same way in every refusal below. */
const ACCEPTED_FORMS =
  "expected a window (7d, 24h) or an ISO-8601 UTC timestamp (2026-07-26T09:15:00Z)";

/**
 * Resolve `--since` to the window's lower edge: a relative form (`7d`, `24h`)
 * subtracted from the injected clock reading, or an absolute timestamp in the
 * journal's own format passed through unchanged.
 *
 * `now` is `env.now()`'s value, handed in as DATA. The relative and absolute
 * forms therefore land on the same instant when they name the same instant,
 * which is what makes `--since 7d` and its equivalent timestamp render
 * byte-identically under a fixed `Env` (F4's acceptance criterion).
 *
 * Nothing here rounds, clamps or guesses. A spec that names no instant is
 * REFUSED, with the reason: a standup header carrying a year the format cannot
 * spell would be a rendered lie, and a window quietly clamped to the epoch
 * would report the wrong days as though they were the days that were asked for.
 */
export function resolveSince(spec: string, now: string): SinceResolution {
  const relative = RELATIVE_SINCE.exec(spec);
  if (relative !== null) return resolveRelative(spec, relative, now);
  if (!TIMESTAMP_PATTERN.test(spec)) return { error: ACCEPTED_FORMS };
  if (epochSeconds(spec) === undefined) {
    return {
      error:
        `${spec} has the shape of a timestamp but names no real instant — ` +
        "check the month, day, hour, minute and second",
    };
  }
  return { since: spec };
}

/** The relative branch: a count of whole units subtracted from the reading. */
function resolveRelative(
  spec: string,
  relative: RegExpExecArray,
  now: string,
): SinceResolution {
  const count = Number(relative[1]);
  const seconds = count * RELATIVE_UNIT_SECONDS[relative[2]!]!;
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(seconds)) {
    return { error: `${spec} is too large to be a window — its length is not an exact number` };
  }
  const nowSeconds = epochSeconds(now);
  if (nowSeconds === undefined) {
    // Unreachable through systemEnv, which always formats a real instant;
    // reachable through a fixed one, and a window dated off a non-instant is
    // not a window.
    return { error: `the clock reading ${now} names no real instant` };
  }
  const cutoff = timestampFromEpochSeconds(nowSeconds - seconds);
  if (cutoff === undefined) {
    return {
      error: `${spec} reaches outside the representable calendar (years 0000–9999) from ${now}`,
    };
  }
  return { since: cutoff };
}

/** Everything one standup renders from — store reads, no derivation done yet. */
export interface StandupInputs {
  /** The window's lower edge, inclusive, already resolved (resolveSince). */
  since: string;
  /** Roadmap node records, in the id order readRoadmapNodes returns. */
  nodes: readonly RoadmapNodeRecord[];
  /** Every work item, in the snapshot's created → id order. */
  items: readonly WorkItemFrontmatter[];
  /** Every run — the run → item mapping a run-scoped act is grouped by. */
  runs: readonly RunSnapshot[];
  /**
   * The acts this window renders from, any order: everything INSIDE it, plus
   * the few pre-window acts the page still needs — the surviving lifecycle
   * facts the group headers derive their stage from, the facts an in-window
   * retraction withdraws, and every retraction in the store. That is exactly
   * what collectStandupWindow keeps, and the whole journal is a valid value
   * too: the walk below is total over ANY slice of it, which is what lets the
   * collected slice be proven byte-identical to the lot.
   */
  events: readonly JournalEvent[];
  /**
   * What each item's status was at the window's lower edge — the pre-window
   * history collapsed to one word per item, so a transition inside the window
   * can name where it came from without the acts that got it there being held.
   * An item absent here has no recorded past the caller could see, and renders
   * `→ <status>` rather than an invented previous one.
   */
  baseline: ReadonlyMap<string, string>;
}

/** What one window needs off the journal, and nothing else (collect below). */
export interface StandupWindow {
  /** The acts to render (StandupInputs.events). */
  events: JournalEvent[];
  /** Status per item at the window's lower edge (StandupInputs.baseline). */
  baseline: Map<string, string>;
}

/**
 * Stream the journal into exactly what one window renders from, and nothing
 * else (PR #26 follow-up E).
 *
 * The earlier reading kept every standup-relevant act of the WHOLE journal and
 * then sorted a copy: the cost of a `--since 24h` read grew with the project's
 * age rather than with the day it asked about. What it needed history for is
 * small and knowable, so history is collapsed as it streams:
 *
 *   · a status per item, the baseline a transition is measured against;
 *   · per item and lifecycle type, the last SURVIVING fact, because the group
 *     headers carry F2's derived stage and that stage reads the whole journal;
 *   · the pre-window facts an in-window retraction withdraws — a correction has
 *     to say what the withdrawn act said, and after this its own line is the
 *     only place those words still exist;
 *   · every retraction, which is the set the derivation and the corrections
 *     both read; a retraction is decided by id alone, so one written before the
 *     fact it names counts exactly as much as one written a year after.
 *
 * TWO passes over the journal, which is deliberate: the surviving winner cannot
 * be chosen until the withdrawn set is known, and a single pass would have to
 * hold every candidate that a retraction still arriving might promote — the
 * unbounded memory this exists to remove. The second read costs I/O, and I/O is
 * not what was growing.
 *
 * `journal` is a THUNK for that reason: it is opened twice, and the collector
 * never touches the store itself, so it stays as testable as the render.
 */
export async function collectStandupWindow(
  since: string,
  journal: () => AsyncIterable<JournalEvent>,
): Promise<StandupWindow> {
  const retractions: JournalEvent[] = [];
  for await (const event of journal()) {
    if (event.type === ROADMAP_COLUMN_RETRACTED_EVENT_TYPE) retractions.push(event);
  }
  // What the derivation must ignore, and — a subset — what a line inside the
  // window has to be able to quote back.
  const withdrawn = new Set<string>();
  const corrected = new Set<string>();
  for (const event of retractions) {
    const target = withdrawnEventId(event);
    if (target === undefined) continue;
    withdrawn.add(target);
    if (event.ts >= since) corrected.add(target);
  }

  const events = [...retractions];
  const baseline = new Map<string, string>();
  // Per item and type, the last surviving pre-window fact. Keyed per ITEM rather
  // than per node because coverage is the view's to decide: two nodes whose
  // epics nest read the same item's facts, and the maximum over a set of items
  // is the maximum of their own maxima.
  const winners = new Map<string, JournalEvent>();
  for await (const event of journal()) {
    // Every retraction is already held, whichever side of the edge it sits on.
    if (event.type === ROADMAP_COLUMN_RETRACTED_EVENT_TYPE) continue;
    if (event.ts >= since) {
      if (isStandupEvent(event)) events.push(event);
      continue;
    }
    if (ITEM_RECORD_EVENT_TYPES.has(event.type)) {
      const recorded = recordedStatus(event);
      if (recorded !== undefined && event.item !== undefined) baseline.set(event.item, recorded);
      continue;
    }
    if (!ROADMAP_COLUMN_FACT_TYPES.has(event.type)) continue;
    // A withdrawn fact is kept only as the words its correction quotes — an
    // item-less one included, since that line still prints under `(no item
    // ref)` — and never as a candidate the columns could still elect.
    if (corrected.has(event.id)) {
      events.push(event);
      continue;
    }
    if (withdrawn.has(event.id) || event.item === undefined) continue;
    const key = `${event.item} ${event.type}`;
    const winner = winners.get(key);
    if (winner === undefined || compareEvents(winner, event) < 0) winners.set(key, event);
  }
  events.push(...winners.values());
  return { events, baseline };
}

/**
 * The item-record mutations whose payload carries a status a standup reads.
 *
 * `item.started-with-open-blocker` (Phase 4 F8) is one of them: it REPLACES
 * `item.updated` as the write-ahead event of a deliberately blocked start, so a
 * set that named only the generic type would make exactly those moves — the
 * ones a reader most wants to see — vanish from the window.
 */
const ITEM_RECORD_EVENT_TYPES: ReadonlySet<string> = new Set([
  CORE_EVENT_TYPES.itemCreated,
  CORE_EVENT_TYPES.itemUpdated,
  CORE_EVENT_TYPES.itemStartedBlocked,
  CORE_EVENT_TYPES.itemClaimed,
  CORE_EVENT_TYPES.itemHandback,
]);

/** The lifecycle acts that carry a feature past its own development (F2/F9). */
const LIFECYCLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  QA_SWEEP_EVENT_TYPE,
  DEPLOY_COMPLETED_EVENT_TYPE,
  RELEASE_ANNOUNCED_EVENT_TYPE,
]);

/**
 * True for every act a standup can read: the item mutations whose payload
 * carries a status, the run pause, the three lifecycle types — and the
 * retractions that withdraw one of those (A1). This is what collectStandupWindow
 * KEEPS of the acts inside the window — the isRoadmapColumnEvent precedent, so
 * a store whose journal outgrows memory still renders a standup. Anything else
 * is not movement and is dropped.
 *
 * A retraction is kept for TWO reasons. The group headers carry
 * roadmapNodeSummary's derived stage, which reads retractions, so a filter that
 * dropped them would print a stage the roadmap view no longer shows. And a
 * withdrawal is movement in its own right (see retractionMovement): without a
 * line of its own, a window whose only act was a retraction reports "no
 * movement", and a release retracted in the SAME window renders `shipped
 * released 0.3.0` under a header reading `built`, with nothing on the page
 * reconciling the two.
 */
export function isStandupEvent(event: JournalEvent): boolean {
  return (
    ITEM_RECORD_EVENT_TYPES.has(event.type) ||
    event.type === CORE_EVENT_TYPES.runPaused ||
    LIFECYCLE_EVENT_TYPES.has(event.type) ||
    event.type === ROADMAP_COLUMN_RETRACTED_EVENT_TYPE
  );
}

/** One rendered act: what it says, and which act said it. */
interface Movement {
  /** The item it groups under; undefined when the act carries no item ref. */
  item?: string;
  event: JournalEvent;
  verb: string;
  detail: string;
}

/**
 * The status one item mutation recorded, read defensively from the payload
 * mutate() journals (`{target, record, body}`) — events are data, the rule
 * every journal reader in the codebase follows. An act whose payload cannot be
 * read as an item record is not a transition and is skipped.
 */
function recordedStatus(event: JournalEvent): string | undefined {
  const record = event.payload["record"];
  if (typeof record !== "object" || record === null) return undefined;
  const status = (record as Record<string, unknown>)["status"];
  return typeof status === "string" ? status : undefined;
}

/**
 * The word a status transition earns — the PRD's four categories in the store's
 * own vocabulary: `blocked` is what got blocked, `parked` is what was dropped,
 * `closed` is what finished, and everything else simply `moved`.
 */
function transitionVerb(status: string): string {
  if (status === "done") return "closed";
  if (status === "blocked") return "blocked";
  if (status === "dropped") return "parked";
  return "moved";
}

/**
 * The movement inside the window, in the store's canonical order.
 *
 * Item status starts at the caller's baseline — what each item stood at when
 * the window opened — so a transition can name where it came from; an item
 * neither the baseline nor the acts here cover renders `→ <status>` rather than
 * inventing a previous one. Any pre-window act the caller DID hand over refines
 * that baseline the same way it always did and renders nothing itself, which is
 * what keeps the walk total over any slice of the journal, the collected one
 * and the whole of it alike. An act that moved no status at all — a claim, a
 * handback, an intent edit — is not movement and renders nothing: this is a
 * curated read, not the timeline `nahel progress` already prints.
 */
function movements(inputs: StandupInputs): Movement[] {
  const runItems = new Map(inputs.runs.map(({ run }) => [run.id, run.item]));
  const status = new Map(inputs.baseline);
  const found: Movement[] = [];
  // A retraction names its target by id and carries no item ref of its own, so
  // the whole window's events are indexed before the walk: the target may sit
  // anywhere, including well before the window's lower edge.
  const byId = new Map(inputs.events.map((event) => [event.id, event]));
  for (const event of [...inputs.events].sort(compareEvents)) {
    const inWindow = event.ts >= inputs.since;

    if (ITEM_RECORD_EVENT_TYPES.has(event.type)) {
      const recorded = recordedStatus(event);
      if (recorded === undefined || event.item === undefined) continue;
      const previous = status.get(event.item);
      status.set(event.item, recorded);
      if (!inWindow) continue;
      if (event.type === CORE_EVENT_TYPES.itemCreated) {
        found.push({ item: event.item, event, verb: "opened", detail: recorded });
      } else if (previous !== recorded) {
        found.push({
          item: event.item,
          event,
          verb: transitionVerb(recorded),
          detail: previous === undefined ? `→ ${recorded}` : `${previous} → ${recorded}`,
        });
      }
      continue;
    }

    if (!inWindow) continue;
    // A paused run is work parked mid-flight; the item it hangs off is what
    // groups it, and run events carry that ref (mutate's run mutations do).
    if (event.type === CORE_EVENT_TYPES.runPaused && event.run !== undefined) {
      const item = event.item ?? runItems.get(event.run);
      found.push({
        ...(item === undefined ? {} : { item }),
        event,
        verb: "parked",
        detail: `run ${event.run}`,
      });
      continue;
    }
    if (event.type === ROADMAP_COLUMN_RETRACTED_EVENT_TYPE) {
      const retracted = retractionMovement(event, byId);
      if (retracted !== undefined) found.push(retracted);
      continue;
    }
    const lifecycle = lifecycleMovement(event);
    if (lifecycle !== undefined) found.push(lifecycle);
  }
  return found;
}

/** The sweep's `failed` count as a phrase, degrading visibly like F2's column. */
function sweepDetail(event: JournalEvent): string {
  return `${payloadText(event.payload, "failed")} failed`;
}

/**
 * The three open-extension acts that carry a feature past its own development
 * (F2's columns, F9's types): a sweep reads `tested`, a deploy and a release
 * both read `shipped`. Undefined for every other type — anything else is not
 * movement a standup reports.
 */
function lifecycleMovement(event: JournalEvent): Movement | undefined {
  const of = (verb: string, detail: string): Movement => ({
    ...(event.item === undefined ? {} : { item: event.item }),
    event,
    verb,
    detail,
  });
  if (event.type === QA_SWEEP_EVENT_TYPE) return of("tested", sweepDetail(event));
  if (event.type === DEPLOY_COMPLETED_EVENT_TYPE) {
    return of("shipped", `deployed ${payloadText(event.payload, DEPLOY_ENVIRONMENT_PAYLOAD_KEY)}`);
  }
  if (event.type === RELEASE_ANNOUNCED_EVENT_TYPE) {
    return of("shipped", `released ${payloadText(event.payload, RELEASE_VERSION_PAYLOAD_KEY)}`);
  }
  return undefined;
}

/**
 * A withdrawal, as movement: `retracted  <what the withdrawn act's own line
 * said> (act <its id>)`, named by the retraction's id like every other line.
 *
 * The original act line stays exactly where it was — the journal is append-only
 * and a standup reports what happened — so a same-window pair reads as the two
 * acts it is: the release was announced, then taken back. The withdrawn act's
 * OWN words are reused verbatim (lifecycleMovement, the one place they live) so
 * a reader can match the two lines without translating between them.
 *
 * It groups under the WITHDRAWN fact's item, because the retraction carries no
 * item ref of its own — the event-id edge is the whole relationship — and that
 * is the item whose derived stage just changed.
 *
 * Undefined when the retraction withdraws nothing: an incomplete payload
 * (withdrawnEventId requires a target AND a reason), an id no event here
 * carries, or a target that is not a lifecycle fact. That is the same silence
 * the derivation keeps, which is the point — a line here for a retraction the
 * columns ignored would report a change that did not happen.
 */
function retractionMovement(
  event: JournalEvent,
  byId: ReadonlyMap<string, JournalEvent>,
): Movement | undefined {
  const target = withdrawnEventId(event);
  if (target === undefined) return undefined;
  const withdrawn = byId.get(target);
  if (withdrawn === undefined) return undefined;
  const said = lifecycleMovement(withdrawn);
  if (said === undefined) return undefined;
  return {
    ...(withdrawn.item === undefined ? {} : { item: withdrawn.item }),
    event,
    verb: "retracted",
    detail: `${said.verb} ${said.detail} (act ${withdrawn.id})`,
  };
}

/** The bucket an act with no item ref falls into — shown, never dropped. */
const NO_ITEM_KEY = "";

/** The label that bucket renders under. */
const NO_ITEM_LABEL = "(no item ref)";

/** The group a movement no roadmap node covers falls into. */
const OUTSIDE_HEADING = "outside the roadmap";

/**
 * Which roadmap nodes cover each item: a node covers the items under its epic,
 * the SAME association rule F2's columns use — snapshot.ts's epicCoverage, the
 * one place that rule lives. Two nodes whose epics nest therefore both report
 * the inner subtree's acts — the honest reading of a store that names one epic
 * inside another, and exactly what the roadmap's columns already show.
 *
 * A node whose epic id no record carries covers NOTHING, so its acts fall
 * through to `outside the roadmap` instead of grouping under a ghost feature:
 * the orphans still naming that dead id as their parent ARE movement no node
 * covers, which is exactly what that section exists for.
 */
function coveringNodes(inputs: StandupInputs): Map<string, string[]> {
  const covering = new Map<string, string[]>();
  for (const { frontmatter } of inputs.nodes) {
    for (const item of epicCoverage(inputs.items, frontmatter.epic)) {
      const nodes = covering.get(item);
      if (nodes === undefined) covering.set(item, [frontmatter.id]);
      else nodes.push(frontmatter.id);
    }
  }
  return covering;
}

/** One item's movement, under the heading that names the item. */
function itemBlock(
  key: string,
  label: string,
  found: readonly Movement[],
  lines: string[],
): void {
  lines.push(`  ${key === NO_ITEM_KEY ? NO_ITEM_LABEL : label}`);
  for (const movement of found) {
    lines.push(
      `    ${movement.event.ts}  ${movement.verb}  ${movement.detail}  act=${movement.event.id}`,
    );
  }
}

/**
 * One group's items, in the snapshot's created → id order. An id no item record
 * carries — an act referencing work that was never written, or written before a
 * compaction — sorts after every known item, by id, and is labelled by the id
 * alone: a missing record is still an act that happened.
 */
function groupBody(
  found: readonly Movement[],
  order: ReadonlyMap<string, number>,
  names: ReadonlyMap<string, string>,
  lines: string[],
): void {
  const byItem = new Map<string, Movement[]>();
  for (const movement of found) {
    const key = movement.item ?? NO_ITEM_KEY;
    const bucket = byItem.get(key);
    if (bucket === undefined) byItem.set(key, [movement]);
    else bucket.push(movement);
  }
  const keys = [...byItem.keys()].sort((a, b) => {
    // The item-less bucket last: it is the residue, not one of the items.
    if (a === NO_ITEM_KEY || b === NO_ITEM_KEY) return a === NO_ITEM_KEY ? 1 : -1;
    const rankA = order.get(a) ?? order.size;
    const rankB = order.get(b) ?? order.size;
    if (rankA !== rankB) return rankA - rankB;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const key of keys) {
    const name = names.get(key);
    itemBlock(key, name === undefined ? key : `${name}  id=${key}`, byItem.get(key)!, lines);
  }
}

/**
 * Render the standup (PURE). The window is stated first, then one group per
 * roadmap node that saw movement — in the id order readRoadmapNodes returns —
 * and a final group for movement no node covers. A node with nothing in the
 * window is silent: a standup lists what moved, and a roster of quiet nodes
 * would bury the answer it exists to give.
 */
export function renderStandup(inputs: StandupInputs): string {
  const found = movements(inputs);
  const header = `standup since ${inputs.since}`;
  if (found.length === 0) return `${header}\n\nno movement in this window`;

  const covering = coveringNodes(inputs);
  const order = new Map(inputs.items.map((item, index) => [item.id, index]));
  const names = new Map(inputs.items.map((item) => [item.id, item.name]));

  const lines: string[] = [header];
  const grouped = new Set<Movement>();
  for (const record of inputs.nodes) {
    const own = found.filter(
      (movement) =>
        movement.item !== undefined &&
        (covering.get(movement.item) ?? []).includes(record.frontmatter.id),
    );
    if (own.length === 0) continue;
    for (const movement of own) grouped.add(movement);
    lines.push("", roadmapNodeSummary(record, inputs.nodes, inputs.items, inputs.events));
    groupBody(own, order, names, lines);
  }
  const outside = found.filter((movement) => !grouped.has(movement));
  if (outside.length > 0) {
    lines.push("", OUTSIDE_HEADING);
    groupBody(outside, order, names, lines);
  }
  return lines.join("\n");
}

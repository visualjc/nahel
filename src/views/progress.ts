import type { Actor, JournalEvent } from "../schema/records";
import { readJournal } from "../store/journal";
import type { StoreLayout } from "../store/layout";

/**
 * The progress view (PRD F6): the merged journal timeline, STRICTLY a view —
 * every rendered token comes off a journal event, nothing else. Split per the
 * epic's pure-views decision: collectProgress streams the store's k-way merge
 * (filters applied per event, a ring buffer for --limit — never a
 * full-journal load), and renderProgress is a PURE function events → string,
 * newest LAST. brief (#8) composes the same collector + renderer for its
 * recent-activity section.
 */

/** Which events a progress read keeps; empty means the whole timeline. */
export interface ProgressQuery {
  /**
   * Item subtree filter: covered item ids (a root plus its descendants — see
   * snapshot.ts's descendantIds). An event matches by its item ref, or …
   */
  itemIds?: ReadonlySet<string>;
  /**
   * … by its run ref against the covered items' runs — run-scoped events
   * (e.g. `log --run`) need not carry an item ref.
   */
  runIds?: ReadonlySet<string>;
  /** Keep events with ts >= since (ISO-8601 UTC, the journal's own format). */
  since?: string;
  /** Keep only the NEWEST n matching events. */
  limit?: number;
}

/** Pure predicate: does one event pass the query's since/item/run filters? */
export function eventMatchesQuery(event: JournalEvent, query: ProgressQuery): boolean {
  if (query.since !== undefined && event.ts < query.since) return false;
  if (query.itemIds !== undefined || query.runIds !== undefined) {
    const byItem = event.item !== undefined && (query.itemIds?.has(event.item) ?? false);
    const byRun = event.run !== undefined && (query.runIds?.has(event.run) ?? false);
    if (!byItem && !byRun) return false;
  }
  return true;
}

/**
 * Stream the merged journal and keep the matching events, oldest → newest.
 * With a limit, a ring buffer keeps exactly the newest n — memory stays O(n)
 * however large the journal grows.
 */
export async function collectProgress(
  layout: StoreLayout,
  query: ProgressQuery = {},
): Promise<JournalEvent[]> {
  const { limit } = query;
  const kept: JournalEvent[] = [];
  let next = 0; // ring cursor: index of the oldest kept event once full
  for await (const event of readJournal(layout)) {
    if (!eventMatchesQuery(event, query)) continue;
    if (limit === undefined || kept.length < limit) {
      kept.push(event);
    } else {
      kept[next] = event;
      next = (next + 1) % limit;
    }
  }
  return next === 0 ? kept : [...kept.slice(next), ...kept.slice(0, next)];
}

function formatActor(actor: Actor): string {
  const base = `${actor.kind}:${actor.id}`;
  return actor.session === undefined ? base : `${base}:${actor.session}`;
}

/**
 * Render the timeline (PURE): one line per event in the given order — pass
 * events oldest-first and the newest is the LAST line. Every token traces to
 * the event: ts, type, actor, refs, payload verbatim.
 */
export function renderProgress(events: readonly JournalEvent[]): string {
  if (events.length === 0) return "no journal events";
  return events
    .map((event) => {
      const parts = [event.ts, event.type, formatActor(event.actor)];
      if (event.item !== undefined) parts.push(`item=${event.item}`);
      if (event.run !== undefined) parts.push(`run=${event.run}`);
      if (Object.keys(event.payload).length > 0) parts.push(JSON.stringify(event.payload));
      return parts.join("  ");
    })
    .join("\n");
}

import { CORE_EVENT_TYPES, ROADMAP_ACKED_EVENT_TYPE } from "../schema/events";
import type { Governance, JournalEvent } from "../schema/records";
import { resolveGovernance } from "./authority";

/**
 * Awaiting your eyes (PRD F5): the agent-attributed roadmap acts a human has
 * not looked at yet. The roadmap layer's control is VISIBILITY, not
 * enforcement — nothing here refuses anything, and no CLI path consults it
 * before writing. It decides one thing: what `nahel brief` says.
 *
 * Three rules, and the codebase answers each exactly once:
 *
 *   1. Under `governance.product: agent` there is NO surface at all. The
 *      agent-as-PO owns the roadmap outright, under its own journaled
 *      authority (ADR-0008 as amended 2026-08-01) — its acts appear in the
 *      ordinary roadmap block and nowhere else. `human` and `delegated` both
 *      raise the surface: `delegated`'s consensus rule governs PRD approval,
 *      not roadmap scribing, and the roadmap layer adds no consensus
 *      requirement of its own.
 *
 *   2. The window opens after the last HUMAN-attributed roadmap act — a node
 *      created or updated, or `nahel roadmap ack`, which says "seen" and
 *      nothing else. Provenance is read from the JOURNAL, exactly as merge
 *      authority reads the flip that authorizes auto-merge, so an ack run
 *      under an agent actor clears nothing. And acts are identified by event
 *      TYPE, never by payload shape: a `note` carrying a node-shaped payload
 *      is inert data, neither a change nor a clear.
 *
 *   3. Before a human has EVER touched the roadmap there is no window, so
 *      there is no line — a first-touch human is told nothing rather than
 *      shown an empty header (F5's acceptance criterion). Their first act, or
 *      their first ack, is what sets the baseline.
 *
 * Deterministic throughout: config plus journal events in, an answer out. No
 * clock, no network, no judgment.
 */

/** Nodes named on the brief's one line before the remainder is counted (F4's cap). */
export const AWAITING_ROADMAP_NODE_CAP = 10;

/** One node an agent touched inside the window. */
export interface AwaitingRoadmapNode {
  id: string;
  /** The node's slug as its LATEST act in the window recorded it. */
  name: string;
}

/** What is waiting for the human's eyes, and the act the window opens after. */
export interface AwaitingRoadmapReview {
  /** Agent-attributed roadmap MUTATIONS in the window — acts, not nodes. */
  changes: number;
  /** The distinct nodes those acts touched, first-touch order, capped. */
  nodes: AwaitingRoadmapNode[];
  /** Distinct nodes beyond the cap — stated, never silently dropped. */
  more: number;
  /** The timestamp of the human roadmap act the window opens after. */
  since: string;
}

/** The roadmap acts a HUMAN performs to say "I have seen this". */
const CLEARING_EVENT_TYPES: ReadonlySet<string> = new Set([
  CORE_EVENT_TYPES.roadmapNodeCreated,
  CORE_EVENT_TYPES.roadmapNodeUpdated,
  ROADMAP_ACKED_EVENT_TYPE,
]);

/** The roadmap acts that MOVE the roadmap; `ack` moves nothing, so it is absent. */
const CHANGE_EVENT_TYPES: ReadonlySet<string> = new Set([
  CORE_EVENT_TYPES.roadmapNodeCreated,
  CORE_EVENT_TYPES.roadmapNodeUpdated,
]);

/**
 * The node an act touched, read defensively from the mutation payload mutate()
 * journals (`{target, record, body}`) — events are data, the same rule
 * authority.ts reads config payloads by. An act whose payload cannot be read
 * is still a change the human must see, so it is keyed and labelled by its own
 * act id rather than dropped (hard constraint 6).
 */
function touchedNode(event: JournalEvent): AwaitingRoadmapNode {
  const record = event.payload["record"];
  const field = (key: string): string | undefined => {
    if (typeof record !== "object" || record === null) return undefined;
    const value = (record as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  };
  const id = field("id") ?? event.id;
  return { id, name: field("name") ?? id };
}

/**
 * Resolve what awaits the human's eyes. `events` may arrive in any order and
 * is read once; only agent roadmap mutations are retained, so memory stays
 * proportional to roadmap history rather than to the journal.
 *
 * The window is decided by TIMESTAMP alone, and inclusively at its lower edge:
 * an agent act sharing the clearing act's second stays raised. Every CLI
 * invocation mints its own
 * session segment, so same-second acts from different sessions all carry seq 0
 * and the total order falls through to the random event id — a lottery that
 * could otherwise hide a change behind an ack that never saw it. Merge
 * authority fails safe by withholding authority; the safe direction HERE is
 * the opposite one, showing the change, because the cost of the fail-safe is
 * one line a human reads twice.
 */
export function awaitingRoadmapReview(
  governance: Partial<Governance> | undefined,
  events: Iterable<JournalEvent>,
): AwaitingRoadmapReview | undefined {
  if (resolveGovernance(governance).product.mode === "agent") return undefined;

  let cutoff: string | undefined;
  const agentActs: JournalEvent[] = [];
  for (const event of events) {
    if (event.actor.kind === "human") {
      if (!CLEARING_EVENT_TYPES.has(event.type)) continue;
      if (cutoff === undefined || event.ts > cutoff) cutoff = event.ts;
    } else if (CHANGE_EVENT_TYPES.has(event.type)) {
      agentActs.push(event);
    }
  }
  if (cutoff === undefined) return undefined;

  // First-touch order, latest name per node: a node renamed inside the window
  // is listed as it now stands, which is what `nahel roadmap` will show.
  const nodes = new Map<string, AwaitingRoadmapNode>();
  let changes = 0;
  for (const event of agentActs) {
    if (event.ts < cutoff) continue;
    changes += 1;
    const node = touchedNode(event);
    const seen = nodes.get(node.id);
    if (seen === undefined) nodes.set(node.id, node);
    else seen.name = node.name;
  }
  if (changes === 0) return undefined;

  const listed = [...nodes.values()];
  return {
    changes,
    nodes: listed.slice(0, AWAITING_ROADMAP_NODE_CAP),
    more: Math.max(listed.length - AWAITING_ROADMAP_NODE_CAP, 0),
    since: cutoff,
  };
}

import { join } from "node:path";
import type { Env } from "../schema/env";
import { MUTATION_EVENT_TYPES } from "../schema/events";
import {
  runSchema,
  workItemFrontmatterSchema,
  type Actor,
  type JournalEvent,
  type Run,
  type WorkItemFrontmatter,
} from "../schema/records";
import { resolveActor } from "./actor";
import {
  appendEvent,
  latestCandidates,
  listSegments,
  mergeSegments,
  newSessionSegmentId,
} from "./journal";
import {
  itemExists,
  readConfig,
  readItem,
  readRun,
  storeLayout,
  writeItem,
  writeRun,
  type StoreLayout,
} from "./layout";

/**
 * The mutation choke point (epic architecture decision): EVERY item/run
 * mutation flows through mutate(), which (1) acts as the resolved actor from
 * the injected context, (2) refuses agent mutations on claimed items —
 * including descendants of a claimed ancestor (claim covers the subtree,
 * PRD F9) on both the current and the post-mutation parent chain — moving an
 * item INTO a claimed subtree is refused too, (3) appends the journal event
 * FIRST, carrying the full mutation
 * payload (write-ahead, PRD F1), and (4) applies the record write. The only
 * crash window leaves the journal ahead of the record — never an unjournaled
 * mutation — and replayPending() heals it deterministically from the payload.
 *
 * Claim enforcement here is a cooperative guardrail against
 * cooperating-but-fallible agents; the journal makes any bypass auditable.
 * There is deliberately NO auth machinery (hard constraint 1).
 */

/** An agent mutation hit a claimed item (or a descendant of one). */
export class ClaimViolationError extends Error {}

/** Everything a mutation needs, resolved once at the entry point. */
export interface StoreContext {
  layout: StoreLayout;
  env: Env;
  actor: Actor;
  /** Writer-scoped session segment id for this context's non-run events. */
  session: string;
}

/**
 * Build a store context: reads nahel/config, resolves the actor (config
 * entry, overridden by the NAHEL_ACTOR value the entry point read from its
 * environment), and mints the writer-scoped session segment unless the caller
 * carries one across CLI invocations.
 */
export async function createStoreContext(
  root: string,
  env: Env,
  options: { actorOverride?: string; session?: string } = {},
): Promise<StoreContext> {
  const layout = storeLayout(root);
  const config = await readConfig(layout);
  return {
    layout,
    env,
    actor: resolveActor(config.actor, options.actorOverride),
    session: options.session ?? newSessionSegmentId(env),
  };
}

/** A state change, as data — the event payload carries all of it. */
export type Mutation =
  | {
      target: "item";
      eventType: string;
      frontmatter: WorkItemFrontmatter;
      body: string;
      /**
       * Extra fields merged into the journal event payload alongside the
       * mutation itself — how item.claimed carries its git baseline and
       * item.handback its evidence (PRD F9) while still flowing write-ahead
       * through this choke point. The reserved replay keys (target, record,
       * body) always win over extras.
       */
      extraPayload?: Record<string, unknown>;
    }
  | { target: "run"; eventType: string; run: Run };

export interface MutationResult {
  /** The write-ahead journal event recording this mutation. */
  event: JournalEvent;
}

/**
 * Walk one ancestor chain (starting at `startId`, inclusive) looking for a
 * claim. Reads DISK records only, so incoming frontmatter can never drop a
 * claim to slip past the check; a record not on disk cannot carry a claim
 * and ends the walk. `seen` is shared across chains: a node a previous walk
 * passed through without returning is proven claim-free upward.
 */
async function findClaimOnChain(
  layout: StoreLayout,
  startId: string | undefined,
  seen: Set<string>,
): Promise<{ id: string; claimedBy: string } | undefined> {
  let current = startId;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (!(await itemExists(layout, current))) return undefined;
    const { frontmatter } = await readItem(layout, current);
    if (frontmatter.claimed_by !== undefined) {
      return { id: frontmatter.id, claimedBy: frontmatter.claimed_by };
    }
    current = frontmatter.parent;
  }
  return undefined;
}

/**
 * Find the claim covering `itemId`, if any: the item's own claim or the
 * nearest claimed ancestor (claims cover the whole subtree). BOTH parent
 * chains are checked — the one the record has now (its on-disk parent) and
 * the one it will have after the mutation (`incomingParent`) — so an agent
 * can neither mutate anything currently under a claim nor move an item INTO
 * a claimed subtree. For records not yet on disk the incoming parent is the
 * only chain.
 */
async function findCoveringClaim(
  layout: StoreLayout,
  itemId: string,
  incomingParent: string | undefined,
): Promise<{ id: string; claimedBy: string } | undefined> {
  const seen = new Set<string>();
  const current = await findClaimOnChain(layout, itemId, seen);
  if (current !== undefined) return current;
  return findClaimOnChain(layout, incomingParent, seen);
}

/**
 * The payload keys mutationEventFields writes and replay reads (target,
 * record, body). Reserved at every non-mutation write seam: `nahel log`
 * refuses --data carrying them at top level, so an observation can never
 * masquerade as a mutation payload.
 */
export const MUTATION_PAYLOAD_KEYS = ["target", "record", "body"] as const;

function mutationEventFields(mutation: Mutation): {
  item: string;
  run?: string;
  payload: Record<string, unknown>;
} {
  if (mutation.target === "item") {
    return {
      item: mutation.frontmatter.id,
      payload: {
        ...mutation.extraPayload,
        target: "item",
        record: mutation.frontmatter,
        body: mutation.body,
      },
    };
  }
  return {
    item: mutation.run.item,
    run: mutation.run.id,
    payload: { target: "run", record: mutation.run },
  };
}

/**
 * Apply one mutation: validate → claim check → write-ahead journal event →
 * record write. Refusals and validation failures write nothing at all.
 */
export async function mutate(ctx: StoreContext, mutation: Mutation): Promise<MutationResult> {
  // Validate the incoming record before anything touches disk.
  const record =
    mutation.target === "item"
      ? workItemFrontmatterSchema.parse(mutation.frontmatter)
      : runSchema.parse(mutation.run);

  // Claim enforcement: agents may not mutate a claimed item or anything in a
  // claimed subtree. Humans pass — the claim is theirs.
  if (ctx.actor.kind === "agent") {
    const targetItem = mutation.target === "item" ? mutation.frontmatter.id : mutation.run.item;
    const incomingParent =
      mutation.target === "item" ? mutation.frontmatter.parent : undefined;
    const claim = await findCoveringClaim(ctx.layout, targetItem, incomingParent);
    if (claim !== undefined) {
      const via = claim.id === targetItem ? "" : ` via claimed ancestor ${claim.id}`;
      throw new ClaimViolationError(
        `refusing agent mutation: item ${targetItem} is covered by a claim${via} (claimed_by ${claim.claimedBy}) — ` +
          `a human must \`nahel handback ${claim.id}\` first`,
      );
    }
  }

  // Write-ahead: the journal event carries the full mutation and lands first.
  const fields = mutationEventFields(mutation);
  const event = await appendEvent(ctx.layout, ctx.env, {
    type: mutation.eventType,
    actor: ctx.actor,
    item: fields.item,
    ...(fields.run === undefined ? { session: ctx.session } : { run: fields.run }),
    payload: fields.payload,
  });

  // Then the record write. If this dies, the journal is ahead — replayPending
  // materializes exactly what the event already records.
  if (mutation.target === "item") {
    await writeItem(ctx.layout, record as WorkItemFrontmatter, mutation.body);
  } else {
    await writeRun(ctx.layout, record as Run);
  }
  return { event };
}

/** One record materialized by replayPending. */
export interface RepairedRecord {
  target: "item" | "run";
  id: string;
  /** The mutation event whose payload was replayed. */
  eventId: string;
}

interface PendingItem {
  event: JournalEvent;
  record: WorkItemFrontmatter;
  body: string;
}

interface PendingRun {
  event: JournalEvent;
  record: Run;
}

/**
 * Detect records behind their latest mutation event (the write-ahead crash
 * window) and materialize them deterministically from the event payloads.
 * Never journals anything itself — it only makes real what the journal
 * already records. Consumed by `validate --repair` (PRD F8).
 *
 * "Latest" is segment-aware: within a segment seq is causal, so each
 * segment's LAST mutation event per record supersedes its earlier ones;
 * across segments, a same-second tie between finalists is genuinely
 * ambiguous (per-invocation session segments, second-precision timestamps —
 * see latestCandidates), so a record matching ANY max-ts finalist is in
 * sync. Only a record matching none is repaired — to the total-order-latest
 * candidate, identical on every machine.
 */
export async function replayPending(layout: StoreLayout): Promise<RepairedRecord[]> {
  const itemFinalists = new Map<string, PendingItem[]>();
  const runFinalists = new Map<string, PendingRun[]>();

  const segments = await listSegments(layout);
  const paths = [
    ...segments.active.map((name) => join(layout.journalDir, name)),
    ...segments.archived.map((name) => join(layout.journalArchiveDir, name)),
  ];
  for (const path of paths) {
    // Per segment, append order is causal order: later overwrites earlier.
    const segmentItems = new Map<string, PendingItem>();
    const segmentRuns = new Map<string, PendingRun>();
    for await (const event of mergeSegments([path])) {
      // Mutations are identified by event TYPE (the choke point's core
      // mutation types), never by payload shape — a mutation-shaped payload
      // under `note` or any open extension type (a forged `nahel log`, a
      // rogue writer) is inert data, not a replayable mutation.
      if (!MUTATION_EVENT_TYPES.has(event.type)) continue;
      const payload = event.payload;
      if (payload["target"] === "item" && payload["record"] !== undefined) {
        const record = workItemFrontmatterSchema.parse(payload["record"]);
        const body = payload["body"];
        if (typeof body !== "string") {
          throw new Error(
            `mutation event ${event.id} has an item payload without a string body — cannot replay`,
          );
        }
        segmentItems.set(record.id, { event, record, body });
      } else if (payload["target"] === "run" && payload["record"] !== undefined) {
        const record = runSchema.parse(payload["record"]);
        segmentRuns.set(record.id, { event, record });
      }
    }
    for (const [id, pending] of segmentItems) {
      itemFinalists.set(id, [...(itemFinalists.get(id) ?? []), pending]);
    }
    for (const [id, pending] of segmentRuns) {
      runFinalists.set(id, [...(runFinalists.get(id) ?? []), pending]);
    }
  }

  const repaired: RepairedRecord[] = [];
  for (const [id, finalists] of [...itemFinalists.entries()].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    // An unreadable or schema-invalid current record is simply out of sync:
    // the journal holds the truth, so repair restores it rather than choking
    // on the corruption (mirrors the run branch below).
    let current: Awaited<ReturnType<typeof readItem>> | undefined;
    try {
      current = await readItem(layout, id);
    } catch {
      current = undefined;
    }
    const candidates = latestCandidates(finalists);
    const inSync =
      current !== undefined &&
      candidates.some(
        (candidate) =>
          JSON.stringify(current!.frontmatter) === JSON.stringify(candidate.record) &&
          current!.body === candidate.body,
      );
    if (!inSync) {
      const pending = candidates[candidates.length - 1]!;
      await writeItem(layout, pending.record, pending.body);
      repaired.push({ target: "item", id, eventId: pending.event.id });
    }
  }
  for (const [id, finalists] of [...runFinalists.entries()].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    let current: Run | undefined;
    try {
      current = await readRun(layout, id);
    } catch {
      current = undefined;
    }
    const candidates = latestCandidates(finalists);
    const inSync =
      current !== undefined &&
      candidates.some(
        (candidate) => JSON.stringify(current) === JSON.stringify(candidate.record),
      );
    if (!inSync) {
      const pending = candidates[candidates.length - 1]!;
      await writeRun(layout, pending.record);
      repaired.push({ target: "run", id, eventId: pending.event.id });
    }
  }
  return repaired;
}

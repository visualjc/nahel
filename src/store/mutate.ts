import type { Env } from "../schema/env";
import {
  runSchema,
  workItemFrontmatterSchema,
  type Actor,
  type JournalEvent,
  type Run,
  type WorkItemFrontmatter,
} from "../schema/records";
import { resolveActor } from "./actor";
import { appendEvent, newSessionSegmentId, readJournal } from "./journal";
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
 * PRD F9), (3) appends the journal event FIRST, carrying the full mutation
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
    }
  | { target: "run"; eventType: string; run: Run };

export interface MutationResult {
  /** The write-ahead journal event recording this mutation. */
  event: JournalEvent;
}

/**
 * Find the claim covering `itemId`, if any: the item's own claim or the
 * nearest claimed ancestor (claims cover the whole subtree). For records not
 * yet on disk, the walk starts from `parentOverride` (the incoming parent).
 * The walk reads DISK records only, so incoming frontmatter can never drop a
 * claim to slip past the check.
 */
async function findCoveringClaim(
  layout: StoreLayout,
  itemId: string,
  parentOverride: string | undefined,
): Promise<{ id: string; claimedBy: string } | undefined> {
  const seen = new Set<string>();
  let current: string | undefined = itemId;
  let isTarget = true;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (!(await itemExists(layout, current))) {
      // A record not on disk cannot carry a claim; for the target itself the
      // incoming parent tells us where it hangs in the tree.
      current = isTarget ? parentOverride : undefined;
      isTarget = false;
      continue;
    }
    const { frontmatter } = await readItem(layout, current);
    if (frontmatter.claimed_by !== undefined) {
      return { id: frontmatter.id, claimedBy: frontmatter.claimed_by };
    }
    current = frontmatter.parent;
    isTarget = false;
  }
  return undefined;
}

function mutationEventFields(mutation: Mutation): {
  item: string;
  run?: string;
  payload: Record<string, unknown>;
} {
  if (mutation.target === "item") {
    return {
      item: mutation.frontmatter.id,
      payload: { target: "item", record: mutation.frontmatter, body: mutation.body },
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
    const parentOverride =
      mutation.target === "item" ? mutation.frontmatter.parent : undefined;
    const claim = await findCoveringClaim(ctx.layout, targetItem, parentOverride);
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
 * Streams the journal in total order, so "latest" is identical on every
 * machine; never journals anything itself — it only makes real what the
 * journal already records. Consumed by `validate --repair` (PRD F8).
 */
export async function replayPending(layout: StoreLayout): Promise<RepairedRecord[]> {
  const latestItems = new Map<string, PendingItem>();
  const latestRuns = new Map<string, PendingRun>();

  for await (const event of readJournal(layout)) {
    const payload = event.payload;
    if (payload["target"] === "item" && payload["record"] !== undefined) {
      const record = workItemFrontmatterSchema.parse(payload["record"]);
      const body = payload["body"];
      if (typeof body !== "string") {
        throw new Error(
          `mutation event ${event.id} has an item payload without a string body — cannot replay`,
        );
      }
      latestItems.set(record.id, { event, record, body });
    } else if (payload["target"] === "run" && payload["record"] !== undefined) {
      const record = runSchema.parse(payload["record"]);
      latestRuns.set(record.id, { event, record });
    }
  }

  const repaired: RepairedRecord[] = [];
  for (const [id, pending] of [...latestItems.entries()].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    const current = (await itemExists(layout, id)) ? await readItem(layout, id) : undefined;
    const inSync =
      current !== undefined &&
      JSON.stringify(current.frontmatter) === JSON.stringify(pending.record) &&
      current.body === pending.body;
    if (!inSync) {
      await writeItem(layout, pending.record, pending.body);
      repaired.push({ target: "item", id, eventId: pending.event.id });
    }
  }
  for (const [id, pending] of [...latestRuns.entries()].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    let current: Run | undefined;
    try {
      current = await readRun(layout, id);
    } catch {
      current = undefined;
    }
    if (current === undefined || JSON.stringify(current) !== JSON.stringify(pending.record)) {
      await writeRun(layout, pending.record);
      repaired.push({ target: "run", id, eventId: pending.event.id });
    }
  }
  return repaired;
}

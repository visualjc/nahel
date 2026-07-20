import { parseArgs } from "node:util";
import type { Env } from "../schema/env";
import { CORE_EVENT_TYPES } from "../schema/events";
import { InvalidIdError } from "../schema/id";
import type { Run, WorkItemFrontmatter } from "../schema/records";
import {
  captureBaseline,
  collectHandbackEvidence,
  gitBaselineSchema,
  type GitBaseline,
} from "../store/baseline";
import { writeHotState } from "../store/hotstate";
import { readJournal } from "../store/journal";
import { listItems, listRuns, readItem, readRun, type StoreLayout } from "../store/layout";
import { closeStoreContext, mutate, type StoreContext } from "../store/mutate";
import {
  commandContext,
  execute,
  requireExistingItem,
  UsageError,
  type Command,
} from "./item";

/**
 * `nahel pause | claim | handback` — the intervention ops (PRD F9, glossary
 * semantics). Commands are thin: parse argv → call the store. Every mutation
 * flows through the store's mutate() choke point (actor resolution, claim
 * refusal, write-ahead journaling); claim baselines and handback evidence are
 * captured by the store's baseline module (spawning git is store-layer I/O)
 * and ride the item.claimed / item.handback events' payloads.
 *
 * claim and handback are HUMAN interventions: the choke point refuses agent
 * mutations anywhere under a claim — including the claimed item itself — so
 * an agent claimant could claim but never hand back. Refusing agents up front
 * keeps the cycle coherent; humans are never refused by the choke point, so
 * the claimant's own claim/handback (and the run pauses a claim causes)
 * always pass. pause has no such restriction — an agent may suspend a run.
 */

const PAUSE_USAGE = `usage:
  nahel pause <run>
    Suspend an active run: status becomes paused (hot state follows) and
    run.paused is journaled. An ended run cannot be paused; resume semantics
    are workflow-owned. Pausing does not move the run's phase.`;

const CLAIM_USAGE = `usage:
  nahel claim <item>
    Claim a work item AND its entire subtree for the resolved actor (a human:
    nahel/config actor entry or NAHEL_ACTOR). Sets claimed_by, pauses active
    runs touching any covered item, and journals item.claimed carrying the
    repo baseline (HEAD commit SHA + git status --porcelain snapshot). While
    claimed, the CLI refuses agent mutations across the subtree.`;

const HANDBACK_USAGE = `usage:
  nahel handback <item>
    Clear a claim you hold and journal item.handback with deterministic
    evidence: commits since the claim baseline (SHAs), the diff summary
    baseline→HEAD (files, +/-), the current dirty state, and the changes that
    were already uncommitted at claim time (excluded from attribution). Only
    the claimant can hand back; agents regain access afterwards.`;

/** Parse exactly one positional (the ref every intervention verb takes). */
function singleRef(argv: string[], verb: string, what: string): string {
  const { positionals } = parseArgs({ args: argv, options: {}, allowPositionals: true });
  if (positionals.length !== 1) {
    throw new UsageError(`${verb} takes exactly one <${what}>`);
  }
  return positionals[0]!;
}

function wantsHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

/** Read a run for an intervention, with an actionable not-found error. */
async function readRunOrUsage(ctx: StoreContext, runId: string): Promise<Run> {
  try {
    return await readRun(ctx.layout, runId);
  } catch (error) {
    // A malformed id is its own refusal (PR #12 review, blocker 2) — never
    // rewrapped as "not found", which would suggest the id could exist.
    if (error instanceof InvalidIdError) {
      throw new UsageError(error.message);
    }
    throw new UsageError(`run ${runId} not found — check the id (records live in nahel/runs/)`);
  }
}

/**
 * Suspend one run: status → paused through the choke point (write-ahead
 * run.paused into the run's segment), then mirror it into hot state so views
 * (issue #7) can render paused runs without reading every record.
 */
async function pauseRun(ctx: StoreContext, run: Run): Promise<void> {
  const paused: Run = { ...run, status: "paused" };
  await mutate(ctx, { target: "run", eventType: CORE_EVENT_TYPES.runPaused, run: paused });
  await writeHotState(ctx.layout, paused.id, {
    phase: paused.phase,
    status: paused.status,
    updated: ctx.env.now(),
  });
}

/**
 * The ids a claim on `rootId` covers: the item plus every descendant
 * (children found by walking parent refs across all item records).
 */
async function collectSubtree(layout: StoreLayout, rootId: string): Promise<Set<string>> {
  const children = new Map<string, string[]>();
  for (const id of (await listItems(layout)).sort()) {
    const { frontmatter } = await readItem(layout, id);
    if (frontmatter.parent !== undefined) {
      const siblings = children.get(frontmatter.parent) ?? [];
      siblings.push(frontmatter.id);
      children.set(frontmatter.parent, siblings);
    }
  }
  const covered = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (covered.has(id)) continue;
    covered.add(id);
    queue.push(...(children.get(id) ?? []));
  }
  return covered;
}

/** Refuse agent actors for the human-only intervention verbs. */
function requireHumanActor(ctx: StoreContext, verb: string): void {
  if (ctx.actor.kind !== "human") {
    throw new UsageError(
      `${verb} is a human intervention — the resolved actor is agent ${ctx.actor.id}; ` +
        `set a human actor (nahel/config actor entry or NAHEL_ACTOR=human:<id>)`,
    );
  }
}

async function pause(argv: string[], env: Env, cwd: string, actorOverride?: string): Promise<number> {
  const runId = singleRef(argv, "pause", "run");
  const ctx = await commandContext(cwd, env, actorOverride);
  const run = await readRunOrUsage(ctx, runId);
  if (run.status === "ended") {
    throw new UsageError(`run ${runId} has ended — an ended run cannot be paused`);
  }
  if (run.status === "paused") {
    throw new UsageError(`run ${runId} is already paused`);
  }
  await pauseRun(ctx, run);
  await closeStoreContext(ctx);
  return 0;
}

async function claim(argv: string[], env: Env, cwd: string, actorOverride?: string): Promise<number> {
  const itemId = singleRef(argv, "claim", "item");
  const ctx = await commandContext(cwd, env, actorOverride);
  requireHumanActor(ctx, "claim");
  await requireExistingItem(ctx.layout, itemId, "item");
  const { frontmatter, body } = await readItem(ctx.layout, itemId);
  if (frontmatter.claimed_by !== undefined) {
    throw new UsageError(
      `item ${itemId} is already claimed by ${frontmatter.claimed_by} — hand it back first (nahel handback ${itemId})`,
    );
  }

  // Baseline and coverage are computed BEFORE any mutation: a failure here
  // (not a git repo, unborn HEAD) writes nothing at all.
  const baseline = await captureBaseline(ctx.layout.root);
  const covered = await collectSubtree(ctx.layout, itemId);

  // The claim itself, write-ahead journaled with its baseline riding along.
  const claimed: WorkItemFrontmatter = {
    ...frontmatter,
    claimed_by: ctx.actor.id,
    updated: ctx.env.now(),
  };
  await mutate(ctx, {
    target: "item",
    eventType: CORE_EVENT_TYPES.itemClaimed,
    frontmatter: claimed,
    body,
    extraPayload: { baseline },
  });

  // Then the claim's consequence: every active run touching a covered item is
  // suspended. The claimant is human, so the choke point never refuses these.
  for (const runId of (await listRuns(ctx.layout)).sort()) {
    const run = await readRun(ctx.layout, runId);
    if (run.status === "active" && covered.has(run.item)) {
      await pauseRun(ctx, run);
    }
  }
  // ONE close for the whole multi-mutation lifecycle, after every mutation.
  await closeStoreContext(ctx);
  return 0;
}

/**
 * The baseline the CURRENT claim journaled: the latest item.claimed event for
 * this item in the journal's total order.
 */
async function latestClaimBaseline(layout: StoreLayout, itemId: string): Promise<GitBaseline> {
  let baseline: GitBaseline | undefined;
  for await (const event of readJournal(layout)) {
    if (event.type === CORE_EVENT_TYPES.itemClaimed && event.item === itemId) {
      const parsed = gitBaselineSchema.safeParse(event.payload["baseline"]);
      if (!parsed.success) {
        throw new Error(
          `item.claimed event ${event.id} carries no valid baseline — cannot compute handback evidence`,
        );
      }
      baseline = parsed.data;
    }
  }
  if (baseline === undefined) {
    throw new Error(
      `no item.claimed event found for item ${itemId} — the claim was never journaled, cannot compute handback evidence`,
    );
  }
  return baseline;
}

async function handback(argv: string[], env: Env, cwd: string, actorOverride?: string): Promise<number> {
  const itemId = singleRef(argv, "handback", "item");
  const ctx = await commandContext(cwd, env, actorOverride);
  requireHumanActor(ctx, "handback");
  await requireExistingItem(ctx.layout, itemId, "item");
  const { frontmatter, body } = await readItem(ctx.layout, itemId);
  if (frontmatter.claimed_by === undefined) {
    throw new UsageError(`item ${itemId} is not claimed — nothing to hand back`);
  }
  if (frontmatter.claimed_by !== ctx.actor.id) {
    throw new UsageError(
      `item ${itemId} is claimed by ${frontmatter.claimed_by} — only the claimant can hand it back (you are ${ctx.actor.id})`,
    );
  }

  // Evidence is computed BEFORE the mutation: a git failure writes nothing.
  const baseline = await latestClaimBaseline(ctx.layout, itemId);
  const evidence = await collectHandbackEvidence(ctx.layout.root, baseline);

  const { claimed_by: _cleared, ...rest } = frontmatter;
  const released: WorkItemFrontmatter = { ...rest, updated: ctx.env.now() };
  await mutate(ctx, {
    target: "item",
    eventType: CORE_EVENT_TYPES.itemHandback,
    frontmatter: released,
    body,
    extraPayload: { evidence },
  });
  await closeStoreContext(ctx);
  return 0;
}

function interventionCommand(
  name: string,
  description: string,
  usage: string,
  body: (argv: string[], env: Env, cwd: string, actorOverride?: string) => Promise<number>,
): Command {
  return {
    name,
    description,
    run: (argv, env, cwd, actorOverride) =>
      execute(`run \`nahel ${name} --help\` for usage`, async () => {
        if (wantsHelp(argv)) {
          console.log(usage);
          return 0;
        }
        return body(argv, env, cwd, actorOverride);
      }),
  };
}

export const pauseCommand: Command = interventionCommand(
  "pause",
  "suspend an active run (status becomes paused; hot state follows)",
  PAUSE_USAGE,
  pause,
);

export const claimCommand: Command = interventionCommand(
  "claim",
  "claim an item and its subtree for a human: pause covered runs, refuse agent mutations",
  CLAIM_USAGE,
  claim,
);

export const handbackCommand: Command = interventionCommand(
  "handback",
  "release a claim you hold, journaling deterministic evidence of the hand-fix",
  HANDBACK_USAGE,
  handback,
);

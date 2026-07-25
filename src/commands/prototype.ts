import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Env } from "../schema/env";
import {
  CORE_EVENT_TYPES,
  PROTOTYPE_DISPOSED_EVENT_TYPE,
  PROTOTYPE_PROMOTED_EVENT_TYPE,
  PROTOTYPE_PROMOTION_REFUSED_EVENT_TYPE,
  PROTOTYPE_VARIANTS_CREATED_EVENT_TYPE,
} from "../schema/events";
import { generateId } from "../schema/id";
import type { InceptionTier } from "../schema/enums";
import type { WorkItemFrontmatter } from "../schema/records";
import { appendEvent, readJournal } from "../store/journal";
import { readConfig, readItem, type StoreLayout } from "../store/layout";
import { closeStoreContext, mutate } from "../store/mutate";
import {
  headCommit,
  prototypeBranch,
  prototypeMiniPrdPath,
  removeVariantWorktree,
  seedVariant,
} from "../store/prototype";
import { commandContext, execute, UsageError, type Command } from "./item";

/**
 * `nahel prototype` (PRD F5) — the deterministic half of the prototype lane.
 *
 * The lane's CREATIVE half (what each approach is, which variant wins) belongs
 * to agents and humans; this verb owns only what must be mechanical:
 *
 *   start   — N branches, N worktrees, N seeded mini-PRDs, N variant items,
 *             one journaled creation record carrying each branch's base (F5.1).
 *   promote — the tier ratchet, then a plan item that will author the full PRD
 *             from the winning mini-PRD (F5.3, F5.4).
 *   dispose — the worktree removed, the item dropped, the reason journaled.
 *
 * Two invariants run through all three. Prototype code NEVER merges: the
 * item-status seam in item.ts refuses a merge-bound flip and `nahel validate`
 * flags any prototype ref that reached the default branch or a remote — so
 * `promote` deliberately carries an IDEA across (the mini-PRD), never a diff.
 * And ceremony is STRIPPED: variants are `direct` lane, no review loop, no
 * consensus, no TDD — the lane doc says so and nothing here buys any.
 */

/**
 * Variant ceiling. A prototype answers one question with a handful of framings;
 * a run that wanted forty worktrees mistyped something, and each variant is a
 * real checkout on a real disk.
 */
const MAX_VARIANTS = 8;

const USAGE = `usage:
  nahel prototype start <item-id> --variants <n> [--approach <text>]...
                        [--worktree-dir <dir>]
    Spawn <n> throwaway variant workspaces for a prototype work item: one
    branch (prototype/<slug>/variant-<n>) and one git worktree each, each
    seeded with its mini-PRD, each owned by its own prototype work item.
      --variants:     how many variants (1-${MAX_VARIANTS})
      --approach:     one approach statement per variant, in order
      --worktree-dir: where the worktrees are created (default: beside the
                      repo; a path inside the repo is refused)

  nahel prototype promote <variant-item-id> [--slug <slug>]
    Open the promotion path for a winning variant: a plan item that authors
    the full PRD from the variant's mini-PRD. Refuses on a seed-tier project
    (the tier ratchet). Prints the plan item id.

  nahel prototype dispose <variant-item-id> [--reason <text>] [--force]
    Remove a variant's worktree, drop its item, and journal the disposal.
    The branch survives as the reference-only record. --force disposes of a
    worktree with uncommitted work.`;

/** One variant, fully resolved before anything is created. */
interface PlannedVariant {
  variant: number;
  item: string;
  branch: string;
  worktree: string;
  prd: string;
  approach: string | undefined;
}

/** What a variant's creation record says about it (read back from the journal). */
interface VariantRecord {
  branch: string;
  worktree: string;
  prd: string;
}

/** The placeholder an unstated approach gets: the exploring agent fills it in. */
const APPROACH_PLACEHOLDER =
  "TODO — state this variant's approach in one paragraph before building anything. " +
  "The approach statement is what gets judged and, if it wins, what gets promoted.";

/**
 * The mini-PRD: an approach statement, the question the throwaway must answer,
 * and the lane's rules restated where the person doing the work will see them.
 * Deliberately short — a prototype that needs a long PRD is a feature.
 */
function miniPrd(options: {
  slug: string;
  variant: number;
  itemId: string;
  branch: string;
  approach: string | undefined;
  now: string;
}): string {
  return [
    "---",
    `name: ${options.slug}-variant-${options.variant}`,
    `created: ${options.now}`,
    `updated: ${options.now}`,
    "---",
    "",
    `# Mini-PRD — ${options.slug}, variant ${options.variant}`,
    "",
    `Prototype work item: ${options.itemId}`,
    `Branch: \`${options.branch}\` — throwaway; its code never merges.`,
    "",
    "## Approach",
    "",
    options.approach ?? APPROACH_PLACEHOLDER,
    "",
    "## What this variant must show",
    "",
    "State the question this variant answers, and what result would make it the",
    "winner versus what result would kill it. Decide that BEFORE building —",
    "a prototype judged after the fact just ratifies whatever got built.",
    "",
    "## Rules of this lane",
    "",
    "- Ceremony is stripped: no TDD, no review loop, no consensus. Build the",
    "  smallest running thing that answers the question.",
    "- The code never merges — not by a PR, not by a push, not by a cherry-pick.",
    "  `nahel validate` flags a prototype ref that reaches a remote or the",
    "  default branch, and the CLI refuses a merge-bound status on this item.",
    "- Only the APPROACH graduates: `nahel prototype promote` opens a plan item",
    "  that authors the full PRD, and the feature lane rebuilds the work.",
    "",
    "See `nahel/workflows/prototype-lane.md` for the whole lane.",
    "",
  ].join("\n");
}

/** The variant work item's body: where its workspace is, and what it may become. */
function variantBody(planned: PlannedVariant, parent: WorkItemFrontmatter): string {
  return [
    `Prototype variant ${planned.variant} of \`${parent.name}\` (item ${parent.id}).`,
    "",
    `- branch: \`${planned.branch}\` — throwaway; its code never merges`,
    `- worktree: ${planned.worktree}`,
    `- mini-PRD: \`${planned.prd}\``,
    "",
    "Ceremony is stripped: no TDD, no review loop, no consensus. This item's",
    "terminal state is `dropped` — `nahel prototype dispose` ends it, and",
    "`nahel prototype promote` carries its approach onto the plan lane first.",
    "",
  ].join("\n");
}

/** The promotion plan item's body: what to author, from what, and under whose approval. */
function promotionBody(options: {
  variant: WorkItemFrontmatter;
  miniPrd: string;
  branch: string;
}): string {
  return [
    `Promote prototype variant ${options.variant.id} (\`${options.variant.name}\`) into the feature lane.`,
    "",
    `- mini-PRD (the approach that won): \`${options.miniPrd}\``,
    `- prototype branch: \`${options.branch}\` — **reference-only**`,
    "",
    "Author the full PRD from the mini-PRD per `nahel/workflows/prd-new.md`, record",
    "it on this item with `--prd docs/prds/<slug>.md`, and clear the approval gate",
    "per the project's `governance.product` — delegated cross-vendor consensus or",
    "the human flip, whichever is in force (`nahel/workflows/afk-run.md` step 6).",
    "Only then parse it into the feature lane (`nahel/workflows/prd-parse.md`).",
    "",
    "Never copy code off the prototype branch. Read it, learn from it, and rebuild",
    "in the feature lane with the ceremony the feature lane demands — the prototype",
    "code never merges, so it must be absent from the promoted feature's diff.",
    "",
  ].join("\n");
}

function requireVariantCount(raw: string | undefined): number {
  if (raw === undefined) {
    throw new UsageError(`--variants is required — how many variants to spawn (1-${MAX_VARIANTS})`);
  }
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > MAX_VARIANTS) {
    throw new UsageError(
      `--variants must be a whole number between 1 and ${MAX_VARIANTS} — got ${JSON.stringify(raw)}`,
    );
  }
  return count;
}

/** Read one item, refusing anything that is not a prototype work item. */
async function requirePrototypeItem(
  layout: StoreLayout,
  id: string,
): Promise<{ frontmatter: WorkItemFrontmatter; body: string }> {
  let record: { frontmatter: WorkItemFrontmatter; body: string };
  try {
    record = await readItem(layout, id);
  } catch {
    throw new UsageError(`item ${id} not found — check the id (records live in nahel/items/)`);
  }
  if (record.frontmatter.type !== "prototype") {
    throw new UsageError(
      `item ${id} is a ${record.frontmatter.type} item, not a prototype — the prototype lane is ` +
        "the TYPE's, never a flag's. Create one with `nahel item new prototype <slug> direct`",
    );
  }
  return record;
}

/**
 * The creation record for one variant item, read back from the journal. The
 * journal is the single source: it is where `start` recorded the branch, the
 * worktree and the base, so promote and dispose never re-derive them from a
 * name and hope the convention held.
 */
async function findVariantRecord(
  layout: StoreLayout,
  itemId: string,
): Promise<VariantRecord | undefined> {
  let found: VariantRecord | undefined;
  for await (const event of readJournal(layout)) {
    if (event.type !== PROTOTYPE_VARIANTS_CREATED_EVENT_TYPE) continue;
    const variants = event.payload["variants"];
    if (!Array.isArray(variants)) continue;
    for (const entry of variants) {
      if (typeof entry !== "object" || entry === null) continue;
      const { item, branch, worktree, prd } = entry as Record<string, unknown>;
      if (
        item === itemId &&
        typeof branch === "string" &&
        typeof worktree === "string" &&
        typeof prd === "string"
      ) {
        found = { branch, worktree, prd };
      }
    }
  }
  return found;
}

async function prototypeStart(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      variants: { type: "string" },
      approach: { type: "string", multiple: true },
      "worktree-dir": { type: "string" },
    },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    throw new UsageError(
      `prototype start takes exactly one <item-id> — got ${positionals.length} positional argument(s)`,
    );
  }
  const itemId = positionals[0]!;
  const count = requireVariantCount(values.variants);
  const approaches = values.approach ?? [];
  if (approaches.length > count) {
    throw new UsageError(
      `${approaches.length} --approach statement(s) for ${count} variant(s) — a dropped approach is a ` +
        "lost idea; pass one per variant, in order, or none at all",
    );
  }

  const ctx = await commandContext(cwd, env, actorOverride);
  const { frontmatter: parent } = await requirePrototypeItem(ctx.layout, itemId);
  const slug = parent.name;
  const worktreeRoot =
    values["worktree-dir"] === undefined
      ? dirname(cwd)
      : isAbsolute(values["worktree-dir"])
        ? values["worktree-dir"]
        : resolve(cwd, values["worktree-dir"]);

  const planned: PlannedVariant[] = [];
  for (let variant = 1; variant <= count; variant += 1) {
    planned.push({
      variant,
      item: generateId(env),
      branch: prototypeBranch(slug, variant),
      worktree: join(worktreeRoot, `${basename(cwd)}-prototype-${slug}-variant-${variant}`),
      prd: prototypeMiniPrdPath(slug, variant),
      approach: approaches[variant - 1],
    });
  }

  // Write-ahead, like every act in this store: the creation record lands in the
  // journal BEFORE any branch exists. Its `base` is what the never-merge check
  // joins on, and a branch whose base was never recorded is a branch validate
  // can only report as unjudgeable — so the record must not be able to go
  // missing behind a crash. A crash the other way is harmless: a recorded
  // variant with no branch is simply absent from the ref scan. HEAD is read
  // ONCE, so the record is honest about what it says: these variants really are
  // siblings off one commit.
  const base = await headCommit(cwd);
  await appendEvent(ctx.layout, ctx.env, {
    type: PROTOTYPE_VARIANTS_CREATED_EVENT_TYPE,
    actor: ctx.actor,
    session: ctx.session,
    item: parent.id,
    payload: {
      slug,
      variants: planned.map((variant) => ({
        item: variant.item,
        variant: variant.variant,
        branch: variant.branch,
        base,
        worktree: variant.worktree,
        prd: variant.prd,
      })),
    },
  });

  for (const variant of planned) {
    const created = env.now();
    const frontmatter: WorkItemFrontmatter = {
      id: variant.item,
      name: `${slug}-variant-${variant.variant}`,
      type: "prototype",
      // Ceremony stripped: a prototype variant is direct-lane by construction.
      status: "in-progress",
      lane: "direct",
      parent: parent.id,
      depends_on: [],
      external_refs: [],
      prd: variant.prd,
      created,
      updated: created,
    };
    await mutate(ctx, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemCreated,
      frontmatter,
      body: variantBody(variant, parent),
    });
    await seedVariant(cwd, {
      branch: variant.branch,
      worktree: variant.worktree,
      prd: variant.prd,
      content: miniPrd({
        slug,
        variant: variant.variant,
        itemId: variant.item,
        branch: variant.branch,
        approach: variant.approach,
        now: created,
      }),
    });
    console.log(`${variant.item}  ${variant.branch}  ${variant.worktree}`);
  }

  await closeStoreContext(ctx);
  return 0;
}

async function prototypePromote(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { slug: { type: "string" } },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    throw new UsageError(
      `prototype promote takes exactly one <variant-item-id> — got ${positionals.length} positional argument(s)`,
    );
  }
  const itemId = positionals[0]!;

  const ctx = await commandContext(cwd, env, actorOverride);
  const { frontmatter: variant } = await requirePrototypeItem(ctx.layout, itemId);
  if (variant.prd === undefined) {
    throw new UsageError(
      `item ${itemId} records no mini-PRD — only a variant spawned by \`nahel prototype start\` ` +
        "promotes, because the mini-PRD (its approach statement) is the thing that graduates",
    );
  }
  const record = await findVariantRecord(ctx.layout, itemId);

  // The tier ratchet (F5.4): promotion is one of the two acts the ratchet
  // guards (the other is delegated governance). Refuse below `standard`, and
  // journal the refusal — a ratchet nobody can audit is a suggestion.
  const config = await readConfig(ctx.layout);
  const tier: InceptionTier | undefined = config.inception?.tier;
  if (tier === undefined || tier === "seed") {
    await appendEvent(ctx.layout, ctx.env, {
      type: PROTOTYPE_PROMOTION_REFUSED_EVENT_TYPE,
      actor: ctx.actor,
      session: ctx.session,
      item: itemId,
      payload: { variant: itemId, tier: tier ?? null, reason: "tier-ratchet" },
    });
    await closeStoreContext(ctx);
    throw new UsageError(
      (tier === undefined
        ? "this project records no inception tier"
        : "this project's recorded inception tier is `seed`") +
        " — promoting a prototype demands `standard` or above (the tier ratchet), so " +
        "upgrade inception first: re-run `nahel/workflows/inception.md` at standard and record the " +
        "new tier with `nahel config set inception`, carrying the constitution signature through.",
    );
  }

  const planId = generateId(env);
  await appendEvent(ctx.layout, ctx.env, {
    type: PROTOTYPE_PROMOTED_EVENT_TYPE,
    actor: ctx.actor,
    session: ctx.session,
    item: itemId,
    payload: {
      variant: itemId,
      plan: planId,
      mini_prd: variant.prd,
      branch: record?.branch ?? null,
      tier,
    },
  });

  const created = env.now();
  await mutate(ctx, {
    target: "item",
    eventType: CORE_EVENT_TYPES.itemCreated,
    frontmatter: {
      id: planId,
      name: values.slug ?? `promote-${variant.name}`,
      type: "plan",
      // The full lane: a promotion authors a PRD and walks the approval gate.
      status: "backlog",
      lane: "full",
      depends_on: [],
      external_refs: [],
      created,
      updated: created,
    },
    // No `prd` yet, deliberately: the plan item's deliverable is the FULL PRD it
    // has not written (ADR-0013), and pointing it at the mini-PRD would record a
    // prototype document as a product decision.
    body: promotionBody({
      variant,
      miniPrd: variant.prd,
      branch: record?.branch ?? "(unrecorded)",
    }),
  });

  await closeStoreContext(ctx);
  console.log(planId);
  return 0;
}

async function prototypeDispose(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { reason: { type: "string" }, force: { type: "boolean" } },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    throw new UsageError(
      `prototype dispose takes exactly one <variant-item-id> — got ${positionals.length} positional argument(s)`,
    );
  }
  const itemId = positionals[0]!;
  const reason = values.reason ?? "no reason recorded";

  const ctx = await commandContext(cwd, env, actorOverride);
  const { frontmatter: variant, body } = await requirePrototypeItem(ctx.layout, itemId);
  const record = await findVariantRecord(ctx.layout, itemId);
  if (record === undefined) {
    throw new UsageError(
      `item ${itemId} has no journaled variant creation record — \`nahel prototype dispose\` ends ` +
        "workspaces `nahel prototype start` created; close anything else with `nahel item update`",
    );
  }

  // The risky step first: a refused removal (uncommitted work, no --force)
  // must leave the item alive and nothing journaled.
  await removeVariantWorktree(cwd, record.worktree, values.force === true);

  await appendEvent(ctx.layout, ctx.env, {
    type: PROTOTYPE_DISPOSED_EVENT_TYPE,
    actor: ctx.actor,
    session: ctx.session,
    item: itemId,
    payload: {
      variant: itemId,
      branch: record.branch,
      worktree: record.worktree,
      mini_prd: record.prd,
      reason,
      forced: values.force === true,
    },
  });
  await mutate(ctx, {
    target: "item",
    eventType: CORE_EVENT_TYPES.itemUpdated,
    // `dropped`, never `done`: a prototype's code is thrown away by design, and
    // `done` is a merge-bound state the CLI refuses on a prototype anyway.
    frontmatter: { ...variant, status: "dropped", updated: env.now() },
    body,
  });

  await closeStoreContext(ctx);
  console.log(`✅ disposed ${itemId} (${record.branch} survives, reference-only)`);
  return 0;
}

export const prototypeCommand: Command = {
  name: "prototype",
  description:
    "run the prototype lane: spawn variant worktrees, promote a winner, dispose of the rest",
  run: (argv, env, cwd, actorOverride) =>
    execute("run `nahel prototype --help` for usage", async () => {
      const [sub, ...rest] = argv;
      if (sub === "--help" || sub === "-h" || rest.includes("--help") || rest.includes("-h")) {
        console.log(USAGE);
        return 0;
      }
      if (sub === "start") return prototypeStart(rest, env, cwd, actorOverride);
      if (sub === "promote") return prototypePromote(rest, env, cwd, actorOverride);
      if (sub === "dispose") return prototypeDispose(rest, env, cwd, actorOverride);
      throw new UsageError(
        sub === undefined
          ? "missing subcommand — expected `prototype start`, `prototype promote` or `prototype dispose`"
          : `unknown subcommand ${JSON.stringify(sub)} — expected start, promote or dispose`,
      );
    }),
};

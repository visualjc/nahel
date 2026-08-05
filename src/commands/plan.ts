import { parseArgs } from "node:util";
import type { Command, CommandContext } from "../cli";
import type { Actor } from "../schema/records";
import { parseActorSpec } from "../store/actor";
import { readJournal } from "../store/journal";
import {
  openStore,
  readConfig,
  readMaps,
  readRoadmapNodes,
  readTickets,
  type RoadmapNodeRecord,
} from "../store/layout";
import { renderPlanBriefing, renderPlanProducts } from "../views/plan";
import { planSince } from "../views/plan-since";
import { loadSnapshot } from "../views/snapshot";
import { UsageError } from "./item";
import { frontierScope, missedRef } from "./roadmap";

/**
 * `nahel plan [ref]` (planning-partner F1): the planning briefing — the one
 * front door of a planning session (D1). A thin I/O wrapper over the pure
 * renderer beside it, exactly like `standup` and `brief`: the store reads
 * happen here, and everything that decides what the page says is a pure
 * function over what they returned.
 *
 * STRICTLY a read. It journals nothing and writes nothing — rendering a
 * briefing is not an act, and DD1 rests on that: the reader's baseline advances
 * when they DO something in the session, never when they read about it. Two
 * runs over an unchanged store are byte-identical, and `git status` is clean
 * after either.
 *
 * The clock is never read. A briefing states what the journal holds and when
 * each act happened, so there is no "now" in it to derive — which is what makes
 * the output byte-identical under replay (HC1).
 */

const USAGE = "usage: nahel plan [ref] [--reader <human|agent>:<id>]";

interface PlanFlags {
  /** The node to brief — its slug or its id; absent is the bare form. */
  ref?: string;
  /** DD1's `--reader` override; absent means the store's human side. */
  reader?: Actor;
}

function parseFlags(argv: string[]): PlanFlags {
  let values: { reader?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: { reader: { type: "string" } },
      strict: true,
      allowPositionals: true,
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (positionals.length > 1) {
    throw new UsageError(
      "plan takes at most one <ref> — one node's briefing, or the product's " +
        `(got ${JSON.stringify(positionals.join(" "))})`,
    );
  }
  const ref = positionals[0];
  // An unreadable reader is refused BEFORE the store is opened: a spec naming
  // no actor would otherwise silently fall back to the human default and brief
  // the wrong window, which is the one error this flag exists to prevent.
  let reader: Actor | undefined;
  if (values.reader !== undefined) {
    try {
      reader = parseActorSpec(values.reader);
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    ...(ref === undefined ? {} : { ref }),
    ...(reader === undefined ? {} : { reader }),
  };
}

/**
 * The node a ref names: id first, then slug — the precedence `resolveRoadmapNode`
 * and `nahel roadmap <ref>` both use, applied to the nodes already in hand.
 */
function resolveNode(
  nodes: readonly RoadmapNodeRecord[],
  ref: string,
): RoadmapNodeRecord | undefined {
  return (
    nodes.find(({ frontmatter }) => frontmatter.id === ref) ??
    nodes.find(({ frontmatter }) => frontmatter.name === ref)
  );
}

/**
 * The bare form's subject (F1): the product node, when the store has exactly
 * one. Two products is a real shape, not an error — the layer assumes one but
 * refuses nothing — so it falls through to the picker, and so does a store with
 * none, where the answer is to name one.
 */
function soleProduct(nodes: readonly RoadmapNodeRecord[]): RoadmapNodeRecord | undefined {
  const products = nodes.filter(({ frontmatter }) => frontmatter.kind === "product");
  return products.length === 1 ? products[0] : undefined;
}

async function runPlan(argv: string[], ctx: CommandContext): Promise<number> {
  try {
    const flags = parseFlags(argv);
    const layout = await openStore(ctx.cwd);
    // Initialized-repo gate: a missing config errors with the `nahel init`
    // pointer instead of briefing a planning session on a repo that has no
    // state. The governance section reads its posture from the same record.
    const config = await readConfig(layout);
    const nodes = await readRoadmapNodes(layout);
    const maps = await readMaps(layout);
    const tickets = await readTickets(layout);
    const { items } = await loadSnapshot(layout);

    const record = flags.ref === undefined ? soleProduct(nodes) : resolveNode(nodes, flags.ref);
    if (record === undefined) {
      // A ref that named nothing is the roadmap layer's refusal, near misses and
      // all; the bare form with no single product is the picker instead.
      if (flags.ref !== undefined) throw await missedRef(layout, nodes, flags.ref);
      ctx.stdout(
        renderPlanProducts(nodes.filter(({ frontmatter }) => frontmatter.kind === "product")),
      );
      return 0;
    }
    const node = record.frontmatter;
    const scope = frontierScope(nodes, maps, items, node.id);
    if (scope === undefined) throw await missedRef(layout, nodes, node.name);
    const map = maps.find(({ frontmatter }) => frontmatter.id === scope.map) ?? null;

    // ONE journal read, shared by every derivation below: the window needs the
    // whole thing (it decides membership by event type and payload, so nothing
    // upstream can filter for it), and the map's derived sections read their
    // order out of the same events by id. A second pass would cost a second
    // read of the same file for facts already in hand.
    const events = await Array.fromAsync(readJournal(layout));
    ctx.stdout(
      renderPlanBriefing({
        node: record,
        map,
        scope,
        nodes,
        maps,
        tickets,
        items,
        events,
        since: planSince({
          node: node.id,
          // `null` is the frontier's spelling of "no chart"; the window's is
          // `undefined`, and the two mean the same thing.
          map: scope.map ?? undefined,
          tickets: tickets.map(({ frontmatter }) => ({
            id: frontmatter.id,
            map: frontmatter.map,
          })),
          events,
          ...(flags.reader === undefined ? {} : { reader: flags.reader }),
        }),
        governance: config.governance,
      }),
    );
    return 0;
  } catch (error) {
    ctx.stderr(`❌ ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof UsageError) ctx.stderr(USAGE);
    return 1;
  }
}

export const planCommand: Command = {
  description:
    "render the planning briefing for a roadmap node: what moved since your last session, the decisions so far, the frontier, the fog, and what the partner may settle here (plan [ref])",
  run: runPlan,
};

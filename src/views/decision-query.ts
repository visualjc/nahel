import { parseArgs } from "node:util";
import type { Actor } from "../schema/records";
import { parseActorSpec } from "../store/actor";
import { resolveMap, type StoreLayout } from "../store/layout";
import { resolveSince } from "./standup";
import type { DecisionProvenance, DecisionRow } from "./decisions";

export type { DecisionRow } from "./decisions";

export interface DecisionQueryContext {
  layout: StoreLayout;
  now: string;
}

const PROVENANCE_BADGES: readonly DecisionProvenance[] = [
  "direct-human",
  "delegated",
  "ratified",
  "agent",
  "incomplete",
];

export const DECISION_QUERY_USAGE =
  "usage: nahel decisions [--since <7d|24h|ISO>] [--by <human|agent|kind:id[:session]>] " +
  "[--map <map-id|node-id|node-slug>] " +
  "[--provenance <direct-human|delegated|ratified|agent|incomplete>] " +
  "[--limit <positive-integer>]";

export const DECISION_QUERY_HELP = "run `nahel decisions --help` for details";

/** Structured refusal metadata for the later CLI adapter to render. */
export class DecisionQueryUsageError extends Error {
  readonly usage = DECISION_QUERY_USAGE;
  readonly help = DECISION_QUERY_HELP;
}

interface DecisionQueryFlags {
  since?: string;
  by?: string;
  map?: string;
  provenance?: string;
  limit?: string;
}

function parseFlags(argv: readonly string[]): DecisionQueryFlags {
  let values: DecisionQueryFlags;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      options: {
        since: { type: "string" },
        by: { type: "string" },
        map: { type: "string" },
        provenance: { type: "string" },
        limit: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    }));
  } catch (error) {
    throw new DecisionQueryUsageError(
      `invalid decisions query ${JSON.stringify(argv.join(" "))} — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (positionals.length > 0) {
    throw new DecisionQueryUsageError(`unexpected extra arguments: ${positionals.join(" ")}`);
  }
  return values;
}

function parseActorSelector(spec: string): Actor["kind"] | Actor {
  if (spec === "human" || spec === "agent") return spec;
  try {
    return parseActorSpec(spec);
  } catch (error) {
    throw new DecisionQueryUsageError(
      `invalid --by ${JSON.stringify(spec)} — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function parseLimit(spec: string | undefined): number {
  if (spec === undefined) return 10;
  const limit = Number(spec);
  if (!/^[0-9]+$/.test(spec) || limit < 1 || !Number.isSafeInteger(limit)) {
    throw new DecisionQueryUsageError(
      `invalid --limit ${JSON.stringify(spec)} — expected a positive safe integer`,
    );
  }
  return limit;
}

/** Apply the decision ledger's query arguments to reconstructed decision rows. */
export async function queryDecisionRows(
  rows: readonly DecisionRow[],
  argv: readonly string[],
  context: DecisionQueryContext,
): Promise<DecisionRow[]> {
  const values = parseFlags(argv);
  const actor = values.by === undefined ? undefined : parseActorSelector(values.by);
  let mapId: string | undefined;
  if (values.map !== undefined) {
    const map = await resolveMap(context.layout, values.map);
    if (map === null) {
      throw new DecisionQueryUsageError(
        `invalid --map ${JSON.stringify(values.map)} — expected a map id or its roadmap node id/slug`,
      );
    }
    mapId = map.frontmatter.id;
  }
  let provenance: DecisionProvenance | undefined;
  if (values.provenance !== undefined) {
    if (!(PROVENANCE_BADGES as readonly string[]).includes(values.provenance)) {
      throw new DecisionQueryUsageError(
        `invalid --provenance ${JSON.stringify(values.provenance)} — expected ${PROVENANCE_BADGES.join(
          ", ",
        )}`,
      );
    }
    provenance = values.provenance as DecisionProvenance;
  }
  let since: string | undefined;
  if (values.since !== undefined) {
    const resolved = resolveSince(values.since, context.now);
    if ("error" in resolved) {
      throw new DecisionQueryUsageError(
        `invalid --since ${JSON.stringify(values.since)} — ${resolved.error}`,
      );
    }
    since = resolved.since;
  }

  return collectNewest(rows, parseLimit(values.limit), (row) => {
    if (!matchesActor(row, actor)) return false;
    if (mapId !== undefined && row.mapId !== mapId) return false;
    if (provenance !== undefined && !row.provenance.includes(provenance)) return false;
    if (since !== undefined && row.resolvedAt !== undefined && row.resolvedAt < since) return false;
    return true;
  });
}

function matchesActor(row: DecisionRow, selector: Actor["kind"] | Actor | undefined): boolean {
  if (selector === undefined) return true;
  if (row.resolver === undefined) return false;
  if (typeof selector === "string") return row.resolver.kind === selector;
  return (
    row.resolver.kind === selector.kind &&
    row.resolver.id === selector.id &&
    row.resolver.session === selector.session
  );
}

/** Filter while scanning and retain at most N rows, kept in ascending render order. */
function collectNewest(
  rows: readonly DecisionRow[],
  limit: number,
  eligible: (row: DecisionRow) => boolean,
): DecisionRow[] {
  const kept: DecisionRow[] = [];
  for (const row of rows) {
    if (!eligible(row)) continue;
    const index = kept.findIndex((candidate) => compareRows(row, candidate) < 0);
    if (index === -1) kept.push(row);
    else kept.splice(index, 0, row);
    if (kept.length > limit) kept.shift();
  }
  return kept;
}

function compareRows(a: DecisionRow, b: DecisionRow): number {
  const aOrder = a.resolutionOrder;
  const bOrder = b.resolutionOrder;
  if (aOrder === undefined || bOrder === undefined) {
    if (aOrder !== undefined) return -1;
    if (bOrder !== undefined) return 1;
    return a.ticketId.localeCompare(b.ticketId);
  }
  const byTimestamp = aOrder.ts.localeCompare(bOrder.ts);
  if (byTimestamp !== 0) return byTimestamp;
  const bySequence = aOrder.seq - bOrder.seq;
  if (bySequence !== 0) return bySequence;
  const byEvent = aOrder.id.localeCompare(bOrder.id);
  if (byEvent !== 0) return byEvent;
  return a.ticketId.localeCompare(b.ticketId);
}

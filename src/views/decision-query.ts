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

/** Apply the decision ledger's query arguments to reconstructed decision rows. */
export async function queryDecisionRows(
  rows: readonly DecisionRow[],
  argv: readonly string[],
  context: DecisionQueryContext,
): Promise<DecisionRow[]> {
  const { values, positionals } = parseArgs({
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
  });
  if (positionals.length > 0) throw new Error(`unexpected extra arguments: ${positionals.join(" ")}`);
  let selected = [...rows];
  if (values.by !== undefined) {
    const selector: Actor["kind"] | Actor =
      values.by === "human" || values.by === "agent" ? values.by : parseActorSpec(values.by);
    selected = selected.filter((row) => {
      if (row.resolver === undefined) return false;
      if (typeof selector === "string") return row.resolver.kind === selector;
      return (
        row.resolver.kind === selector.kind &&
        row.resolver.id === selector.id &&
        row.resolver.session === selector.session
      );
    });
  }
  if (values.map !== undefined) {
    const map = await resolveMap(context.layout, values.map);
    if (map === null) {
      throw new Error(
        `invalid --map ${JSON.stringify(values.map)} — expected a map id or its roadmap node id/slug`,
      );
    }
    selected = selected.filter((row) => row.mapId === map.frontmatter.id);
  }
  if (values.provenance !== undefined) {
    if (!(PROVENANCE_BADGES as readonly string[]).includes(values.provenance)) {
      throw new Error(
        `invalid --provenance ${JSON.stringify(values.provenance)} — expected ${PROVENANCE_BADGES.join(
          ", ",
        )}`,
      );
    }
    selected = selected.filter((row) =>
      row.provenance.includes(values.provenance as DecisionProvenance),
    );
  }
  if (values.since !== undefined) {
    const resolved = resolveSince(values.since, context.now);
    if ("error" in resolved) {
      throw new Error(`invalid --since ${JSON.stringify(values.since)} — ${resolved.error}`);
    }
    selected = selected.filter(
      (row) => row.resolvedAt === undefined || row.resolvedAt >= resolved.since,
    );
  }

  let limit = 10;
  if (values.limit !== undefined) {
    if (!/^[0-9]+$/.test(values.limit) || Number(values.limit) < 1) {
      throw new Error(`invalid --limit ${JSON.stringify(values.limit)} — expected a positive integer`);
    }
    limit = Number(values.limit);
  }
  return collectNewest(selected, limit);
}

/** Retain at most N rows while scanning, kept in ascending render order. */
function collectNewest(rows: readonly DecisionRow[], limit: number): DecisionRow[] {
  const kept: DecisionRow[] = [];
  for (const row of rows) {
    const index = kept.findIndex((candidate) => compareRows(row, candidate) < 0);
    if (index === -1) kept.push(row);
    else kept.splice(index, 0, row);
    if (kept.length > limit) kept.shift();
  }
  return kept;
}

function compareRows(a: DecisionRow, b: DecisionRow): number {
  if (a.resolutionOrder !== undefined && b.resolutionOrder !== undefined) {
    const byTimestamp = a.resolutionOrder.ts.localeCompare(b.resolutionOrder.ts);
    if (byTimestamp !== 0) return byTimestamp;
    const bySequence = a.resolutionOrder.seq - b.resolutionOrder.seq;
    if (bySequence !== 0) return bySequence;
    const byEvent = a.resolutionOrder.id.localeCompare(b.resolutionOrder.id);
    if (byEvent !== 0) return byEvent;
  }
  const byTime = (a.resolvedAt ?? "").localeCompare(b.resolvedAt ?? "");
  return byTime !== 0 ? byTime : a.ticketId.localeCompare(b.ticketId);
}

import { parseArgs } from "node:util";
import type { StoreLayout } from "../store/layout";
import { resolveSince } from "./standup";
import type { DecisionRow } from "./decisions";

export type { DecisionRow } from "./decisions";

export interface DecisionQueryContext {
  layout: StoreLayout;
  now: string;
}

/** Apply the decision ledger's query arguments to reconstructed decision rows. */
export async function queryDecisionRows(
  rows: readonly DecisionRow[],
  argv: readonly string[],
  context: DecisionQueryContext,
): Promise<DecisionRow[]> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { since: { type: "string" } },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length > 0) throw new Error(`unexpected extra arguments: ${positionals.join(" ")}`);
  if (values.since === undefined) return [...rows];

  const resolved = resolveSince(values.since, context.now);
  if ("error" in resolved) {
    throw new Error(`invalid --since ${JSON.stringify(values.since)} — ${resolved.error}`);
  }
  return rows.filter(
    (row) => row.resolvedAt !== undefined && row.resolvedAt >= resolved.since,
  );
}

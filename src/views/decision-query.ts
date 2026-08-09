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
  if (values.since === undefined) return selected;

  const resolved = resolveSince(values.since, context.now);
  if ("error" in resolved) {
    throw new Error(`invalid --since ${JSON.stringify(values.since)} — ${resolved.error}`);
  }
  return selected.filter(
    (row) => row.resolvedAt !== undefined && row.resolvedAt >= resolved.since,
  );
}

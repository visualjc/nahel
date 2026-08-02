import type { RoadmapNodeRecord } from "../store/layout";

/**
 * The roadmap node renderer (Phase 4 F1): PURE functions over records already
 * read from the store — no I/O, no clock, no randomness, so the same nodes
 * always render byte-identical output.
 */

/**
 * The facts about a node that live on OTHER nodes, so a single record read
 * cannot answer them: which nodes name this one as their predecessor (lineage
 * read forwards), and which initiatives link it sideways (membership read from
 * the feature's side). Both in id order — the order readRoadmapNodes returns.
 */
export interface RoadmapNodeLinks {
  successors: string[];
  initiatives: string[];
}

/** Collect the reverse links pointing AT `id` (see RoadmapNodeLinks). */
export function roadmapNodeLinks(
  nodes: readonly RoadmapNodeRecord[],
  id: string,
): RoadmapNodeLinks {
  const successors: string[] = [];
  const initiatives: string[] = [];
  for (const { frontmatter } of nodes) {
    if (frontmatter.predecessor === id) successors.push(frontmatter.id);
    // An absent link list means no links: the schema leaves it optional so an
    // omitted key reaches validate as a soft judgment, not a parse failure.
    if ((frontmatter.features ?? []).includes(id)) initiatives.push(frontmatter.id);
  }
  return { successors, initiatives };
}

/**
 * Render one node: a header line in the house style of `status` (name, kind,
 * then `key=value` fields), one indented line per field it actually carries,
 * and the intent prose as the body below. Absent fields print nothing at all —
 * a blank `prd=` would read as a recorded empty path.
 */
export function renderRoadmapNode(record: RoadmapNodeRecord, links: RoadmapNodeLinks): string {
  const node = record.frontmatter;
  const lines = [
    [node.name, node.kind, `horizon=${node.horizon}`, `id=${node.id}`].join("  "),
  ];
  const field = (key: string, value: string | undefined): void => {
    if (value !== undefined && value !== "") lines.push(`  ${key}=${value}`);
  };
  field("parent", node.parent);
  field("design_doc", node.design_doc);
  field("adrs", (node.adrs ?? []).join(", "));
  field("prd", node.prd);
  field("epic", node.epic);
  field("predecessor", node.predecessor);
  field("successors", links.successors.join(", "));
  field("features", (node.features ?? []).join(", "));
  field("initiatives", links.initiatives.join(", "));
  lines.push(`  created=${node.created}  updated=${node.updated}`);
  const intent = record.body.trimEnd();
  if (intent !== "") lines.push("", intent);
  return lines.join("\n");
}

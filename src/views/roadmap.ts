import type { RoadmapNodeFrontmatter, WorkItemFrontmatter } from "../schema/records";
import type { RoadmapNodeRecord } from "../store/layout";
import { descendantIds } from "./snapshot";

/**
 * The roadmap node renderer and its derived statuses (Phase 4 F1 + F2): PURE
 * functions over records already read from the store — no I/O, no clock, no
 * randomness, so the same nodes always render byte-identical output, and a
 * render on a fresh clone of the same commit matches one on the machine that
 * wrote it.
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

/**
 * A feature node's dev status (F2): the rollup of the work under its epic.
 * There is no `unknown` work-item status — the word means "nahel cannot see
 * the epic", which is a different fact from any status a child could hold.
 */
export type RoadmapDevStatus = "planned" | "in-flight" | "built" | "unknown";

/**
 * The two truth-table rows that are ALSO `validate` warnings: a node naming an
 * epic no item record carries, and an epic whose every child was dropped. Both
 * derive a status all the same — the warning is advisory, and the rollup stays
 * total (F2: every case has a stated outcome).
 */
export type RoadmapEpicAnomaly = "epic-missing" | "all-dropped";

/** A dev-status derivation: the status, plus the anomaly `validate` reports. */
export interface RoadmapDevRollup {
  status: RoadmapDevStatus;
  anomaly?: RoadmapEpicAnomaly;
}

/**
 * Derive a feature node's dev status from the work items under its epic (F2),
 * total over the recorded vocabulary:
 *
 * | epic state | dev status |
 * | no epic id on the node | `planned` |
 * | epic id with no item record | `unknown` + `epic-missing` |
 * | zero children after excluding `dropped` | `planned` (+ `all-dropped` when children existed) |
 * | every non-dropped child `done` | `built` |
 * | every non-dropped child `backlog` | `planned` |
 * | anything else | `in-flight` |
 *
 * The rollup covers the epic's whole SUBTREE, not just its direct children:
 * work nests (an epic's task can own its own children), and the same coverage
 * rule the event association uses below — descendantIds, which claims and
 * `progress --item` also use — is the only one under which "flipping a leaf
 * work item to done changes the feature's status" (F2's first acceptance
 * criterion) holds. The epic item's OWN status is excluded: it is the
 * container, not work under itself.
 *
 * `dropped` children are excluded entirely (dropped work is not work), and
 * `blocked` / `in-review` fall into the catch-all row as started work —
 * blocking is advisory (F8), never a roadmap state of its own.
 */
export function featureDevStatus(
  node: RoadmapNodeFrontmatter,
  items: readonly WorkItemFrontmatter[],
): RoadmapDevRollup {
  const epic = node.epic;
  if (epic === undefined) return { status: "planned" };
  if (!items.some((item) => item.id === epic)) {
    return { status: "unknown", anomaly: "epic-missing" };
  }
  const covered = descendantIds(items, epic);
  const children = items.filter((item) => item.id !== epic && covered.has(item.id));
  const live = children.filter((item) => item.status !== "dropped");
  if (live.length === 0) {
    if (children.length === 0) return { status: "planned" };
    return { status: "planned", anomaly: "all-dropped" };
  }
  if (live.every((item) => item.status === "done")) return { status: "built" };
  if (live.every((item) => item.status === "backlog")) return { status: "planned" };
  return { status: "in-flight" };
}

/**
 * The feature nodes a product node rolls up (F2): its `feature` CHILDREN, in
 * the id order readRoadmapNodes returns. An `initiative` child is deliberately
 * not one of them — an initiative links features sideways and its own rollup
 * semantics are undefined (F1's non-goal), so counting it here would invent a
 * number the PRD refuses to define.
 */
export function productFeatureNodes(
  nodes: readonly RoadmapNodeRecord[],
  productId: string,
): RoadmapNodeRecord[] {
  return nodes.filter(
    ({ frontmatter }) => frontmatter.kind === "feature" && frontmatter.parent === productId,
  );
}

/** The order the product distribution prints its buckets in. */
const DEV_STATUS_ORDER: readonly RoadmapDevStatus[] = ["built", "in-flight", "planned", "unknown"];

/**
 * A product node's status (F2): the count distribution of its feature
 * children's dev statuses — never one word that hides the shape, and never a
 * bucket left out. Every bucket prints even at zero, `unknown` included: the
 * distribution is a fixed-width shape a reader can scan down a column, and an
 * omitted bucket would read as a bucket that was not derived.
 *
 * A product with no feature children renders `no features` — the explicit
 * statement, not a row of zeros that would claim an empty rollup was measured.
 */
export function renderProductStatus(statuses: readonly RoadmapDevStatus[]): string {
  if (statuses.length === 0) return "no features";
  return DEV_STATUS_ORDER.map(
    (status) => `${statuses.filter((each) => each === status).length} ${status}`,
  ).join(" · ");
}

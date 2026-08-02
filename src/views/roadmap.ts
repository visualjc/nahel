import { DECISION_TICKET_STATES, ROADMAP_HORIZONS } from "../schema/enums";
import {
  DEPLOY_COMPLETED_EVENT_TYPE,
  QA_SWEEP_EVENT_TYPE,
  RELEASE_ANNOUNCED_EVENT_TYPE,
} from "../schema/events";
import type {
  JournalEvent,
  RoadmapNodeFrontmatter,
  WorkItemFrontmatter,
} from "../schema/records";
import { compareEvents } from "../store/journal";
import type { MapRecord, RoadmapNodeRecord, TicketRecord } from "../store/layout";
import { descendantIds } from "./snapshot";
import { renderItemTree } from "./status";

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
  const field = (key: string, value: string | undefined): void => fieldLine(lines, key, value);
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
 * One indented `key=value` field line, skipped entirely when the value is
 * absent or empty — a blank `prd=` would read as a recorded empty path.
 */
function fieldLine(lines: string[], key: string, value: string | undefined): void {
  if (value !== undefined && value !== "") lines.push(`  ${key}=${value}`);
}

/** A section heading with its count, then one indented line per entry. */
function section(lines: string[], heading: string, entries: readonly string[]): void {
  lines.push("", `${heading} (${entries.length}):`);
  // An EMPTY section still prints its heading: a section that vanished when it
  // emptied would read as one that was never charted, which is a different
  // fact about a map (F7's five sections are all always present).
  if (entries.length === 0) lines.push("  (none)");
  for (const entry of entries) lines.push(`  ${entry}`);
}

/** One ticket as a map's reader sees it: identity, then the question's first line. */
function ticketLines(record: TicketRecord): string[] {
  const ticket = record.frontmatter;
  const head = [ticket.id, ticket.type, ticket.state];
  if (ticket.claimant !== undefined) head.push(`claimed by ${ticket.claimant}`);
  if (ticket.blockers.length > 0) head.push(`blocked by ${ticket.blockers.join(", ")}`);
  const question = record.body.split("\n", 1)[0] ?? "";
  // A distilled ticket has no body left; the decision line below carries it.
  return question === "" ? [head.join("  ")] : [head.join("  "), `    ${question}`];
}

/**
 * Render one map (F7): the node it charts, its destination, its Notes prose,
 * and its listed sections — decisions so far, the questions a decision
 * invalidated (derived from the tickets, see below), not yet specified, out of
 * scope, and the tickets hanging off it. Pure over records already read, so two
 * reads of an unchanged store are byte-identical (HC1).
 *
 * `node` is the record the map charts, or null when no node carries that id yet
 * (it may arrive by a later merge — `validate` reports the dangling ref).
 */
export function renderMap(
  record: MapRecord,
  node: RoadmapNodeRecord | null,
  tickets: readonly TicketRecord[],
): string {
  const map = record.frontmatter;
  const lines = [`map of ${node?.frontmatter.name ?? map.node}  id=${map.id}`];
  fieldLine(lines, "node", map.node);
  fieldLine(lines, "destination", map.destination);
  lines.push(`  created=${map.created}  updated=${map.updated}`);
  const notes = record.body.trimEnd();
  if (notes !== "") lines.push("", notes);
  section(
    lines,
    "decisions so far",
    map.decisions.map((entry) => `${entry.ticket}  ${entry.decision}`),
  );
  // The questions another decision answered out of existence (F7's invalidated
  // close). DERIVED from the tickets rather than stored as a sixth section: the
  // fact already lives on the ticket that died, and the layer's rule is that
  // anything derivable is derived and never hand-set (F2). It prints HERE, next
  // to the decisions, because the decision that killed each of these is one of
  // them — and deliberately NOT under Out of scope, which means "ruled beyond
  // the destination" and would be false of every line below.
  section(
    lines,
    "invalidated by a decision",
    tickets
      .filter(({ frontmatter }) => frontmatter.invalidated_by !== undefined)
      .map(({ frontmatter }) =>
        [`${frontmatter.id}  invalidated by ${frontmatter.invalidated_by}`, frontmatter.reason]
          .filter((part) => part !== undefined && part !== "")
          .join("  —  "),
      ),
  );
  section(lines, "not yet specified", map.fog);
  section(
    lines,
    "out of scope",
    map.out_of_scope.map((entry) =>
      entry.ticket === undefined ? entry.reason : `${entry.reason}  (${entry.ticket})`,
    ),
  );
  lines.push("", `tickets (${tickets.length}):`);
  if (tickets.length === 0) lines.push("  (none)");
  for (const ticket of tickets) for (const line of ticketLines(ticket)) lines.push(`  ${line}`);
  return lines.join("\n");
}

/**
 * Render one decision ticket (F7): its identity and lifecycle facts — the same
 * `state`, `claimant` and `blockers` F8's frontier predicate joins on — then
 * the question itself as the body. A distilled ticket prints no question,
 * because there is none left; its decision line is what remains.
 */
export function renderTicket(record: TicketRecord, map: MapRecord | null): string {
  const ticket = record.frontmatter;
  const lines = [`ticket ${ticket.id}  ${ticket.type}  ${ticket.state}`];
  fieldLine(lines, "map", ticket.map);
  fieldLine(lines, "destination", map?.frontmatter.destination);
  fieldLine(lines, "claimant", ticket.claimant);
  fieldLine(lines, "blockers", ticket.blockers.join(", "));
  fieldLine(lines, "decision", ticket.decision);
  fieldLine(lines, "reason", ticket.reason);
  fieldLine(lines, "invalidated_by", ticket.invalidated_by);
  fieldLine(lines, "resolution", ticket.resolution);
  lines.push(`  created=${ticket.created}  updated=${ticket.updated}`);
  const question = record.body.trimEnd();
  if (question !== "") lines.push("", question);
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
  return devRollup(node.epic, items, epicCoverage(node, items));
}

/** A node with no epic covers nothing — no walk, and no event can associate. */
const NO_COVERAGE: ReadonlySet<string> = new Set();

/**
 * The item ids a feature node's epic covers: the epic plus its descendants, the
 * ONE walk of the item tree per node. Callers that need both the rollup and the
 * event association compute it once and pass it to each — they are asking the
 * same question of the same subtree.
 */
function epicCoverage(
  node: RoadmapNodeFrontmatter,
  items: readonly WorkItemFrontmatter[],
): ReadonlySet<string> {
  return node.epic === undefined ? NO_COVERAGE : descendantIds(items, node.epic);
}

/**
 * The rollup over an ALREADY-computed coverage set — the single place every row
 * of the truth table lives, so `validate`'s reading and the views' reading
 * cannot drift apart.
 */
function devRollup(
  epic: string | undefined,
  items: readonly WorkItemFrontmatter[],
  covered: ReadonlySet<string>,
): RoadmapDevRollup {
  if (epic === undefined) return { status: "planned" };
  if (!items.some((item) => item.id === epic)) {
    return { status: "unknown", anomaly: "epic-missing" };
  }
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

/** The column value for a fact the store does not carry (F2's no-event rows). */
const NO_VALUE = "—";

/** The three event types the columns read; anything else is not a column fact. */
const COLUMN_EVENT_TYPES: ReadonlySet<string> = new Set([
  QA_SWEEP_EVENT_TYPE,
  DEPLOY_COMPLETED_EVENT_TYPE,
  RELEASE_ANNOUNCED_EVENT_TYPE,
]);

/**
 * A payload value for a column: absent, null, or blank renders `?` — brief's
 * absent-payload-key convention, widened to blank because a recorded empty
 * `environment` tells a reader exactly as much as an omitted one, and the
 * render table spells both cases the same way.
 */
function payloadText(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (value === undefined || value === null) return "?";
  const text = String(value).trim();
  return text === "" ? "?" : text;
}

/**
 * The sweep's `failed` count, or undefined when the payload does not carry a
 * usable number — the `(? failed)` row. A sweep that journaled an incomplete
 * summary is itself worth seeing, so a NEGATIVE count is rendered verbatim
 * rather than hidden behind `?`: it is a recorded number, just an impossible
 * one, and the render table's `?` row is about absent and non-numeric values.
 */
function failedCount(payload: Record<string, unknown>): number | undefined {
  const value = payload["failed"];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * A feature's single-word stage (F9's precedence table, derived by F2's
 * machinery). Every dev status is also a stage: the last four rows of the
 * table ARE the rollup, reached when no event covers the node.
 */
export type RoadmapStage = "released" | "deployed" | "tested" | RoadmapDevStatus;

/** Every derived column of one feature node (F2). No node record carries any of it. */
export interface RoadmapFeatureStatus {
  /** The rollup of the work under the epic. */
  dev: RoadmapDevStatus;
  /** The `validate` warning the rollup earned, when it earned one. */
  anomaly?: RoadmapEpicAnomaly;
  /** QA / deploy / release, rendered per F2's table — `—` when no event covers. */
  qa: string;
  deploy: string;
  release: string;
  /** The three columns and the rollup, collapsed to one word by precedence. */
  stage: RoadmapStage;
}

/**
 * Derive every column of one feature node (F2) — the call F3's view and F4's
 * brief block each make once per feature.
 *
 * The event ASSOCIATION rule is stored, not inferred: an event covers this node
 * iff its `item` ref names the node's epic or a descendant of it in the item
 * `parent` tree. An event with no `item`, or one pointing outside the subtree,
 * covers nothing here — it stays store-wide and renders only in `brief`'s QA
 * line. Coverage is by REF, so an event still covers a node whose epic id has
 * no item record: the ref is the recorded fact, and the missing epic is its own
 * warning. (Two feature nodes whose epics nest therefore both see the inner
 * subtree's events — the honest reading of a tree that names one epic inside
 * another, which `validate`'s shape checks are what flag.)
 *
 * When more than one event of a type covers the node, the winner is the LAST in
 * the store's canonical total order (`ts` → `seq` → `id`, compareEvents), so
 * the result does not depend on the order `events` arrives in — the same winner
 * on every machine and on a fresh clone.
 *
 * The `stage` collapses all of it to one word by PRECEDENCE, first match wins:
 * release, then deploy, then sweep, then the dev rollup. Precedence rather than
 * recency is what keeps the stage stable — a deploy recorded after a release
 * must not regress the feature to `deployed`. A covering sweep lifts the stage
 * to `tested` whatever the sweep FAILED: the word says a sweep ran over this
 * feature, and the QA column is where the outcome is read.
 */
export function featureStatus(
  node: RoadmapNodeFrontmatter,
  items: readonly WorkItemFrontmatter[],
  events: readonly JournalEvent[],
): RoadmapFeatureStatus {
  // One walk, shared by the rollup and the association below. A node with no
  // epic yields the empty coverage, so the loop simply matches nothing.
  const covered = epicCoverage(node, items);
  const rollup = devRollup(node.epic, items, covered);
  const winners = new Map<string, JournalEvent>();
  for (const event of events) {
    if (event.item === undefined || !covered.has(event.item)) continue;
    if (!COLUMN_EVENT_TYPES.has(event.type)) continue;
    const current = winners.get(event.type);
    if (current === undefined || compareEvents(current, event) < 0) {
      winners.set(event.type, event);
    }
  }
  const sweep = winners.get(QA_SWEEP_EVENT_TYPE);
  const deployed = winners.get(DEPLOY_COMPLETED_EVENT_TYPE);
  const released = winners.get(RELEASE_ANNOUNCED_EVENT_TYPE);
  let qa = NO_VALUE;
  if (sweep !== undefined) {
    const failed = failedCount(sweep.payload);
    qa = failed === 0 ? `tested ${sweep.ts}` : `tested ${sweep.ts} (${failed ?? "?"} failed)`;
  }
  // First match wins, top-down — the precedence table read literally.
  let stage: RoadmapStage;
  if (released !== undefined) stage = "released";
  else if (deployed !== undefined) stage = "deployed";
  else if (sweep !== undefined) stage = "tested";
  else stage = rollup.status;
  return {
    dev: rollup.status,
    anomaly: rollup.anomaly,
    qa,
    stage,
    deploy:
      deployed === undefined
        ? NO_VALUE
        : `deployed ${payloadText(deployed.payload, "environment")} ${deployed.ts}`,
    release:
      released === undefined
        ? NO_VALUE
        : `released ${payloadText(released.payload, "version")} ${released.ts}`,
  };
}

/**
 * True for the three event types the derived columns read (F2). Exported so the
 * command can KEEP only these while streaming the journal: the views take their
 * events as an array, and a store whose journal outgrows memory must still
 * render the roadmap. Anything else is not a column fact and is dropped.
 */
export function isRoadmapColumnEvent(event: JournalEvent): boolean {
  return COLUMN_EVENT_TYPES.has(event.type);
}

/** One feature node beside its derivation — featureStatus called once, per feature. */
interface FeatureWithStatus {
  record: RoadmapNodeRecord;
  status: RoadmapFeatureStatus;
}

/**
 * Derive every listed feature ONCE. Both callers need the same derivation twice
 * over — the product's distribution counts the dev statuses, the lines print the
 * columns — and deriving per use would walk the item tree and the journal twice
 * per feature for identical answers.
 */
function featureStatuses(
  features: readonly RoadmapNodeRecord[],
  items: readonly WorkItemFrontmatter[],
  events: readonly JournalEvent[],
): FeatureWithStatus[] {
  return features.map((record) => ({
    record,
    status: featureStatus(record.frontmatter, items, events),
  }));
}

/**
 * The line a feature renders as, in the product level and in the zoom alike: the
 * slug, the single-word stage, then F2's four derived columns VERBATIM — the
 * render table's strings are the contract, so they are printed and never
 * reformatted here. Fields are separated by two spaces because the values carry
 * single spaces of their own (`tested <ts> (2 failed)`), the same house rule
 * `status`'s `parent=<id> (missing)` already follows.
 */
function featureLine(record: RoadmapNodeRecord, status: RoadmapFeatureStatus): string {
  return [record.frontmatter.name, ...statusFields(status), `id=${record.frontmatter.id}`].join(
    "  ",
  );
}

/** The derived columns as fields — the same words in the list and in the zoom. */
function statusFields(status: RoadmapFeatureStatus): string[] {
  return [
    status.stage,
    `dev=${status.dev}`,
    `qa=${status.qa}`,
    `deploy=${status.deploy}`,
    `release=${status.release}`,
  ];
}

/** One node as a plain listing line — no derivation, for the kinds that have none. */
function nodeLine(node: RoadmapNodeFrontmatter): string {
  return `${node.name}  ${node.kind}  horizon=${node.horizon}  id=${node.id}`;
}

/**
 * The feature children under one node, grouped `now → next → later` (F3). Every
 * bucket prints even when empty, for renderProductStatus's reason: the three
 * horizons are a fixed shape a reader scans down, and a bucket that vanished
 * when it emptied would read as one nobody has decided about. Multiple parallel
 * `now`s are the intended shape (F8) and are rendered as the ordinary case —
 * nothing counts them, nothing warns.
 *
 * Within a bucket, features keep the id order readRoadmapNodes returns: ids are
 * unique, so the order is total, and it does not move when a node is renamed.
 */
function horizonGroups(
  features: readonly FeatureWithStatus[],
  indent: string,
  lines: string[],
): void {
  for (const horizon of ROADMAP_HORIZONS) {
    const bucket = features.filter(({ record }) => record.frontmatter.horizon === horizon);
    lines.push(`${indent}${horizon} (${bucket.length}):`);
    if (bucket.length === 0) lines.push(`${indent}  (none)`);
    for (const { record, status } of bucket) {
      lines.push(`${indent}  ${featureLine(record, status)}`);
    }
  }
}

/** What a store with no nodes says: how to start, not an empty frame. */
const NO_ROADMAP =
  "no roadmap yet — chart the product first:\n" +
  '  nahel roadmap node new product <slug> --horizon now --intent "<what this product is>"';

/**
 * The zoom hint a rendering ends with (F3), so the drill path is discoverable
 * from the output itself rather than from the help. The example is the
 * alphabetically first slug among the nodes the rendering named: stable against
 * id churn and against re-parenting, so a doc-tested rendering does not wobble
 * when unrelated state moves.
 */
function zoomHint(names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined;
  return `↳ nahel roadmap <node>  — zoom in (e.g. nahel roadmap ${[...names].sort()[0]!})`;
}

/** Close a rendering with its hints; absent ones are dropped, not left blank. */
function hintBlock(lines: string[], hints: readonly (string | undefined)[]): void {
  const present = hints.filter((hint): hint is string => hint !== undefined);
  if (present.length > 0) lines.push("", ...present);
}

/**
 * `nahel roadmap` with no ref (F3): the product level. One line per product node
 * — its horizon, its id, and F2's distribution over its feature children — then
 * those children grouped by horizon with their derived columns.
 *
 * Products render in the id order readRoadmapNodes returns. One product per
 * store is the assumed shape (a second is a non-goal, not a refusal), so a
 * second product node simply renders as a second block.
 *
 * A node that is neither a product nor a product's feature child — an
 * initiative, a node whose parent is missing, a feature parented to a feature —
 * is listed under `outside the product tree` rather than dropped: the shapes are
 * `validate` warnings, and a view that hid them would make the store look
 * smaller than it is. That section is ABSENT when empty, not an empty header.
 */
export function renderRoadmapOverview(
  nodes: readonly RoadmapNodeRecord[],
  items: readonly WorkItemFrontmatter[],
  events: readonly JournalEvent[],
): string {
  if (nodes.length === 0) return NO_ROADMAP;
  const lines: string[] = [];
  const placed = new Set<string>();
  for (const record of nodes) {
    if (record.frontmatter.kind !== "product") continue;
    placed.add(record.frontmatter.id);
    const features = featureStatuses(
      productFeatureNodes(nodes, record.frontmatter.id),
      items,
      events,
    );
    for (const { record: feature } of features) placed.add(feature.frontmatter.id);
    if (lines.length > 0) lines.push("");
    lines.push(
      [
        record.frontmatter.name,
        record.frontmatter.kind,
        `horizon=${record.frontmatter.horizon}`,
        `id=${record.frontmatter.id}`,
        renderProductStatus(features.map(({ status }) => status.dev)),
      ].join("  "),
    );
    horizonGroups(features, "  ", lines);
  }
  const outside = nodes.filter(({ frontmatter }) => !placed.has(frontmatter.id));
  if (outside.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`outside the product tree (${outside.length}):`);
    for (const { frontmatter } of outside) lines.push(`  ${nodeLine(frontmatter)}`);
  }
  hintBlock(lines, [zoomHint(nodes.map(({ frontmatter }) => frontmatter.name))]);
  return lines.join("\n");
}

/** Everything one zoom renders from — five store reads, no derivation done yet. */
export interface RoadmapZoomFacts {
  nodes: readonly RoadmapNodeRecord[];
  items: readonly WorkItemFrontmatter[];
  events: readonly JournalEvent[];
  maps: readonly MapRecord[];
  tickets: readonly TicketRecord[];
}

/**
 * The path down to this node, `product › feature`, or undefined at the top —
 * a one-crumb trail would only repeat the header line below it. A parent no
 * record carries ends the trail as `<id> (missing)` rather than silently
 * shortening it (the record may arrive by a later merge, ADR-0012), and a
 * parent cycle ends it as `<name> (cycle)`: both are `validate` findings, and
 * neither may hang the render.
 */
function breadcrumb(
  nodes: readonly RoadmapNodeRecord[],
  node: RoadmapNodeFrontmatter,
): string | undefined {
  const byId = new Map(nodes.map(({ frontmatter }) => [frontmatter.id, frontmatter]));
  const trail: string[] = [];
  const seen = new Set<string>([node.id]);
  let parent = node.parent;
  while (parent !== undefined) {
    const found = byId.get(parent);
    if (found === undefined) {
      trail.unshift(`${parent} (missing)`);
      break;
    }
    if (seen.has(found.id)) {
      trail.unshift(`${found.name} (cycle)`);
      break;
    }
    seen.add(found.id);
    trail.unshift(found.name);
    parent = found.parent;
  }
  return trail.length === 0 ? undefined : [...trail, node.name].join(" › ");
}

/**
 * The chart hanging off this node (F7), summarised to one line: where the effort
 * is going, its tickets by state — every state, at zero too, so the shape is
 * fixed — and how much fog is left. An unfinished map is stated as the ordinary
 * case and never flagged: mapping and building run concurrently by design (F8),
 * so a feature may carry an in-flight epic and open questions at once.
 */
function mapLine(map: MapRecord | undefined, tickets: readonly TicketRecord[]): string {
  if (map === undefined) return "map: none charted";
  const own = tickets.filter(({ frontmatter }) => frontmatter.map === map.frontmatter.id);
  const states = DECISION_TICKET_STATES.map(
    (state) => `${own.filter(({ frontmatter }) => frontmatter.state === state).length} ${state}`,
  ).join(" · ");
  return [
    `map: ${JSON.stringify(map.frontmatter.destination)}`,
    `tickets: ${states}`,
    `not yet specified (${map.frontmatter.fog.length})`,
    `id=${map.frontmatter.id}`,
  ].join("  ");
}

/**
 * The third generation, reachable without a second command (F3): the epic's
 * whole subtree, rendered by the ONE item-line renderer `nahel status` uses.
 *
 * The two "none" cases are stated, never errors: a feature with no epic yet is
 * the ordinary shape of intent recorded before work exists, and an epic id no
 * record carries is a `validate` finding whose record may still arrive by merge.
 */
function workItemsSection(
  node: RoadmapNodeFrontmatter,
  items: readonly WorkItemFrontmatter[],
  lines: string[],
): void {
  lines.push("");
  if (node.epic === undefined) {
    lines.push(
      "work items: none — no epic recorded yet " +
        `(link one with \`nahel roadmap node update ${node.name} --epic <item-id>\`)`,
    );
    return;
  }
  if (!items.some((item) => item.id === node.epic)) {
    lines.push(
      `work items: none — epic ${node.epic} has no item record here ` +
        "(`nahel validate` names it; the record may arrive by a later merge)",
    );
    return;
  }
  const covered = descendantIds(items, node.epic);
  const subtree = items.filter((item) => covered.has(item.id));
  lines.push(`work items (${subtree.length}):`);
  // knownIds is every item in the store, so the epic's own parent — which sits
  // outside this slice — is not reported as missing.
  lines.push(...renderItemTree(subtree, new Set(items.map((item) => item.id))));
}

/**
 * `nahel roadmap <ref>` (F3): the zoom. A breadcrumb of the node's ancestors,
 * the node itself exactly as `roadmap node show` prints it (one renderer, so the
 * two verbs cannot drift), then what the node's kind makes derivable — a
 * feature's columns and the work under its epic, a product's distribution — its
 * chart, its children, and the hints that carry the reader further down.
 *
 * An initiative gets no derived line of its own: its rollup semantics are
 * deliberately undefined until a real initiative lands (F1's non-goal), and a
 * number invented here would be exactly the judgment the layer refuses to make.
 */
export function renderRoadmapZoom(record: RoadmapNodeRecord, facts: RoadmapZoomFacts): string {
  const node = record.frontmatter;
  const lines: string[] = [];
  const trail = breadcrumb(facts.nodes, node);
  if (trail !== undefined) lines.push(trail);
  lines.push(renderRoadmapNode(record, roadmapNodeLinks(facts.nodes, node.id)));

  if (node.kind === "feature") {
    lines.push("", `status: ${statusFields(featureStatus(node, facts.items, facts.events)).join("  ")}`);
  }

  const features = featureStatuses(productFeatureNodes(facts.nodes, node.id), facts.items, facts.events);
  if (node.kind === "product") {
    lines.push("", `features: ${renderProductStatus(features.map(({ status }) => status.dev))}`);
  }
  if (features.length > 0) {
    if (node.kind !== "product") lines.push("");
    horizonGroups(features, "  ", lines);
  }
  const others = facts.nodes.filter(
    ({ frontmatter }) => frontmatter.parent === node.id && frontmatter.kind !== "feature",
  );
  if (others.length > 0) {
    lines.push("", `other children (${others.length}):`);
    for (const { frontmatter } of others) lines.push(`  ${nodeLine(frontmatter)}`);
  }

  const map = facts.maps.find(({ frontmatter }) => frontmatter.node === node.id);
  lines.push("", mapLine(map, facts.tickets));

  if (node.kind === "feature") workItemsSection(node, facts.items, lines);

  const children = [...features.map(({ record: child }) => child), ...others];
  hintBlock(lines, [
    zoomHint(children.map(({ frontmatter }) => frontmatter.name)),
    node.epic !== undefined && facts.items.some((item) => item.id === node.epic)
      ? `↳ nahel progress --item ${node.epic}  — the work under this feature`
      : undefined,
    map === undefined ? undefined : `↳ nahel roadmap map show ${node.name}  — the chart`,
  ]);
  return lines.join("\n");
}

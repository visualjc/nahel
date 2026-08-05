import { resolveGovernance } from "../governance/authority";
import type {
  Governance,
  JournalEvent,
  WorkItemFrontmatter,
} from "../schema/records";
import type { MapRecord, RoadmapNodeRecord, TicketRecord } from "../store/layout";
import type { PlanSinceRecordChange, PlanSinceTicketAct, PlanSinceWindow } from "./plan-since";
import {
  mapDecisionLines,
  mapOutOfScopeLines,
  renderFrontier,
  roadmapNodeLine,
  sectionLines,
  type FrontierScope,
} from "./roadmap";

/**
 * The planning briefing (planning-partner F1/DD5): what `nahel plan [ref]`
 * prints. PURE over records and events already read from the store — no I/O, no
 * clock, no randomness — so the same store always renders byte-identical text
 * and the verb journals nothing at all.
 *
 * The ORDER is the deliverable, and it is DD5's, because a fresh agent reads
 * top-down: (1) which node this is and where it is going, (2) what happened
 * since the reader was last here, (3) what is already decided, (4) what can be
 * taken now, (5) what is still foggy and what was ruled out, (6) which altitude
 * this session is working at and the workflow that conducts it, (7) the
 * governance line — the posture in force and what the partner may settle by
 * itself here.
 *
 * Nothing here DERIVES: the window comes from planSince (F2), the frontier from
 * renderFrontier, the decisions and out-of-scope lines from the map's own
 * derivations, and the posture from resolveGovernance. A briefing that computed
 * any of them a second way would be a second answer to a settled question.
 */

/** The workflow that conducts a planning session (F3 authors it). */
const PLAN_WORKFLOW = "nahel/workflows/plan.md";

/** The workflow that charts a map on an uncharted node. */
const CHART_WORKFLOW = "nahel/workflows/chart-map.md";

/** A record field a change line has no value for — never rendered as blank. */
const UNSET = "(unset)";

/** Everything one briefing renders from — every field a store read, underived. */
export interface PlanBriefingFacts {
  /** The node being briefed. */
  node: RoadmapNodeRecord;
  /** Its map, or null when nothing charts it yet. */
  map: MapRecord | null;
  /** What the frontier section narrows to — the same scope `roadmap frontier <ref>` uses. */
  scope: FrontierScope;
  /** The whole store's records: the frontier's predicates are evaluated over all of them. */
  nodes: readonly RoadmapNodeRecord[];
  maps: readonly MapRecord[];
  tickets: readonly TicketRecord[];
  items: readonly WorkItemFrontmatter[];
  /** The journal, in any order — read only by the derivations, never by the rendering. */
  events: readonly JournalEvent[];
  /** The debrief (F2/DD1), already derived for this node and this reader. */
  since: PlanSinceWindow;
  /** `config.governance`, resolved for display exactly as `nahel brief` resolves it. */
  governance: Partial<Governance> | undefined;
}

/** Render one node's briefing, in DD5's order. */
export function renderPlanBriefing(facts: PlanBriefingFacts): string {
  const node = facts.node.frontmatter;
  const map = facts.map;
  const lines = [`plan ${roadmapNodeLine(node)}`];
  if (map === null) {
    // An uncharted node is briefed all the same — the sections below say what
    // is missing, and this says how to fill them. Refusing would make the verb
    // useless at exactly the moment a planning session starts.
    lines.push(
      "  no map yet — this node is not charted",
      `  ↳ nahel roadmap map new --node ${node.name} --destination "<where this is going>"  — chart it`,
      `  ↳ ${CHART_WORKFLOW}  — the charting session that fills it`,
    );
  } else {
    lines.push(`  destination=${map.frontmatter.destination}`, `  map=${map.frontmatter.id}`);
  }

  lines.push("", ...sinceLines(facts.since));

  // The map's tickets, which are what both derived sections are read over. An
  // uncharted node has none, so both render their stated empty section rather
  // than vanishing — the map view's rule, kept here.
  const charted =
    map === null
      ? []
      : facts.tickets.filter(({ frontmatter }) => frontmatter.map === map.frontmatter.id);
  lines.push("", ...sectionLines("decisions so far", mapDecisionLines(charted, facts.events)));

  // The frontier verb's own rendering, hints included: one derivation of what
  // can be taken now, and the briefing is one of its two surfaces.
  lines.push(
    "",
    renderFrontier({
      tickets: facts.tickets,
      maps: facts.maps,
      nodes: facts.nodes,
      items: facts.items,
      scope: facts.scope,
    }),
  );

  lines.push("", ...sectionLines("not yet specified", map?.frontmatter.fog ?? []));
  lines.push(
    "",
    ...sectionLines(
      "out of scope",
      map === null ? [] : mapOutOfScopeLines(map.frontmatter, charted, facts.events),
    ),
  );

  lines.push("", ...altitudeLines(node.kind));
  lines.push("", `↳ ${PLAN_WORKFLOW}  — the workflow that conducts this session`);
  lines.push("", ...governanceLines(facts.governance));
  return lines.join("\n");
}

/**
 * The bare form in a store that does not have exactly one product (F1): the
 * products it does have, and the two things a reader can do about it. A store
 * with none renders the stated empty section and the second hint alone — "name
 * a new one" is the whole answer there.
 */
export function renderPlanProducts(products: readonly RoadmapNodeRecord[]): string {
  const lines = sectionLines(
    "products",
    products.map(({ frontmatter }) => roadmapNodeLine(frontmatter)),
  );
  lines.push("", "pick the one you are planning, or name a new one.", "");
  // The hint names the alphabetically first product, the rule every roadmap
  // hint follows: stable against id churn, and a real runnable command.
  const first = products.map(({ frontmatter }) => frontmatter.name).sort()[0];
  if (first !== undefined) lines.push(`↳ nahel plan ${first}  — that product's briefing`);
  lines.push(
    '↳ nahel roadmap node new product <slug> --horizon now --intent "<what this product is>"' +
      "  — name a new one",
  );
  return lines.join("\n");
}

/**
 * DD5's section 2 — the debrief, rendered from C2's window and nothing else, in
 * DD5's order: tickets resolved and closed with the one-liner their act
 * recorded, tickets opened, what the map and the node changed, then the
 * research notes linked to this map's tickets.
 *
 * Every ACT line names the event it came from as `act=<id>`, the way `standup`
 * does, so a reader can follow any line back to the journal. A record CHANGE
 * carries no act id: it is the NET effect of however many acts, and naming one
 * of them would claim a change that a different act may have made.
 */
function sinceLines(window: PlanSinceWindow): string[] {
  const body: string[] = [];
  for (const act of window.resolved) body.push(actLine("resolved", act));
  for (const act of window.closed) body.push(actLine("closed", act));
  for (const act of window.created) body.push(actLine("opened", act));
  body.push(...changeLines("map", window.map));
  body.push(...changeLines("node", window.node));
  for (const note of window.notes) {
    body.push(`  ${note.event.ts}  noted  ticket=${note.ticket}  act=${note.event.id}`);
  }
  // `empty` is the window's own verdict; the length check catches the one shape
  // it cannot see — an act that re-stated a record without changing a field,
  // which is movement with nothing to report.
  return [
    `since your last session (${baselineClause(window)}):`,
    ...(window.empty || body.length === 0 ? ["  nothing new since your last touch"] : body),
  ];
}

/** Which act the window opens after, and why that act anchors it. */
function baselineClause(window: PlanSinceWindow): string {
  const baseline = window.baseline;
  if (baseline === undefined) return "nothing anchors a baseline — all of it is new";
  return baseline.kind === "reader"
    ? `after your last act here, ${baseline.event.ts}`
    : `after the map was charted, ${baseline.event.ts}`;
}

/** One ticket act: when, what it did, which ticket, the line it wrote, its event. */
function actLine(verb: string, act: PlanSinceTicketAct): string {
  const detail = act.line === undefined ? act.id : `${act.id}  ${act.line}`;
  return `  ${act.event.ts}  ${verb}  ${detail}  act=${act.event.id}`;
}

/** What the window did to one record — scalars as `from → to`, lists as `+`/`-`. */
function changeLines(what: string, change: PlanSinceRecordChange | undefined): string[] {
  if (change === undefined) return [];
  const lines: string[] = [];
  // A record CREATED inside the window says so first: every field below it is
  // new, and without the marker the reader cannot tell a chart from an edit.
  if (change.created) lines.push(`  ${what}  created`);
  for (const { field, from, to } of change.fields) {
    lines.push(`  ${what}  ${field}  ${from ?? UNSET} → ${to ?? UNSET}`);
  }
  for (const { field, added, removed } of change.lists) {
    for (const entry of added) lines.push(`  ${what}  ${field}  + ${entry}`);
    for (const entry of removed) lines.push(`  ${what}  ${field}  - ${entry}`);
  }
  return lines;
}

/**
 * DD5's section 6 — the three altitudes and their granularity (D2), with the
 * one this node sits at marked. All three ALWAYS print: the gradient is the
 * point, and a session may drop an altitude mid-conversation, so a list that
 * showed only the placed one would hide the two doors beside it.
 *
 * A node's kind places it: a feature is where PRD-level definition happens,
 * and everything above one (a product, an initiative) is roadmap shaping.
 * Ideation is never a node's altitude — it is the posture a session takes
 * before an idea has a node at all.
 */
function altitudeLines(kind: string): string[] {
  const placed = kind === "feature" ? "feature definition" : "roadmap shaping";
  const mark = (label: string): string => (label === placed ? `${label} (this node)` : label);
  return [
    "altitude:",
    `  ${mark("feature definition")} — full map discipline: every decision is a ticket, resolved in one line`,
    `  ${mark("roadmap shaping")} — the node mutations ARE the record, plus one journaled session note`,
    "  ideation — bless an idea into a later-horizon node; park a reject as an out-of-scope line",
  ];
}

/**
 * DD5's section 7 — the posture in force and its consequence for THIS session
 * (D3 as refined by dx5wkzq7, plus DD2's flag). The mode line is `nahel brief`'s
 * shape, defaults marked as defaults, because a resolved default and a
 * committed intent are different facts about a project.
 *
 * What moves with the mode is exactly one clause: grilling tickets are the
 * human's under `human` governance and the partner's under `delegated`/`agent`.
 * Research and task tickets it always answers; a prototype ticket it always
 * STARTS and never finishes alone. The human-only line never moves at all —
 * DD2's refusal is CLI-enforced under every mode.
 */
function governanceLines(governance: Partial<Governance> | undefined): string[] {
  const product = resolveGovernance(governance).product;
  const grilling =
    product.mode === "human"
      ? "Grilling tickets wait for you — unless you delegate them by name in this session."
      : "Grilling tickets too, with a rationale it can defend later.";
  return [
    "governance:",
    `  product: ${product.mode}${product.defaulted ? " (default)" : ""}`,
    "  self-resolves here: research and task tickets; prototype tickets are STARTED, not awaited " +
      `(prototype-lane's verdict rules finish them). ${grilling}`,
    "  never: a [human-only] ticket — under an agent actor resolve, close and --clear-human-only " +
      "are all refused.",
  ];
}

import {
  foundingSignatureStatus,
  readMergeAuthority,
  resolveGovernance,
  type FoundingSignatureStatus,
  type MergeAuthorityStatus,
} from "../governance/authority";
import {
  awaitingRoadmapReview,
  type AwaitingRoadmapReview,
} from "../governance/roadmap-review";
import { QA_SWEEP_EVENT_TYPE } from "../schema/events";
import type {
  Actor,
  Config,
  JournalEvent,
  ObservationFrontmatter,
  WorkItemFrontmatter,
} from "../schema/records";
import {
  knowledgePaths,
  listObservations,
  readObservation,
  readTextFile,
  type StoreLayout,
} from "../store/layout";
import { GOAL_HEADING, HARD_CONSTRAINTS_HEADING } from "../templates/product";
import { collectProgress, renderProgress } from "./progress";
import { chronological, loadSnapshot, type Snapshot } from "./snapshot";
import { renderStatus } from "./status";

/**
 * `nahel brief` view (PRD F7): the deterministic onboarding pack. Required
 * sections in FIXED order — constitution extract (verbatim by the frozen
 * heading convention, never summarized), the signed founding paragraph when
 * one exists (F9.5, so the per-dispatch signed-core check reads the brief
 * rather than nahel/config raw), knowledge & canonical-truth
 * pointers, governance & merge authority (the operative policy, Phase 2
 * F2.2/F3.4), item statuses (renderStatus composed), recent activity
 * (renderProgress composed), pending human decisions, QA state (open `qa`
 * items and the latest `qa.sweep-completed`, Phase 3 F6), validate warnings.
 *
 * 4 KB target budget with a fixed-priority truncation ladder: oldest activity
 * first, then done-item detail, then a constitution clip with an explicit
 * file pointer. Required sections are never dropped and every truncation is
 * visibly marked. Rendering is PURE (renderBrief: inputs → string); all I/O
 * lives in composeBrief, per the epic's pure-views decision.
 */

/** The brief's size target in UTF-8 bytes (PRD F7: "4 KB target"). */
export const BRIEF_BUDGET_BYTES = 4096;

/**
 * The validate-warnings seam (task #8 ↔ #9): brief renders whatever warning
 * lines this source yields. The default stub reports none; the orchestrator
 * wires validate's real findings collector here at merge (a two-line swap in
 * src/commands/brief.ts — see the note there).
 */
export type BriefWarningsSource = (layout: StoreLayout) => Promise<string[]>;

/** Default warnings source until validate (#9) is wired: no warnings. */
export const NO_WARNINGS: BriefWarningsSource = async () => [];

/** Everything renderBrief needs — pure data, one value per section input. */
export interface BriefInputs {
  snapshot: Snapshot;
  /** Merged journal events, oldest → newest (collectProgress order). */
  events: readonly JournalEvent[];
  /** PRODUCT.md content, or null when the file is missing (a finding). */
  productText: string | null;
  /** Repo-relative knowledge paths from config — never absolute in output. */
  productPath: string;
  contextPath: string;
  adrPath: string;
  /**
   * Founding section from config, or undefined. Only a founding carrying a
   * PARAGRAPH renders a section — its signature is resolved from `events`.
   */
  founding?: Config["founding"];
  /** Governance section from config, or undefined — resolved for display. */
  governance?: Config["governance"];
  /** Merge authority in force, with its journal provenance (F3.4). */
  merge: MergeAuthorityStatus;
  /** Responsibility routing map from config, or undefined when unconfigured. */
  routing?: Config["routing"];
  /**
   * Observation records, oldest → newest (created → id), for the active
   * repro-waivers section (F5). Optional: absent renders no waiver block.
   */
  observations?: readonly ObservationFrontmatter[];
  /** Validate warning lines from the injected source. */
  warnings: readonly string[];
}

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;

/**
 * Literal section slicing on a frozen heading (PRD F7 / templates/product.ts
 * contract — no markdown AST): the body is every line after the exact heading
 * line up to the next `#`/`##` heading, verbatim, with only the surrounding
 * blank lines trimmed. Null when the heading line is absent.
 */
export function extractSection(markdown: string, heading: string): string | null {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##? /.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end);
  while (body.length > 0 && body[0]!.trim() === "") body.shift();
  while (body.length > 0 && body[body.length - 1]!.trim() === "") body.pop();
  return body.join("\n");
}

/**
 * Prune done-item detail for the truncation ladder: drop items whose status
 * is `done` unless a live (non-done) item sits somewhere beneath them — done
 * ancestors stay so the tree the composed renderStatus draws keeps its shape.
 */
export function withoutDoneDetail(items: readonly WorkItemFrontmatter[]): {
  items: WorkItemFrontmatter[];
  omitted: number;
} {
  const byId = new Map(items.map((item) => [item.id, item]));
  const keep = new Set<string>();
  for (const item of items) {
    if (item.status === "done") continue;
    keep.add(item.id);
    // Walk the parent chain (cycle-safe) so done ancestors of live work stay.
    const seen = new Set<string>([item.id]);
    let current = item.parent === undefined ? undefined : byId.get(item.parent);
    while (current !== undefined && !seen.has(current.id)) {
      keep.add(current.id);
      seen.add(current.id);
      current = current.parent === undefined ? undefined : byId.get(current.parent);
    }
  }
  const kept = items.filter((item) => keep.has(item.id));
  return { items: kept, omitted: items.length - kept.length };
}

/** Section 1 body: the verbatim constitution extract, or explicit findings. */
function constitutionBody(inputs: BriefInputs): string {
  if (inputs.productText === null) {
    return `finding: ${inputs.productPath} is missing — goal and hard constraints unavailable (run nahel init to scaffold the constitution)`;
  }
  const parts: string[] = [];
  for (const heading of [GOAL_HEADING, HARD_CONSTRAINTS_HEADING]) {
    const body = extractSection(inputs.productText, heading);
    parts.push(
      body === null
        ? `finding: ${inputs.productPath} has no "${heading}" section — expected by the frozen template convention`
        : `${heading}\n\n${body}`,
    );
  }
  return parts.join("\n\n");
}

/**
 * Optional signed-founding body (PRD F9.5): under a hands-off founding the
 * paragraph is the constitution's only human-signed content, and it is checked
 * before EVERY implementation dispatch — so it belongs in the brief, verbatim,
 * rather than making each runner read nahel/config raw. Rendered whenever a
 * paragraph exists; null otherwise, so a guided project carries zero founding
 * noise (the routing-section precedent).
 *
 * The attribution line is the whole point of the second line: an UNSIGNED
 * paragraph authorizes nothing (validate's `founding.unsigned`), and shown
 * without that mark it would read as signed constitutional text.
 *
 * No truncation rung touches this section. The paragraph is stored verbatim
 * and compared against verbatim (F9.5) — a clipped signature is not a
 * signature, and one paragraph costs the budget far less than the PRODUCT.md
 * extract the ladder already clips.
 */
function foundingBody(
  founding: Config["founding"],
  events: readonly JournalEvent[],
): string | null {
  const status = foundingSignatureStatus(founding, events);
  if (status === undefined) return null;
  return `${founding!.paragraph}\n${foundingAttribution(status)}`;
}

/**
 * The attribution line: who signed, or why nobody did. Each defect states the
 * journal fact it actually rests on — an ambiguous signature HAS acts (they
 * disagree) and a mismatching one HAS an act (it records other bytes), so
 * reporting either as "none recorded" would be both untrue and a pointer at
 * the wrong repair. The no-act wording is reserved for an empty journal.
 *
 * A mismatch's wording turns on WHO acted: only a human act ever signed
 * anything (F9.5), so only there can the text have moved out from under a
 * signature — claiming that of an agent act would assert a signature it never
 * had, and read as though a human's intent had been overwritten.
 */
function foundingAttribution(status: FoundingSignatureStatus): string {
  const named = (entry: { event: string; actor: Actor }): string =>
    `${entry.actor.kind}:${entry.actor.id} (act ${entry.event})`;
  if (status.signed) return `signed by: ${named(status.recordedBy!)}`;

  const cause =
    status.defect === "ambiguous"
      ? `${(status.tied ?? []).length} same-second acts disagree: ${(status.tied ?? [])
          .map(named)
          .join(", ")}`
      : status.defect === "paragraph-mismatch"
        ? `${named(status.recordedBy!)} records different paragraph bytes${
            status.recordedBy!.actor.kind === "human"
              ? " — the text moved after it was signed"
              : " and, being agent-run, signed nothing anyway"
          }`
        : status.recordedBy === undefined
          ? "no journaled act records it"
          : `recorded by ${named(status.recordedBy)}`;
  return `UNSIGNED — ${cause}; it authorizes nothing until a human re-records it (nahel validate: founding.unsigned)`;
}

/** Section 2 body: configured knowledge paths plus every nahel state layer. */
function knowledgeBody(inputs: BriefInputs): string {
  return [
    `constitution (goal, hard constraints; human-owned): ${inputs.productPath}`,
    `glossary & ubiquitous language: ${inputs.contextPath}`,
    `architecture decisions (ADRs): ${inputs.adrPath}`,
    "work items (intent): nahel/items/",
    "runs & hot state (execution): nahel/runs/<run-id>/",
    "journal (history, append-only; view via nahel progress): nahel/journal/",
    "observations (curated facts): nahel/observations/",
    "config (knowledge paths, actor): nahel/config",
  ].join("\n");
}

/**
 * Section 3 body — the operative policy (PRD F2.2 config semantics, F3.4):
 * who owns product and architecture legislation, and who may merge. ALWAYS
 * rendered, unlike routing: every project has a posture, and a posture read
 * from absence still governs what an agent may do without asking. Defaults
 * are marked `(default)` so a host agent can tell committed intent from a
 * resolved default, and an unauthorized `merge: on-approve` is marked inert
 * with the authority actually in force — never quietly shown as if live.
 */
function governanceBody(inputs: BriefInputs): string {
  const governance = resolveGovernance(inputs.governance);
  const area = (label: string, resolved: { mode: string; defaulted: boolean }): string =>
    `${label}: ${resolved.mode}${resolved.defaulted ? " (default)" : ""}`;
  const lines = [
    area("product", governance.product),
    area("architecture", governance.architecture),
    mergeLine(inputs.merge),
  ];
  // The posture's consequence, right under the posture that decides it (F5).
  const awaiting = awaitingRoadmapReview(inputs.governance, inputs.events);
  if (awaiting !== undefined) lines.push(awaitingRoadmapLine(awaiting));
  return lines.join("\n");
}

/**
 * The awaiting-your-eyes line (PRD F5): what agents moved on the roadmap since
 * the human last touched it. ONE line — acts counted, nodes named up to the
 * cap, remainder stated with the verb that shows the rest, exactly as F4's
 * block degrades. Rendered only when something waits, so a project whose
 * roadmap the human keeps up with (and every project under agent-as-PO, which
 * has no surface at all) carries zero noise.
 *
 * No truncation rung touches it: it is one line, and it is the layer's entire
 * control — a roadmap layer that trusts every agent to write needs the human
 * to be told what was written.
 */
function awaitingRoadmapLine(awaiting: AwaitingRoadmapReview): string {
  const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const named = awaiting.nodes.map((node) => node.name).join(", ");
  const rest = awaiting.more === 0 ? "" : `, +${awaiting.more} more — nahel roadmap`;
  return (
    `roadmap changes since your last touch (${awaiting.since}): ` +
    `${count(awaiting.changes, "agent act")} on ${count(awaiting.nodes.length + awaiting.more, "node")} — ${named}${rest}`
  );
}

/** The merge-authority line: what config says, and what is actually in force. */
function mergeLine(status: MergeAuthorityStatus): string {
  if (status.defect === undefined) {
    return `merge: ${status.configured}${status.defaulted ? " (default)" : ""}`;
  }
  const why =
    status.defect === "agent-set"
      ? `inert — agent-set by ${status.setBy!.actor.kind}:${status.setBy!.actor.id}`
      : "inert — no journaled config mutation sets it";
  return `merge: ${status.configured} (${why}; in force: merge: ${status.effective})`;
}

/**
 * Optional routing section body (PRD F3, ADR-0015): each CONFIGURED
 * responsibility on its own line with its agent/model, in the schema's enum
 * order, followed by the two non-responsibility keys — `review2` (the review
 * loop's second reviewer slot, F3.1) and `default`. A slot nobody can see is a
 * slot nobody honors: the loop resolves both reviewers off this section. Null
 * when nothing is configured — the section is then omitted entirely, so an
 * unconfigured project's brief carries zero routing noise.
 */
function routingBody(routing: Config["routing"]): string | null {
  if (routing === undefined) return null;
  const lines: string[] = [];
  for (const responsibility of [
    "architecture",
    "implementation",
    "review",
    "review2",
    "default",
  ] as const) {
    const entry = routing[responsibility];
    if (entry === undefined) continue;
    const parts: string[] = [];
    if (entry.agent !== undefined) parts.push(`agent=${entry.agent}`);
    if (entry.model !== undefined) parts.push(`model=${entry.model}`);
    lines.push(`${responsibility}: ${parts.join(" ")}`);
  }
  return lines.length === 0 ? null : lines.join("\n");
}

/** The observation tag that marks a repro waiver (F5.3, bug-lane workflow). */
export const REPRO_WAIVER_TAG = "repro-waiver";

/**
 * Optional active-repro-waivers section body (PRD F5.3): every observation
 * tagged `repro-waiver` whose referenced bug is still live. A waiver on a
 * done or dropped item is history, not an alert; a waiver whose item ref is
 * missing or absent cannot be PROVEN closed, so it stays surfaced, marked —
 * never silently skipped (hard constraint 6). Null when no waiver is active,
 * so a waiver-free brief carries zero noise (the routing-section precedent).
 */
function waiversBody(
  observations: readonly ObservationFrontmatter[] | undefined,
  items: readonly WorkItemFrontmatter[],
): string | null {
  if (observations === undefined) return null;
  const byId = new Map(items.map((item) => [item.id, item]));
  const lines: string[] = [];
  for (const observation of observations) {
    if (!observation.tags.includes(REPRO_WAIVER_TAG)) continue;
    const label = observation.name ?? observation.id;
    if (observation.item === undefined) {
      lines.push(`waiver: ${label} id=${observation.id} item=none`);
      continue;
    }
    const item = byId.get(observation.item);
    if (item === undefined) {
      lines.push(`waiver: ${label} id=${observation.id} item=${observation.item} (missing)`);
      continue;
    }
    if (item.status === "done" || item.status === "dropped") continue;
    lines.push(`waiver: ${label} id=${observation.id} item=${item.id}`);
  }
  return lines.length === 0 ? null : lines.join("\n");
}

/** A payload value rendered for a one-line summary; absent reads as `?`. */
function payloadField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (value === undefined || value === null) return "?";
  if (Array.isArray(value)) return String(value.length);
  return String(value);
}

/**
 * QA section body (PRD F6): every OPEN `qa` work item on one line each, then
 * the latest sweep summary on one line. Always rendered — a project with no
 * QA state says so explicitly, because "no section" and "no sweep ever" are
 * different facts to a fresh agent and only one of them is true.
 *
 * `findings_filed` is journaled as a list of bug-item ids; the brief shows
 * its COUNT and points at the report for the ids — a one-line surface stays
 * one line. Absent payload keys render `?` rather than vanishing: a sweep
 * that journaled an incomplete summary is itself worth seeing.
 */
function qaBody(items: readonly WorkItemFrontmatter[], events: readonly JournalEvent[]): string {
  const lines: string[] = [];
  for (const item of items) {
    if (item.type !== "qa") continue;
    if (item.status === "done" || item.status === "dropped") continue;
    lines.push(`qa item: ${item.name} id=${item.id} status=${item.status}`);
  }
  // Events arrive oldest → newest, so the last match is the latest sweep.
  let sweep: JournalEvent | undefined;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.type === QA_SWEEP_EVENT_TYPE) {
      sweep = events[i];
      break;
    }
  }
  if (sweep !== undefined) {
    const field = (key: string): string => payloadField(sweep!.payload, key);
    lines.push(
      `latest sweep: ${sweep.ts} cases=${field("cases_run")} passed=${field("passed")} ` +
        `failed=${field("failed")} findings=${field("findings_filed")} report=${field("report")}`,
    );
  }
  return lines.length === 0 ? "none" : lines.join("\n");
}

/** Section 5 body: claims, blocked items, paused runs — or an explicit none. */
function decisionsBody(snapshot: Snapshot): string {
  const lines: string[] = [];
  for (const item of snapshot.items) {
    if (item.claimed_by !== undefined) {
      lines.push(`claim: ${item.name} id=${item.id} claimed_by=${item.claimed_by}`);
    }
  }
  for (const item of snapshot.items) {
    if (item.status === "blocked") lines.push(`blocked: ${item.name} id=${item.id}`);
  }
  for (const entry of snapshot.runs) {
    if (entry.run.status === "paused") {
      lines.push(`paused run: ${entry.run.id} item=${entry.run.item}`);
    }
  }
  return lines.length === 0 ? "none" : lines.join("\n");
}

/** Section 4 body: the newest `kept` events via the composed renderer, drops marked. */
function activityBody(events: readonly JournalEvent[], kept: number): string {
  const total = events.length;
  if (total === 0) return renderProgress(events); // "no journal events"
  const dropped = total - kept;
  const marker =
    dropped === 0
      ? null
      : `[… ${dropped} older events truncated — full timeline: nahel progress]`;
  if (kept === 0) return marker!;
  const rendered = renderProgress(events.slice(dropped));
  return marker === null ? rendered : `${marker}\n${rendered}`;
}

/** Clip to a code-point prefix (never splits a surrogate pair). */
function clipText(text: string, codePoints: number): string {
  return Array.from(text).slice(0, codePoints).join("");
}

/** One deterministic assembly at a given rung of the truncation ladder. */
function assemble(
  inputs: BriefInputs,
  keptEvents: number,
  dropDone: boolean,
  constitutionClip: number | null,
): string {
  let constitution = constitutionBody(inputs);
  if (constitutionClip !== null) {
    constitution = `${clipText(constitution, constitutionClip)}\n[… constitution truncated — read ${inputs.productPath} in full]`;
  }

  let statusSection: string;
  if (dropDone) {
    const pruned = withoutDoneDetail(inputs.snapshot.items);
    statusSection =
      renderStatus({ items: pruned.items, runs: inputs.snapshot.runs }) +
      `\n[… ${pruned.omitted} done items omitted — full tree: nahel status]`;
  } else {
    statusSection = renderStatus(inputs.snapshot);
  }

  const sections = [
    "nahel brief",
    `== constitution (${inputs.productPath}) ==\n${constitution}`,
  ];
  // Optional, with the constitution it IS: the signed founding paragraph (F9.5).
  const founding = foundingBody(inputs.founding, inputs.events);
  if (founding !== null) sections.push(`== signed founding paragraph (nahel/config) ==\n${founding}`);
  sections.push(
    `== knowledge & canonical truth ==\n${knowledgeBody(inputs)}`,
    `== governance & merge authority ==\n${governanceBody(inputs)}`,
  );
  // Optional, right after governance: advisory routing map when configured.
  const routing = routingBody(inputs.routing);
  if (routing !== null) sections.push(`== responsibility routing ==\n${routing}`);
  sections.push(
    `== item statuses ==\n${statusSection}`,
    `== recent activity (newest last) ==\n${activityBody(inputs.events, keptEvents)}`,
    `== pending human decisions ==\n${decisionsBody(inputs.snapshot)}`,
  );
  // Optional, right after decisions: active repro waivers (F5) — a live
  // waiver is an alert the next session must see; none configured, no noise.
  const waivers = waiversBody(inputs.observations, inputs.snapshot.items);
  if (waivers !== null) sections.push(`== active repro waivers ==\n${waivers}`);
  sections.push(
    // Required, not optional (PRD F6): where QA stands is part of arriving.
    `== qa (open items, latest sweep) ==\n${qaBody(inputs.snapshot.items, inputs.events)}`,
  );
  sections.push(
    `== validate warnings ==\n${inputs.warnings.length === 0 ? "none" : inputs.warnings.join("\n")}`,
  );
  return sections.join("\n\n");
}

/** Largest value in [lo, hi] whose assembly fits the budget; -1 when none does. */
function largestFitting(lo: number, hi: number, size: (value: number) => number): number {
  let best = -1;
  while (lo <= hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (size(mid) <= BRIEF_BUDGET_BYTES) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * Render the brief (PURE: inputs → string). Fits the 4 KB target by walking
 * the fixed truncation ladder; when even the smallest assembly exceeds the
 * target (a pathologically large live tree), the result runs over budget but
 * every section is present and every truncation is marked — never silent.
 */
export function renderBrief(inputs: BriefInputs): string {
  const total = inputs.events.length;
  const full = assemble(inputs, total, false, null);
  if (byteLength(full) <= BRIEF_BUDGET_BYTES) return full;

  // Rung 1: drop oldest activity first. Size is monotone in kept events, so
  // binary-search the largest kept count in [0, total-1] (marker present).
  if (total > 0) {
    const kept = largestFitting(0, total - 1, (k) =>
      byteLength(assemble(inputs, k, false, null)),
    );
    if (kept >= 0) return assemble(inputs, kept, false, null);
  }

  // Rung 2: with activity exhausted, drop done-item detail.
  const dropDone = withoutDoneDetail(inputs.snapshot.items).omitted > 0;
  if (dropDone && byteLength(assemble(inputs, 0, true, null)) <= BRIEF_BUDGET_BYTES) {
    return assemble(inputs, 0, true, null);
  }

  // Rung 3: clip the constitution, keeping the largest prefix that fits.
  const constitutionLength = Array.from(constitutionBody(inputs)).length;
  const clip = largestFitting(0, constitutionLength, (c) =>
    byteLength(assemble(inputs, 0, dropDone, c)),
  );
  return assemble(inputs, 0, dropDone, Math.max(clip, 0));
}

/**
 * Compose the brief for a repo: ONE store read pass (the same snapshot the
 * other views load, the merged journal, PRODUCT.md through the store's text
 * read) plus the injected warnings source, then the pure renderer.
 */
export async function composeBrief(
  layout: StoreLayout,
  config: Config,
  warningsSource: BriefWarningsSource = NO_WARNINGS,
): Promise<string> {
  const snapshot = await loadSnapshot(layout);
  const events = await collectProgress(layout);
  const productText = await readTextFile((await knowledgePaths(layout, config)).product);
  // Observations feed the active-repro-waivers section (F5), in the same
  // deterministic created → id order the snapshot gives items.
  const observations: ObservationFrontmatter[] = [];
  for (const id of await listObservations(layout)) {
    observations.push((await readObservation(layout, id)).frontmatter);
  }
  observations.sort(chronological((observation) => [observation.created, observation.id]));
  const warnings = await warningsSource(layout);
  return renderBrief({
    snapshot,
    events,
    productText,
    productPath: config.knowledge.product,
    contextPath: config.knowledge.context,
    adrPath: config.knowledge.adr,
    founding: config.founding,
    governance: config.governance,
    merge: await readMergeAuthority(layout, config),
    routing: config.routing,
    observations,
    warnings,
  });
}

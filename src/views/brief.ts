import type { Config, JournalEvent, WorkItemFrontmatter } from "../schema/records";
import { knowledgePaths, readTextFile, type StoreLayout } from "../store/layout";
import { GOAL_HEADING, HARD_CONSTRAINTS_HEADING } from "../templates/product";
import { collectProgress, renderProgress } from "./progress";
import { loadSnapshot, type Snapshot } from "./snapshot";
import { renderStatus } from "./status";

/**
 * `nahel brief` view (PRD F7): the deterministic onboarding pack. Six
 * required sections in FIXED order — constitution extract (verbatim by the
 * frozen heading convention, never summarized), knowledge & canonical-truth
 * pointers, item statuses (renderStatus composed), recent activity
 * (renderProgress composed), pending human decisions, validate warnings.
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

  return [
    "nahel brief",
    `== constitution (${inputs.productPath}) ==\n${constitution}`,
    `== knowledge & canonical truth ==\n${knowledgeBody(inputs)}`,
    `== item statuses ==\n${statusSection}`,
    `== recent activity (newest last) ==\n${activityBody(inputs.events, keptEvents)}`,
    `== pending human decisions ==\n${decisionsBody(inputs.snapshot)}`,
    `== validate warnings ==\n${inputs.warnings.length === 0 ? "none" : inputs.warnings.join("\n")}`,
  ].join("\n\n");
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
  const productText = await readTextFile(knowledgePaths(layout, config).product);
  const warnings = await warningsSource(layout);
  return renderBrief({
    snapshot,
    events,
    productText,
    productPath: config.knowledge.product,
    contextPath: config.knowledge.context,
    adrPath: config.knowledge.adr,
    warnings,
  });
}

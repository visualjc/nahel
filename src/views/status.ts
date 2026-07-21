import { buildItemTree, type ItemNode, type RunSnapshot, type Snapshot } from "./snapshot";

/**
 * The status renderer (PRD F5): a PURE function snapshot → string — no I/O,
 * no clock, no randomness, so the same snapshot always renders byte-identical
 * output. The `status` command wraps it; brief (#8) composes it verbatim as
 * its item-statuses section.
 */

/** The run's current phase: the hot-state mirror when readable, else the record. */
function runPhase(entry: RunSnapshot): string {
  const mirrored = entry.hotState?.["phase"];
  return typeof mirrored === "string" ? mirrored : entry.run.phase;
}

/**
 * Rendering knobs. `showPrd` adds `prd=<path>` to item lines that carry one
 * (F1, ADR-0013) — `nahel status` is the detailed view and turns it on; the
 * default stays terse so brief's composed item-statuses section is unchanged.
 */
export interface RenderStatusOptions {
  showPrd?: boolean;
}

function itemLine(
  node: ItemNode,
  depth: number,
  knownIds: ReadonlySet<string>,
  options: RenderStatusOptions,
): string {
  const { item } = node;
  const parts = [
    `${"  ".repeat(depth + 1)}${item.name}`,
    item.type,
    item.status,
    `lane=${item.lane}`,
    `id=${item.id}`,
  ];
  if (options.showPrd === true && item.prd !== undefined) parts.push(`prd=${item.prd}`);
  if (item.claimed_by !== undefined) parts.push(`claimed_by=${item.claimed_by}`);
  if (item.parent !== undefined && !knownIds.has(item.parent)) {
    parts.push(`parent=${item.parent} (missing)`);
  }
  return parts.join("  ");
}

function renderNodes(
  nodes: readonly ItemNode[],
  depth: number,
  knownIds: ReadonlySet<string>,
  options: RenderStatusOptions,
  out: string[],
): void {
  for (const node of nodes) {
    out.push(itemLine(node, depth, knownIds, options));
    renderNodes(node.children, depth + 1, knownIds, options, out);
  }
}

function runLine(entry: RunSnapshot): string {
  const { run } = entry;
  return [
    `  ${run.id}`,
    `item=${run.item}`,
    `phase=${runPhase(entry)}`,
    `status=${run.status}`,
    `started=${run.started}`,
  ].join("  ");
}

/** Render the work-item tree (via parent), claims, and open runs with phases. */
export function renderStatus(snapshot: Snapshot, options: RenderStatusOptions = {}): string {
  const lines: string[] = [];

  if (snapshot.items.length === 0) {
    lines.push("work items: none");
  } else {
    lines.push("work items:");
    const knownIds = new Set(snapshot.items.map((item) => item.id));
    renderNodes(buildItemTree(snapshot.items), 0, knownIds, options, lines);
  }

  lines.push("");

  const open = snapshot.runs.filter((entry) => entry.run.status !== "ended");
  if (open.length === 0) {
    lines.push("runs: none open");
  } else {
    lines.push("runs:");
    for (const entry of open) lines.push(runLine(entry));
  }

  return lines.join("\n");
}

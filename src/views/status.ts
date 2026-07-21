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

function itemLine(node: ItemNode, depth: number, knownIds: ReadonlySet<string>): string {
  const { item } = node;
  const parts = [
    `${"  ".repeat(depth + 1)}${item.name}`,
    item.type,
    item.status,
    `lane=${item.lane}`,
    `id=${item.id}`,
  ];
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
  out: string[],
): void {
  for (const node of nodes) {
    out.push(itemLine(node, depth, knownIds));
    renderNodes(node.children, depth + 1, knownIds, out);
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
export function renderStatus(snapshot: Snapshot): string {
  const lines: string[] = [];

  if (snapshot.items.length === 0) {
    lines.push("work items: none");
  } else {
    lines.push("work items:");
    const knownIds = new Set(snapshot.items.map((item) => item.id));
    renderNodes(buildItemTree(snapshot.items), 0, knownIds, lines);
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

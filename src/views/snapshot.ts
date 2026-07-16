import type { Run, WorkItemFrontmatter } from "../schema/records";
import { readHotState, type HotState } from "../store/hotstate";
import { listItems, listRuns, readItem, readRun, type StoreLayout } from "../store/layout";

/**
 * The shared view snapshot (task #7; epic decision "views are pure functions
 * over store reads"): ONE store read pass produces the state object every
 * view renders from. status/progress consume it now; brief (#8) composes the
 * same renderers over it and validate (#9) checks the same shape — so this
 * type is the contract, and the renderers stay pure `(snapshot) → string`
 * functions with all I/O confined to loadSnapshot.
 */

/** One run with its hot state — the run-scoped phase mirror (ADR-0012). */
export interface RunSnapshot {
  run: Run;
  /**
   * `state.json` content, or null when the file does not exist yet — the
   * write-ahead crash window can leave a journaled run without hot state,
   * and a read-only view must render that, not error. Malformed hot state
   * (unparseable JSON, non-object) still throws: that IS corrupt state.
   */
  hotState: HotState | null;
}

/** Everything the views render from, loaded in one pass, deterministically ordered. */
export interface Snapshot {
  /** Every work item's frontmatter (claims ride on claimed_by), ordered created → id. */
  items: WorkItemFrontmatter[];
  /** Every run with its hot state, ordered started → id. */
  runs: RunSnapshot[];
}

/**
 * The store's missing-hot-state signal (hotstate.ts throws this exact phrase
 * for an absent state.json; any other failure is real corruption). Store gap,
 * noted like init.ts's fileExists: a first-class "read or null" primitive in
 * src/store would replace this error-shape dependence.
 */
const MISSING_HOT_STATE = /has no hot state yet/;

/** Deterministic order: primary timestamp, ties broken by id. */
function chronological<T>(key: (value: T) => readonly [string, string]) {
  return (a: T, b: T): number => {
    const [tsA, idA] = key(a);
    const [tsB, idB] = key(b);
    if (tsA !== tsB) return tsA < tsB ? -1 : 1;
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  };
}

/**
 * Load the snapshot: one read pass over items, runs, and each run's hot
 * state. Any unparseable record throws — callers surface that as a non-zero
 * exit, never as silently partial output.
 */
export async function loadSnapshot(layout: StoreLayout): Promise<Snapshot> {
  const items: WorkItemFrontmatter[] = [];
  for (const id of await listItems(layout)) {
    items.push((await readItem(layout, id)).frontmatter);
  }
  items.sort(chronological((item) => [item.created, item.id]));

  const runs: RunSnapshot[] = [];
  for (const id of await listRuns(layout)) {
    const run = await readRun(layout, id);
    let hotState: HotState | null;
    try {
      hotState = await readHotState(layout, id);
    } catch (error) {
      if (error instanceof Error && MISSING_HOT_STATE.test(error.message)) {
        hotState = null;
      } else {
        throw error;
      }
    }
    runs.push({ run, hotState });
  }
  runs.sort(chronological((entry) => [entry.run.started, entry.run.id]));

  return { items, runs };
}

/** One node of the work-item tree: an item and its children (input order). */
export interface ItemNode {
  item: WorkItemFrontmatter;
  children: ItemNode[];
}

/**
 * True when following the parent chain upward from `item` returns to `item`
 * itself — the item sits on a parent cycle. The `seen` guard also terminates
 * chains that run into a cycle not involving `item`.
 */
function onParentCycle(
  item: WorkItemFrontmatter,
  byId: ReadonlyMap<string, WorkItemFrontmatter>,
): boolean {
  const seen = new Set<string>([item.id]);
  let current = item.parent === undefined ? undefined : byId.get(item.parent);
  while (current !== undefined) {
    if (current.id === item.id) return true;
    if (seen.has(current.id)) return false;
    seen.add(current.id);
    current = current.parent === undefined ? undefined : byId.get(current.parent);
  }
  return false;
}

/**
 * Build the hierarchy via `parent` (pure). Roots are items without a parent,
 * items whose parent record is missing (they surface at the root rather than
 * disappearing), and members of a parent cycle (which therefore never nest —
 * the tree stays finite). Sibling order follows input order, so a snapshot's
 * created → id order carries through.
 */
export function buildItemTree(items: readonly WorkItemFrontmatter[]): ItemNode[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const nodes = new Map(items.map((item) => [item.id, { item, children: [] } as ItemNode]));
  const roots: ItemNode[] = [];
  for (const item of items) {
    const node = nodes.get(item.id)!;
    const parent = item.parent === undefined ? undefined : nodes.get(item.parent);
    if (parent === undefined || onParentCycle(item, byId)) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }
  return roots;
}

/**
 * The subtree an item covers (pure): the item itself plus every transitive
 * child — the same coverage rule claims use (PRD F9) and the set `progress
 * --item` filters by. Cycle-safe via the visited set.
 */
export function descendantIds(
  items: readonly WorkItemFrontmatter[],
  rootId: string,
): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const item of items) {
    if (item.parent !== undefined) {
      const siblings = childrenOf.get(item.parent);
      if (siblings === undefined) childrenOf.set(item.parent, [item.id]);
      else siblings.push(item.id);
    }
  }
  const covered = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of childrenOf.get(current) ?? []) {
      if (!covered.has(child)) {
        covered.add(child);
        queue.push(child);
      }
    }
  }
  return covered;
}

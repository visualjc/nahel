import { afterEach, describe, expect, test } from "bun:test";
import { rm, unlink } from "node:fs/promises";
import { hotStatePath } from "../../src/store/hotstate";
import { ensureLayout, writeConfig } from "../../src/store/layout";
import {
  buildItemTree,
  descendantIds,
  loadSnapshot,
  type ItemNode,
} from "../../src/views/snapshot";
import { makeConfig, makeFrontmatter, makeTempDir, seededEnv } from "../store/helpers";
import { buildPopulatedStore } from "./helpers";

/**
 * The shared snapshot loader (task #7): ONE store read pass produces the
 * state object every view renders from — items (with hierarchy machinery),
 * runs with their hot state, claims on the frontmatter. status/progress
 * consume it now; brief (#8) and validate (#9) import the same type later.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("loadSnapshot — one read pass over the store", () => {
  test("loads every item and run from a store populated via the real commands", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const snapshot = await loadSnapshot(store.layout);

    expect(snapshot.items.map((item) => item.id)).toEqual([
      store.epicId,
      store.taskAlphaId,
      store.taskBetaId,
      store.soloChoreId,
    ]);
    expect(snapshot.runs.map((entry) => entry.run.id)).toEqual([
      store.activeRunId,
      store.endedRunId,
    ]);

    const epic = snapshot.items[0]!;
    expect(epic.name).toBe("demo-epic");
    expect(epic.type).toBe("plan");
    expect(epic.lane).toBe("full");
    expect(epic.status).toBe("backlog");

    const alpha = snapshot.items[1]!;
    expect(alpha.parent).toBe(store.epicId);
    expect(alpha.claimed_by).toBe("jim");

    const beta = snapshot.items[2]!;
    expect(beta.status).toBe("in-progress");
    expect(beta.parent).toBe(store.epicId);

    expect(snapshot.items[3]!.parent).toBeUndefined();
  });

  test("runs carry their hot state — the phase mirror the run commands maintain", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const snapshot = await loadSnapshot(store.layout);

    const active = snapshot.runs.find((entry) => entry.run.id === store.activeRunId)!;
    expect(active.run.status).toBe("active");
    expect(active.run.phase).toBe("building");
    expect(active.hotState).not.toBeNull();
    expect(active.hotState!["phase"]).toBe("building");
    expect(active.hotState!["status"]).toBe("active");

    const ended = snapshot.runs.find((entry) => entry.run.id === store.endedRunId)!;
    expect(ended.run.status).toBe("ended");
    expect(ended.run.phase).toBe("success");
    expect(ended.hotState!["outcome"]).toBe("success");
  });

  test("a run whose state.json is missing (crash window) loads with hotState null, not an error", async () => {
    const store = await buildPopulatedStore(tempDirs);
    await unlink(hotStatePath(store.layout, store.activeRunId));

    const snapshot = await loadSnapshot(store.layout);
    const active = snapshot.runs.find((entry) => entry.run.id === store.activeRunId)!;
    expect(active.hotState).toBeNull();
    // The run record itself still carries the phase.
    expect(active.run.phase).toBe("building");
  });

  test("an empty initialized store snapshots to empty item and run lists", async () => {
    const root = await makeTempDir("nahel-views-empty-");
    tempDirs.push(root);
    const layout = await ensureLayout(root);
    await writeConfig(layout, makeConfig());

    const snapshot = await loadSnapshot(layout);
    expect(snapshot.items).toEqual([]);
    expect(snapshot.runs).toEqual([]);
  });

  test("two identically-seeded stores load JSON-identical snapshots (determinism)", async () => {
    const a = await buildPopulatedStore(tempDirs, 7);
    const b = await buildPopulatedStore(tempDirs, 7);
    expect(JSON.stringify(await loadSnapshot(a.layout), null, 2)).toBe(
      JSON.stringify(await loadSnapshot(b.layout), null, 2),
    );
  });
});

describe("buildItemTree — hierarchy via parent (pure)", () => {
  test("epics nest their tasks; independent items are separate roots", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const snapshot = await loadSnapshot(store.layout);
    const roots = buildItemTree(snapshot.items);

    expect(roots.map((node) => node.item.id)).toEqual([store.epicId, store.soloChoreId]);
    const epic = roots[0]!;
    expect(epic.children.map((node) => node.item.id)).toEqual([
      store.taskAlphaId,
      store.taskBetaId,
    ]);
    expect(epic.children.every((node) => node.children.length === 0)).toBe(true);
    expect(roots[1]!.children).toEqual([]);
  });

  test("an item whose parent record is missing surfaces as a root, never disappears", () => {
    const env = seededEnv();
    const orphan = makeFrontmatter(env, { name: "orphan", parent: "zzzzzzzz" });
    const roots = buildItemTree([orphan]);
    expect(roots.map((node) => node.item.id)).toEqual([orphan.id]);
  });

  test("a parent cycle terminates: cycle members render as roots instead of looping", () => {
    const env = seededEnv();
    const a = makeFrontmatter(env, { name: "cycle-a" });
    const b = makeFrontmatter(env, { name: "cycle-b" });
    const cycleA = { ...a, parent: b.id };
    const cycleB = { ...b, parent: a.id };
    const child = makeFrontmatter(env, { name: "under-cycle", parent: cycleA.id });

    const roots = buildItemTree([cycleA, cycleB, child]);
    expect(roots.map((node) => node.item.id).sort()).toEqual([cycleA.id, cycleB.id].sort());
    // The non-cycle child still hangs under its parent.
    const rootA = roots.find((node) => node.item.id === cycleA.id)!;
    expect(rootA.children.map((node) => node.item.id)).toEqual([child.id]);
    // Every node is finite — walking the whole tree terminates.
    const walk = (node: ItemNode): number =>
      1 + node.children.reduce((sum, next) => sum + walk(next), 0);
    expect(roots.reduce((sum, node) => sum + walk(node), 0)).toBe(3);
  });
});

describe("descendantIds — subtree coverage (pure)", () => {
  test("covers the root itself plus all transitive children", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const snapshot = await loadSnapshot(store.layout);

    expect(descendantIds(snapshot.items, store.epicId)).toEqual(
      new Set([store.epicId, store.taskAlphaId, store.taskBetaId]),
    );
    expect(descendantIds(snapshot.items, store.taskAlphaId)).toEqual(
      new Set([store.taskAlphaId]),
    );
    expect(descendantIds(snapshot.items, store.soloChoreId)).toEqual(
      new Set([store.soloChoreId]),
    );
  });

  test("terminates on a parent cycle", () => {
    const env = seededEnv();
    const a = makeFrontmatter(env, { name: "cycle-a" });
    const b = makeFrontmatter(env, { name: "cycle-b" });
    const cycleA = { ...a, parent: b.id };
    const cycleB = { ...b, parent: a.id };
    expect(descendantIds([cycleA, cycleB], cycleA.id)).toEqual(
      new Set([cycleA.id, cycleB.id]),
    );
  });
});

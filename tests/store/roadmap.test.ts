import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CORE_EVENT_TYPES } from "../../src/schema/events";
import { generateId, InvalidIdError } from "../../src/schema/id";
import type { RoadmapNodeFrontmatter } from "../../src/schema/records";
import { readJournal } from "../../src/store/journal";
import {
  ensureLayout,
  listRoadmapNodes,
  readItem,
  readRoadmapNode,
  readRoadmapNodes,
  resolveRoadmapNode,
  roadmapNodePath,
  storeLayout,
  writeConfig,
  writeRoadmapNode,
  type StoreLayout,
} from "../../src/store/layout";
import { createStoreContext, mutate, replayPending } from "../../src/store/mutate";
import { makeConfig, makeFrontmatter, makeTempDir, seededEnv } from "./helpers";

/**
 * Roadmap node storage and its mutation path (Phase 4 F1): node records live
 * under `nahel/roadmap/` as markdown + frontmatter, one file per node — the
 * same disjoint-file shape items use, so two worktrees adding different nodes
 * merge as a directory union (ADR-0012). Every creation and update rides the
 * existing write-ahead choke point, and the canonical direction (node → item,
 * never the reverse) is proven by the item records staying byte-identical.
 */

let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

async function setup() {
  const root = await makeTempDir("nahel-roadmap-store-");
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig());
  const env = seededEnv({ tickSeconds: 1 });
  const ctx = await createStoreContext(root, env);
  return { root, layout, env, ctx };
}

function makeNode(
  env: ReturnType<typeof seededEnv>,
  overrides: Partial<RoadmapNodeFrontmatter> = {},
): RoadmapNodeFrontmatter {
  const ts = env.now();
  return {
    id: generateId(env),
    name: "detached-state-repo",
    kind: "feature",
    horizon: "now",
    adrs: [],
    features: [],
    created: ts,
    updated: ts,
    ...overrides,
  };
}

/** Every item record's bytes, keyed by filename — the direction-rule witness. */
async function itemBytes(layout: StoreLayout): Promise<Record<string, string>> {
  const names = (await readdir(layout.itemsDir)).sort();
  const bytes: Record<string, string> = {};
  for (const name of names) {
    bytes[name] = await readFile(join(layout.itemsDir, name), "utf8");
  }
  return bytes;
}

describe("store/layout — roadmap node records live under nahel/roadmap/", () => {
  test("the layout names nahel/roadmap and node paths are <id>.md inside it", () => {
    const layout = storeLayout("/repo");
    expect(layout.roadmapDir).toBe("/repo/nahel/roadmap");
    expect(roadmapNodePath(layout, "9k3m2n4p")).toBe("/repo/nahel/roadmap/9k3m2n4p.md");
  });

  test("a crafted id never reaches a path — validated at the choke point like items", () => {
    const layout = storeLayout("/repo");
    expect(() => roadmapNodePath(layout, "../../PRODUCT")).toThrow(InvalidIdError);
  });

  test("write then read round-trips frontmatter and the intent body", async () => {
    const { layout, env } = await setup();
    const node = makeNode(env, { prd: "docs/prds/detached-state-repo.md", epic: "0gz8r4cm" });
    await writeRoadmapNode(layout, node, "Move state out of the app repo.\n");

    const read = await readRoadmapNode(layout, node.id);
    expect(read.frontmatter).toEqual(node);
    expect(read.body).toBe("Move state out of the app repo.\n");
  });

  test("listing is empty before any node exists — the ABSENT directory, and only that", async () => {
    const { layout } = await setup();
    expect(await listRoadmapNodes(layout)).toEqual([]);
    expect(await readRoadmapNodes(layout)).toEqual([]);
  });

  test("an UNREADABLE roadmap directory is reported, never rendered as an empty roadmap", async () => {
    // "No nodes" and "could not look" are different facts and only the first
    // is safe to render: a swallowed read failure would let the roadmap views
    // claim a store has no roadmap when it has one nahel could not read.
    const { layout } = await setup();
    await writeFile(layout.roadmapDir, "not a directory");
    expect(listRoadmapNodes(layout)).rejects.toThrow();
    expect(readRoadmapNodes(layout)).rejects.toThrow();
  });

  test("readRoadmapNodes returns every node in id order — a deterministic read for the views", async () => {
    const { layout, env } = await setup();
    const b = makeNode(env, { id: "bbbbbbbb", name: "second" });
    const a = makeNode(env, { id: "aaaaaaaa", name: "first" });
    await writeRoadmapNode(layout, b, "second\n");
    await writeRoadmapNode(layout, a, "first\n");

    expect(await listRoadmapNodes(layout)).toEqual(["aaaaaaaa", "bbbbbbbb"]);
    expect((await readRoadmapNodes(layout)).map((n) => n.frontmatter.name)).toEqual([
      "first",
      "second",
    ]);
  });

  test("a node resolves by slug and by id to the SAME node; an unknown ref resolves to null", async () => {
    const { layout, env } = await setup();
    const node = makeNode(env, { name: "changelog-and-product-updates" });
    await writeRoadmapNode(layout, node, "intent\n");

    const bySlug = await resolveRoadmapNode(layout, "changelog-and-product-updates");
    const byId = await resolveRoadmapNode(layout, node.id);
    expect(bySlug?.frontmatter).toEqual(node);
    expect(byId?.frontmatter).toEqual(bySlug?.frontmatter);
    expect(await resolveRoadmapNode(layout, "no-such-node")).toBeNull();
    expect(await resolveRoadmapNode(layout, "zzzzzzzz")).toBeNull();
  });
});

describe("store/mutate — roadmap nodes ride the write-ahead choke point", () => {
  test("the journal event lands first with the full record, actor attribution, and no item ref", async () => {
    const { layout, env, ctx } = await setup();
    const node = makeNode(env, { epic: "0gz8r4cm" });

    const { event } = await mutate(ctx, {
      target: "roadmap-node",
      eventType: CORE_EVENT_TYPES.roadmapNodeCreated,
      frontmatter: node,
      body: "Move state out of the app repo.\n",
    });

    expect(event.type).toBe("roadmap.node-created");
    expect(event.actor).toEqual({ kind: "agent", id: "claude-code" });
    expect(event.payload).toEqual({
      target: "roadmap-node",
      record: node,
      body: "Move state out of the app repo.\n",
    });
    // The node's epic ref is a RECORD field, never the event's item ref: the
    // relationship is stored one way, on the node, and nothing about it
    // reaches the work item — not even as an event reference.
    expect(event.item).toBeUndefined();
    expect(event.run).toBeUndefined();

    const events = await Array.fromAsync(readJournal(layout));
    expect(events.map((e) => e.type)).toEqual(["roadmap.node-created"]);
    expect((await readRoadmapNode(layout, node.id)).frontmatter).toEqual(node);
  });

  test("an update journals its own event carrying the post-mutation record", async () => {
    const { layout, env, ctx } = await setup();
    const node = makeNode(env);
    await mutate(ctx, {
      target: "roadmap-node",
      eventType: CORE_EVENT_TYPES.roadmapNodeCreated,
      frontmatter: node,
      body: "intent\n",
    });
    const rehorizoned = { ...node, horizon: "later" as const, updated: env.now() };
    await mutate(ctx, {
      target: "roadmap-node",
      eventType: CORE_EVENT_TYPES.roadmapNodeUpdated,
      frontmatter: rehorizoned,
      body: "intent\n",
    });

    const events = await Array.fromAsync(readJournal(layout));
    expect(events.map((e) => e.type)).toEqual(["roadmap.node-created", "roadmap.node-updated"]);
    expect(events[1]!.payload["record"]).toEqual(rehorizoned);
    expect((await readRoadmapNode(layout, node.id)).frontmatter.horizon).toBe("later");
  });

  test("DIRECTION: linking a node to a work item leaves every item record byte-identical", async () => {
    const { layout, env, ctx } = await setup();
    const epic = makeFrontmatter(env, { name: "detached-state-repo" });
    await mutate(ctx, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemCreated,
      frontmatter: epic,
      body: "the epic\n",
    });
    const before = await itemBytes(layout);

    const node = makeNode(env, { epic: epic.id });
    await mutate(ctx, {
      target: "roadmap-node",
      eventType: CORE_EVENT_TYPES.roadmapNodeCreated,
      frontmatter: node,
      body: "intent\n",
    });
    await mutate(ctx, {
      target: "roadmap-node",
      eventType: CORE_EVENT_TYPES.roadmapNodeUpdated,
      frontmatter: { ...node, horizon: "next", updated: env.now() },
      body: "intent\n",
    });

    // Not "equivalent" — byte-identical. A run that touched an item record
    // fails this criterion (F1's canonical one-way direction).
    expect(await itemBytes(layout)).toEqual(before);
    expect((await readItem(layout, epic.id)).frontmatter).toEqual(epic);
  });

  test("a claim on the epic item does NOT freeze its roadmap node — claims cover items, not intent", async () => {
    const { layout, env, ctx } = await setup();
    const epic = makeFrontmatter(env, { claimed_by: "jim" });
    await writeRoadmapNode(layout, makeNode(env, { id: "aaaaaaaa" }), "seed\n");
    await mutate(ctx, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemCreated,
      frontmatter: { ...epic, claimed_by: undefined },
      body: "",
    });
    // Claim it as the human, then act as the agent on the node covering it.
    const human = await createStoreContext(ctx.layout.root, env, { actorOverride: "human:jim" });
    await mutate(human, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemClaimed,
      frontmatter: epic,
      body: "",
    });

    const node = makeNode(env, { id: "bbbbbbbb", name: "claimed-epic-node", epic: epic.id });
    await mutate(ctx, {
      target: "roadmap-node",
      eventType: CORE_EVENT_TYPES.roadmapNodeCreated,
      frontmatter: node,
      body: "intent\n",
    });
    expect((await readRoadmapNode(layout, node.id)).frontmatter.epic).toBe(epic.id);
  });

  test("replayPending heals a node whose record write died after its event landed", async () => {
    const { layout, env, ctx } = await setup();
    const node = makeNode(env);
    await rename(layout.roadmapDir, `${layout.roadmapDir}.parked`).catch(() => undefined);
    await writeFile(layout.roadmapDir, "not a directory");
    expect(
      mutate(ctx, {
        target: "roadmap-node",
        eventType: CORE_EVENT_TYPES.roadmapNodeCreated,
        frontmatter: node,
        body: "intent\n",
      }),
    ).rejects.toThrow();
    await rm(layout.roadmapDir);

    // The journal is ahead; repair materializes exactly what it already records.
    const repaired = await replayPending(layout);
    expect(repaired).toEqual([
      { target: "roadmap-node", id: node.id, eventId: (await Array.fromAsync(readJournal(layout)))[0]!.id },
    ]);
    const read = await readRoadmapNode(layout, node.id);
    expect(read.frontmatter).toEqual(node);
    expect(read.body).toBe("intent\n");
    // Idempotent: a second repair over an in-sync store changes nothing.
    expect(await replayPending(layout)).toEqual([]);
  });
});

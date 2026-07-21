import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { CORE_EVENT_TYPES } from "../../src/schema/events";
import type { WorkItemFrontmatter } from "../../src/schema/records";
import { newSessionSegmentId, runSegmentPath, sessionSegmentPath } from "../../src/store/journal";
import {
  ensureLayout,
  observationPath,
  readItem,
  readObservation,
  readRun,
  writeConfig,
  writeItem,
} from "../../src/store/layout";
import {
  ClaimViolationError,
  createStoreContext,
  mutate,
  replayPending,
  type StoreContext,
} from "../../src/store/mutate";
import {
  makeConfig,
  makeFrontmatter,
  makeObservation,
  makeRun,
  makeTempDir,
  seededEnv,
} from "./helpers";

let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

async function setup(options: { actorOverride?: string } = {}) {
  const root = await makeTempDir();
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig());
  const env = seededEnv({ tickSeconds: 1 });
  const ctx = await createStoreContext(root, env, options);
  return { root, layout, env, ctx };
}

describe("createStoreContext", () => {
  test("resolves the actor from the config actor entry", async () => {
    const { ctx } = await setup();
    expect(ctx.actor).toEqual({ kind: "agent", id: "claude-code" });
  });

  test("the NAHEL_ACTOR override value wins over config", async () => {
    const { ctx } = await setup({ actorOverride: "human:jim" });
    expect(ctx.actor).toEqual({ kind: "human", id: "jim" });
  });

  test("mints a writer-scoped session segment id for the context", async () => {
    const { ctx } = await setup();
    expect(ctx.session).toMatch(/^[0-9a-z]{8}$/);
  });

  test("accepts an explicit session id (one session across many CLI calls)", async () => {
    const root = await makeTempDir();
    dirs.push(root);
    const layout = await ensureLayout(root);
    await writeConfig(layout, makeConfig());
    const env = seededEnv();
    const session = newSessionSegmentId(env);
    const ctx = await createStoreContext(root, env, { session });
    expect(ctx.session).toBe(session);
  });
});

describe("mutate — write-ahead journaling", () => {
  test("an item mutation appends the event to the session segment, then writes the record", async () => {
    const { layout, env, ctx } = await setup();
    const frontmatter = makeFrontmatter(env);
    const { event } = await mutate(ctx, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemCreated,
      frontmatter,
      body: "# The item\n",
    });

    // Event: right segment, right refs, full mutation payload.
    const raw = await readFile(sessionSegmentPath(layout, ctx.session), "utf8");
    expect(JSON.parse(raw.trim())).toEqual(event);
    expect(event.type).toBe("item.created");
    expect(event.item).toBe(frontmatter.id);
    expect(event.run).toBeUndefined();
    expect(event.payload).toEqual({
      target: "item",
      record: frontmatter,
      body: "# The item\n",
    });

    // Record materialized.
    const record = await readItem(layout, frontmatter.id);
    expect(record.frontmatter).toEqual(frontmatter);
    expect(record.body).toBe("# The item\n");
  });

  test("a run mutation appends the event to the run's own segment", async () => {
    const { layout, env, ctx } = await setup();
    const item = makeFrontmatter(env);
    await mutate(ctx, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemCreated,
      frontmatter: item,
      body: "",
    });
    const run = makeRun(env, item.id);
    const { event } = await mutate(ctx, {
      target: "run",
      eventType: CORE_EVENT_TYPES.runStarted,
      run,
    });

    const raw = await readFile(runSegmentPath(layout, run.id), "utf8");
    expect(JSON.parse(raw.trim())).toEqual(event);
    expect(event.run).toBe(run.id);
    expect(event.item).toBe(item.id);
    expect(event.payload).toEqual({ target: "run", record: run });
    expect(await readRun(layout, run.id)).toEqual(run);
  });

  test("mutation events carry the full mutation payload (replay needs no other source)", async () => {
    const { env, ctx } = await setup();
    const frontmatter = makeFrontmatter(env);
    const { event } = await mutate(ctx, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemCreated,
      frontmatter,
      body: "complete body\n",
    });
    const payload = event.payload as { record: WorkItemFrontmatter; body: string };
    expect(payload.record).toEqual(frontmatter);
    expect(payload.body).toBe("complete body\n");
  });

  test("an invalid record is refused before anything touches disk — no event, no record", async () => {
    const { layout, env, ctx } = await setup();
    const bad = { ...makeFrontmatter(env), status: "nonsense" };
    expect(
      // @ts-expect-error deliberately invalid status
      mutate(ctx, { target: "item", eventType: "item.created", frontmatter: bad, body: "" }),
    ).rejects.toThrow();
    expect(
      readFile(sessionSegmentPath(layout, ctx.session), "utf8"),
    ).rejects.toThrow();
  });
});

describe("mutate — claim enforcement (cooperative guardrail, PRD F9)", () => {
  /** Tree: root (claimed by jim) → child → grandchild; sibling unclaimed. */
  async function claimedTree(ctx: StoreContext, env: ReturnType<typeof seededEnv>) {
    const root = makeFrontmatter(env, { name: "root-epic", claimed_by: "jim" });
    const child = makeFrontmatter(env, { name: "child", parent: root.id });
    const grandchild = makeFrontmatter(env, { name: "grandchild", parent: child.id });
    const sibling = makeFrontmatter(env, { name: "sibling" });
    for (const frontmatter of [root, child, grandchild, sibling]) {
      await writeItem(ctx.layout, frontmatter, "");
    }
    return { root, child, grandchild, sibling };
  }

  test("refuses an agent mutation on a directly claimed item, naming the claim holder", async () => {
    const { env, ctx } = await setup();
    const { root } = await claimedTree(ctx, env);
    const attempt = mutate(ctx, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemUpdated,
      frontmatter: { ...root, status: "in-progress", claimed_by: "jim" },
      body: "",
    });
    expect(attempt).rejects.toThrow(ClaimViolationError);
    expect(attempt).rejects.toThrow(/jim/);
    expect(attempt).rejects.toThrow(root.id);
  });

  test("refuses an agent mutation on a descendant of a claimed ancestor (subtree coverage)", async () => {
    const { env, ctx } = await setup();
    const { root, grandchild } = await claimedTree(ctx, env);
    const attempt = mutate(ctx, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemUpdated,
      frontmatter: { ...grandchild, status: "in-progress" },
      body: "",
    });
    expect(attempt).rejects.toThrow(ClaimViolationError);
    expect(attempt).rejects.toThrow(root.id);
  });

  test("the claim check reads the disk record — an incoming frontmatter that drops claimed_by cannot bypass it", async () => {
    const { env, ctx } = await setup();
    const { root } = await claimedTree(ctx, env);
    const { claimed_by: _dropped, ...withoutClaim } = root;
    const attempt = mutate(ctx, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemUpdated,
      frontmatter: { ...withoutClaim, status: "done" },
      body: "",
    });
    expect(attempt).rejects.toThrow(ClaimViolationError);
  });

  test("refuses an agent --parent move of an unclaimed item INTO a claimed subtree, writing nothing", async () => {
    const { layout, env, ctx } = await setup();
    const { root, child, sibling } = await claimedTree(ctx, env);
    // sibling is unclaimed and outside the claimed subtree; the mutation
    // re-parents it under `child` — whose ancestor `root` is claimed. The
    // check must evaluate the POST-mutation chain, not just the on-disk one.
    const attempt = mutate(ctx, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemUpdated,
      frontmatter: { ...sibling, parent: child.id },
      body: "",
    });
    await expect(attempt).rejects.toThrow(ClaimViolationError);
    await expect(attempt).rejects.toThrow(root.id);
    // Refusal writes nothing: record unchanged, no journal event.
    expect((await readItem(layout, sibling.id)).frontmatter.parent).toBeUndefined();
    await expect(
      readFile(sessionSegmentPath(layout, ctx.session), "utf8"),
    ).rejects.toThrow();
  });

  test("refuses an agent run mutation whose run touches a covered item", async () => {
    const { env, ctx } = await setup();
    const { grandchild } = await claimedTree(ctx, env);
    const attempt = mutate(ctx, {
      target: "run",
      eventType: CORE_EVENT_TYPES.runStarted,
      run: makeRun(env, grandchild.id),
    });
    expect(attempt).rejects.toThrow(ClaimViolationError);
  });

  test("refuses creating a new agent item under a claimed ancestor", async () => {
    const { env, ctx } = await setup();
    const { child } = await claimedTree(ctx, env);
    const attempt = mutate(ctx, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemCreated,
      frontmatter: makeFrontmatter(env, { name: "new-under-claim", parent: child.id }),
      body: "",
    });
    expect(attempt).rejects.toThrow(ClaimViolationError);
  });

  test("allows agent mutations on unclaimed items outside the claimed subtree", async () => {
    const { layout, env, ctx } = await setup();
    const { sibling } = await claimedTree(ctx, env);
    await mutate(ctx, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemUpdated,
      frontmatter: { ...sibling, status: "in-progress" },
      body: "",
    });
    expect((await readItem(layout, sibling.id)).frontmatter.status).toBe("in-progress");
  });

  test("human actors are never refused — claim blocks agents, not the human who claimed", async () => {
    const { root: repoRoot, env, ctx } = await setup();
    const { root } = await claimedTree(ctx, env);
    const human = await createStoreContext(repoRoot, env, { actorOverride: "human:jim" });
    await mutate(human, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemUpdated,
      frontmatter: { ...root, status: "in-progress" },
      body: "",
    });
    expect((await readItem(ctx.layout, root.id)).frontmatter.status).toBe("in-progress");
  });

  test("a refused mutation writes nothing: no journal event, no record change", async () => {
    const { layout, env, ctx } = await setup();
    const { root } = await claimedTree(ctx, env);
    expect(
      mutate(ctx, {
        target: "item",
        eventType: CORE_EVENT_TYPES.itemUpdated,
        frontmatter: { ...root, status: "done" },
        body: "",
      }),
    ).rejects.toThrow(ClaimViolationError);
    expect((await readItem(layout, root.id)).frontmatter.status).toBe("backlog");
    expect(
      readFile(sessionSegmentPath(layout, ctx.session), "utf8"),
    ).rejects.toThrow();
  });
});

describe("mutate — observation mutations (PRD F6)", () => {
  test("an observation mutation appends observation.created to the session segment, then writes the record", async () => {
    const { layout, env, ctx } = await setup();
    // Provenance: a real journaled event to cite.
    const item = makeFrontmatter(env);
    const { event: source } = await mutate(ctx, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemCreated,
      frontmatter: item,
      body: "",
    });

    const frontmatter = makeObservation(env, [source.id]);
    const { event } = await mutate(ctx, {
      target: "observation",
      eventType: CORE_EVENT_TYPES.observationCreated,
      frontmatter,
      body: "The distilled fact.\n",
    });

    // Event: session segment (observations ref no run), full mutation payload,
    // no item/run refs — provenance lives in the record's sources.
    const raw = await readFile(sessionSegmentPath(layout, ctx.session), "utf8");
    const lines = raw.trim().split("\n");
    expect(JSON.parse(lines[lines.length - 1]!)).toEqual(event);
    expect(event.type).toBe("observation.created");
    expect(event.item).toBeUndefined();
    expect(event.run).toBeUndefined();
    expect(event.payload).toEqual({
      target: "observation",
      record: frontmatter,
      body: "The distilled fact.\n",
    });

    // Record materialized.
    const record = await readObservation(layout, frontmatter.id);
    expect(record.frontmatter).toEqual(frontmatter);
    expect(record.body).toBe("The distilled fact.\n");
  });

  test("an invalid observation is refused before anything touches disk", async () => {
    const { layout, env, ctx } = await setup();
    const bad = { ...makeObservation(env, []), sources: ["not an id"] };
    expect(
      mutate(ctx, {
        target: "observation",
        eventType: CORE_EVENT_TYPES.observationCreated,
        frontmatter: bad,
        body: "",
      }),
    ).rejects.toThrow();
    expect(readFile(sessionSegmentPath(layout, ctx.session), "utf8")).rejects.toThrow();
  });

  test("claims never block observations — an agent distills while items are claimed", async () => {
    const { layout, env, ctx } = await setup();
    const claimed = makeFrontmatter(env, { name: "claimed-item", claimed_by: "jim" });
    await writeItem(ctx.layout, claimed, "");

    const frontmatter = makeObservation(env, []);
    await mutate(ctx, {
      target: "observation",
      eventType: CORE_EVENT_TYPES.observationCreated,
      frontmatter,
      body: "a fact\n",
    });
    expect((await readObservation(layout, frontmatter.id)).body).toBe("a fact\n");
  });

  test("replayPending materializes an observation the write-ahead crash window lost", async () => {
    const { layout, env, ctx } = await setup();
    const frontmatter = makeObservation(env, []);
    await mutate(ctx, {
      target: "observation",
      eventType: CORE_EVENT_TYPES.observationCreated,
      frontmatter,
      body: "the fact the crash lost\n",
    });
    // Simulate the crash window: the journal is ahead, the record is gone.
    await rm(observationPath(layout, frontmatter.id));

    const repaired = await replayPending(layout);
    expect(repaired).toEqual([
      { target: "observation", id: frontmatter.id, eventId: expect.any(String) },
    ]);
    const record = await readObservation(layout, frontmatter.id);
    expect(record.frontmatter).toEqual(frontmatter);
    expect(record.body).toBe("the fact the crash lost\n");

    // Idempotent: a healed store replays nothing.
    expect(await replayPending(layout)).toEqual([]);
  });
});

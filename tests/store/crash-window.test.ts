import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { CORE_EVENT_TYPES } from "../../src/schema/events";
import { readJournal, sessionSegmentPath } from "../../src/store/journal";
import { ensureLayout, itemExists, readItem, readRun, writeConfig } from "../../src/store/layout";
import { createStoreContext, mutate, replayPending } from "../../src/store/mutate";
import { makeConfig, makeFrontmatter, makeRun, makeTempDir, seededEnv } from "./helpers";

let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

async function setup() {
  const root = await makeTempDir();
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig());
  const env = seededEnv({ tickSeconds: 1 });
  const ctx = await createStoreContext(root, env);
  return { root, layout, env, ctx };
}

/**
 * Make the NEXT record write fail by replacing nahel/items with a plain file,
 * killing the process exactly in the crash window between the two fs ops of a
 * mutation: after the journal append, before the record write.
 */
async function sabotageItemWrites(itemsDir: string): Promise<void> {
  await rename(itemsDir, `${itemsDir}.parked`);
  await writeFile(itemsDir, "not a directory");
}

async function healItemWrites(itemsDir: string): Promise<void> {
  await rm(itemsDir);
  await rename(`${itemsDir}.parked`, itemsDir);
}

describe("mutation consistency — the write-ahead crash window", () => {
  test("when the record write dies, the journal is already ahead: event present, record unchanged — never an unjournaled record change", async () => {
    const { layout, env, ctx } = await setup();
    const v1 = makeFrontmatter(env);
    await mutate(ctx, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemCreated,
      frontmatter: v1,
      body: "version one\n",
    });

    await sabotageItemWrites(layout.itemsDir);
    const v2 = { ...v1, status: "in-progress" as const, updated: env.now() };
    expect(
      mutate(ctx, {
        target: "item",
        eventType: CORE_EVENT_TYPES.itemUpdated,
        frontmatter: v2,
        body: "version two\n",
      }),
    ).rejects.toThrow();
    await healItemWrites(layout.itemsDir);

    // Journal ahead: both events on disk, update event carries the full v2.
    const events = await Array.fromAsync(readJournal(layout));
    expect(events.map((e) => e.type)).toEqual(["item.created", "item.updated"]);
    expect(events[1]!.payload).toEqual({ target: "item", record: v2, body: "version two\n" });

    // Record behind: still v1 — the crash window can under-materialize, never lie.
    const record = await readItem(layout, v1.id);
    expect(record.frontmatter).toEqual(v1);
    expect(record.body).toBe("version one\n");
  });

  test("replayPending() heals a journal-ahead record deterministically from the event payload", async () => {
    const { layout, env, ctx } = await setup();
    const v1 = makeFrontmatter(env);
    await mutate(ctx, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemCreated,
      frontmatter: v1,
      body: "version one\n",
    });

    await sabotageItemWrites(layout.itemsDir);
    const v2 = { ...v1, status: "in-progress" as const, updated: env.now() };
    expect(
      mutate(ctx, {
        target: "item",
        eventType: CORE_EVENT_TYPES.itemUpdated,
        frontmatter: v2,
        body: "version two\n",
      }),
    ).rejects.toThrow();
    await healItemWrites(layout.itemsDir);

    const repaired = await replayPending(layout);
    expect(repaired).toEqual([
      { target: "item", id: v1.id, eventId: (await Array.fromAsync(readJournal(layout)))[1]!.id },
    ]);
    const record = await readItem(layout, v1.id);
    expect(record.frontmatter).toEqual(v2);
    expect(record.body).toBe("version two\n");
  });

  test("replayPending() materializes a record that was never written at all (crash on create)", async () => {
    const { layout, env, ctx } = await setup();
    await sabotageItemWrites(layout.itemsDir);
    const v1 = makeFrontmatter(env);
    expect(
      mutate(ctx, {
        target: "item",
        eventType: CORE_EVENT_TYPES.itemCreated,
        frontmatter: v1,
        body: "born in the journal\n",
      }),
    ).rejects.toThrow();
    await healItemWrites(layout.itemsDir);

    expect(await itemExists(layout, v1.id)).toBe(false);
    await replayPending(layout);
    const record = await readItem(layout, v1.id);
    expect(record.frontmatter).toEqual(v1);
    expect(record.body).toBe("born in the journal\n");
  });

  test("replayPending() heals run records too, from the run mutation payload", async () => {
    const { layout, env, ctx } = await setup();
    const item = makeFrontmatter(env);
    await mutate(ctx, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemCreated,
      frontmatter: item,
      body: "",
    });
    const run = makeRun(env, item.id);
    await mutate(ctx, { target: "run", eventType: CORE_EVENT_TYPES.runStarted, run });

    // Crash window on run end: journal the end, lose the record write.
    await rename(layout.runsDir, `${layout.runsDir}.parked`);
    await writeFile(layout.runsDir, "not a directory");
    const ended = { ...run, status: "ended" as const, ended: env.now() };
    expect(
      mutate(ctx, { target: "run", eventType: CORE_EVENT_TYPES.runEnded, run: ended }),
    ).rejects.toThrow();
    await rm(layout.runsDir);
    await rename(`${layout.runsDir}.parked`, layout.runsDir);

    expect((await readRun(layout, run.id)).status).toBe("active");
    const repaired = await replayPending(layout);
    expect(repaired.map((r) => `${r.target}:${r.id}`)).toEqual([`run:${run.id}`]);
    expect(await readRun(layout, run.id)).toEqual(ended);
  });

  test("replayPending() applies the LATEST mutation event in total order when several are pending", async () => {
    const { layout, env, ctx } = await setup();
    const v1 = makeFrontmatter(env);
    await sabotageItemWrites(layout.itemsDir);
    for (const status of ["backlog", "in-progress", "done"] as const) {
      expect(
        mutate(ctx, {
          target: "item",
          eventType: CORE_EVENT_TYPES.itemUpdated,
          frontmatter: { ...v1, status, updated: env.now() },
          body: `at ${status}\n`,
        }),
      ).rejects.toThrow();
    }
    await healItemWrites(layout.itemsDir);

    await replayPending(layout);
    const record = await readItem(layout, v1.id);
    expect(record.frontmatter.status).toBe("done");
    expect(record.body).toBe("at done\n");
  });

  test("replayPending() is idempotent: a healed store reports nothing to repair", async () => {
    const { layout, env, ctx } = await setup();
    const item = makeFrontmatter(env);
    await mutate(ctx, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemCreated,
      frontmatter: item,
      body: "steady state\n",
    });
    expect(await replayPending(layout)).toEqual([]);
    // Non-mutation events (plain notes) never trigger repairs.
    const before = await readItem(layout, item.id);
    const { appendEvent } = await import("../../src/store/journal");
    await appendEvent(layout, env, {
      type: "note",
      actor: ctx.actor,
      item: item.id,
      payload: { text: "just an observation" },
      session: ctx.session,
    });
    expect(await replayPending(layout)).toEqual([]);
    expect(await readItem(layout, item.id)).toEqual(before);
  });

  test("replayPending() never journals: repairs only materialize what the journal already records", async () => {
    const { layout, env, ctx } = await setup();
    await sabotageItemWrites(layout.itemsDir);
    const v1 = makeFrontmatter(env);
    expect(
      mutate(ctx, {
        target: "item",
        eventType: CORE_EVENT_TYPES.itemCreated,
        frontmatter: v1,
        body: "",
      }),
    ).rejects.toThrow();
    await healItemWrites(layout.itemsDir);

    const eventsBefore = (await Array.fromAsync(readJournal(layout))).length;
    await replayPending(layout);
    const eventsAfter = (await Array.fromAsync(readJournal(layout))).length;
    expect(eventsAfter).toBe(eventsBefore);
    // The session segment holds exactly the one crash-window event.
    const raw = await readFile(sessionSegmentPath(layout, ctx.session), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
  });
});

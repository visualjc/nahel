import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { CORE_EVENT_TYPES } from "../../src/schema/events";
import { readJournal } from "../../src/store/journal";
import {
  ensureLayout,
  listItems,
  listRuns,
  readItem,
  storeLayout,
  writeConfig,
} from "../../src/store/layout";
import { createStoreContext, mutate, replayPending } from "../../src/store/mutate";
import { makeConfig, makeFrontmatter, makeRun, makeTempDir, seededEnv } from "./helpers";

let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

/** Drive a full item + run lifecycle plus a logged note inside one worktree. */
async function driveWork(root: string, seed: number, agentId: string) {
  const env = seededEnv({ seed, tickSeconds: 1 });
  // Empty directories don't travel through git; recreate them (idempotent),
  // exactly as any CLI invocation in a fresh worktree would.
  await ensureLayout(root);
  const ctx = await createStoreContext(root, env, { actorOverride: `agent:${agentId}` });
  const item = makeFrontmatter(env, { name: `${agentId}-item` });
  await mutate(ctx, {
    target: "item",
    eventType: CORE_EVENT_TYPES.itemCreated,
    frontmatter: item,
    body: `# Work by ${agentId}\n`,
  });
  const run = makeRun(env, item.id, { actor: ctx.actor });
  await mutate(ctx, { target: "run", eventType: CORE_EVENT_TYPES.runStarted, run });
  const { appendEvent } = await import("../../src/store/journal");
  await appendEvent(ctx.layout, env, {
    type: "note",
    actor: ctx.actor,
    item: item.id,
    payload: { text: `observation from ${agentId}` },
    session: ctx.session,
  });
  await mutate(ctx, {
    target: "item",
    eventType: CORE_EVENT_TYPES.itemUpdated,
    frontmatter: { ...item, status: "in-progress", updated: env.now() },
    body: `# Work by ${agentId}\n`,
  });
  await mutate(ctx, {
    target: "run",
    eventType: CORE_EVENT_TYPES.runEnded,
    run: { ...run, status: "ended", ended: env.now() },
  });
  return { item: item.id, run: run.id };
}

describe("merge-safety proof at store level (ADR-0012, PRD success criterion 8)", () => {
  test(
    "two real git worktrees mutate and log in parallel; the merge produces zero conflicts and one coherent store",
    async () => {
      const root = await makeTempDir("nahel-merge-");
      dirs.push(root);

      // Founding commit on main: the nahel/ layout and config.
      git(root, "init", "--initial-branch=main");
      git(root, "config", "user.email", "test@nahel.test");
      git(root, "config", "user.name", "Nahel Test");
      const layout = await ensureLayout(root);
      await writeConfig(layout, makeConfig());
      // .gitkeep-style placeholders so empty dirs commit; real repos get these from init.
      git(root, "add", "-A");
      git(root, "commit", "-m", "founding: nahel layout");

      // Two parallel worktrees, as the AFK execution model runs them.
      const wtA = join(root, "..", `${root.split("/").pop()}-wt-a`);
      const wtB = join(root, "..", `${root.split("/").pop()}-wt-b`);
      dirs.push(wtA, wtB);
      git(root, "worktree", "add", wtA, "-b", "agent-a");
      git(root, "worktree", "add", wtB, "-b", "agent-b");

      // Both agents drive full lifecycles in parallel (distinct seeds → distinct ids).
      const [workA, workB] = await Promise.all([
        driveWork(wtA, 1001, "agent-a"),
        driveWork(wtB, 2002, "agent-b"),
      ]);
      expect(workA.item).not.toBe(workB.item);
      git(wtA, "add", "-A");
      git(wtA, "commit", "-m", "agent-a: item + run lifecycle");
      git(wtB, "add", "-A");
      git(wtB, "commit", "-m", "agent-b: item + run lifecycle");

      // Merge both branches into main: zero conflicts, by construction.
      git(root, "merge", "--no-edit", "agent-a");
      const mergeB = spawnSync("git", ["merge", "--no-edit", "agent-b"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(mergeB.status).toBe(0);
      expect(mergeB.stdout + mergeB.stderr).not.toContain("CONFLICT");
      expect(git(root, "status", "--porcelain").trim()).toBe("");

      // The merged store is coherent: both items, both runs, all events, in
      // one deterministic total order, and nothing left journal-ahead.
      const merged = storeLayout(root);
      expect((await listItems(merged)).sort()).toEqual([workA.item, workB.item].sort());
      expect((await listRuns(merged)).sort()).toEqual([workA.run, workB.run].sort());
      expect((await readItem(merged, workA.item)).frontmatter.status).toBe("in-progress");
      expect((await readItem(merged, workB.item)).frontmatter.status).toBe("in-progress");

      const events = await Array.fromAsync(readJournal(merged));
      // 5 events per agent: created, run.started, note, updated, run.ended.
      expect(events).toHaveLength(10);
      expect(new Set(events.map((e) => e.id)).size).toBe(10);
      const byActor = Map.groupBy(events, (e) => e.actor.id);
      expect(byActor.get("agent-a")).toHaveLength(5);
      expect(byActor.get("agent-b")).toHaveLength(5);

      expect(await replayPending(merged)).toEqual([]);
    },
    { timeout: 60_000 },
  );
});

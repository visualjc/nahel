import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  appendEvent,
  closeSession,
  listSegments,
  newSessionSegmentId,
  readJournal,
  runSegmentPath,
} from "../../src/store/journal";
import { ensureLayout, writeRun, type StoreLayout } from "../../src/store/layout";
import { rotateJournal } from "../../src/store/rotate";
import { makeFrontmatter, makeRun, makeTempDir, seededEnv } from "./helpers";

const actor = { kind: "agent", id: "claude-code" } as const;

let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

async function setup(): Promise<StoreLayout> {
  const root = await makeTempDir();
  dirs.push(root);
  return ensureLayout(root);
}

describe("rotateJournal — closed segments only", () => {
  test("archives the segment of an ended run", async () => {
    const layout = await setup();
    const env = seededEnv({ tickSeconds: 1 });
    const run = makeRun(env, makeFrontmatter(env).id, { status: "ended", ended: env.now() });
    await writeRun(layout, run);
    await appendEvent(layout, env, { type: "run.ended", actor, run: run.id, payload: {} });

    const result = await rotateJournal(layout);
    expect(result.archived).toEqual([`run-${run.id}.jsonl`]);
    const segments = await listSegments(layout);
    expect(segments.active).toEqual([]);
    expect(segments.archived).toEqual([`run-${run.id}.jsonl`]);
  });

  test("never touches the segment of an active run", async () => {
    const layout = await setup();
    const env = seededEnv({ tickSeconds: 1 });
    const run = makeRun(env, makeFrontmatter(env).id, { status: "active" });
    await writeRun(layout, run);
    await appendEvent(layout, env, { type: "run.started", actor, run: run.id, payload: {} });
    const before = await readFile(runSegmentPath(layout, run.id), "utf8");

    const result = await rotateJournal(layout);
    expect(result.archived).toEqual([]);
    expect(await readFile(runSegmentPath(layout, run.id), "utf8")).toBe(before);
  });

  test("never touches the segment of a paused run — paused is not closed", async () => {
    const layout = await setup();
    const env = seededEnv({ tickSeconds: 1 });
    const run = makeRun(env, makeFrontmatter(env).id, { status: "paused" });
    await writeRun(layout, run);
    await appendEvent(layout, env, { type: "run.paused", actor, run: run.id, payload: {} });

    const result = await rotateJournal(layout);
    expect(result.archived).toEqual([]);
    expect((await listSegments(layout)).active).toEqual([`run-${run.id}.jsonl`]);
  });

  test("leaves a run segment alone when the run record is missing (cannot prove it closed)", async () => {
    const layout = await setup();
    const env = seededEnv({ tickSeconds: 1 });
    await appendEvent(layout, env, { type: "run.started", actor, run: "aaaaaaaa", payload: {} });

    const result = await rotateJournal(layout);
    expect(result.archived).toEqual([]);
    expect((await listSegments(layout)).active).toEqual(["run-aaaaaaaa.jsonl"]);
  });

  test("archives a session segment closed via closeSession", async () => {
    const layout = await setup();
    const env = seededEnv({ tickSeconds: 1 });
    const session = newSessionSegmentId(env);
    await appendEvent(layout, env, { type: "note", actor, payload: {}, session });
    await closeSession(layout, env, actor, session);

    const result = await rotateJournal(layout);
    expect(result.archived).toEqual([`session-${session}.jsonl`]);
    expect((await listSegments(layout)).archived).toEqual([`session-${session}.jsonl`]);
  });

  test("never touches an open session segment", async () => {
    const layout = await setup();
    const env = seededEnv({ tickSeconds: 1 });
    const session = newSessionSegmentId(env);
    await appendEvent(layout, env, { type: "note", actor, payload: {}, session });

    const result = await rotateJournal(layout);
    expect(result.archived).toEqual([]);
    expect((await listSegments(layout)).active).toEqual([`session-${session}.jsonl`]);
  });

  test("mixed journal: archives exactly the closed segments, in one pass", async () => {
    const layout = await setup();
    const env = seededEnv({ tickSeconds: 1 });
    const item = makeFrontmatter(env).id;
    const endedRun = makeRun(env, item, { status: "ended", ended: env.now() });
    const activeRun = makeRun(env, item, { status: "active" });
    await writeRun(layout, endedRun);
    await writeRun(layout, activeRun);
    await appendEvent(layout, env, { type: "run.ended", actor, run: endedRun.id, payload: {} });
    await appendEvent(layout, env, { type: "run.started", actor, run: activeRun.id, payload: {} });
    const closedSession = newSessionSegmentId(env);
    const openSession = newSessionSegmentId(env);
    await appendEvent(layout, env, { type: "note", actor, payload: {}, session: closedSession });
    await closeSession(layout, env, actor, closedSession);
    await appendEvent(layout, env, { type: "note", actor, payload: {}, session: openSession });

    const result = await rotateJournal(layout);
    expect(result.archived.sort()).toEqual(
      [`run-${endedRun.id}.jsonl`, `session-${closedSession}.jsonl`].sort(),
    );
    const segments = await listSegments(layout);
    expect(segments.active.sort()).toEqual(
      [`run-${activeRun.id}.jsonl`, `session-${openSession}.jsonl`].sort(),
    );
  });

  test("rotation preserves every event and its id: the merged read is identical before and after", async () => {
    const layout = await setup();
    const env = seededEnv({ tickSeconds: 1 });
    const run = makeRun(env, makeFrontmatter(env).id, { status: "ended", ended: env.now() });
    await writeRun(layout, run);
    for (let i = 0; i < 5; i++) {
      await appendEvent(layout, env, { type: "note", actor, run: run.id, payload: { i } });
    }
    const before = await Array.fromAsync(readJournal(layout));
    await rotateJournal(layout);
    const after = await Array.fromAsync(readJournal(layout));
    expect(after).toEqual(before);
  });

  test("an archive-name collision NEVER clobbers: the newcomer gets a numbered name (7nzsz577)", async () => {
    // The speed-count-game incident: a run's segment was already archived,
    // new events for the same run recreated a live segment with the same
    // name, and rename() silently overwrote the archived file — history
    // destroyed by the CLI's own rotation (HC6). Both segments are history;
    // the later arrival must take a uniquified name, the original untouched.
    const layout = await setup();
    const env = seededEnv({ tickSeconds: 1 });
    const run = makeRun(env, makeFrontmatter(env).id, { status: "ended", ended: env.now() });
    await writeRun(layout, run);
    await appendEvent(layout, env, { type: "run.ended", actor, run: run.id, payload: {} });
    await rotateJournal(layout);
    const archivedPath = join(layout.journalArchiveDir, `run-${run.id}.jsonl`);
    const original = await readFile(archivedPath, "utf8");

    // New events for the archived run recreate a live segment of the same name.
    await appendEvent(layout, env, { type: "note", actor, run: run.id, payload: { late: 1 } });
    const result = await rotateJournal(layout);
    console.log("[collision]", result);
    expect(result.archived).toEqual([`run-${run.id}.2.jsonl`]);
    expect(await readFile(archivedPath, "utf8")).toBe(original);

    // And again: the suffix keeps counting, nothing is ever lost.
    await appendEvent(layout, env, { type: "note", actor, run: run.id, payload: { late: 2 } });
    expect((await rotateJournal(layout)).archived).toEqual([`run-${run.id}.3.jsonl`]);
    const segments = await listSegments(layout);
    expect(segments.archived.sort()).toEqual([
      `run-${run.id}.2.jsonl`,
      `run-${run.id}.3.jsonl`,
      `run-${run.id}.jsonl`,
    ]);
    // The merged journal still yields every event exactly once.
    const events = await Array.fromAsync(readJournal(layout));
    expect(events.filter((e) => e.type === "run.ended")).toHaveLength(1);
    expect(events.filter((e) => e.type === "note")).toHaveLength(2);
  });

  test("a pre-seeded UNCLAIMED lock is stolen after the grace period — rotation still sweeps (codex round 2)", async () => {
    // Codex's round-2 repro shape: a stale lock dir with no ownership marker
    // (a holder that died before claiming, or a hand-made dir) must not block
    // rotation forever — and only an EMPTY dir can be cleared this way, so a
    // claimed lock is never touched by the grace path.
    const layout = await setup();
    const env = seededEnv({ tickSeconds: 1 });
    const run = makeRun(env, makeFrontmatter(env).id, { status: "ended", ended: env.now() });
    await writeRun(layout, run);
    await appendEvent(layout, env, { type: "run.ended", actor, run: run.id, payload: {} });
    await mkdir(join(layout.journalDir, ".rotate.lock"));

    const result = await rotateJournal(layout);
    console.log("[stale unclaimed lock]", result);
    expect(result.archived).toEqual([`run-${run.id}.jsonl`]);
  }, 15_000);

  test("a lock whose holder is DEAD is stolen by exactly its marker — rotation still sweeps", async () => {
    const layout = await setup();
    const env = seededEnv({ tickSeconds: 1 });
    const run = makeRun(env, makeFrontmatter(env).id, { status: "ended", ended: env.now() });
    await writeRun(layout, run);
    await appendEvent(layout, env, { type: "run.ended", actor, run: run.id, payload: {} });
    // A real dead pid: a child that has already exited and been reaped.
    const { spawn } = await import("node:child_process");
    const child = spawn("true");
    expect(typeof child.pid).toBe("number");
    await new Promise((resolve) => child.once("exit", resolve));
    const lockDir = join(layout.journalDir, ".rotate.lock");
    await mkdir(lockDir);
    await writeFile(join(lockDir, `pid-${child.pid}`), "");

    const result = await rotateJournal(layout);
    console.log("[dead holder]", result);
    expect(result.archived).toEqual([`run-${run.id}.jsonl`]);
  }, 15_000);

  test("rotation is idempotent: a second pass archives nothing", async () => {
    const layout = await setup();
    const env = seededEnv({ tickSeconds: 1 });
    const run = makeRun(env, makeFrontmatter(env).id, { status: "ended", ended: env.now() });
    await writeRun(layout, run);
    await appendEvent(layout, env, { type: "run.ended", actor, run: run.id, payload: {} });
    await rotateJournal(layout);
    expect((await rotateJournal(layout)).archived).toEqual([]);
  });

  test("fresh clone: archives into a missing archive dir (git never materializes empty dirs)", async () => {
    const layout = await setup();
    const env = seededEnv({ tickSeconds: 1 });
    const session = newSessionSegmentId(env);
    await appendEvent(layout, env, { type: "note", actor, payload: {}, session });
    await closeSession(layout, env, actor, session);
    // A clone of a repo whose archive was empty at commit time has no
    // journal/archive directory at all — rotation must still succeed.
    await rm(layout.journalArchiveDir, { recursive: true, force: true });

    const result = await rotateJournal(layout);
    expect(result.archived).toEqual([`session-${session}.jsonl`]);
    expect((await listSegments(layout)).archived).toEqual([`session-${session}.jsonl`]);
  });

  test("ignores files that are not journal segments", async () => {
    const layout = await setup();
    await writeFile(join(layout.journalDir, "README.txt"), "not a segment\n");
    const result = await rotateJournal(layout);
    expect(result.archived).toEqual([]);
    expect(await readFile(join(layout.journalDir, "README.txt"), "utf8")).toBe(
      "not a segment\n",
    );
  });
});

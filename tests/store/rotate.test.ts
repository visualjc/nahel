import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
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

  test("rotation is idempotent: a second pass archives nothing", async () => {
    const layout = await setup();
    const env = seededEnv({ tickSeconds: 1 });
    const run = makeRun(env, makeFrontmatter(env).id, { status: "ended", ended: env.now() });
    await writeRun(layout, run);
    await appendEvent(layout, env, { type: "run.ended", actor, run: run.id, payload: {} });
    await rotateJournal(layout);
    expect((await rotateJournal(layout)).archived).toEqual([]);
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

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claimCommand, handbackCommand, pauseCommand } from "../../src/commands/intervene";
import { itemCommand } from "../../src/commands/item";
import { runCommand } from "../../src/commands/run";
import type { Env } from "../../src/schema/env";
import type { JournalEvent } from "../../src/schema/records";
import { listSegments, SESSION_CLOSED_EVENT_TYPE } from "../../src/store/journal";
import { ensureLayout, writeConfig, type StoreLayout } from "../../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * Mutation-command session lifecycle (PRD F1: rotation/archiving enforced by
 * the CLI). Every mutation command mints a per-invocation writer-scoped
 * session segment; a successful lifecycle must close it (session.closed as
 * the segment's final event) and the opportunistic sweep must archive it —
 * otherwise the random segment id is unrecoverable and the segment stays
 * active forever. Exercised through the REAL command surface, journaling
 * verified by reading the segments back.
 */

const JIM = "human:jim";

let dirs: string[] = [];
let logs: string[] = [];
let errs: string[] = [];
let logSpy: { mockRestore(): void };
let errSpy: { mockRestore(): void };

beforeEach(() => {
  logs = [];
  errs = [];
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.join(" "));
  });
  errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errs.push(args.join(" "));
  });
});

afterEach(async () => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

/** Run a real git command in a repo, returning stdout. */
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

/** Temp dir with a real git repo (one initial commit) and a nahel store. */
async function setup() {
  const root = await makeTempDir("nahel-cmd-session-");
  dirs.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "commit.gpgsign", "false");
  await writeFile(join(root, "app.txt"), "version one\n");
  git(root, "add", "app.txt");
  git(root, "commit", "-q", "-m", "initial");

  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig()); // config actor: agent claude-code
  const env = seededEnv({ tickSeconds: 1 });
  return { root, layout, env };
}

/** All events of one segment file, in file (append) order. */
async function segmentEvents(path: string): Promise<JournalEvent[]> {
  const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.trim() !== "");
  return lines.map((line) => JSON.parse(line) as JournalEvent);
}

/** Session segment filenames, split active/archived, name-sorted. */
async function sessionSegments(
  layout: StoreLayout,
): Promise<{ active: string[]; archived: string[] }> {
  const segments = await listSegments(layout);
  const isSession = (name: string) => name.startsWith("session-");
  return {
    active: segments.active.filter(isSession).sort(),
    archived: segments.archived.filter(isSession).sort(),
  };
}

/**
 * The archived session segment whose first event has `type` — verbose
 * failure when absent so the test names exactly what is missing.
 */
async function archivedSegmentOpening(
  layout: StoreLayout,
  type: string,
): Promise<JournalEvent[]> {
  const { archived } = await sessionSegments(layout);
  for (const name of archived) {
    const events = await segmentEvents(join(layout.journalArchiveDir, name));
    if (events[0]?.type === type) return events;
  }
  throw new Error(
    `no archived session segment opens with ${type} — archived: [${archived.join(", ")}]`,
  );
}

/** Create an item through the command and return its printed id. */
async function newItem(env: Env, root: string, args: string[] = []): Promise<string> {
  const before = logs.length;
  const code = await itemCommand.run(["new", "feature", "test-item", "direct", ...args], env, root);
  expect(code).toBe(0);
  const id = logs[before];
  if (id === undefined) throw new Error("item new printed nothing");
  return id;
}

/** Start a run through the command and return its printed run id. */
async function startRun(env: Env, root: string, itemId: string): Promise<string> {
  const before = logs.length;
  const code = await runCommand.run(["start", itemId], env, root);
  expect(code).toBe(0);
  const id = logs[before];
  if (id === undefined) throw new Error("run start printed nothing");
  return id;
}

describe("mutation commands close and archive their session segment", () => {
  test("item new: segment ends with session.closed and the sweep archives it", async () => {
    const { root, layout, env } = await setup();
    await newItem(env, root);

    const { active, archived } = await sessionSegments(layout);
    expect(active).toEqual([]); // nothing left open for the writer to lose
    expect(archived).toHaveLength(1);

    const events = await segmentEvents(join(layout.journalArchiveDir, archived[0]!));
    expect(events.map((e) => e.type)).toEqual(["item.created", SESSION_CLOSED_EVENT_TYPE]);
    expect(events[1]!.actor).toEqual(events[0]!.actor); // closed by the same writer
  });

  test("item update: its own fresh segment is closed and archived too", async () => {
    const { root, layout, env } = await setup();
    const id = await newItem(env, root);
    const code = await itemCommand.run(["update", id, "--status", "in-progress"], env, root);
    expect(code).toBe(0);

    const { active, archived } = await sessionSegments(layout);
    expect(active).toEqual([]);
    expect(archived).toHaveLength(2); // one per invocation, both swept

    const events = await archivedSegmentOpening(layout, "item.updated");
    expect(events.map((e) => e.type)).toEqual(["item.updated", SESSION_CLOSED_EVENT_TYPE]);
  });

  test("claim (multi-mutation): ONE close after the whole lifecycle; the paused run's segment stays active", async () => {
    const { root, layout, env } = await setup();
    const itemId = await newItem(env, root);
    const runId = await startRun(env, root, itemId);

    const code = await claimCommand.run([itemId], env, root, JIM);
    expect(code).toBe(0);

    // The claim's item.claimed landed in this invocation's session segment;
    // its run.paused consequences landed in the runs' own segments. One
    // session.closed for the invocation, appended after ALL mutations.
    const events = await archivedSegmentOpening(layout, "item.claimed");
    expect(events.map((e) => e.type)).toEqual(["item.claimed", SESSION_CLOSED_EVENT_TYPE]);

    // Run segments close via run end, never via this mechanism: the paused
    // (not ended) run's segment is untouched and still active.
    const segments = await listSegments(layout);
    expect(segments.active).toContain(`run-${runId}.jsonl`);
    const runEvents = await segmentEvents(join(layout.journalDir, `run-${runId}.jsonl`));
    expect(runEvents.map((e) => e.type)).toEqual(["run.started", "run.paused"]);
  });

  test("handback: segment ends with session.closed and is archived", async () => {
    const { root, layout, env } = await setup();
    const itemId = await newItem(env, root);
    expect(await claimCommand.run([itemId], env, root, JIM)).toBe(0);

    const code = await handbackCommand.run([itemId], env, root, JIM);
    expect(code).toBe(0);

    const { active } = await sessionSegments(layout);
    expect(active).toEqual([]);
    const events = await archivedSegmentOpening(layout, "item.handback");
    expect(events.map((e) => e.type)).toEqual(["item.handback", SESSION_CLOSED_EVENT_TYPE]);
  });

  test("pause: run-scoped mutations only — no session segment is ever created", async () => {
    const { root, layout, env } = await setup();
    const itemId = await newItem(env, root);
    const runId = await startRun(env, root, itemId);

    const code = await pauseCommand.run([runId], env, root);
    expect(code).toBe(0);

    // run.paused went to the run's segment; the invocation's minted session
    // id was never written to, so no file exists to close or archive.
    const { active, archived } = await sessionSegments(layout);
    expect(active).toEqual([]);
    expect(archived).toHaveLength(1); // item new's segment only
    const runEvents = await segmentEvents(join(layout.journalDir, `run-${runId}.jsonl`));
    expect(runEvents.map((e) => e.type)).toEqual(["run.started", "run.paused"]);
  });

  test("run start / run update: run segments keep closing via run end, not session close", async () => {
    const { root, layout, env } = await setup();
    const itemId = await newItem(env, root);
    const runId = await startRun(env, root, itemId);
    expect(await runCommand.run(["update", runId, "--phase", "building"], env, root)).toBe(0);

    // No session segment appeared for the run-scoped invocations, and the
    // active run segment does NOT end with session.closed.
    const { active } = await sessionSegments(layout);
    expect(active).toEqual([]);
    const runEvents = await segmentEvents(join(layout.journalDir, `run-${runId}.jsonl`));
    expect(runEvents.map((e) => e.type)).toEqual(["run.started", "run.updated"]);
  });

  test("a refused lifecycle writes nothing: no session segment to close or abandon", async () => {
    const { root, layout, env } = await setup();
    const code = await itemCommand.run(
      ["update", "zzzzzzzz", "--status", "in-progress"],
      env,
      root,
    );
    expect(code).toBe(1);

    const { active, archived } = await sessionSegments(layout);
    expect(active).toEqual([]);
    expect(archived).toEqual([]);
  });
});

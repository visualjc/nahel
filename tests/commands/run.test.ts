import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { itemCommand } from "../../src/commands/item";
import { runCommand } from "../../src/commands/run";
import type { Env } from "../../src/schema/env";
import { ID_PATTERN } from "../../src/schema/id";
import type { JournalEvent } from "../../src/schema/records";
import { readHotState } from "../../src/store/hotstate";
import {
  appendEvent,
  closeSession,
  listSegments,
  newSessionSegmentId,
  readJournal,
  runSegmentPath,
} from "../../src/store/journal";
import {
  ensureLayout,
  listRuns,
  readItem,
  readRun,
  writeConfig,
  writeItem,
  type StoreLayout,
} from "../../src/store/layout";
import { rotateJournal } from "../../src/store/rotate";
import { makeConfig, makeFrontmatter, makeRun, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel run start|update|end` (PRD F3). Commands are exercised directly
 * (cli.ts registration is issue #4). Journaling is verified by READING the
 * journal/segments — the commands never log directly; the store's mutate()
 * choke point auto-journals, and `run end` closes the run's segment (its
 * run.ended event is the segment's final line and rotation may archive it).
 */

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

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

function stderr(): string {
  return errs.join("\n");
}

async function setup() {
  const root = await makeTempDir("nahel-cmd-run-");
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig());
  const env = seededEnv({ tickSeconds: 1 });
  return { root, layout, env };
}

async function journalEvents(layout: StoreLayout): Promise<JournalEvent[]> {
  const events: JournalEvent[] = [];
  for await (const event of readJournal(layout)) events.push(event);
  return events;
}

/**
 * Parse every event line of one run segment file, in file order — from the
 * active dir, or from journal/archive/ once `run end` has rotated it.
 */
async function segmentEvents(layout: StoreLayout, runId: string): Promise<JournalEvent[]> {
  const active = runSegmentPath(layout, runId);
  const raw = await readFile(active, "utf8").catch(() =>
    readFile(join(layout.journalArchiveDir, basename(active)), "utf8"),
  );
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as JournalEvent);
}

/** Create an item through the command and return its printed id. */
async function newItem(env: Env, root: string, args: string[] = []): Promise<string> {
  const before = logs.length;
  const code = await itemCommand.run(
    ["new", "feature", "test-item", "direct", ...args],
    env,
    root,
  );
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

describe("runCommand shape", () => {
  test("is a registration-ready command object", () => {
    expect(runCommand.name).toBe("run");
    expect(runCommand.description.length).toBeGreaterThan(0);
    expect(typeof runCommand.run).toBe("function");
  });
});

describe("run start", () => {
  test("creates the run record plus its state.json and prints the run id", async () => {
    const { root, layout, env } = await setup();
    const itemId = await newItem(env, root);

    const code = await runCommand.run(["start", itemId], env, root);
    expect(stderr()).toBe("");
    expect(code).toBe(0);
    const runId = logs[logs.length - 1]!;
    expect(runId).toMatch(ID_PATTERN);

    const run = await readRun(layout, runId);
    expect(run.id).toBe(runId);
    expect(run.item).toBe(itemId);
    expect(run.actor).toEqual({ kind: "agent", id: "claude-code" });
    expect(run.lane).toBe("direct");
    expect(run.phase).toBe("starting");
    expect(run.status).toBe("active");
    expect(run.started).toMatch(TIMESTAMP);
    expect(run.ended).toBeUndefined();

    const hot = await readHotState(layout, runId);
    expect(hot).toEqual({ phase: "starting", status: "active", updated: run.started });
  });

  test("the run's lane comes from the item", async () => {
    const { root, layout, env } = await setup();
    const before = logs.length;
    await itemCommand.run(["new", "plan", "big-plan", "full"], env, root);
    const itemId = logs[before]!;

    const runId = await startRun(env, root, itemId);
    expect((await readRun(layout, runId)).lane).toBe("full");
  });

  test("auto-journals run.started into the run's own segment with the full record", async () => {
    const { root, layout, env } = await setup();
    const itemId = await newItem(env, root);
    const runId = await startRun(env, root, itemId);

    const events = await segmentEvents(layout, runId);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("run.started");
    expect(event.run).toBe(runId);
    expect(event.item).toBe(itemId);
    expect(event.actor).toEqual({ kind: "agent", id: "claude-code" });
    expect(event.payload).toEqual({ target: "run", record: await readRun(layout, runId) });
  });

  test("refuses a nonexistent item, creating nothing", async () => {
    const { root, layout, env } = await setup();
    const code = await runCommand.run(["start", "zzzzzzzz"], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain("zzzzzzzz");
    expect(stderr()).toContain("does not reference an existing item");
    expect(logs).toEqual([]);
    expect(await listRuns(layout)).toEqual([]);
    expect(await journalEvents(layout)).toEqual([]);
  });

  test("an agent run on a claimed item is refused via the choke point — no run, no segment", async () => {
    const { root, layout, env } = await setup();
    const itemId = await newItem(env, root);
    const record = await readItem(layout, itemId);
    await writeItem(layout, { ...record.frontmatter, claimed_by: "jim" }, record.body);

    const code = await runCommand.run(["start", itemId], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain(itemId);
    expect(stderr()).toContain("jim");
    expect(stderr()).toContain("handback");
    expect(await listRuns(layout)).toEqual([]);
    await expect(segmentEvents(layout, "zzzzzzzz")).rejects.toThrow(); // and obviously no segment
    expect(await journalEvents(layout)).toHaveLength(1); // only item.created
  });

  test("rejects extra positionals and unknown flags", async () => {
    const { root, env } = await setup();
    const itemId = await newItem(env, root);
    expect(await runCommand.run(["start", itemId, "extra"], env, root)).toBe(1);
    errs = [];
    expect(await runCommand.run(["start", itemId, "--bogus"], env, root)).toBe(1);
    expect(stderr()).toContain("--bogus");
  });

  test("an explicit actorOverride wins over the config actor for the run's actor", async () => {
    // The NAHEL_ACTOR environment variable itself is read only by the cli.ts
    // entry point (tests/cli.test.ts covers the env contract end-to-end); at
    // the command layer the override arrives as an argument.
    const { root, layout, env } = await setup(); // config actor: agent claude-code
    const itemId = await newItem(env, root);

    const code = await runCommand.run(["start", itemId], env, root, "human:jim");
    expect(stderr()).toBe("");
    expect(code).toBe(0);
    const runId = logs[logs.length - 1]!;

    expect((await readRun(layout, runId)).actor).toEqual({ kind: "human", id: "jim" });
    const events = await segmentEvents(layout, runId);
    expect(events[0]!.actor).toEqual({ kind: "human", id: "jim" });
  });
});

describe("run update", () => {
  test("--phase updates the run record and its hot state, journaling run.updated", async () => {
    const { root, layout, env } = await setup();
    const itemId = await newItem(env, root);
    const runId = await startRun(env, root, itemId);

    const code = await runCommand.run(["update", runId, "--phase", "diagnosing"], env, root);
    expect(stderr()).toBe("");
    expect(code).toBe(0);

    const run = await readRun(layout, runId);
    expect(run.phase).toBe("diagnosing");
    expect(run.status).toBe("active");

    const hot = await readHotState(layout, runId);
    expect(hot["phase"]).toBe("diagnosing");
    expect(hot["status"]).toBe("active");
    expect(hot["updated"]).toMatch(TIMESTAMP);

    const events = await segmentEvents(layout, runId);
    expect(events).toHaveLength(2);
    expect(events[1]!.type).toBe("run.updated");
    expect(events[1]!.run).toBe(runId);
    expect(events[1]!.payload).toEqual({ target: "run", record: run });
  });

  test("requires --phase", async () => {
    const { root, env } = await setup();
    const runId = await startRun(env, root, await newItem(env, root));
    expect(await runCommand.run(["update", runId], env, root)).toBe(1);
    expect(stderr()).toContain("--phase");
  });

  test("rejects an empty --phase value", async () => {
    const { root, layout, env } = await setup();
    const runId = await startRun(env, root, await newItem(env, root));
    expect(await runCommand.run(["update", runId, "--phase", ""], env, root)).toBe(1);
    expect((await readRun(layout, runId)).phase).toBe("starting");
  });

  test("fails actionably on an unknown run id", async () => {
    const { root, env } = await setup();
    expect(await runCommand.run(["update", "zzzzzzzz", "--phase", "x"], env, root)).toBe(1);
    expect(stderr()).toContain("zzzzzzzz");
    expect(stderr()).toContain("not found");
  });

  test("refuses to update an ended run", async () => {
    const { root, layout, env } = await setup();
    const itemId = await newItem(env, root);
    const runId = await startRun(env, root, itemId);
    await runCommand.run(["end", runId, "success"], env, root);

    const code = await runCommand.run(["update", runId, "--phase", "zombie"], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain("ended");
    expect((await readRun(layout, runId)).phase).toBe("success");
  });

  test("rejects unknown flags by name", async () => {
    const { root, env } = await setup();
    const runId = await startRun(env, root, await newItem(env, root));
    expect(
      await runCommand.run(["update", runId, "--phase", "x", "--force"], env, root),
    ).toBe(1);
    expect(stderr()).toContain("--force");
  });
});

describe("run end", () => {
  test("closes the run: status ended, ended timestamp, outcome as final phase; hot state mirrors it", async () => {
    const { root, layout, env } = await setup();
    const itemId = await newItem(env, root);
    const runId = await startRun(env, root, itemId);

    const code = await runCommand.run(["end", runId, "success"], env, root);
    expect(stderr()).toBe("");
    expect(code).toBe(0);

    const run = await readRun(layout, runId);
    expect(run.status).toBe("ended");
    expect(run.ended).toMatch(TIMESTAMP);
    expect(run.phase).toBe("success"); // outcome recorded durably on the record
    expect(run.started < run.ended!).toBe(true);

    const hot = await readHotState(layout, runId);
    expect(hot).toEqual({
      phase: "success",
      status: "ended",
      outcome: "success",
      updated: run.ended,
    });

    const events = await segmentEvents(layout, runId);
    const last = events[events.length - 1]!;
    expect(last.type).toBe("run.ended");
    expect(last.payload).toEqual({ target: "run", record: run });
  });

  test("closes AND archives the run's journal segment itself — rotation needs no separate pass", async () => {
    const { root, layout, env } = await setup();
    const itemId = await newItem(env, root);
    const runId = await startRun(env, root, itemId);
    await runCommand.run(["update", runId, "--phase", "working"], env, root);

    // Active while the run is open: rotation must not touch it.
    expect((await rotateJournal(layout)).archived).toEqual([]);

    await runCommand.run(["end", runId, "failure"], env, root);
    const segments = await listSegments(layout);
    expect(segments.archived).toContain(`run-${runId}.jsonl`);
    expect(segments.active).not.toContain(`run-${runId}.jsonl`);
    // Nothing left for a follow-up sweep: run end already rotated it.
    expect((await rotateJournal(layout)).archived).toEqual([]);
  });

  test("opportunistically sweeps other provably-closed segments while ending a run", async () => {
    const { root, layout, env } = await setup();
    const runId = await startRun(env, root, await newItem(env, root));
    // A closed-but-unarchived session segment left behind by an earlier writer.
    const human = { kind: "human", id: "maintainer" } as const;
    const session = newSessionSegmentId(env);
    await appendEvent(layout, env, { type: "note", actor: human, payload: {}, session });
    await closeSession(layout, env, human, session);

    expect(await runCommand.run(["end", runId, "success"], env, root)).toBe(0);
    const segments = await listSegments(layout);
    expect(segments.archived).toContain(`run-${runId}.jsonl`);
    expect(segments.archived).toContain(`session-${session}.jsonl`);
    expect(segments.active).not.toContain(`session-${session}.jsonl`);
  });

  test("after end + rotation, the run's history stays readable through the merged journal", async () => {
    const { root, layout, env } = await setup();
    const runId = await startRun(env, root, await newItem(env, root));
    await runCommand.run(["update", runId, "--phase", "working"], env, root);
    expect(await runCommand.run(["end", runId, "success"], env, root)).toBe(0);

    // The archived segment still tells the run's whole story via the merged read.
    const types = (await journalEvents(layout))
      .filter((event) => event.run === runId)
      .map((event) => event.type);
    expect(types).toEqual(["run.started", "run.updated", "run.ended"]);
  });

  test("refuses to end an already-ended run, changing nothing", async () => {
    const { root, layout, env } = await setup();
    const runId = await startRun(env, root, await newItem(env, root));
    await runCommand.run(["end", runId, "success"], env, root);
    const before = await readRun(layout, runId);

    const code = await runCommand.run(["end", runId, "failure"], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain("already ended");
    expect(await readRun(layout, runId)).toEqual(before);
  });

  test("fails actionably on an unknown run id", async () => {
    const { root, env } = await setup();
    expect(await runCommand.run(["end", "zzzzzzzz", "success"], env, root)).toBe(1);
    expect(stderr()).toContain("zzzzzzzz");
    expect(stderr()).toContain("not found");
  });

  test("requires an outcome", async () => {
    const { root, env } = await setup();
    const runId = await startRun(env, root, await newItem(env, root));
    expect(await runCommand.run(["end", runId], env, root)).toBe(1);
    expect(stderr()).toContain("outcome");
  });
});

describe("run — dispatch and help", () => {
  test("--help documents start, update --phase and end <outcome>, exit 0", async () => {
    const { root, env } = await setup();
    const code = await runCommand.run(["--help"], env, root);
    expect(code).toBe(0);
    const help = logs.join("\n");
    expect(help).toContain("run start");
    expect(help).toContain("--phase");
    expect(help).toContain("outcome");
  });

  test("no subcommand and unknown subcommands are usage errors", async () => {
    const { root, env } = await setup();
    expect(await runCommand.run([], env, root)).toBe(1);
    errs = [];
    expect(await runCommand.run(["restart", "zzzzzzzz"], env, root)).toBe(1);
    expect(stderr()).toContain("restart");
  });
});

describe("full lifecycle end-to-end — zero hand-edits (PRD F3)", () => {
  test("item new → run start → phase updates → run end → item done, all journaled in order", async () => {
    const { root, layout, env } = await setup();

    // 1. Create the item.
    expect(await itemCommand.run(["new", "bug", "login-crash", "direct"], env, root)).toBe(0);
    const itemId = logs[0]!;
    expect(itemId).toMatch(ID_PATTERN);

    // 2. Start a run and mark the item in-progress.
    expect(await runCommand.run(["start", itemId], env, root)).toBe(0);
    const runId = logs[1]!;
    expect(runId).toMatch(ID_PATTERN);
    expect(await itemCommand.run(["update", itemId, "--status", "in-progress"], env, root)).toBe(0);

    // 3. Drive the run through its phases.
    expect(await runCommand.run(["update", runId, "--phase", "diagnosing"], env, root)).toBe(0);
    expect(await runCommand.run(["update", runId, "--phase", "fixing"], env, root)).toBe(0);

    // 4. Close the run, then the item.
    expect(await runCommand.run(["end", runId, "success"], env, root)).toBe(0);
    expect(await itemCommand.run(["update", itemId, "--status", "done"], env, root)).toBe(0);

    expect(stderr()).toBe("");

    // Final records — every field driven by commands, nothing hand-edited.
    const { frontmatter } = await readItem(layout, itemId);
    expect(frontmatter.status).toBe("done");
    expect(frontmatter.created < frontmatter.updated).toBe(true);

    const run = await readRun(layout, runId);
    expect(run.status).toBe("ended");
    expect(run.phase).toBe("success");
    expect(run.item).toBe(itemId);

    const hot = await readHotState(layout, runId);
    expect(hot["status"]).toBe("ended");
    expect(hot["outcome"]).toBe("success");

    // The journal tells the whole story, in total order, with resolved actors —
    // and the commands issued zero direct log calls to get it.
    const events = await journalEvents(layout);
    expect(events.map((event) => event.type)).toEqual([
      "item.created",
      "run.started",
      "item.updated",
      "run.updated",
      "run.updated",
      "run.ended",
      "item.updated",
    ]);
    for (const event of events) {
      expect(event.actor).toEqual({ kind: "agent", id: "claude-code" });
    }

    // Write-ahead payloads are complete: the final events reproduce the disk
    // records exactly (replay needs no other source).
    const lastItemEvent = events[events.length - 1]!;
    expect(lastItemEvent.payload["record"]).toEqual(frontmatter);
    const runEnded = events[events.length - 2]!;
    expect(runEnded.payload["record"]).toEqual(run);
  });
});

describe("run — ids validated before any path join (PR #12 review blocker 2 + amendment)", () => {
  /**
   * The verified hot-state escape: plant a schema-valid run.json OUTSIDE the
   * repo and address it with a traversal run id — the raw argv id must be
   * refused before any read/write, and no state.json may appear at the plant.
   */
  async function plantOutsideRun(env: Env, root: string): Promise<{ dir: string; id: string }> {
    const dir = await makeTempDir("nahel-plant-");
    dirs.push(dir);
    const planted = makeRun(env, makeFrontmatter(env).id);
    await writeFile(join(dir, "run.json"), `${JSON.stringify(planted)}\n`);
    // From nahel/runs, three levels up is the temp dir both roots live in.
    return { dir, id: `../../../${basename(dir)}` };
  }

  test("run update with a traversal id refuses; no state.json outside nahel/runs", async () => {
    const { root, layout, env } = await setup();
    const plant = await plantOutsideRun(env, root);

    const code = await runCommand.run(["update", plant.id, "--phase", "pwned"], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain("invalid run id");
    expect(existsSync(join(plant.dir, "state.json"))).toBe(false);
    // Nothing journaled, no run record materialized inside the repo either.
    expect(await journalEvents(layout)).toEqual([]);
    expect(await listRuns(layout)).toEqual([]);
  });

  test("run end with a traversal id refuses; no state.json outside nahel/runs", async () => {
    const { root, layout, env } = await setup();
    const plant = await plantOutsideRun(env, root);

    const code = await runCommand.run(["end", plant.id, "success"], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain("invalid run id");
    expect(existsSync(join(plant.dir, "state.json"))).toBe(false);
    expect(await journalEvents(layout)).toEqual([]);
  });

  test("run update with an absolute-ish id refuses with an invalid-id error", async () => {
    const { root, env } = await setup();
    const code = await runCommand.run(["update", "/tmp/evil", "--phase", "x"], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain("invalid run id");
  });

  test("run start with a traversal item id refuses with an invalid-id error", async () => {
    const { root, layout, env } = await setup();
    await writeFile(join(root, "PRODUCT.md"), "# canary\n");
    const code = await runCommand.run(["start", "../../PRODUCT"], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain("invalid item id");
    expect(await listRuns(layout)).toEqual([]);
  });
});

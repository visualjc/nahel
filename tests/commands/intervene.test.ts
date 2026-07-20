import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claimCommand, handbackCommand, pauseCommand } from "../../src/commands/intervene";
import { itemCommand } from "../../src/commands/item";
import { runCommand } from "../../src/commands/run";
import type { Env } from "../../src/schema/env";
import type { JournalEvent } from "../../src/schema/records";
import { collectHandbackEvidence, gitBaselineSchema } from "../../src/store/baseline";
import { readHotState } from "../../src/store/hotstate";
import { readJournal } from "../../src/store/journal";
import { ensureLayout, readItem, readRun, writeConfig, type StoreLayout } from "../../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel pause | claim | handback` — the intervention ops (PRD F9). Commands
 * are exercised directly (cli.ts registration is the orchestrator's merge
 * step). Fixtures are REAL git temp repos driven through the real commands;
 * journaling is verified by READING the journal — the intervention ops never
 * log directly, they flow through the store's mutate() choke point, whose
 * claim enforcement these tests prove end-to-end (PRD success criterion 7).
 */

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SHA = /^[0-9a-f]{40}$/;

/** The claiming human, as a NAHEL_ACTOR override value. */
const JIM = "human:jim";
/** A different human — a non-claimant. */
const ALICE = "human:alice";

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

/** Run a real git command in a repo, returning stdout. */
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

/** Temp dir with a real git repo (one initial commit) and a nahel store. */
async function setup() {
  const root = await makeTempDir("nahel-cmd-intervene-");
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

/** Same as setup() but without git init — a plain directory with a store. */
async function setupWithoutGit() {
  const root = await makeTempDir("nahel-cmd-intervene-nogit-");
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

describe("intervention command shapes", () => {
  test("pause, claim and handback are registration-ready command objects", () => {
    for (const [command, name] of [
      [pauseCommand, "pause"],
      [claimCommand, "claim"],
      [handbackCommand, "handback"],
    ] as const) {
      expect(command.name).toBe(name);
      expect(command.description.length).toBeGreaterThan(0);
      expect(typeof command.run).toBe("function");
    }
  });
});

describe("pause", () => {
  test("suspends an active run: record status paused, hot state mirrors it, run.paused journaled", async () => {
    const { root, layout, env } = await setup();
    const itemId = await newItem(env, root);
    const runId = await startRun(env, root, itemId);
    errs = [];

    const code = await pauseCommand.run([runId], env, root);
    expect(stderr()).toBe("");
    expect(code).toBe(0);

    const run = await readRun(layout, runId);
    expect(run.status).toBe("paused");
    expect(run.phase).toBe("starting"); // pause suspends; it does not move the phase
    expect(run.ended).toBeUndefined();

    const hot = await readHotState(layout, runId);
    expect(hot["status"]).toBe("paused");
    expect(hot["phase"]).toBe("starting");
    expect(hot["updated"]).toMatch(TIMESTAMP);

    const events = await journalEvents(layout);
    const paused = events[events.length - 1]!;
    expect(paused.type).toBe("run.paused");
    expect(paused.run).toBe(runId);
    expect(paused.item).toBe(itemId);
    expect(paused.payload).toEqual({ target: "run", record: run });
  });

  test("refuses to pause an already-paused run, changing nothing", async () => {
    const { root, layout, env } = await setup();
    const runId = await startRun(env, root, await newItem(env, root));
    expect(await pauseCommand.run([runId], env, root)).toBe(0);
    const before = await readRun(layout, runId);
    const eventsBefore = (await journalEvents(layout)).length;

    const code = await pauseCommand.run([runId], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain("already paused");
    expect(await readRun(layout, runId)).toEqual(before);
    expect(await journalEvents(layout)).toHaveLength(eventsBefore);
  });

  test("refuses to pause an ended run", async () => {
    const { root, layout, env } = await setup();
    const runId = await startRun(env, root, await newItem(env, root));
    expect(await runCommand.run(["end", runId, "success"], env, root)).toBe(0);

    const code = await pauseCommand.run([runId], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain("ended");
    expect((await readRun(layout, runId)).status).toBe("ended");
  });

  test("fails actionably on an unknown run id", async () => {
    const { root, env } = await setup();
    expect(await pauseCommand.run(["zzzzzzzz"], env, root)).toBe(1);
    expect(stderr()).toContain("zzzzzzzz");
    expect(stderr()).toContain("not found");
  });

  test("rejects missing/extra positionals and unknown flags", async () => {
    const { root, env } = await setup();
    expect(await pauseCommand.run([], env, root)).toBe(1);
    errs = [];
    expect(await pauseCommand.run(["a", "b"], env, root)).toBe(1);
    errs = [];
    expect(await pauseCommand.run(["a", "--force"], env, root)).toBe(1);
    expect(stderr()).toContain("--force");
  });

  test("--help documents the verb, exit 0", async () => {
    const { root, env } = await setup();
    expect(await pauseCommand.run(["--help"], env, root)).toBe(0);
    expect(logs.join("\n")).toContain("pause <run>");
  });
});

describe("claim", () => {
  test("sets claimed_by from the resolved actor and journals item.claimed carrying the git baseline", async () => {
    const { root, layout, env } = await setup();
    const itemId = await newItem(env, root);
    // Dirty-at-claim edge case: an uncommitted edit exists when the claim lands.
    await writeFile(join(root, "app.txt"), "version one\nuncommitted human edit\n");
    errs = [];

    const code = await claimCommand.run([itemId], env, root, JIM);
    expect(stderr()).toBe("");
    expect(code).toBe(0);

    const { frontmatter } = await readItem(layout, itemId);
    expect(frontmatter.claimed_by).toBe("jim");
    expect(frontmatter.created < frontmatter.updated).toBe(true);

    // The invocation's session-close marker follows the mutation.
    const events = await journalEvents(layout);
    const claimed = events[events.length - 2]!;
    expect(claimed.type).toBe("item.claimed");
    expect(claimed.item).toBe(itemId);
    expect(claimed.actor).toEqual({ kind: "human", id: "jim" });
    // Write-ahead payload still carries the full mutation…
    expect(claimed.payload["target"]).toBe("item");
    expect(claimed.payload["record"]).toEqual(frontmatter);
    expect(claimed.payload["body"]).toBe("");
    // …plus the baseline: HEAD SHA and the porcelain snapshot.
    const baseline = gitBaselineSchema.parse(claimed.payload["baseline"]);
    expect(baseline.head).toBe(git(root, "rev-parse", "HEAD").trim());
    expect(baseline.head).toMatch(SHA);
    expect(baseline.dirty).toContain(" M app.txt");
  });

  test("covers the entire subtree: active runs on descendants are paused, unrelated runs stay active", async () => {
    const { root, layout, env } = await setup();
    const rootItem = await newItem(env, root);
    const child = await newItem(env, root, ["--parent", rootItem]);
    const grandchild = await newItem(env, root, ["--parent", child]);
    const unrelated = await newItem(env, root);

    const rootRun = await startRun(env, root, rootItem);
    const childRun = await startRun(env, root, child);
    const grandchildRun = await startRun(env, root, grandchild);
    const unrelatedRun = await startRun(env, root, unrelated);
    const endedRun = await startRun(env, root, child);
    expect(await runCommand.run(["end", endedRun, "success"], env, root)).toBe(0);
    errs = [];

    const code = await claimCommand.run([rootItem], env, root, JIM);
    expect(stderr()).toBe("");
    expect(code).toBe(0);

    // Only the claimed root's frontmatter carries the claim; coverage of the
    // subtree is the store's ancestor walk, not per-descendant writes.
    expect((await readItem(layout, rootItem)).frontmatter.claimed_by).toBe("jim");
    expect((await readItem(layout, child)).frontmatter.claimed_by).toBeUndefined();
    expect((await readItem(layout, grandchild)).frontmatter.claimed_by).toBeUndefined();

    expect((await readRun(layout, rootRun)).status).toBe("paused");
    expect((await readRun(layout, childRun)).status).toBe("paused");
    expect((await readRun(layout, grandchildRun)).status).toBe("paused");
    expect((await readRun(layout, unrelatedRun)).status).toBe("active");
    expect((await readRun(layout, endedRun)).status).toBe("ended"); // ended stays ended

    for (const runId of [rootRun, childRun, grandchildRun]) {
      expect((await readHotState(layout, runId))["status"]).toBe("paused");
    }

    const events = await journalEvents(layout);
    const types = events.map((event) => event.type);
    expect(types.filter((type) => type === "run.paused")).toHaveLength(3);
    expect(types).toContain("item.claimed");
    // The claim event precedes the pauses it causes.
    expect(types.indexOf("item.claimed")).toBeLessThan(types.indexOf("run.paused"));
    const pausedRuns = events.filter((event) => event.type === "run.paused").map((e) => e.run);
    expect(pausedRuns.sort()).toEqual([rootRun, childRun, grandchildRun].sort());
  });

  test("refuses to claim an already-claimed item — same or different actor — journaling nothing", async () => {
    const { root, layout, env } = await setup();
    const itemId = await newItem(env, root);
    expect(await claimCommand.run([itemId], env, root, JIM)).toBe(0);
    const eventsBefore = (await journalEvents(layout)).length;

    errs = [];
    expect(await claimCommand.run([itemId], env, root, JIM)).toBe(1);
    expect(stderr()).toContain("already claimed by jim");

    errs = [];
    expect(await claimCommand.run([itemId], env, root, ALICE)).toBe(1);
    expect(stderr()).toContain("already claimed by jim");

    expect((await readItem(layout, itemId)).frontmatter.claimed_by).toBe("jim");
    expect(await journalEvents(layout)).toHaveLength(eventsBefore);
  });

  test("refuses an agent actor: claim is a human intervention", async () => {
    const { root, layout, env } = await setup();
    const itemId = await newItem(env, root); // config actor: agent claude-code

    const code = await claimCommand.run([itemId], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain("human");
    expect((await readItem(layout, itemId)).frontmatter.claimed_by).toBeUndefined();
  });

  test("outside a git repo the claim fails cleanly: no claim set, nothing journaled", async () => {
    const { root, layout, env } = await setupWithoutGit();
    const itemId = await newItem(env, root);
    const eventsBefore = (await journalEvents(layout)).length;

    const code = await claimCommand.run([itemId], env, root, JIM);
    expect(code).toBe(1);
    expect(stderr()).not.toBe("");
    expect((await readItem(layout, itemId)).frontmatter.claimed_by).toBeUndefined();
    expect(await journalEvents(layout)).toHaveLength(eventsBefore);
  });

  test("fails actionably on an unknown item and on bad argv", async () => {
    const { root, env } = await setup();
    expect(await claimCommand.run(["zzzzzzzz"], env, root, JIM)).toBe(1);
    expect(stderr()).toContain("zzzzzzzz");
    errs = [];
    expect(await claimCommand.run([], env, root, JIM)).toBe(1);
    errs = [];
    expect(await claimCommand.run(["a", "b"], env, root, JIM)).toBe(1);
  });
});

describe("claim enforcement through the store choke point (PRD success criterion 7)", () => {
  test("agent mutations are refused on the claimed item AND on a descendant; the human passes; handback restores agent access", async () => {
    const { root, layout, env } = await setup();
    const rootItem = await newItem(env, root);
    const child = await newItem(env, root, ["--parent", rootItem]);
    expect(await claimCommand.run([rootItem], env, root, JIM)).toBe(0);
    errs = [];

    // Agent (config actor) on the claimed item itself: refused.
    expect(
      await itemCommand.run(["update", rootItem, "--status", "in-progress"], env, root),
    ).toBe(1);
    expect(stderr()).toContain(rootItem);
    expect(stderr()).toContain("claim");
    expect((await readItem(layout, rootItem)).frontmatter.status).toBe("backlog");

    // Agent on a DESCENDANT of the claimed ancestor: refused, naming the ancestor.
    errs = [];
    expect(
      await itemCommand.run(["update", child, "--status", "in-progress"], env, root),
    ).toBe(1);
    expect(stderr()).toContain(rootItem);
    expect((await readItem(layout, child)).frontmatter.status).toBe("backlog");

    // Agent starting a run on a descendant: also refused via the choke point.
    errs = [];
    expect(await runCommand.run(["start", child], env, root)).toBe(1);
    expect(stderr()).toContain(rootItem);

    // The claiming human passes — the claim is theirs.
    errs = [];
    expect(
      await itemCommand.run(["update", child, "--status", "in-progress"], env, root, JIM),
    ).toBe(0);
    expect(stderr()).toBe("");
    expect((await readItem(layout, child)).frontmatter.status).toBe("in-progress");

    // Handback restores agent access to the whole subtree.
    expect(await handbackCommand.run([rootItem], env, root, JIM)).toBe(0);
    errs = [];
    expect(
      await itemCommand.run(["update", child, "--status", "in-review"], env, root),
    ).toBe(0);
    expect(stderr()).toBe("");
    expect((await readItem(layout, child)).frontmatter.status).toBe("in-review");
    expect(await runCommand.run(["start", child], env, root)).toBe(0);
  });
});

describe("handback", () => {
  test("clears the claim and journals item.handback with deterministic evidence", async () => {
    const { root, layout, env } = await setup();
    const itemId = await newItem(env, root);

    // Dirty at claim time: excluded from attribution later.
    await writeFile(join(root, "wip.txt"), "human work in progress before claim\n");
    expect(await claimCommand.run([itemId], env, root, JIM)).toBe(0);
    const claimEvent = (await journalEvents(layout)).find((e) => e.type === "item.claimed")!;
    const baseline = gitBaselineSchema.parse(claimEvent.payload["baseline"]);

    // The hand-fix: edit a tracked file and commit it during the claim.
    await writeFile(join(root, "app.txt"), "version one\nversion two — human fix\n");
    git(root, "add", "app.txt");
    git(root, "commit", "-q", "-m", "hand-fix during claim");
    const fixSha = git(root, "rev-parse", "HEAD").trim();
    // And a still-uncommitted edit at handback time.
    await writeFile(join(root, "later.txt"), "dirty at handback\n");
    errs = [];

    const code = await handbackCommand.run([itemId], env, root, JIM);
    expect(stderr()).toBe("");
    expect(code).toBe(0);

    const { frontmatter } = await readItem(layout, itemId);
    expect(frontmatter.claimed_by).toBeUndefined();
    expect("claimed_by" in frontmatter).toBe(false);

    // The invocation's session-close marker follows the mutation.
    const events = await journalEvents(layout);
    const handback = events[events.length - 2]!;
    expect(handback.type).toBe("item.handback");
    expect(handback.item).toBe(itemId);
    expect(handback.actor).toEqual({ kind: "human", id: "jim" });
    expect(handback.payload["record"]).toEqual(frontmatter);

    const evidence = handback.payload["evidence"] as Record<string, unknown>;
    expect(evidence["baseline_head"]).toBe(baseline.head);
    expect(evidence["commits"]).toEqual([fixSha]);
    expect(evidence["diff"]).toEqual([{ file: "app.txt", added: 1, deleted: 0 }]);
    expect(evidence["dirty"]).toContain("?? later.txt");
    expect(evidence["dirty"]).toContain("?? wip.txt");
    // The dirty-at-claim edit is attributed to nobody: listed as excluded.
    expect(evidence["excluded_from_attribution"]).toEqual(baseline.dirty);
    expect(baseline.dirty).toContain("?? wip.txt");

    // The journaled evidence is exactly the store's deterministic function of
    // repo state — byte-identical to an independent recomputation.
    const recomputed = await collectHandbackEvidence(root, baseline);
    expect(JSON.stringify(evidence)).toBe(JSON.stringify(recomputed));
  });

  test("identical repo state yields byte-identical evidence across claim/handback cycles", async () => {
    const { root, layout, env } = await setup();
    const itemId = await newItem(env, root);

    expect(await claimCommand.run([itemId], env, root, JIM)).toBe(0);
    expect(await handbackCommand.run([itemId], env, root, JIM)).toBe(0);
    expect(await claimCommand.run([itemId], env, root, JIM)).toBe(0);
    expect(await handbackCommand.run([itemId], env, root, JIM)).toBe(0);
    expect(stderr()).toBe("");

    const handbacks = (await journalEvents(layout)).filter((e) => e.type === "item.handback");
    expect(handbacks).toHaveLength(2);
    expect(JSON.stringify(handbacks[1]!.payload["evidence"])).toBe(
      JSON.stringify(handbacks[0]!.payload["evidence"]),
    );
  });

  test("refuses a non-claimant human, an agent, and an unclaimed item — journaling nothing", async () => {
    const { root, layout, env } = await setup();
    const itemId = await newItem(env, root);

    // Unclaimed: nothing to hand back.
    expect(await handbackCommand.run([itemId], env, root, JIM)).toBe(1);
    expect(stderr()).toContain("not claimed");

    expect(await claimCommand.run([itemId], env, root, JIM)).toBe(0);
    const eventsBefore = (await journalEvents(layout)).length;

    // Non-claimant human.
    errs = [];
    expect(await handbackCommand.run([itemId], env, root, ALICE)).toBe(1);
    expect(stderr()).toContain("jim");
    expect(stderr()).toContain("claimant");

    // Agent actor (config default).
    errs = [];
    expect(await handbackCommand.run([itemId], env, root)).toBe(1);
    expect(stderr()).toContain("human");

    expect((await readItem(layout, itemId)).frontmatter.claimed_by).toBe("jim");
    expect(await journalEvents(layout)).toHaveLength(eventsBefore);
  });

  test("fails actionably on an unknown item and on bad argv", async () => {
    const { root, env } = await setup();
    expect(await handbackCommand.run(["zzzzzzzz"], env, root, JIM)).toBe(1);
    expect(stderr()).toContain("zzzzzzzz");
    errs = [];
    expect(await handbackCommand.run([], env, root, JIM)).toBe(1);
  });
});

describe("full intervention cycle end-to-end (PRD F9)", () => {
  test("claim → runs pause → human hand-fix → handback → agent resumes, all journaled in order", async () => {
    const { root, layout, env } = await setup();

    // Agent working normally: item, child, active run on the child.
    const epic = await newItem(env, root);
    const task = await newItem(env, root, ["--parent", epic]);
    const runId = await startRun(env, root, task);

    // Human intervenes at the epic level: the whole subtree is covered.
    expect(await claimCommand.run([epic], env, root, JIM)).toBe(0);
    expect((await readRun(layout, runId)).status).toBe("paused");
    expect((await readHotState(layout, runId))["status"]).toBe("paused");

    // Agent is locked out of the subtree while the human fixes by hand.
    expect(await runCommand.run(["start", task], env, root)).toBe(1);
    await writeFile(join(root, "app.txt"), "version one\nhand-fixed by jim\n");
    git(root, "add", "app.txt");
    git(root, "commit", "-q", "-m", "jim's hand-fix");
    const fixSha = git(root, "rev-parse", "HEAD").trim();

    // Handback: claim cleared, evidence journaled, agent resumes.
    expect(await handbackCommand.run([epic], env, root, JIM)).toBe(0);
    expect((await readItem(layout, epic)).frontmatter.claimed_by).toBeUndefined();
    expect(await runCommand.run(["start", task], env, root)).toBe(0);

    // Each item-mutating invocation appends its session-close marker after
    // its mutations; run-scoped invocations (run start) close via run end.
    const types = (await journalEvents(layout)).map((event) => event.type);
    expect(types).toEqual([
      "item.created", // epic
      "session.closed",
      "item.created", // task
      "session.closed",
      "run.started",
      "item.claimed",
      "run.paused", // still inside the claim invocation — ONE close after both
      "session.closed",
      "item.handback",
      "session.closed",
      "run.started", // agent resumed
    ]);
    const handback = (await journalEvents(layout)).find((e) => e.type === "item.handback")!;
    const evidence = handback.payload["evidence"] as Record<string, unknown>;
    expect(evidence["commits"]).toEqual([fixSha]);
    expect(evidence["diff"]).toEqual([{ file: "app.txt", added: 1, deleted: 0 }]);
  });
});

describe("interventions — ids validated before any path join (PR #12 review blocker 2)", () => {
  test("pause with a traversal run id refuses with an invalid-id error", async () => {
    const { root, env } = await setup();
    const code = await pauseCommand.run(["../../evil"], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain("invalid run id");
  });

  test("claim with a traversal item id refuses before touching anything", async () => {
    const { root, layout, env } = await setup();
    // PRODUCT.md sits at exactly the path ../../PRODUCT reaches from nahel/items.
    const canary = "# canary constitution\n";
    await writeFile(join(root, "PRODUCT.md"), canary);

    const code = await claimCommand.run(["../../PRODUCT"], env, root, JIM);
    expect(code).toBe(1);
    expect(stderr()).toContain("invalid item id");
    expect(await journalEvents(layout)).toEqual([]);
  });

  test("handback with a traversal item id refuses likewise", async () => {
    const { root, layout, env } = await setup();
    await writeFile(join(root, "PRODUCT.md"), "# canary\n");
    const code = await handbackCommand.run(["../../PRODUCT"], env, root, JIM);
    expect(code).toBe(1);
    expect(stderr()).toContain("invalid item id");
    expect(await journalEvents(layout)).toEqual([]);
  });
});

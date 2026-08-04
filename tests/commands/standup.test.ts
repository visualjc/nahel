import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { itemCommand } from "../../src/commands/item";
import { logCommand } from "../../src/commands/log";
import { roadmapCommand } from "../../src/commands/roadmap";
import { standupCommand } from "../../src/commands/standup";
import type { Env } from "../../src/schema/env";
import { ID_PATTERN } from "../../src/schema/id";
import { ensureLayout, writeConfig } from "../../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel standup --since` (Phase 4 F4): the curated window over the journal.
 * Every case drives the REAL command against a real temp-dir store, so what
 * the tests exercise is the whole path — flag parsing, the window resolved off
 * the injected clock, the store reads, the rendering — and never a renderer fed
 * hand-built facts.
 */

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

/** A fresh store, plus an Env whose clock is FROZEN at `now`. */
async function setup(now = "2026-08-02T09:15:00Z", tickSeconds = 0) {
  const root = await makeTempDir("nahel-standup-");
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig());
  return { root, layout, env: seededEnv({ now, tickSeconds }) };
}

/** Run standup, expect success, and return everything it printed. */
async function standup(env: Env, root: string, args: string[]): Promise<string> {
  const before = logs.length;
  const code = await standupCommand.run(args, {
    env,
    cwd: root,
    stdout: (text: string) => logs.push(text),
    stderr: (text: string) => errs.push(text),
  });
  expect(errs.join("\n")).toBe("");
  expect(code).toBe(0);
  return logs.slice(before).join("\n");
}

/** Run standup expecting a non-zero exit; returns what it wrote to stderr. */
async function standupFails(env: Env, root: string, args: string[]): Promise<string> {
  const before = errs.length;
  const code = await standupCommand.run(args, {
    env,
    cwd: root,
    stdout: (text: string) => logs.push(text),
    stderr: (text: string) => errs.push(text),
  });
  expect(code).toBe(1);
  const written = errs.slice(before).join("\n");
  errs = [];
  return written;
}

/** Create a work item through the CLI and return its printed id. */
async function newItem(env: Env, root: string, args: string[]): Promise<string> {
  const before = logs.length;
  expect(await itemCommand.run(["new", ...args], env, root)).toBe(0);
  const id = logs[before];
  expect(id).toMatch(ID_PATTERN);
  return id!;
}

/**
 * Record an open-extension event through `nahel log`; its type warning is
 * expected. Returns the event's id, read off the command's own success line —
 * which is how a workflow author gets it too, and what a retraction has to name.
 */
async function log(env: Env, root: string, args: string[]): Promise<string> {
  const before = logs.length;
  expect(
    await logCommand.run(args, {
      env,
      cwd: root,
      stdout: (text: string) => logs.push(text),
      stderr: (text: string) => errs.push(text),
    }),
  ).toBe(0);
  errs = [];
  const id = /event ([a-z0-9]+) /.exec(logs.slice(before).join("\n"))?.[1];
  expect(id).toMatch(ID_PATTERN);
  return id!;
}

/** Every file under a directory, path → bytes — the store's exact state. */
async function snapshotTree(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(path, await readFile(path, "utf8"));
  }
  return files;
}

/**
 * A store with one feature node over an epic, one child that moved and closed,
 * and a deploy — a real recent window's worth of movement.
 */
async function moved(env: Env, root: string) {
  const epic = await newItem(env, root, ["plan", "demo-epic", "full"]);
  const child = await newItem(env, root, ["feature", "leaf-work", "direct", "--parent", epic]);
  expect(await itemCommand.run(["update", child, "--status", "in-progress"], env, root)).toBe(0);
  expect(await itemCommand.run(["update", child, "--status", "done"], env, root)).toBe(0);
  const before = logs.length;
  expect(
    await roadmapCommand.run(
      [
        "node",
        "new",
        "feature",
        "detached-state-repo",
        "--horizon",
        "now",
        "--intent",
        "Get state out of the repo.",
        "--epic",
        epic,
      ],
      env,
      root,
    ),
  ).toBe(0);
  const node = logs[before]!;
  await log(env, root, [
    "deploy.completed",
    "--item",
    child,
    "--data",
    "environment=staging",
  ]);
  return { epic, child, node };
}

describe("nahel standup — the window flag", () => {
  test("--since is required, and the refusal names both accepted forms", async () => {
    const { root, env } = await setup();
    const written = await standupFails(env, root, []);
    expect(written).toContain("--since");
    expect(written).toContain("7d");
  });

  test("an unreadable window is refused, naming what was given", async () => {
    const { root, env } = await setup();
    const written = await standupFails(env, root, ["--since", "yesterday"]);
    expect(written).toContain('"yesterday"');
  });

  test("a timestamp naming no real instant is refused, naming the problem", async () => {
    const { root, env } = await setup();
    for (const impossible of ["2026-02-30T00:00:00Z", "2026-01-01T24:00:00Z"]) {
      const written = await standupFails(env, root, ["--since", impossible]);
      expect(written).toContain(impossible);
      expect(written).toContain("no real instant");
    }
  });

  test("an oversized window is refused cleanly — never a standup with a malformed year", async () => {
    const { root, env } = await setup();
    const before = logs.length;
    const written = await standupFails(env, root, ["--since", "999999999d"]);
    expect(written).toContain("999999999d");
    expect(written).toContain("calendar");
    // The bug this replaces: a rendered header carrying an impossible year.
    expect(logs.slice(before).join("\n")).not.toContain("standup since");
  });

  test("an uninitialized repo is refused with the init pointer, not an empty standup", async () => {
    const root = await makeTempDir("nahel-standup-bare-");
    dirs.push(root);
    const written = await standupFails(seededEnv(), root, ["--since", "7d"]);
    expect(written.toLowerCase()).toContain("nahel init");
  });
});

describe("nahel standup — a real window over a real store", () => {
  test("the movement renders, grouped by node and item, every line naming its act", async () => {
    const { root, env, layout } = await setup("2026-08-02T09:15:00Z", 1);
    const { child, node } = await moved(env, root);

    const out = await standup(env, root, ["--since", "7d"]);

    // Header, node group, item group, then one line per act.
    const lines = out.split("\n");
    // Seven days back from whatever second the ticking Env had reached.
    expect(lines[0]).toMatch(/^standup since 2026-07-26T09:15:[0-9]{2}Z$/);
    // The node header is F2's own derivation: the deploy below lifts the stage
    // past `built`, exactly as `nahel roadmap` reports it.
    expect(lines).toContain(`detached-state-repo  feature  deployed  id=${node}`);
    expect(lines.some((line) => line === `  leaf-work  id=${child}`)).toBe(true);
    expect(out).toContain("opened  backlog  act=");
    expect(out).toContain("moved  backlog → in-progress  act=");
    expect(out).toContain("closed  in-progress → done  act=");
    expect(out).toContain("shipped  deployed staging  act=");

    // Every `act=` names an event that really exists in the journal.
    const acts = [...out.matchAll(/act=([0-9a-z]{8})/g)].map((match) => match[1]!);
    // Both items opened, the child moved then closed, and the deploy shipped.
    expect(acts.length).toBe(5);
    const journal = await readdir(layout.journalDir, { recursive: true });
    const text = (
      await Promise.all(
        journal
          .filter((name) => name.endsWith(".jsonl"))
          .map((name) => readFile(join(layout.journalDir, name), "utf8")),
      )
    ).join("");
    for (const act of acts) expect(text).toContain(`"id":"${act}"`);
  });

  test("a window that predates every act says so, rather than showing a frame", async () => {
    const { root, env } = await setup("2026-08-02T09:15:00Z", 1);
    await moved(env, root);

    expect(await standup(env, root, ["--since", "2026-08-02T23:00:00Z"])).toBe(
      "standup since 2026-08-02T23:00:00Z\n\nno movement in this window",
    );
  });

  test("an empty store renders the window and nothing else", async () => {
    const { root, env } = await setup();
    expect(await standup(env, root, ["--since", "7d"])).toBe(
      "standup since 2026-07-26T09:15:00Z\n\nno movement in this window",
    );
  });
});

describe("nahel standup — determinism and purity", () => {
  test("under a FIXED Env, --since 7d and the equivalent timestamp are byte-identical", async () => {
    const { root, env } = await setup("2026-08-02T09:15:00Z", 1);
    await moved(env, root);
    // A frozen clock: the two invocations must resolve the same instant.
    const frozen = seededEnv({ now: "2026-08-02T09:15:00Z", tickSeconds: 0 });

    const relative = await standup(frozen, root, ["--since", "7d"]);
    const absolute = await standup(frozen, root, ["--since", "2026-07-26T09:15:00Z"]);

    expect(relative).toBe(absolute);
    expect(relative).toContain("standup since 2026-07-26T09:15:00Z");
    // The spec itself is never echoed — that is what makes the two agree.
    expect(relative).not.toContain("7d");
  });

  test("the same fixed Env and store render byte-identically on every run", async () => {
    const { root, env } = await setup("2026-08-02T09:15:00Z", 1);
    await moved(env, root);
    const frozen = seededEnv({ now: "2026-08-02T09:15:00Z", tickSeconds: 0 });

    expect(await standup(frozen, root, ["--since", "30d"])).toBe(
      await standup(frozen, root, ["--since", "30d"]),
    );
  });

  test("running standup leaves the store byte-identical — no records, no events", async () => {
    const { root, env, layout } = await setup("2026-08-02T09:15:00Z", 1);
    await moved(env, root);
    const before = await snapshotTree(layout.nahelDir);

    await standup(env, root, ["--since", "7d"]);

    expect(await snapshotTree(layout.nahelDir)).toEqual(before);
  });
});

/**
 * `nahel standup` is DOCUMENTED VOCABULARY, not just a renderer: the glossary
 * is where this project's terms live (F1's roadmap node, F7's decision ticket,
 * F9's lifecycle events all landed there), and a verb whose words nobody wrote
 * down is a verb a reader has to reverse-engineer from its output. The words
 * are asserted so that renaming one in code fails the glossary still teaching
 * the old spelling.
 */
describe("nahel standup — documented vocabulary", () => {
  /** One glossary entry, by its bolded term — the line is the definition. */
  async function entry(term: string): Promise<string> {
    const glossary = await Bun.file(join(import.meta.dir, "../../CONTEXT.md")).text();
    const line = glossary.split("\n").find((each) => each.startsWith(`- **${term}** —`));
    expect(line).toBeDefined();
    return line!;
  }

  test("the glossary defines the verb, its window forms, and its zero-state promise", async () => {
    const defined = await entry("Standup");
    expect(defined).toContain("`nahel standup --since");
    expect(defined).toContain("7d");
    expect(defined).toContain("24h");
    expect(defined).toContain("zero new state");
  });

  test("the glossary lists every word a standup line can carry", async () => {
    const defined = await entry("Standup");
    for (const verb of [
      "opened",
      "moved",
      "blocked",
      "parked",
      "closed",
      "tested",
      "shipped",
      "retracted",
    ]) {
      expect(defined).toContain(`\`${verb}\``);
    }
    expect(defined).toContain("act=");
    expect(defined).toContain("outside the roadmap");
  });

  test("every documented verb is one the command can actually print", async () => {
    const { root, env } = await setup("2026-08-02T09:15:00Z", 1);
    const { epic, child } = await moved(env, root);
    // `moved` already produced opened / moved / closed / shipped; the rest need
    // their own acts, on their own items — a done item cannot become blocked.
    const stuck = await newItem(env, root, ["bug", "flaky-test", "direct", "--parent", epic]);
    expect(await itemCommand.run(["update", stuck, "--status", "blocked"], env, root)).toBe(0);
    const abandoned = await newItem(env, root, ["chore", "old-idea", "direct", "--parent", epic]);
    expect(await itemCommand.run(["update", abandoned, "--status", "dropped"], env, root)).toBe(0);
    await log(env, root, [
      "qa.sweep-completed",
      "--item",
      child,
      "--data",
      "cases_run=3",
      "--data",
      "failed=0",
    ]);

    // `retracted` needs a lifecycle fact to withdraw: the release below is
    // announced and then taken back, and both acts stay in the window.
    const release = await log(env, root, [
      "release.announced",
      "--item",
      child,
      "--data",
      "version=0.3.0",
    ]);
    await log(env, root, [
      "roadmap.column-retracted",
      "--data",
      `event=${release}`,
      "--data",
      "reason=announced against the wrong epic",
    ]);

    const out = await standup(env, root, ["--since", "7d"]);
    const defined = await entry("Standup");
    for (const verb of [
      "opened",
      "moved",
      "blocked",
      "parked",
      "closed",
      "tested",
      "shipped",
      "retracted",
    ]) {
      expect(out).toContain(`  ${verb}  `);
      expect(defined).toContain(`\`${verb}\``);
    }
  });
});

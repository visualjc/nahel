import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claimCommand } from "../../src/commands/intervene";
import { itemCommand } from "../../src/commands/item";
import { roadmapCommand } from "../../src/commands/roadmap";
import type { Env } from "../../src/schema/env";
import { ID_PATTERN } from "../../src/schema/id";
import { ensureLayout, writeConfig, type StoreLayout } from "../../src/store/layout";
import { ROADMAP_SUBCOMMANDS } from "../../src/views/roadmap";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel roadmap frontier` (Phase 4 F8): the takeable edge — everything that can
 * start NOW, across BOTH record kinds, because a ticket-only frontier would
 * answer "what can I decide" while going silent on "what can I build".
 *
 * The whole surface is READ-ONLY and refuses nothing: an item failing either
 * predicate can still be started deliberately, and no command anywhere refuses
 * work because a blocker is open (the anti-waterfall rule).
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

function stderr(): string {
  return errs.join("\n");
}

async function ok(env: Env, root: string, args: string[], actor?: string): Promise<string[]> {
  const before = logs.length;
  const code = await roadmapCommand.run(args, env, root, actor);
  expect(stderr()).toBe("");
  expect(code).toBe(0);
  return logs.slice(before);
}

async function item(env: Env, root: string, args: string[], actor?: string): Promise<string[]> {
  const before = logs.length;
  const code = await itemCommand.run(args, env, root, actor);
  expect(stderr()).toBe("");
  expect(code).toBe(0);
  return logs.slice(before);
}

function lastId(printed: string[]): string {
  const id = printed[printed.length - 1]!;
  expect(id).toMatch(ID_PATTERN);
  return id;
}

/** The rendering `nahel roadmap frontier [ref]` prints, as one string. */
async function frontier(env: Env, root: string, args: string[] = []): Promise<string> {
  return (await ok(env, root, ["frontier", ...args])).join("\n");
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

/** Run a real git command in a repo, returning stdout. */
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

/**
 * A fresh store with a charted feature node and nothing else, inside a real git
 * repo — `nahel claim` captures a repo baseline, and the claim coverage rule is
 * one of the two halves of F8's work-item predicate.
 */
async function setup(): Promise<{
  root: string;
  layout: StoreLayout;
  env: Env;
  node: string;
  map: string;
}> {
  const root = await makeTempDir("nahel-cmd-frontier-");
  dirs.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "commit.gpgsign", "false");
  await writeFile(join(root, "app.txt"), "version one\n");
  git(root, "add", "app.txt");
  git(root, "commit", "-q", "-m", "initial");
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig());
  const env = seededEnv({ tickSeconds: 1 });
  const node = lastId(
    await ok(env, root, [
      "node",
      "new",
      "feature",
      "deployment-devops-workflows",
      "--horizon",
      "now",
      "--intent",
      "Deploy and release, drivable by a fresh agent.",
    ]),
  );
  const map = lastId(
    await ok(env, root, [
      "map",
      "new",
      "--node",
      node,
      "--destination",
      "a deploy a fresh agent can drive",
    ]),
  );
  return { root, layout, env, node, map };
}

/** One open ticket on the map, optionally blocked by siblings. */
async function ticket(
  env: Env,
  root: string,
  map: string,
  question: string,
  blockers: readonly string[] = [],
): Promise<string> {
  return lastId(
    await ok(env, root, [
      "ticket",
      "new",
      "--map",
      map,
      "--type",
      "research",
      "--question",
      question,
      ...blockers.flatMap((id) => ["--blocked-by", id]),
    ]),
  );
}

describe("the ticket half of the frontier (F8)", () => {
  test("lists exactly the eligible tickets: open, unclaimed, every blocker settled", async () => {
    const { root, env, map } = await setup();
    const free = await ticket(env, root, map, "which deploy target do we own?");
    const blocked = await ticket(env, root, map, "which CD provider?", [free]);

    const listed = await frontier(env, root);
    expect(listed).toContain(free);
    // The blocked one is held back — its blocker is still open.
    expect(listed).not.toContain(blocked);
    expect(listed).toContain("tickets (1)");
  });

  test("claiming a ticket removes it from the frontier; releasing it restores it", async () => {
    const { root, env, map } = await setup();
    const id = await ticket(env, root, map, "which deploy target do we own?");
    expect(await frontier(env, root)).toContain(id);

    await ok(env, root, ["ticket", "claim", id], "agent:codex");
    expect(await frontier(env, root)).not.toContain(id);

    // Release is permitted to ANY actor, and returns the ticket to the frontier.
    await ok(env, root, ["ticket", "release", id], "human:jim");
    expect(await frontier(env, root)).toContain(id);
  });

  test("resolving a blocker adds its dependents; so does closing one", async () => {
    const { root, env, map } = await setup();
    const first = await ticket(env, root, map, "which deploy target do we own?");
    const second = await ticket(env, root, map, "what does staging cost?");
    const viaResolve = await ticket(env, root, map, "which CD provider?", [first]);
    const viaClose = await ticket(env, root, map, "do we need a CDN?", [second]);

    expect(await frontier(env, root)).not.toContain(viaResolve);
    await ok(env, root, ["ticket", "resolve", first, "--decision", "we own fly.io and nothing past it"]);
    expect(await frontier(env, root)).toContain(viaResolve);

    expect(await frontier(env, root)).not.toContain(viaClose);
    await ok(env, root, [
      "ticket",
      "close",
      second,
      "--out-of-scope",
      "--reason",
      "cost is not this destination's question",
    ]);
    expect(await frontier(env, root)).toContain(viaClose);
  });

  test("a ticket waits on EVERY blocker — one settled of two is still held back", async () => {
    const { root, env, map } = await setup();
    const first = await ticket(env, root, map, "which deploy target do we own?");
    const second = await ticket(env, root, map, "what does staging cost?");
    const dependent = await ticket(env, root, map, "which CD provider?", [first, second]);

    await ok(env, root, ["ticket", "resolve", first, "--decision", "we own fly.io"]);
    expect(await frontier(env, root)).not.toContain(dependent);
    await ok(env, root, ["ticket", "resolve", second, "--decision", "staging is one machine"]);
    expect(await frontier(env, root)).toContain(dependent);
  });

  test("the ticket line names the map's node, and the question underneath it", async () => {
    const { root, env, map } = await setup();
    const id = await ticket(env, root, map, "which deploy target do we own?");

    const listed = await frontier(env, root);
    expect(listed).toContain(`${id}  research  map=deployment-devops-workflows`);
    expect(listed).toContain("which deploy target do we own?");
  });
});

describe("frontier is a read-only verb of `nahel roadmap` (F8)", () => {
  test("running it leaves the store byte-identical — no records, no events", async () => {
    const { root, env, layout, map } = await setup();
    await ticket(env, root, map, "which deploy target do we own?");
    const before = await snapshotTree(layout.nahelDir);

    await frontier(env, root);

    expect(await snapshotTree(layout.nahelDir)).toEqual(before);
  });

  test("the same store renders byte-identically on every run (HC1)", async () => {
    const { root, env, map } = await setup();
    await ticket(env, root, map, "which deploy target do we own?");

    expect(await frontier(env, root)).toBe(await frontier(env, root));
  });

  test("`frontier` is a reserved verb — the word can never be spelled as an id", () => {
    expect(ROADMAP_SUBCOMMANDS.has("frontier")).toBe(true);
    expect(ID_PATTERN.test("frontier")).toBe(false);
  });

  test("a node named `frontier` is reached by `roadmap node show`, not by the bare ref", async () => {
    const { root, env } = await setup();
    const id = lastId(
      await ok(env, root, [
        "node",
        "new",
        "feature",
        "frontier",
        "--horizon",
        "now",
        "--intent",
        "an awkward slug",
      ]),
    );
    // The bare word dispatches the VIEW, never the zoom.
    expect(await frontier(env, root)).not.toContain("an awkward slug");
    expect((await ok(env, root, ["node", "show", "frontier"])).join("\n")).toContain(id);
  });
});

/** One work item, created through the CLI; returns its id. */
async function work(
  env: Env,
  root: string,
  name: string,
  extra: readonly string[] = [],
): Promise<string> {
  return lastId(await item(env, root, ["new", "feature", name, "direct", ...extra]));
}

describe("the work-item half of the frontier (F8)", () => {
  test("a backlog item with no dependencies is takeable", async () => {
    const { root, env } = await setup();
    const id = await work(env, root, "add-refunds");

    const listed = await frontier(env, root);
    expect(listed).toContain("work items (1)");
    expect(listed).toContain(`add-refunds  feature  backlog  lane=direct  id=${id}`);
  });

  test("every depends_on target must be settled: `done` and `dropped` free it, anything live does not", async () => {
    const { root, env } = await setup();
    const finished = await work(env, root, "schema-change");
    const abandoned = await work(env, root, "old-approach");
    const running = await work(env, root, "wire-the-gateway");
    const waiting = await work(env, root, "add-refunds", [
      "--depends-on",
      finished,
      "--depends-on",
      abandoned,
    ]);
    const blocked = await work(env, root, "add-payouts", ["--depends-on", running]);

    // Still waiting: neither dependency has settled yet.
    expect(await frontier(env, root)).not.toContain(waiting);

    await item(env, root, ["update", finished, "--status", "done"]);
    await item(env, root, ["update", abandoned, "--status", "dropped"]);
    expect(await frontier(env, root)).toContain(waiting);

    // The one whose dependency is merely STARTED is not takeable.
    await item(env, root, ["update", running, "--status", "in-progress"]);
    expect(await frontier(env, root)).not.toContain(blocked);
  });

  test("only `backlog` is takeable — every other status is off the frontier", async () => {
    const { root, env } = await setup();
    const ids = new Map<string, string>();
    for (const status of ["in-progress", "in-review", "blocked", "done", "dropped"]) {
      const id = await work(env, root, `work-${status}`);
      await item(env, root, ["update", id, "--status", status]);
      ids.set(status, id);
    }

    const listed = await frontier(env, root);
    expect(listed).toContain("work items (0)");
    for (const [status, id] of ids) expect(`${status}:${listed}`).not.toContain(id);
  });

  test("an item covered by an intervention claim is not takeable — its own, or an ANCESTOR's", async () => {
    const { root, env } = await setup();
    const epic = lastId(await item(env, root, ["new", "plan", "payments-epic", "full"]));
    const child = await work(env, root, "add-refunds", ["--parent", epic]);
    const grandchild = await work(env, root, "refund-webhook", ["--parent", child]);
    const untouched = await work(env, root, "unrelated-chore");
    expect(await frontier(env, root)).toContain(child);

    // A claim covers the whole SUBTREE, so all three go — and nothing else does.
    expect(await claimCommand.run([epic], env, root, "human:jim")).toBe(0);
    expect(stderr()).toBe("");

    const listed = await frontier(env, root);
    for (const id of [epic, child, grandchild]) expect(listed).not.toContain(id);
    expect(listed).toContain(untouched);
  });
});

describe("the frontier carries the reader onward (F8)", () => {
  test("a takeable ticket earns a runnable hint at the question in full", async () => {
    const { root, env, map } = await setup();
    const id = await ticket(env, root, map, "which deploy target do we own?");

    const hint = (await frontier(env, root)).split("\n").find((line) => line.startsWith("↳ "));
    expect(hint).toContain(`nahel roadmap ticket show ${id}`);
    // …and it runs.
    const [, , ...args] = hint!.slice("↳ ".length, hint!.indexOf("  — ")).split(" ");
    expect(await roadmapCommand.run(args, env, root)).toBe(0);
    expect(stderr()).toBe("");
  });

  test("an empty frontier points back up rather than stopping dead", async () => {
    const { root, env } = await setup();

    expect(await frontier(env, root)).toContain("↳ nahel roadmap  — back to the product level");
  });

  test("a takeable work item earns a runnable hint at its timeline", async () => {
    const { root, env } = await setup();
    const id = await work(env, root, "add-refunds");

    const hints = (await frontier(env, root)).split("\n").filter((line) => line.startsWith("↳ "));
    expect(hints.join("\n")).toContain(`nahel progress --item ${id}`);
  });
});

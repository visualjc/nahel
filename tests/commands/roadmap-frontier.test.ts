import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claimCommand } from "../../src/commands/intervene";
import { itemCommand } from "../../src/commands/item";
import { roadmapCommand } from "../../src/commands/roadmap";
import type { Env } from "../../src/schema/env";
import { ITEM_STARTED_BLOCKED_EVENT_TYPE } from "../../src/schema/events";
import { ID_PATTERN } from "../../src/schema/id";
import type { JournalEvent } from "../../src/schema/records";
import { readJournal } from "../../src/store/journal";
import { ensureLayout, writeConfig, type StoreLayout } from "../../src/store/layout";
import { validateStore } from "../../src/validate";
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

async function journalEvents(layout: StoreLayout): Promise<JournalEvent[]> {
  return Array.fromAsync(readJournal(layout));
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

describe("`nahel roadmap frontier <ref>` — one node's takeable edge (F8)", () => {
  test("scopes to that node's chart and to the work under its epic, and names it", async () => {
    const { root, env, node, map } = await setup();
    const epic = lastId(await item(env, root, ["new", "plan", "payments-epic", "full"]));
    await ok(env, root, ["node", "update", node, "--epic", epic]);
    const mine = await work(env, root, "add-refunds", ["--parent", epic]);
    const question = await ticket(env, root, map, "which deploy target do we own?");

    // A second node, charted and epic'd of its own — everything about it is
    // takeable, and none of it belongs to the first node's frontier.
    const other = lastId(
      await ok(env, root, [
        "node",
        "new",
        "feature",
        "billing-portal",
        "--horizon",
        "next",
        "--intent",
        "Self-serve billing.",
      ]),
    );
    const otherMap = lastId(
      await ok(env, root, ["map", "new", "--node", other, "--destination", "a portal"]),
    );
    const otherTicket = await ticket(env, root, otherMap, "which billing provider?");
    const otherItem = await work(env, root, "portal-shell");

    const scoped = await frontier(env, root, ["deployment-devops-workflows"]);
    expect(scoped).toContain("frontier of deployment-devops-workflows");
    expect(scoped).toContain(question);
    expect(scoped).toContain(mine);
    expect(scoped).not.toContain(otherTicket);
    expect(scoped).not.toContain(otherItem);
    // …while the store-wide view still holds everything.
    const wide = await frontier(env, root);
    for (const id of [question, mine, otherTicket, otherItem]) expect(wide).toContain(id);
  });

  test("the node's id and the map's own id address the same frontier as the slug", async () => {
    const { root, env, node, map } = await setup();
    await ticket(env, root, map, "which deploy target do we own?");

    const bySlug = await frontier(env, root, ["deployment-devops-workflows"]);
    expect(await frontier(env, root, [node])).toBe(bySlug);
    expect(await frontier(env, root, [map])).toBe(bySlug);
  });

  test("a blocker OUTSIDE the scope still holds an in-scope item back", async () => {
    const { root, env, node } = await setup();
    const epic = lastId(await item(env, root, ["new", "plan", "payments-epic", "full"]));
    await ok(env, root, ["node", "update", node, "--epic", epic]);
    // The dependency hangs off no node at all — the predicate is evaluated over
    // the whole store, and only the RESULT is narrowed to the scope.
    const outside = await work(env, root, "shared-schema");
    const waiting = await work(env, root, "add-refunds", ["--parent", epic, "--depends-on", outside]);

    expect(await frontier(env, root, ["deployment-devops-workflows"])).not.toContain(waiting);
    await item(env, root, ["update", outside, "--status", "done"]);
    expect(await frontier(env, root, ["deployment-devops-workflows"])).toContain(waiting);
  });

  test("a node with no chart and no epic renders both sections at zero, never an error", async () => {
    const { root, env } = await setup();
    await ok(env, root, [
      "node",
      "new",
      "feature",
      "billing-portal",
      "--horizon",
      "later",
      "--intent",
      "Self-serve billing.",
    ]);

    const scoped = await frontier(env, root, ["billing-portal"]);
    expect(scoped).toContain("frontier of billing-portal");
    expect(scoped).toContain("tickets (0)");
    expect(scoped).toContain("work items (0)");
  });

  test("a ref naming no node is refused by name, with the near misses", async () => {
    const { root, env } = await setup();

    errs = [];
    expect(await roadmapCommand.run(["frontier", "deployment-devops"], env, root)).toBe(1);
    expect(stderr()).toContain("deployment-devops-workflows");
    errs = [];
  });

  test("more than one ref is refused — the frontier is scoped to one node", async () => {
    const { root, env } = await setup();

    errs = [];
    expect(await roadmapCommand.run(["frontier", "a", "b"], env, root)).toBe(1);
    expect(stderr()).toContain("one");
    errs = [];
  });
});

describe("an empty frontier says WHY, and never reads as an empty store (F8)", () => {
  test("a store with nothing in it states both sections at zero", async () => {
    const { root, env } = await setup();

    const listed = await frontier(env, root);
    expect(listed).toContain("tickets (0):\n  (none)");
    expect(listed).toContain("work items (0):\n  (none)");
  });

  test("held-back tickets are counted by the reason they are held", async () => {
    const { root, env, map } = await setup();
    const first = await ticket(env, root, map, "which deploy target do we own?");
    await ticket(env, root, map, "which CD provider?", [first]);
    await ok(env, root, ["ticket", "claim", first], "agent:codex");

    const listed = await frontier(env, root);
    expect(listed).toContain("tickets (0):\n  (none) — 1 blocked, 1 claimed");
  });

  test("held-back work items are counted the same way, and a decided one is not a near miss", async () => {
    const { root, env } = await setup();
    const running = await work(env, root, "wire-the-gateway");
    await work(env, root, "add-refunds", ["--depends-on", running]);
    const claimed = await work(env, root, "unrelated-chore");
    await item(env, root, ["update", running, "--status", "in-progress"]);
    expect(await claimCommand.run([claimed], env, root, "human:jim")).toBe(0);
    expect(stderr()).toBe("");

    const listed = await frontier(env, root);
    // `wire-the-gateway` is in-progress — started work is not a near miss at
    // all, so only the two BACKLOG items held back are counted.
    expect(listed).toContain("work items (0):\n  (none) — 1 blocked by a dependency, 1 claimed");
  });
});

/**
 * The anti-waterfall rule (F8): blocking is ADVISORY everywhere. No command
 * refuses work because a blocker is open — an agent may deliberately start a
 * blocked item, and doing so journals the choice, naming every open blocker, so
 * it is visible rather than prevented.
 */
describe("starting a blocked item is recorded, never refused (F8)", () => {
  test("the start succeeds and journals the deliberate-start event naming EVERY open blocker", async () => {
    const { root, layout, env } = await setup();
    const first = await work(env, root, "schema-change");
    const second = await work(env, root, "wire-the-gateway");
    const settled = await work(env, root, "old-approach");
    await item(env, root, ["update", settled, "--status", "dropped"]);
    const blocked = await work(env, root, "add-refunds", [
      "--depends-on",
      first,
      "--depends-on",
      second,
      "--depends-on",
      settled,
    ]);

    // Nothing refuses — the start is an ordinary success.
    expect(await itemCommand.run(["update", blocked, "--status", "in-progress"], env, root)).toBe(0);
    expect(stderr()).toBe("");

    const started = (await journalEvents(layout)).filter(
      (event) => event.type === ITEM_STARTED_BLOCKED_EVENT_TYPE,
    );
    expect(started).toHaveLength(1);
    expect(started[0]!.item).toBe(blocked);
    expect(started[0]!.actor).toEqual({ kind: "agent", id: "claude-code" });
    // Every OPEN blocker, and only those: the dropped one has settled.
    expect(started[0]!.payload).toEqual({ from: "backlog", blockers: [first, second] });
  });

  test("the caller is told, in the same breath as the recording", async () => {
    const { root, env } = await setup();
    const dependency = await work(env, root, "schema-change");
    const blocked = await work(env, root, "add-refunds", ["--depends-on", dependency]);

    const before = logs.length;
    expect(await itemCommand.run(["update", blocked, "--status", "in-progress"], env, root)).toBe(0);
    const said = logs.slice(before).join("\n");
    expect(said).toContain(dependency);
    expect(said).toContain("advisory");
  });

  test("an unblocked start journals nothing extra — the event is about the CHOICE", async () => {
    const { root, layout, env } = await setup();
    const dependency = await work(env, root, "schema-change");
    await item(env, root, ["update", dependency, "--status", "done"]);
    const free = await work(env, root, "add-refunds", ["--depends-on", dependency]);

    await item(env, root, ["update", free, "--status", "in-progress"]);

    expect(
      (await journalEvents(layout)).filter((e) => e.type === ITEM_STARTED_BLOCKED_EVENT_TYPE),
    ).toEqual([]);
  });

  test("re-stating `in-progress` is not a second start", async () => {
    const { root, layout, env } = await setup();
    const dependency = await work(env, root, "schema-change");
    const blocked = await work(env, root, "add-refunds", ["--depends-on", dependency]);

    await item(env, root, ["update", blocked, "--status", "in-progress"]);
    await item(env, root, ["update", blocked, "--status", "in-progress", "--lane", "epic-lite"]);

    expect(
      (await journalEvents(layout)).filter((e) => e.type === ITEM_STARTED_BLOCKED_EVENT_TYPE),
    ).toHaveLength(1);
  });

  test("the started item leaves the frontier, and the whole path refused nothing", async () => {
    const { root, env } = await setup();
    const dependency = await work(env, root, "schema-change");
    const blocked = await work(env, root, "add-refunds", ["--depends-on", dependency]);
    expect(await frontier(env, root)).not.toContain(blocked);

    // Started while blocked, then carried all the way to done — no refusal
    // anywhere in the path, which is the acceptance criterion itself.
    for (const status of ["in-progress", "in-review", "done"]) {
      expect(await itemCommand.run(["update", blocked, "--status", status], env, root)).toBe(0);
    }
    expect(stderr()).toBe("");
  });

  // The type is SELF-RECORDED, so `nahel log` must refuse to hand-append it —
  // pinned in tests/commands/log.test.ts beside every other reserved type,
  // which is the one place that guard cannot be forgotten.
});

describe("multiple parallel `now`s are correct, never warned about (F8)", () => {
  test("three `now`-horizon nodes produce no validate finding at all", async () => {
    const { root, layout, env } = await setup();
    const product = lastId(
      await ok(env, root, [
        "node",
        "new",
        "product",
        "nahel",
        "--horizon",
        "now",
        "--intent",
        "The product.",
      ]),
    );
    for (const name of ["first-delta", "second-delta", "third-delta"]) {
      await ok(env, root, [
        "node",
        "new",
        "feature",
        name,
        "--horizon",
        "now",
        "--intent",
        "A delta.",
        "--parent",
        product,
      ]);
    }
    // The setup's own charted node is a fourth `now` with no product parent, so
    // it is moved under the product too — the shape under test is parallelism,
    // not an orphan.
    await ok(env, root, ["node", "update", "deployment-devops-workflows", "--parent", product]);

    const findings = await validateStore(layout, { now: env.now() });
    console.log("[parallel nows]", JSON.stringify(findings));
    expect(findings).toEqual([]);
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

  test("the hint names the item on the FIRST line, not whichever sorts first flat", async () => {
    const { root, env } = await setup();
    // The child is created BEFORE the item that ends up its parent, so the
    // store's flat `created` → `id` order starts with the child while the
    // rendered TREE starts with the parent. The two genuinely disagree, and a
    // hint that followed the flat order would point past the first line a
    // reader sees. (Same-second creation reaches the same disagreement through
    // the id tiebreak — this shape gets there without depending on the clock.)
    const child = await work(env, root, "add-refunds");
    const parent = await work(env, root, "payments-epic");
    await item(env, root, ["update", child, "--parent", parent]);

    const rendered = await frontier(env, root);
    const lines = rendered.split("\n").filter((line) => line.includes("  backlog  "));
    expect(lines[0]).toContain(parent);
    expect(lines[1]).toContain(child);
    expect(rendered).toContain(`↳ nahel progress --item ${parent}  —`);
  });
});

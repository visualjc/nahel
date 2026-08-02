import { afterEach, beforeEach, expect, spyOn, test, describe } from "bun:test";
import { rm } from "node:fs/promises";
import { itemCommand } from "../../src/commands/item";
import { logCommand } from "../../src/commands/log";
import { roadmapCommand } from "../../src/commands/roadmap";
import type { Env } from "../../src/schema/env";
import { ID_PATTERN } from "../../src/schema/id";
import type { JournalEvent } from "../../src/schema/records";
import { readJournal } from "../../src/store/journal";
import { ensureLayout, writeConfig, type StoreLayout } from "../../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel roadmap [ref]` (Phase 4 F3): the zooming view. Every case runs the
 * real command against a real temp-dir store, so what the tests exercise is
 * the whole read path — store → derivations → rendered text — and not a
 * renderer fed hand-built facts.
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

async function setup() {
  const root = await makeTempDir("nahel-roadmap-view-");
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig());
  const env = seededEnv({ tickSeconds: 1 });
  return { root, layout, env };
}

/** Run the roadmap command, expect success, and return everything it printed. */
async function view(env: Env, root: string, args: string[] = []): Promise<string> {
  const before = logs.length;
  const code = await roadmapCommand.run(args, env, root);
  expect(stderr()).toBe("");
  expect(code).toBe(0);
  return logs.slice(before).join("\n");
}

/** Create a node through the CLI and return its printed id. */
async function newNode(env: Env, root: string, args: string[]): Promise<string> {
  const before = logs.length;
  expect(await roadmapCommand.run(["node", "new", ...args], env, root)).toBe(0);
  const id = logs[before];
  expect(id).toMatch(ID_PATTERN);
  return id!;
}

/** Create a work item through the CLI and return its printed id. */
async function newItem(env: Env, root: string, args: string[]): Promise<string> {
  const before = logs.length;
  expect(await itemCommand.run(["new", ...args], env, root)).toBe(0);
  const id = logs[before];
  expect(id).toMatch(ID_PATTERN);
  return id!;
}

/** Record an open-extension event; `log` warns about the type, which is expected. */
async function log(env: Env, root: string, args: string[]): Promise<void> {
  expect(
    await logCommand.run(args, {
      env,
      cwd: root,
      stdout: (text: string) => logs.push(text),
      stderr: (text: string) => errs.push(text),
    }),
  ).toBe(0);
  errs = [];
}

async function journalEvents(layout: StoreLayout): Promise<JournalEvent[]> {
  return Array.fromAsync(readJournal(layout));
}

/**
 * One product with three features spanning the horizons: a built one (its epic's
 * only child is done), a planned one with no epic at all, and a later one.
 */
async function product(env: Env, root: string) {
  const nahel = await newNode(env, root, [
    "product",
    "nahel",
    "--horizon",
    "now",
    "--intent",
    "Durable, tool-agnostic project state.",
    "--design-doc",
    "docs/roadmap.md",
  ]);
  const epic = await newItem(env, root, ["plan", "detached-epic", "full"]);
  const leaf = await newItem(env, root, ["feature", "leaf-work", "direct", "--parent", epic]);
  expect(await itemCommand.run(["update", leaf, "--status", "done"], env, root)).toBe(0);
  const built = await newNode(env, root, [
    "feature",
    "detached-state-repo",
    "--horizon",
    "now",
    "--intent",
    "Get state out of the repo.",
    "--parent",
    "nahel",
    "--prd",
    "docs/prds/detached-state-repo.md",
    "--epic",
    epic,
  ]);
  const planned = await newNode(env, root, [
    "feature",
    "architecture-docs-wiki",
    "--horizon",
    "now",
    "--intent",
    "Publish the architecture docs.",
    "--parent",
    "nahel",
  ]);
  const later = await newNode(env, root, [
    "feature",
    "roadmap-mindmap-visualization",
    "--horizon",
    "later",
    "--intent",
    "Draw the tree.",
    "--parent",
    "nahel",
  ]);
  return { nahel, epic, leaf, built, planned, later };
}

describe("nahel roadmap — the product level (F3)", () => {
  test("one line per product node: name, kind, horizon, id, and the derived distribution", async () => {
    const { root, env } = await setup();
    const { nahel } = await product(env, root);

    const out = await view(env, root);
    expect(out).toContain(
      `nahel  product  horizon=now  id=${nahel}  1 built · 0 in-flight · 2 planned · 0 unknown`,
    );
  });

  test("feature children are grouped now → next → later, every bucket present with its count", async () => {
    const { root, env } = await setup();
    const { built, planned, later } = await product(env, root);

    const out = await view(env, root);
    expect(out).toContain("  now (2):");
    expect(out).toContain("  next (0):\n    (none)");
    expect(out).toContain("  later (1):");
    // The buckets print in horizon order, not in the order nodes were created.
    expect(out.indexOf("  now (2):")).toBeLessThan(out.indexOf("  next (0):"));
    expect(out.indexOf("  next (0):")).toBeLessThan(out.indexOf("  later (1):"));
    // Features sit inside their own bucket, in the id order the store returns.
    const nowBlock = out.slice(out.indexOf("  now (2):"), out.indexOf("  next (0):"));
    const ids = [built, planned].sort();
    expect(nowBlock.indexOf(ids[0]!)).toBeLessThan(nowBlock.indexOf(ids[1]!));
    expect(out.slice(out.indexOf("  later (1):"))).toContain(later);
  });

  test("each feature line carries the derived columns verbatim — F2's render-table strings", async () => {
    const { root, env } = await setup();
    const { built, planned, epic } = await product(env, root);
    await log(env, root, ["qa.sweep-completed", "--item", epic, "--data", "failed=2"]);
    const sweep = (await journalEvents(await ensureLayout(root))).filter(
      (event) => event.type === "qa.sweep-completed",
    );
    expect(sweep).toHaveLength(1);
    const ts = sweep[0]!.ts;

    const out = await view(env, root);
    expect(out).toContain(
      `    detached-state-repo  tested  dev=built  qa=tested ${ts} (2 failed)  deploy=—  release=—  id=${built}`,
    );
    expect(out).toContain(
      `    architecture-docs-wiki  planned  dev=planned  qa=—  deploy=—  release=—  id=${planned}`,
    );
  });

  test("several parallel `now`s render as the ordinary shape — nothing warns, nothing is singled out", async () => {
    const { root, env } = await setup();
    await product(env, root);
    await newNode(env, root, [
      "feature",
      "changelog-and-product-updates",
      "--horizon",
      "now",
      "--intent",
      "Ship the changelog.",
      "--parent",
      "nahel",
    ]);

    const out = await view(env, root);
    expect(out).toContain("  now (3):");
    expect(out).not.toContain("warning");
    expect(stderr()).toBe("");
  });

  test("a node outside every product's feature children still appears — nothing vanishes", async () => {
    const { root, env } = await setup();
    await product(env, root);
    const initiative = await newNode(env, root, [
      "initiative",
      "developer-experience",
      "--horizon",
      "next",
      "--intent",
      "The DX theme.",
      "--feature",
      "detached-state-repo",
    ]);
    const orphan = await newNode(env, root, [
      "feature",
      "unparented-feature",
      "--horizon",
      "later",
      "--intent",
      "No product above it yet.",
    ]);

    const out = await view(env, root);
    expect(out).toContain("outside the product tree (2):");
    expect(out).toContain(`  developer-experience  initiative  horizon=next  id=${initiative}`);
    expect(out).toContain(`  unparented-feature  feature  horizon=later  id=${orphan}`);
  });

  test("the section is absent, not an empty header, when every node sits under a product", async () => {
    const { root, env } = await setup();
    await product(env, root);

    expect(await view(env, root)).not.toContain("outside the product tree");
  });

  test("the rendering ends with a zoom hint naming a real child slug", async () => {
    const { root, env } = await setup();
    await product(env, root);

    const out = await view(env, root);
    const last = out.split("\n").filter((line) => line !== "").pop();
    expect(last).toStartWith("↳ nahel roadmap ");
    expect(last).toContain("architecture-docs-wiki");
  });

  test("an empty store says how to start, exits 0, and writes nothing", async () => {
    const { root, layout, env } = await setup();
    const before = await journalEvents(layout);

    const out = await view(env, root);
    expect(out).toContain("no roadmap yet");
    expect(out).toContain("nahel roadmap node new product");
    expect(await journalEvents(layout)).toEqual(before);
  });

  test("two consecutive renders are byte-identical and the store is untouched — a pure view", async () => {
    const { root, layout, env } = await setup();
    await product(env, root);
    const before = await journalEvents(layout);

    const first = await view(env, root);
    logs = [];
    const second = await view(env, root);
    expect(second).toBe(first);
    expect(await journalEvents(layout)).toEqual(before);
  });

  test("two product nodes both render, in the id order the store reads them back", async () => {
    const { root, env } = await setup();
    const { nahel } = await product(env, root);
    const second = await newNode(env, root, [
      "product",
      "speed-count",
      "--horizon",
      "next",
      "--intent",
      "The card-counting trainer.",
    ]);

    const out = await view(env, root);
    expect(out).toContain(`nahel  product  horizon=now  id=${nahel}`);
    expect(out).toContain(`speed-count  product  horizon=next  id=${second}  no features`);
    const [first, last] = [nahel, second].sort();
    expect(out.indexOf(`id=${first}`)).toBeLessThan(out.indexOf(`id=${last}`));
  });
});

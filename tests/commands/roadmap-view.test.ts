import { afterEach, beforeEach, expect, spyOn, test, describe } from "bun:test";
import { rm } from "node:fs/promises";
import { itemCommand } from "../../src/commands/item";
import { logCommand } from "../../src/commands/log";
import { progressCommand } from "../../src/commands/progress";
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

describe("nahel roadmap <ref> — zooming a node (F3)", () => {
  test("a product zoom: its own detail, the distribution, and its children by horizon", async () => {
    const { root, env } = await setup();
    const { nahel, built } = await product(env, root);

    const out = await view(env, root, ["nahel"]);
    expect(out).toContain(`nahel  product  horizon=now  id=${nahel}`);
    expect(out).toContain("  design_doc=docs/roadmap.md");
    expect(out).toContain("Durable, tool-agnostic project state.");
    expect(out).toContain("features: 1 built · 0 in-flight · 2 planned · 0 unknown");
    expect(out).toContain("  now (2):");
    expect(out).toContain(`  later (1):`);
    expect(out).toContain(`    detached-state-repo  built  dev=built`);
    // The top of the tree has no ancestors, so there is no breadcrumb to print.
    expect(out).not.toContain("›");
    expect(out).toContain(`id=${built}`);
  });

  test("a feature zoom: breadcrumb, its links, the derived columns, and the work under it", async () => {
    const { root, layout, env } = await setup();
    const { built, epic, leaf } = await product(env, root);
    await log(env, root, ["qa.sweep-completed", "--item", epic, "--data", "failed=0"]);
    const ts = (await journalEvents(layout)).find((e) => e.type === "qa.sweep-completed")!.ts;

    const out = await view(env, root, ["detached-state-repo"]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("nahel › detached-state-repo");
    expect(out).toContain(`detached-state-repo  feature  horizon=now  id=${built}`);
    expect(out).toContain("  prd=docs/prds/detached-state-repo.md");
    expect(out).toContain(`  epic=${epic}`);
    expect(out).toContain("Get state out of the repo.");
    expect(out).toContain(`status: tested  dev=built  qa=tested ${ts}  deploy=—  release=—`);
    expect(out).toContain("work items (2):");
    expect(out).toContain(`  detached-epic  plan  backlog  lane=full  id=${epic}`);
    expect(out).toContain(`    leaf-work  feature  done  lane=direct  id=${leaf}`);
  });

  test("the same node by slug and by id renders byte-identically", async () => {
    const { root, env } = await setup();
    const { built } = await product(env, root);

    const bySlug = await view(env, root, ["detached-state-repo"]);
    logs = [];
    expect(await view(env, root, [built])).toBe(bySlug);
  });

  test("a feature's initiative membership is on the zoom", async () => {
    const { root, env } = await setup();
    await product(env, root);
    const initiative = await newNode(env, root, [
      "initiative",
      "developer-experience",
      "--horizon",
      "now",
      "--intent",
      "The DX theme.",
      "--feature",
      "detached-state-repo",
    ]);

    expect(await view(env, root, ["detached-state-repo"])).toContain(`initiatives=${initiative}`);
  });

  test("a feature with no epic yet renders the node and SAYS so — it does not error", async () => {
    const { root, env } = await setup();
    await product(env, root);

    const out = await view(env, root, ["architecture-docs-wiki"]);
    expect(out).toContain("architecture-docs-wiki  feature  horizon=now");
    expect(out).toContain("Publish the architecture docs.");
    expect(out).toContain("status: planned  dev=planned");
    expect(out).toContain("work items: none — no epic recorded yet");
    expect(out).toContain("--epic");
  });

  test("a feature naming an epic no item record carries says exactly that", async () => {
    const { root, env } = await setup();
    await product(env, root);
    await newNode(env, root, [
      "feature",
      "dangling-epic",
      "--horizon",
      "next",
      "--intent",
      "Its epic never arrived.",
      "--parent",
      "nahel",
      "--epic",
      "aaaaaaaa",
    ]);

    const out = await view(env, root, ["dangling-epic"]);
    expect(out).toContain("status: unknown  dev=unknown");
    expect(out).toContain("work items: none — epic aaaaaaaa has no item record here");
  });

  test("an unfinished map and an in-flight epic render side by side, neither flagged (F8)", async () => {
    const { root, env } = await setup();
    const { epic } = await product(env, root);
    expect(await itemCommand.run(["update", epic, "--status", "in-progress"], env, root)).toBe(0);
    const child = await newItem(env, root, ["chore", "half-done", "direct", "--parent", epic]);
    expect(await itemCommand.run(["update", child, "--status", "in-progress"], env, root)).toBe(0);
    expect(
      await roadmapCommand.run(
        [
          "map",
          "new",
          "--node",
          "detached-state-repo",
          "--destination",
          "State lives outside the repo",
          "--fog",
          "how does a fresh clone bootstrap?",
        ],
        env,
        root,
      ),
    ).toBe(0);
    expect(
      await roadmapCommand.run(
        [
          "ticket",
          "new",
          "--map",
          "detached-state-repo",
          "--type",
          "research",
          "--question",
          "Which transport?",
        ],
        env,
        root,
      ),
    ).toBe(0);

    const out = await view(env, root, ["detached-state-repo"]);
    expect(out).toContain("status: in-flight  dev=in-flight");
    expect(out).toContain(
      'map: "State lives outside the repo"  tickets: 1 open · 0 claimed · 0 resolved · 0 closed',
    );
    expect(out).toContain("not yet specified (1)");
    expect(out.toLowerCase()).not.toContain("warning");
    expect(stderr()).toBe("");
  });

  test("a feature with no map says so, in the same place the chart would print", async () => {
    const { root, env } = await setup();
    await product(env, root);

    expect(await view(env, root, ["detached-state-repo"])).toContain("map: none charted");
  });

  test("the zoom ends with the drill hints: the work under the feature, and its chart", async () => {
    const { root, env } = await setup();
    const { epic } = await product(env, root);
    expect(
      await roadmapCommand.run(
        ["map", "new", "--node", "detached-state-repo", "--destination", "Out of the repo"],
        env,
        root,
      ),
    ).toBe(0);

    const out = await view(env, root, ["detached-state-repo"]);
    expect(out).toContain(`↳ nahel progress --item ${epic}`);
    expect(out).toContain("↳ nahel roadmap map show detached-state-repo");
  });

  test("a product zoom hints at zooming its children", async () => {
    const { root, env } = await setup();
    await product(env, root);

    const out = await view(env, root, ["nahel"]);
    const last = out.split("\n").filter((line) => line !== "").pop();
    expect(last).toStartWith("↳ nahel roadmap ");
    expect(last).toContain("architecture-docs-wiki");
  });

  test("two consecutive zooms are byte-identical and the store is untouched", async () => {
    const { root, layout, env } = await setup();
    await product(env, root);
    const before = await journalEvents(layout);

    const first = await view(env, root, ["detached-state-repo"]);
    logs = [];
    expect(await view(env, root, ["detached-state-repo"])).toBe(first);
    expect(await journalEvents(layout)).toEqual(before);
  });
});

describe("nahel roadmap <ref> — refs that miss, and where they point (F3)", () => {
  /** Run the command expecting a refusal, and return what it printed on stderr. */
  async function refuse(env: Env, root: string, args: string[]): Promise<string> {
    expect(await roadmapCommand.run(args, env, root)).toBe(1);
    return stderr();
  }

  test("an unknown ref exits non-zero and NAMES the near-miss slugs", async () => {
    const { root, env } = await setup();
    await product(env, root);

    const message = await refuse(env, root, ["detached-state"]);
    expect(message).toContain('"detached-state"');
    expect(message).toContain("detached-state-repo");
    // A slug sharing nothing with the ref is not offered as a guess.
    expect(message).not.toContain("architecture-docs-wiki");
  });

  test("near misses are alphabetical and capped, so the guess list cannot sprawl", async () => {
    const { root, env } = await setup();
    await product(env, root);
    for (const suffix of ["a", "b", "c", "d", "e", "f"]) {
      await newNode(env, root, [
        "feature",
        `deploy-${suffix}`,
        "--horizon",
        "next",
        "--intent",
        "one of many",
        "--parent",
        "nahel",
      ]);
    }

    const message = await refuse(env, root, ["deploy"]);
    const named = ["a", "b", "c", "d", "e", "f"].filter((suffix) =>
      message.includes(`deploy-${suffix}`),
    );
    expect(named).toEqual(["a", "b", "c", "d", "e"]);
    expect(message.indexOf("deploy-a")).toBeLessThan(message.indexOf("deploy-b"));
  });

  test("a ref that resembles nothing is still told where the list is", async () => {
    const { root, env } = await setup();
    await product(env, root);

    const message = await refuse(env, root, ["zzzzzz"]);
    expect(message).toContain("nahel roadmap");
    expect(message).not.toContain("did you mean");
  });

  test("a WORK-ITEM id is not an unknown ref — it points at the item's own view", async () => {
    const { root, env } = await setup();
    const { epic } = await product(env, root);

    const message = await refuse(env, root, [epic]);
    expect(message).toContain(`nahel progress --item ${epic}`);
    expect(message).toContain("work item");
    expect(message).not.toContain("does not name");
  });

  test("two refs are refused — the zoom takes exactly one", async () => {
    const { root, env } = await setup();
    await product(env, root);

    expect(await refuse(env, root, ["nahel", "detached-state-repo"])).toContain("one ref");
  });

  test("a node named after a subcommand is reached through `node show`, and the verb keeps the word", async () => {
    const { root, env } = await setup();
    await product(env, root);
    await newNode(env, root, ["feature", "map", "--horizon", "now", "--intent", "an awkward slug"]);

    // The verb wins the word: `roadmap map` is still the map subcommand.
    expect(await refuse(env, root, ["map"])).toContain("map");
    logs = [];
    expect(await roadmapCommand.run(["node", "show", "map"], env, root)).toBe(0);
    expect(logs.join("\n")).toContain("map  feature  horizon=now");
  });

  test("a rendering with nothing under it still ends with a hint — back to the product level", async () => {
    const { root, env } = await setup();
    await product(env, root);

    const out = await view(env, root, ["architecture-docs-wiki"]);
    const last = out.split("\n").filter((line) => line !== "").pop();
    expect(last).toBe("↳ nahel roadmap  — back to the product level");
  });
});

describe("the zoom hints are the drill path, and they run (F3)", () => {
  /** Every hint line a rendering ends with. */
  function hints(out: string): string[] {
    return out.split("\n").filter((line) => line.startsWith("↳ "));
  }

  /**
   * Follow one hint the way a reader does: run exactly the command it names —
   * the text between the arrow and the dash — and return what it printed.
   */
  async function follow(env: Env, root: string, hint: string): Promise<string> {
    const command = hint.slice("↳ ".length, hint.indexOf("  — "));
    const [nahel, verb, ...args] = command.split(" ");
    expect(nahel).toBe("nahel");
    const before = logs.length;
    if (verb === "roadmap") {
      expect(await roadmapCommand.run(args, env, root)).toBe(0);
    } else if (verb === "progress") {
      expect(
        await progressCommand.run(args, {
          env,
          cwd: root,
          stdout: (text: string) => logs.push(text),
          stderr: (text: string) => errs.push(text),
        }),
      ).toBe(0);
    } else {
      throw new Error(`hint names a verb no reader can run: ${JSON.stringify(command)}`);
    }
    expect(stderr()).toBe("");
    return logs.slice(before).join("\n");
  }

  test("every hint printed anywhere in the view is a command that runs verbatim", async () => {
    const { root, env } = await setup();
    await product(env, root);
    expect(
      await roadmapCommand.run(
        ["map", "new", "--node", "detached-state-repo", "--destination", "Out of the repo"],
        env,
        root,
      ),
    ).toBe(0);

    const renderings = [
      await view(env, root),
      await view(env, root, ["nahel"]),
      await view(env, root, ["detached-state-repo"]),
      await view(env, root, ["architecture-docs-wiki"]),
    ];
    const followed: string[] = [];
    for (const rendering of renderings) {
      const lines = hints(rendering);
      expect(lines.length).toBeGreaterThan(0);
      for (const hint of lines) followed.push(await follow(env, root, hint));
    }
    expect(followed).toHaveLength(6);
    for (const output of followed) expect(output).not.toBe("");
  });

  test("the three orientation questions, three commands, each answer in the output", async () => {
    const { root, env } = await setup();
    const { epic, leaf } = await product(env, root);

    // Where are we with the product?
    const wide = await view(env, root);
    expect(wide).toContain("nahel  product");
    expect(wide).toContain("1 built · 0 in-flight · 2 planned · 0 unknown");
    // Where is feature A? — by the slug the first answer printed.
    expect(wide).toContain("detached-state-repo");
    const feature = await view(env, root, ["detached-state-repo"]);
    expect(feature).toContain("status: built  dev=built");
    // Where is feature A item 2? — by the hint the second answer printed.
    const hint = hints(feature).find((line) => line.includes("progress --item"));
    expect(hint).toBeDefined();
    const timeline = await follow(env, root, hint!);
    expect(timeline).toContain(epic);
    expect(timeline).toContain(leaf);
  });
});

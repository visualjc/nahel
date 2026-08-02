import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { itemCommand } from "../../src/commands/item";
import { roadmapCommand } from "../../src/commands/roadmap";
import type { Env } from "../../src/schema/env";
import { ID_PATTERN } from "../../src/schema/id";
import type { JournalEvent } from "../../src/schema/records";
import { readJournal } from "../../src/store/journal";
import {
  ensureLayout,
  listRoadmapNodes,
  readRoadmapNode,
  resolveRoadmapNode,
  writeConfig,
  type StoreLayout,
} from "../../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel roadmap node` (Phase 4 F1): the roadmap node write and read-back
 * surface. Every act goes through the real command object against a real
 * temp-dir store (item.test.ts / observe.test.ts style), so "entirely through
 * the CLI — no hand-editing anywhere" (HC3) is what the tests exercise.
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

function stdout(): string {
  return logs.join("\n");
}

async function setup() {
  const root = await makeTempDir("nahel-cmd-roadmap-");
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig());
  const env = seededEnv({ tickSeconds: 1 });
  return { root, layout, env };
}

/** Run the command, expect success, and return everything it printed. */
async function ok(env: Env, root: string, args: string[], actor?: string): Promise<string[]> {
  const before = logs.length;
  const code = await roadmapCommand.run(args, env, root, actor);
  expect(stderr()).toBe("");
  expect(code).toBe(0);
  return logs.slice(before);
}

/** Create a node through the CLI and return its printed id. */
async function newNode(env: Env, root: string, args: string[], actor?: string): Promise<string> {
  const printed = await ok(env, root, ["node", "new", ...args], actor);
  const id = printed[printed.length - 1];
  if (id === undefined) throw new Error("roadmap node new printed nothing");
  expect(id).toMatch(ID_PATTERN);
  return id;
}

async function journalEvents(layout: StoreLayout): Promise<JournalEvent[]> {
  return Array.fromAsync(readJournal(layout));
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

describe("nahel roadmap node new — one record, three kinds", () => {
  test("creates a product node with its design doc and ADR refs, journaled with actor attribution", async () => {
    const { root, layout, env } = await setup();
    const id = await newNode(env, root, [
      "product",
      "nahel",
      "--horizon",
      "now",
      "--intent",
      "Durable, tool-agnostic project state for agentic development.",
      "--design-doc",
      "docs/roadmap.md",
      "--adr",
      "docs/adr/0012-merge-safe-state.md",
      "--adr",
      "docs/adr/0004-determinism.md",
    ]);

    const { frontmatter, body } = await readRoadmapNode(layout, id);
    expect(frontmatter.kind).toBe("product");
    expect(frontmatter.name).toBe("nahel");
    expect(frontmatter.horizon).toBe("now");
    expect(frontmatter.design_doc).toBe("docs/roadmap.md");
    // Recorded order, not sorted: the ADR list is a sequence.
    expect(frontmatter.adrs).toEqual([
      "docs/adr/0012-merge-safe-state.md",
      "docs/adr/0004-determinism.md",
    ]);
    expect(body).toBe("Durable, tool-agnostic project state for agentic development.\n");

    const events = (await journalEvents(layout)).filter((e) => e.type.startsWith("roadmap."));
    expect(events.map((e) => e.type)).toEqual(["roadmap.node-created"]);
    expect(events[0]!.actor).toEqual({ kind: "agent", id: "claude-code" });
    expect((events[0]!.payload["record"] as { id: string }).id).toBe(id);
  });

  test("creates a feature node under the product with its prd and epic item id", async () => {
    const { root, layout, env } = await setup();
    const product = await newNode(env, root, ["product", "nahel", "--horizon", "now", "--intent", "the product"]);
    const feature = await newNode(env, root, [
      "feature",
      "detached-state-repo",
      "--horizon",
      "next",
      "--intent",
      "Move nahel state out of the app repo.",
      "--parent",
      "nahel",
      "--prd",
      "docs/prds/detached-state-repo.md",
      "--epic",
      "0gz8r4cm",
    ]);

    const { frontmatter } = await readRoadmapNode(layout, feature);
    // --parent took a SLUG and resolved it to the parent's id.
    expect(frontmatter.parent).toBe(product);
    expect(frontmatter.horizon).toBe("next");
    expect(frontmatter.prd).toBe("docs/prds/detached-state-repo.md");
    expect(frontmatter.epic).toBe("0gz8r4cm");
  });

  test("creates an initiative node linking two feature nodes sideways", async () => {
    const { root, layout, env } = await setup();
    const a = await newNode(env, root, ["feature", "feature-a", "--horizon", "now", "--intent", "a"]);
    const b = await newNode(env, root, ["feature", "feature-b", "--horizon", "now", "--intent", "b"]);
    const initiative = await newNode(env, root, [
      "initiative",
      "developer-experience",
      "--horizon",
      "now",
      "--intent",
      "Make the first hour delightful.",
      "--feature",
      "feature-a",
      "--feature",
      "feature-b",
    ]);

    expect((await readRoadmapNode(layout, initiative)).frontmatter.features).toEqual([a, b]);
  });

  test("refuses a duplicate slug at creation, naming the holder — and writes nothing", async () => {
    const { root, layout, env } = await setup();
    await newNode(env, root, ["feature", "detached-state-repo", "--horizon", "now", "--intent", "first"]);

    const code = await roadmapCommand.run(
      ["node", "new", "feature", "detached-state-repo", "--horizon", "later", "--intent", "second"],
      env,
      root,
    );
    expect(code).toBe(1);
    expect(stderr()).toContain("detached-state-repo");
    expect(await listRoadmapNodes(layout)).toHaveLength(1);
  });

  test("requires a horizon and an intent — a node with neither states nothing", async () => {
    const { root, layout, env } = await setup();
    expect(await roadmapCommand.run(["node", "new", "feature", "no-horizon", "--intent", "x"], env, root)).toBe(1);
    expect(stderr()).toContain("horizon");
    errs = [];
    expect(await roadmapCommand.run(["node", "new", "feature", "no-intent", "--horizon", "now"], env, root)).toBe(1);
    expect(stderr()).toContain("intent");
    expect(await listRoadmapNodes(layout)).toEqual([]);
  });

  test("refuses an unknown kind, horizon, or non-slug name with the legal values", async () => {
    const { root, env } = await setup();
    expect(
      await roadmapCommand.run(["node", "new", "epic", "x", "--horizon", "now", "--intent", "y"], env, root),
    ).toBe(1);
    expect(stderr()).toContain("initiative");
    errs = [];
    expect(
      await roadmapCommand.run(["node", "new", "feature", "x", "--horizon", "someday", "--intent", "y"], env, root),
    ).toBe(1);
    expect(stderr()).toContain("later");
    errs = [];
    expect(
      await roadmapCommand.run(["node", "new", "feature", "Not A Slug", "--horizon", "now", "--intent", "y"], env, root),
    ).toBe(1);
    expect(stderr()).toContain("slug");
  });

  test("soft structural rules: a feature under a feature is CREATED, never refused (F1)", async () => {
    const { root, layout, env } = await setup();
    const parent = await newNode(env, root, ["feature", "parent-feature", "--horizon", "now", "--intent", "p"]);
    const child = await newNode(env, root, [
      "feature",
      "child-feature",
      "--horizon",
      "now",
      "--intent",
      "c",
      "--parent",
      "parent-feature",
    ]);
    expect((await readRoadmapNode(layout, child)).frontmatter.parent).toBe(parent);
  });

  test("a link ref must be a known slug or a well-formed id — a typo'd slug is refused, a bare id is not", async () => {
    const { root, layout, env } = await setup();
    const code = await roadmapCommand.run(
      ["node", "new", "feature", "orphan", "--horizon", "now", "--intent", "x", "--parent", "no-such-node"],
      env,
      root,
    );
    expect(code).toBe(1);
    expect(stderr()).toContain("no-such-node");
    expect(await listRoadmapNodes(layout)).toEqual([]);

    // A bare id is a raw reference: the node it names may arrive by a later
    // merge (ADR-0012), so it is recorded and left to `nahel validate`.
    errs = [];
    const id = await newNode(env, root, [
      "feature",
      "orphan",
      "--horizon",
      "now",
      "--intent",
      "x",
      "--parent",
      "zzzzzzzz",
    ]);
    expect((await readRoadmapNode(layout, id)).frontmatter.parent).toBe("zzzzzzzz");
  });
});

describe("nahel roadmap node update — rename, re-parent, re-horizon", () => {
  test("renames, re-parents, and re-horizons through the CLI, each journaled", async () => {
    const { root, layout, env } = await setup();
    const product = await newNode(env, root, ["product", "nahel", "--horizon", "now", "--intent", "p"]);
    const node = await newNode(env, root, ["feature", "old-name", "--horizon", "later", "--intent", "i"]);

    await ok(env, root, ["node", "update", "old-name", "--name", "new-name"]);
    await ok(env, root, ["node", "update", "new-name", "--parent", "nahel"]);
    await ok(env, root, ["node", "update", "new-name", "--horizon", "now"]);

    const { frontmatter } = await readRoadmapNode(layout, node);
    expect(frontmatter.name).toBe("new-name");
    expect(frontmatter.parent).toBe(product);
    expect(frontmatter.horizon).toBe("now");
    expect(frontmatter.created).not.toBe(frontmatter.updated);

    const updates = (await journalEvents(layout)).filter((e) => e.type === "roadmap.node-updated");
    expect(updates).toHaveLength(3);
    for (const event of updates) {
      expect(event.actor).toEqual({ kind: "agent", id: "claude-code" });
    }
    // The horizon change is journaled as itself, carrying the record that set
    // it — what F4's horizon-entry ordering reads back.
    expect((updates[2]!.payload["record"] as { horizon: string }).horizon).toBe("now");
  });

  test("a rename onto an existing slug is refused — slugs stay unique per store", async () => {
    const { root, layout, env } = await setup();
    await newNode(env, root, ["feature", "taken", "--horizon", "now", "--intent", "a"]);
    const other = await newNode(env, root, ["feature", "other", "--horizon", "now", "--intent", "b"]);

    const code = await roadmapCommand.run(["node", "update", "other", "--name", "taken"], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain("taken");
    expect((await readRoadmapNode(layout, other)).frontmatter.name).toBe("other");
  });

  test("renaming a node to its own current name is not a duplicate", async () => {
    const { root, layout, env } = await setup();
    const id = await newNode(env, root, ["feature", "same", "--horizon", "now", "--intent", "a"]);
    await ok(env, root, ["node", "update", "same", "--name", "same", "--horizon", "later"]);
    expect((await readRoadmapNode(layout, id)).frontmatter.horizon).toBe("later");
  });

  test("--intent replaces the intent prose; the record's links are untouched", async () => {
    const { root, layout, env } = await setup();
    const id = await newNode(env, root, [
      "feature",
      "restated",
      "--horizon",
      "now",
      "--intent",
      "first statement",
      "--prd",
      "docs/prds/restated.md",
    ]);
    await ok(env, root, ["node", "update", "restated", "--intent", "sharper statement"]);
    const record = await readRoadmapNode(layout, id);
    expect(record.body).toBe("sharper statement\n");
    expect(record.frontmatter.prd).toBe("docs/prds/restated.md");
  });

  test("clear flags remove the field; each is mutually exclusive with its setter", async () => {
    const { root, layout, env } = await setup();
    const id = await newNode(env, root, [
      "feature",
      "clearable",
      "--horizon",
      "now",
      "--intent",
      "i",
      "--prd",
      "docs/prds/clearable.md",
      "--epic",
      "0gz8r4cm",
      "--parent",
      "zzzzzzzz",
    ]);
    await ok(env, root, ["node", "update", "clearable", "--clear-prd", "--clear-epic", "--clear-parent"]);
    const { frontmatter } = await readRoadmapNode(layout, id);
    expect("prd" in frontmatter).toBe(false);
    expect("epic" in frontmatter).toBe(false);
    expect("parent" in frontmatter).toBe(false);

    const code = await roadmapCommand.run(
      ["node", "update", "clearable", "--prd", "docs/prds/x.md", "--clear-prd"],
      env,
      root,
    );
    expect(code).toBe(1);
    expect(stderr()).toContain("mutually exclusive");
  });

  test("repeated --adr and --feature replace the whole list, in the order given", async () => {
    const { root, layout, env } = await setup();
    const a = await newNode(env, root, ["feature", "feature-a", "--horizon", "now", "--intent", "a"]);
    const b = await newNode(env, root, ["feature", "feature-b", "--horizon", "now", "--intent", "b"]);
    const id = await newNode(env, root, [
      "initiative",
      "theme",
      "--horizon",
      "now",
      "--intent",
      "t",
      "--feature",
      "feature-a",
    ]);
    await ok(env, root, ["node", "update", "theme", "--feature", "feature-b", "--feature", "feature-a"]);
    expect((await readRoadmapNode(layout, id)).frontmatter.features).toEqual([b, a]);

    await ok(env, root, [
      "node",
      "update",
      "theme",
      "--adr",
      "docs/adr/0002-b.md",
      "--adr",
      "docs/adr/0001-a.md",
    ]);
    expect((await readRoadmapNode(layout, id)).frontmatter.adrs).toEqual([
      "docs/adr/0002-b.md",
      "docs/adr/0001-a.md",
    ]);
  });

  test("refuses an update with nothing to change, and an unknown ref", async () => {
    const { root, env } = await setup();
    await newNode(env, root, ["feature", "known", "--horizon", "now", "--intent", "i"]);
    expect(await roadmapCommand.run(["node", "update", "known"], env, root)).toBe(1);
    expect(stderr()).toContain("nothing to update");
    errs = [];
    expect(await roadmapCommand.run(["node", "update", "ghost", "--horizon", "now"], env, root)).toBe(1);
    expect(stderr()).toContain("ghost");
  });

  test("a node cannot be its own parent", async () => {
    const { root, env } = await setup();
    await newNode(env, root, ["feature", "selfish", "--horizon", "now", "--intent", "i"]);
    expect(await roadmapCommand.run(["node", "update", "selfish", "--parent", "selfish"], env, root)).toBe(1);
    expect(stderr()).toContain("own parent");
  });
});

describe("nahel roadmap node show — reading the node back", () => {
  test("a node reads back by slug and by id with byte-identical output", async () => {
    const { root, env } = await setup();
    const id = await newNode(env, root, [
      "product",
      "nahel",
      "--horizon",
      "now",
      "--intent",
      "Durable project state.",
      "--design-doc",
      "docs/roadmap.md",
      "--adr",
      "docs/adr/0012-merge-safe-state.md",
    ]);

    const bySlug = (await ok(env, root, ["node", "show", "nahel"])).join("\n");
    logs = [];
    const byId = (await ok(env, root, ["node", "show", id])).join("\n");
    expect(byId).toBe(bySlug);
    expect(bySlug).toContain("nahel");
    expect(bySlug).toContain("product");
    expect(bySlug).toContain("horizon=now");
    expect(bySlug).toContain(`id=${id}`);
    expect(bySlug).toContain("design_doc=docs/roadmap.md");
    expect(bySlug).toContain("docs/adr/0012-merge-safe-state.md");
    expect(bySlug).toContain("Durable project state.");
  });

  test("shows a feature's lineage BOTH ways: predecessor from the successor, successor from the predecessor", async () => {
    const { root, env } = await setup();
    const old = await newNode(env, root, ["feature", "search-v1", "--horizon", "later", "--intent", "first delta"]);
    const next = await newNode(env, root, [
      "feature",
      "search-v2",
      "--horizon",
      "now",
      "--intent",
      "second delta",
      "--predecessor",
      "search-v1",
    ]);

    const successorView = (await ok(env, root, ["node", "show", "search-v2"])).join("\n");
    expect(successorView).toContain(`predecessor=${old}`);
    logs = [];
    const predecessorView = (await ok(env, root, ["node", "show", "search-v1"])).join("\n");
    expect(predecessorView).toContain(`successors=${next}`);
  });

  test("shows a feature's initiative membership, and the initiative's own links", async () => {
    const { root, env } = await setup();
    const a = await newNode(env, root, ["feature", "feature-a", "--horizon", "now", "--intent", "a"]);
    const b = await newNode(env, root, ["feature", "feature-b", "--horizon", "now", "--intent", "b"]);
    const initiative = await newNode(env, root, [
      "initiative",
      "developer-experience",
      "--horizon",
      "now",
      "--intent",
      "dx",
      "--feature",
      "feature-a",
      "--feature",
      "feature-b",
    ]);

    const featureView = (await ok(env, root, ["node", "show", "feature-a"])).join("\n");
    expect(featureView).toContain(`initiatives=${initiative}`);
    logs = [];
    const initiativeView = (await ok(env, root, ["node", "show", "developer-experience"])).join("\n");
    expect(initiativeView).toContain(`features=${a}, ${b}`);
  });

  test("an unknown ref exits non-zero naming it, and show mutates nothing", async () => {
    const { root, layout, env } = await setup();
    await newNode(env, root, ["feature", "known", "--horizon", "now", "--intent", "i"]);
    const before = await journalEvents(layout);
    const code = await roadmapCommand.run(["node", "show", "unknown-node"], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain("unknown-node");
    expect(await journalEvents(layout)).toEqual(before);
  });

  test("two consecutive shows are byte-identical — the read is pure", async () => {
    const { root, env } = await setup();
    await newNode(env, root, ["feature", "stable", "--horizon", "now", "--intent", "i"]);
    const first = (await ok(env, root, ["node", "show", "stable"])).join("\n");
    logs = [];
    const second = (await ok(env, root, ["node", "show", "stable"])).join("\n");
    expect(second).toBe(first);
  });
});

describe("nahel roadmap node — the canonical one-way direction", () => {
  test("git diff over nahel/items/ is EMPTY across creating and linking nodes", async () => {
    const { root, layout, env } = await setup();
    // A real epic item, committed, so git can witness any byte that changes.
    const before = logs.length;
    expect(await itemCommand.run(["new", "feature", "detached-state-repo", "full"], env, root)).toBe(0);
    const epic = logs[before]!;

    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "commit.gpgsign", "false");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "state before the roadmap layer");

    await newNode(env, root, ["product", "nahel", "--horizon", "now", "--intent", "the product"]);
    await newNode(env, root, [
      "feature",
      "detached-state-repo",
      "--horizon",
      "now",
      "--intent",
      "Move state out.",
      "--parent",
      "nahel",
      "--epic",
      epic,
    ]);
    await ok(env, root, ["node", "update", "detached-state-repo", "--horizon", "next"]);

    // The whole node↔item relationship lives on the node: not one item record
    // byte moved. A run that touched an item record fails this criterion.
    expect(git(root, "status", "--porcelain", "nahel/items")).toBe("");
    expect(git(root, "diff", "--", "nahel/items")).toBe("");
    // …and the nodes really do exist and really do point at the item.
    const nodes = await listRoadmapNodes(layout);
    expect(nodes).toHaveLength(2);
    const feature = await resolveRoadmapNode(layout, "detached-state-repo");
    expect(feature?.frontmatter.epic).toBe(epic);
  });
});

describe("nahel roadmap — usage surface", () => {
  test("--help prints the node verbs without touching the store", async () => {
    const { root, layout, env } = await setup();
    expect(await roadmapCommand.run(["--help"], env, root)).toBe(0);
    expect(stdout()).toContain("roadmap node new");
    expect(stdout()).toContain("roadmap node update");
    expect(stdout()).toContain("roadmap node show");
    expect(await listRoadmapNodes(layout)).toEqual([]);
  });

  test("an unknown subcommand exits non-zero naming what is expected", async () => {
    const { root, env } = await setup();
    expect(await roadmapCommand.run(["frontier"], env, root)).toBe(1);
    expect(stderr()).toContain("node");
  });
});

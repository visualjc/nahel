import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { roadmapCommand } from "../../src/commands/roadmap";
import type { Env } from "../../src/schema/env";
import { ID_PATTERN } from "../../src/schema/id";
import type { JournalEvent } from "../../src/schema/records";
import { readJournal } from "../../src/store/journal";
import {
  ensureLayout,
  listMaps,
  readMap,
  resolveMap,
  writeConfig,
  type StoreLayout,
} from "../../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel roadmap map` (Phase 4 F7): charting a wayfinder map on a roadmap
 * node — destination, notes, fog and out-of-scope — entirely through the CLI
 * (HC3), every act journaled with actor attribution.
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
  const root = await makeTempDir("nahel-cmd-map-");
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig());
  const env = seededEnv({ tickSeconds: 1 });
  return { root, layout, env };
}

async function ok(env: Env, root: string, args: string[], actor?: string): Promise<string[]> {
  const before = logs.length;
  const code = await roadmapCommand.run(args, env, root, actor);
  expect(stderr()).toBe("");
  expect(code).toBe(0);
  return logs.slice(before);
}

async function fails(env: Env, root: string, args: string[]): Promise<string> {
  errs = [];
  expect(await roadmapCommand.run(args, env, root)).toBe(1);
  return stderr();
}

async function printedId(printed: string[]): Promise<string> {
  const id = printed[printed.length - 1]!;
  expect(id).toMatch(ID_PATTERN);
  return id;
}

/** A store with one feature node to chart. */
async function withNode() {
  const { root, layout, env } = await setup();
  const printed = await ok(env, root, [
    "node",
    "new",
    "feature",
    "deployment-devops-workflows",
    "--horizon",
    "now",
    "--intent",
    "Deploy and release, drivable by a fresh agent.",
  ]);
  return { root, layout, env, node: await printedId(printed) };
}

async function journalEvents(layout: StoreLayout): Promise<JournalEvent[]> {
  return Array.fromAsync(readJournal(layout));
}

describe("nahel roadmap map new — the chart attached to a node", () => {
  test("charts a map with all five sections and prints its id, journaled with actor attribution", async () => {
    const { root, layout, env, node } = await withNode();
    const id = await printedId(
      await ok(
        env,
        root,
        [
          "map",
          "new",
          "--node",
          "deployment-devops-workflows",
          "--destination",
          "a deploy a fresh agent can drive with no tribal knowledge",
          "--notes",
          "Two stores to cover; the CLI already records the events.",
          "--fog",
          "how does a rollback get journaled?",
          "--fog",
          "who owns the release notes?",
          "--out-of-scope",
          "marketing announcements",
        ],
        "human:jim",
      ),
    );

    const map = await readMap(layout, id);
    expect(map.frontmatter.node).toBe(node);
    expect(map.frontmatter.destination).toBe(
      "a deploy a fresh agent can drive with no tribal knowledge",
    );
    expect(map.frontmatter.fog).toEqual([
      "how does a rollback get journaled?",
      "who owns the release notes?",
    ]);
    expect(map.frontmatter.out_of_scope).toEqual([{ reason: "marketing announcements" }]);
    expect(map.frontmatter.decisions).toEqual([]);
    expect(map.body).toBe("Two stores to cover; the CLI already records the events.\n");

    const created = (await journalEvents(layout)).find((e) => e.type === "roadmap.map-created")!;
    expect(created.actor).toEqual({ kind: "human", id: "jim" });
    expect(created.payload).toEqual({
      target: "map",
      record: map.frontmatter,
      body: map.body,
    });
  });

  test("a map without a destination is refused — a map that charts nowhere charts nothing", async () => {
    const { root, env } = await withNode();
    expect(
      await fails(env, root, ["map", "new", "--node", "deployment-devops-workflows"]),
    ).toContain("--destination");
  });

  test("the node ref may be a slug or an id, and an unknown SLUG is refused", async () => {
    const { root, layout, env, node } = await withNode();
    const id = await printedId(
      await ok(env, root, ["map", "new", "--node", node, "--destination", "by id"]),
    );
    expect((await readMap(layout, id)).frontmatter.node).toBe(node);
    expect(await fails(env, root, ["map", "new", "--node", "no-such-node", "--destination", "x"]))
      .toContain("no-such-node");
  });

  test("a second map on the same node is refused, naming the map that already charts it", async () => {
    const { root, env, node } = await withNode();
    await ok(env, root, ["map", "new", "--node", node, "--destination", "first"]);
    const message = await fails(env, root, [
      "map",
      "new",
      "--node",
      "deployment-devops-workflows",
      "--destination",
      "second",
    ]);
    expect(message).toContain("already");
    expect(message).toContain("deployment-devops-workflows");
  });
});

describe("nahel roadmap map update — the sections move through the CLI", () => {
  async function charted() {
    const { root, layout, env, node } = await withNode();
    const map = await printedId(
      await ok(env, root, [
        "map",
        "new",
        "--node",
        node,
        "--destination",
        "a deploy a fresh agent can drive",
        "--notes",
        "first notes",
        "--fog",
        "how does a rollback get journaled?",
      ]),
    );
    return { root, layout, env, node, map };
  }

  test("re-states the destination and the notes, journaling the update", async () => {
    const { root, layout, env, map } = await charted();
    await ok(env, root, [
      "map",
      "update",
      "deployment-devops-workflows",
      "--destination",
      "a deploy AND a release a fresh agent can drive",
      "--notes",
      "second notes",
    ]);
    const record = await readMap(layout, map);
    expect(record.frontmatter.destination).toBe(
      "a deploy AND a release a fresh agent can drive",
    );
    expect(record.body).toBe("second notes\n");
    expect(record.frontmatter.updated).not.toBe(record.frontmatter.created);
    expect((await journalEvents(layout)).map((e) => e.type)).toContain("roadmap.map-updated");
  });

  test("repeatable --fog replaces the whole section; --clear-fog empties it — the graduation path", async () => {
    const { root, layout, env, map } = await charted();
    // Graduating one fog line into a ticket means re-stating what is LEFT.
    await ok(env, root, ["map", "update", map, "--fog", "who owns the release notes?"]);
    expect((await readMap(layout, map)).frontmatter.fog).toEqual([
      "who owns the release notes?",
    ]);
    await ok(env, root, ["map", "update", map, "--clear-fog"]);
    expect((await readMap(layout, map)).frontmatter.fog).toEqual([]);
  });

  test("--fog and --clear-fog together are refused — the intent is ambiguous", async () => {
    const { root, env, map } = await charted();
    expect(await fails(env, root, ["map", "update", map, "--fog", "x", "--clear-fog"])).toContain(
      "mutually exclusive",
    );
  });

  test("an update with no flags is refused rather than journaling a no-op", async () => {
    const { root, env, map } = await charted();
    expect(await fails(env, root, ["map", "update", map])).toContain("nothing to update");
  });

  test("an unknown map ref is refused naming what a ref may be", async () => {
    const { root, env } = await charted();
    expect(await fails(env, root, ["map", "update", "no-such-map", "--notes", "x"])).toContain(
      "no-such-map",
    );
  });

  test("there is no flag that sets a decision — decisions are recorded by resolving a ticket", async () => {
    const { root, env, map } = await charted();
    expect(await fails(env, root, ["map", "update", map, "--decision", "we chose X"])).toContain(
      "resolve",
    );
  });
});

describe("nahel roadmap map show — the whole chart in one read", () => {
  test("prints every section, the node it charts, and its tickets", async () => {
    const { root, layout, env, node } = await withNode();
    const map = await printedId(
      await ok(env, root, [
        "map",
        "new",
        "--node",
        node,
        "--destination",
        "a deploy a fresh agent can drive",
        "--notes",
        "two stores to cover",
        "--fog",
        "how does a rollback get journaled?",
        "--out-of-scope",
        "marketing announcements",
      ]),
    );
    const ticket = await printedId(
      await ok(env, root, [
        "ticket",
        "new",
        "--map",
        map,
        "--type",
        "research",
        "--question",
        "which deploy target do we own?",
      ]),
    );

    const printed = (await ok(env, root, ["map", "show", "deployment-devops-workflows"])).join(
      "\n",
    );
    expect(printed).toContain("deployment-devops-workflows");
    expect(printed).toContain(`id=${map}`);
    expect(printed).toContain("destination=a deploy a fresh agent can drive");
    expect(printed).toContain("two stores to cover");
    expect(printed).toContain("how does a rollback get journaled?");
    expect(printed).toContain("marketing announcements");
    expect(printed).toContain(ticket);
    expect(printed).toContain("research");
    expect(printed).toContain("open");
    // Empty sections say so rather than vanishing — an omitted heading reads
    // as a section that was never charted.
    expect(printed).toContain("decisions so far");
    expect(printed).toContain("(none)");

    // Reading changes nothing, and two reads are byte-identical (HC1).
    const again = (await ok(env, root, ["map", "show", map])).join("\n");
    expect(again).toBe(printed);
    expect(await listMaps(layout)).toEqual([map]);
    expect((await resolveMap(layout, node))?.frontmatter.id).toBe(map);
  });

  test("an unknown ref exits non-zero naming the ref", async () => {
    const { root, env } = await withNode();
    expect(await fails(env, root, ["map", "show", "nope"])).toContain("nope");
  });
});

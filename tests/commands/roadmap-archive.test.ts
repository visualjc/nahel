import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { itemCommand } from "../../src/commands/item";
import { logCommand } from "../../src/commands/log";
import { roadmapCommand } from "../../src/commands/roadmap";
import type { Env } from "../../src/schema/env";
import { CORE_EVENT_TYPES, RELEASE_ANNOUNCED_EVENT_TYPE } from "../../src/schema/events";
import { ID_PATTERN } from "../../src/schema/id";
import type { JournalEvent } from "../../src/schema/records";
import { readJournal } from "../../src/store/journal";
import {
  ensureLayout,
  readItem,
  readRoadmapNode,
  writeConfig,
  type StoreLayout,
} from "../../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * PRD archival (Phase 4 F10): a released feature's PRD moves to
 * `docs/prds/archived/` with a stamped header, every stored reference to the
 * old path moves with it in the SAME act, and the product design doc is
 * updated in place rather than archived.
 *
 * Every case drives the real path — the release is logged into a real store,
 * the verb reads the stage back through F9's derivation, and the records are
 * read off disk afterwards — because the whole point of the feature is that
 * nothing is hand-edited: a reference the CLI did not move is a dangling path.
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

const PRD_PATH = "docs/prds/detached-state.md";
const ARCHIVED_PATH = "docs/prds/archived/detached-state.md";
const DESIGN_DOC = "docs/design/product.md";
const PRD_TEXT = `---
name: detached-state
created: 2026-07-01T00:00:00Z
---

# Detached state

The delta this PRD states.
`;
const DESIGN_TEXT = `# nahel — what the product is

State lives outside the repo it describes.
`;

async function ok(env: Env, root: string, args: string[]): Promise<string[]> {
  const before = logs.length;
  const code = await roadmapCommand.run(args, env, root);
  expect(errs.join("\n")).toBe("");
  expect(code).toBe(0);
  return logs.slice(before);
}

async function fails(env: Env, root: string, args: string[]): Promise<string> {
  errs = [];
  expect(await roadmapCommand.run(args, env, root)).toBe(1);
  const message = errs.join("\n");
  errs = [];
  return message;
}

function lastId(printed: string[]): string {
  const id = printed[printed.length - 1]!;
  expect(id).toMatch(ID_PATTERN);
  return id;
}

async function newItem(env: Env, root: string, args: string[]): Promise<string> {
  const before = logs.length;
  expect(await itemCommand.run(["new", ...args], env, root)).toBe(0);
  return lastId(logs.slice(before));
}

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

async function events(layout: StoreLayout): Promise<JournalEvent[]> {
  return Array.fromAsync(readJournal(layout));
}

/** Everything the fixture built, so a case can name the record it checks. */
interface Released {
  root: string;
  layout: StoreLayout;
  env: Env;
  /** The plan item that AUTHORED the PRD (ADR-0013). */
  plan: string;
  /** The epic the PRD was parsed into — the item the node covers. */
  epic: string;
  /** Two further records sharing the same `prd` path: the catch-all. */
  others: [string, string];
  node: string;
  nodeName: string;
}

/**
 * A released feature whose PRD is referenced FIVE times: the feature node, the
 * authoring plan item, the epic parsed from it, and two unrelated records that
 * happen to share the path. Release is logged, never hand-set — the stage the
 * verb gates on is F9's derivation over that event.
 */
async function released(
  options: { designDoc?: string | null } = {},
): Promise<Released> {
  const root = await makeTempDir("nahel-roadmap-archive-");
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig());
  const env = seededEnv({ tickSeconds: 1 });

  await mkdir(join(root, "docs", "prds"), { recursive: true });
  await writeFile(join(root, PRD_PATH), PRD_TEXT, "utf8");
  const designDoc = options.designDoc === undefined ? DESIGN_DOC : options.designDoc;
  if (designDoc !== null) {
    await mkdir(join(root, "docs", "design"), { recursive: true });
    await writeFile(join(root, designDoc), DESIGN_TEXT, "utf8");
  }

  await ok(env, root, [
    "node",
    "new",
    "product",
    "nahel",
    "--horizon",
    "now",
    "--intent",
    "Durable, tool-agnostic project state.",
    ...(designDoc === null ? [] : ["--design-doc", designDoc]),
  ]);
  const plan = await newItem(env, root, [
    "plan",
    "detached-state-prd",
    "full",
    "--prd",
    PRD_PATH,
  ]);
  expect(await itemCommand.run(["update", plan, "--status", "done"], env, root)).toBe(0);
  const epic = await newItem(env, root, ["feature", "detached-state", "full", "--prd", PRD_PATH]);
  const leaf = await newItem(env, root, ["feature", "leaf-work", "direct", "--parent", epic]);
  expect(await itemCommand.run(["update", leaf, "--status", "done"], env, root)).toBe(0);
  const other1 = await newItem(env, root, [
    "chore",
    "migration-notes",
    "direct",
    "--prd",
    PRD_PATH,
  ]);
  const other2 = await newItem(env, root, ["bug", "stale-path", "direct", "--prd", PRD_PATH]);
  const nodeName = "detached-state-repo";
  const node = lastId(
    await ok(env, root, [
      "node",
      "new",
      "feature",
      nodeName,
      "--horizon",
      "now",
      "--intent",
      "Get state out of the repo.",
      "--parent",
      "nahel",
      "--epic",
      epic,
      "--prd",
      PRD_PATH,
    ]),
  );
  await log(env, root, [
    RELEASE_ANNOUNCED_EVENT_TYPE,
    "--item",
    epic,
    "--data",
    "version=0.3.0",
  ]);
  return { root, layout, env, plan, epic, others: [other1, other2], node, nodeName };
}

/** The `prd` field of every record that could hold one, keyed by id. */
async function prdRefs(fixture: Released): Promise<Record<string, string | undefined>> {
  const refs: Record<string, string | undefined> = {};
  for (const id of [fixture.plan, fixture.epic, ...fixture.others]) {
    refs[id] = (await readItem(fixture.layout, id)).frontmatter.prd;
  }
  refs[fixture.node] = (await readRoadmapNode(fixture.layout, fixture.node)).frontmatter.prd;
  return refs;
}

async function text(root: string, path: string): Promise<string | null> {
  return readFile(join(root, path), "utf8").catch(() => null);
}

describe("nahel roadmap archive — the released delta is closed (F10)", () => {
  test("a feature that has not reached released is never archived, and the refusal names the stage", async () => {
    const fixture = await released();
    // A second feature under the same product, with no release event at all.
    await mkdir(join(fixture.root, "docs", "prds"), { recursive: true });
    await writeFile(join(fixture.root, "docs/prds/live-delta.md"), PRD_TEXT, "utf8");
    await ok(fixture.env, fixture.root, [
      "node",
      "new",
      "feature",
      "live-delta",
      "--horizon",
      "now",
      "--intent",
      "Still being built.",
      "--parent",
      "nahel",
      "--prd",
      "docs/prds/live-delta.md",
    ]);

    const said = await fails(fixture.env, fixture.root, ["archive", "live-delta"]);
    expect(said).toContain("live-delta");
    expect(said).toContain("released");
    // The stage it IS standing at, so the refusal says what is missing.
    expect(said).toContain("planned");
    // Nothing moved: the PRD is still live and the node still points at it.
    expect(await text(fixture.root, "docs/prds/live-delta.md")).not.toBeNull();
    expect(await text(fixture.root, "docs/prds/archived/live-delta.md")).toBeNull();
  });

  test("the archived PRD carries all four stamped elements, including the journal pointer", async () => {
    const fixture = await released();
    await ok(fixture.env, fixture.root, ["archive", fixture.nodeName]);

    expect(await text(fixture.root, PRD_PATH)).toBeNull();
    const archived = await text(fixture.root, ARCHIVED_PATH);
    expect(archived).not.toBeNull();
    const header = archived!;
    // 1. the released date (the ts of the release event that earned the stage)
    const release = (await events(fixture.layout)).find(
      (event) => event.type === RELEASE_ANNOUNCED_EVENT_TYPE,
    )!;
    expect(header).toContain(release.ts);
    // 2. the epic / item link
    expect(header).toContain(fixture.epic);
    expect(header).toContain(fixture.node);
    // 3. the journal pointer: the id of the archival event itself
    const archival = (await events(fixture.layout)).find(
      (event) => event.type === CORE_EVENT_TYPES.prdArchived,
    )!;
    expect(archival).toBeDefined();
    expect(header).toContain(archival.id);
    // 4. the line that says what is authoritative from here on
    expect(header).toContain("code and tests are the truth now");
    // The document itself is preserved whole, below the stamp.
    expect(header).toContain("The delta this PRD states.");
    // The stamp sits above the document, where a reader lands.
    expect(header.indexOf("code and tests are the truth now")).toBeLessThan(
      header.indexOf("The delta this PRD states."),
    );
  });

  test("all four reference kinds move in the same act, and no record holds the old path", async () => {
    const fixture = await released();
    await ok(fixture.env, fixture.root, ["archive", fixture.nodeName]);

    const refs = await prdRefs(fixture);
    expect(refs).toEqual({
      [fixture.node]: ARCHIVED_PATH,
      [fixture.plan]: ARCHIVED_PATH,
      [fixture.epic]: ARCHIVED_PATH,
      [fixture.others[0]]: ARCHIVED_PATH,
      [fixture.others[1]]: ARCHIVED_PATH,
    });
    expect(Object.values(refs)).not.toContain(PRD_PATH);
  });

  test("one act: every reference rides ONE write-ahead event, which names both paths", async () => {
    const fixture = await released();
    await ok(fixture.env, fixture.root, ["archive", fixture.nodeName]);

    const archivals = (await events(fixture.layout)).filter(
      (event) => event.type === CORE_EVENT_TYPES.prdArchived,
    );
    expect(archivals).toHaveLength(1);
    const payload = archivals[0]!.payload;
    expect(JSON.stringify(payload)).toContain(PRD_PATH);
    expect(JSON.stringify(payload)).toContain(ARCHIVED_PATH);
    // A sequence event: one write-ahead record of every write the act made.
    expect(payload["target"]).toBe("sequence");
    expect(Array.isArray(payload["records"])).toBe(true);
  });

  test("the product design doc is updated in place — diffable, never archived", async () => {
    const fixture = await released();
    const before = await text(fixture.root, DESIGN_DOC);
    await ok(fixture.env, fixture.root, ["archive", fixture.nodeName]);

    const after = await text(fixture.root, DESIGN_DOC);
    expect(after).not.toBeNull();
    // Updated in place: the original prose is still there, with the release
    // appended to it — a diff, not a rewrite.
    expect(after!.startsWith(before!)).toBe(true);
    expect(after).toContain(ARCHIVED_PATH);
    expect(after).toContain(fixture.nodeName);
    // Never archived: the design doc stays exactly where the node names it.
    expect(await text(fixture.root, "docs/prds/archived/product.md")).toBeNull();
  });

  test("re-running archival is refused, naming the archived path — nothing is stamped or rewritten twice", async () => {
    const fixture = await released();
    await ok(fixture.env, fixture.root, ["archive", fixture.nodeName]);
    const archived = await text(fixture.root, ARCHIVED_PATH);
    const design = await text(fixture.root, DESIGN_DOC);

    const said = await fails(fixture.env, fixture.root, ["archive", fixture.nodeName]);
    expect(said).toContain(ARCHIVED_PATH);
    expect(said).toContain("already");
    expect(await text(fixture.root, ARCHIVED_PATH)).toBe(archived!);
    expect(await text(fixture.root, DESIGN_DOC)).toBe(design!);
    expect(
      (await events(fixture.layout)).filter(
        (event) => event.type === CORE_EVENT_TYPES.prdArchived,
      ),
    ).toHaveLength(1);
  });

  test("a node with no PRD, and a ref that names nothing, are refused by name", async () => {
    const fixture = await released();
    expect(await fails(fixture.env, fixture.root, ["archive", "nahel"])).toContain("no `prd`");
    expect(await fails(fixture.env, fixture.root, ["archive", "no-such-node"])).toContain(
      "does not name a roadmap node",
    );
  });
});

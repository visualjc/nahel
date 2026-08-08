import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { itemCommand } from "../../src/commands/item";
import { logCommand } from "../../src/commands/log";
import { roadmapCommand } from "../../src/commands/roadmap";
import { validateCommand } from "../../src/commands/validate";
import type { Env } from "../../src/schema/env";
import {
  CORE_EVENT_TYPES,
  DEPLOY_COMPLETED_EVENT_TYPE,
  QA_SWEEP_EVENT_TYPE,
  RELEASE_ANNOUNCED_EVENT_TYPE,
} from "../../src/schema/events";
import { ID_PATTERN } from "../../src/schema/id";
import type { JournalEvent } from "../../src/schema/records";
import { readJournal } from "../../src/store/journal";
import * as store from "../../src/store/layout";
import {
  ensureLayout,
  readItem,
  readRoadmapNode,
  writeConfig,
  type StoreLayout,
} from "../../src/store/layout";
import * as lifecycle from "../../src/store/mutate";
import { createStoreContext, mutate } from "../../src/store/mutate";
import { makeConfig, makeTempDir, seedCanonicalWorkflows, seededEnv } from "../store/helpers";

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
 * The three payload keys an ARCHIVAL-QUALIFIED release carries (A3): archival
 * stamps a delta closed on a release a reader can follow back, so the version,
 * the channel it went out on, and a pointer to the announcement must all be
 * there. `--data` entries, so a case can drop one and watch the verb refuse.
 */
const FULL_RELEASE: readonly string[] = [
  "version=0.3.0",
  "channel=github",
  "announcement=https://github.com/visualjc/nahel/releases/tag/v0.3.0",
];

/** The same, at the successor's version — one delta per archive slot. */
const SUCCESSOR_RELEASE: readonly string[] = [
  "version=0.4.0",
  "channel=github",
  "announcement=https://github.com/visualjc/nahel/releases/tag/v0.4.0",
];

/** `--data` flags for each entry, in order. */
function dataArgs(entries: readonly string[]): string[] {
  return entries.flatMap((entry) => ["--data", entry]);
}

/**
 * A released feature whose PRD is referenced FIVE times: the feature node, the
 * authoring plan item, the epic parsed from it, and two unrelated records that
 * happen to share the path. Release is logged, never hand-set — the stage the
 * verb gates on is F9's derivation over that event.
 */
async function released(
  options: { designDoc?: string | null; release?: readonly string[] } = {},
): Promise<Released> {
  const root = await makeTempDir("nahel-roadmap-archive-");
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig());
  await seedCanonicalWorkflows(layout); // what `nahel init` writes; ensureLayout does not
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
    ...dataArgs(options.release ?? FULL_RELEASE),
  ]);
  return { root, layout, env, plan, epic, others: [other1, other2], node, nodeName };
}

/**
 * A SECOND released feature whose PRD reuses a basename — the shape that makes
 * two live documents want the same archive path. Its own epic, its own release,
 * and the released node named as its predecessor: lineage done correctly, which
 * is exactly when the collision bites.
 */
async function releasedSuccessor(
  fixture: Released,
  prdPath: string,
  name: string,
  body: string,
): Promise<{ epic: string; node: string }> {
  await mkdir(join(fixture.root, "docs", "prds"), { recursive: true });
  await writeFile(join(fixture.root, prdPath), body, "utf8");
  const epic = await newItem(fixture.env, fixture.root, [
    "feature",
    `${name}-epic`,
    "full",
    "--prd",
    prdPath,
  ]);
  const leaf = await newItem(fixture.env, fixture.root, [
    "feature",
    `${name}-leaf`,
    "direct",
    "--parent",
    epic,
  ]);
  expect(await itemCommand.run(["update", leaf, "--status", "done"], fixture.env, fixture.root)).toBe(
    0,
  );
  const node = lastId(
    await ok(fixture.env, fixture.root, [
      "node",
      "new",
      "feature",
      name,
      "--horizon",
      "now",
      "--intent",
      "The next delta on the same feature.",
      "--parent",
      "nahel",
      "--epic",
      epic,
      "--prd",
      prdPath,
      "--predecessor",
      fixture.nodeName,
    ]),
  );
  await log(fixture.env, fixture.root, [
    RELEASE_ANNOUNCED_EVENT_TYPE,
    "--item",
    epic,
    ...dataArgs(SUCCESSOR_RELEASE),
  ]);
  return { epic, node };
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

  test("a product carrying no design doc: the PRD still closes, and nothing is invented", async () => {
    const fixture = await released({ designDoc: null });
    await ok(fixture.env, fixture.root, ["archive", fixture.nodeName]);

    expect(await text(fixture.root, ARCHIVED_PATH)).not.toBeNull();
    expect(await text(fixture.root, PRD_PATH)).toBeNull();
    expect(Object.values(await prdRefs(fixture))).toEqual([
      ARCHIVED_PATH,
      ARCHIVED_PATH,
      ARCHIVED_PATH,
      ARCHIVED_PATH,
      ARCHIVED_PATH,
    ]);
    // No design doc to update means no document step, not a refusal and not a
    // file conjured at some default path.
    expect(await text(fixture.root, DESIGN_DOC)).toBeNull();
    expect((await validate(fixture.root)).code).toBe(0);
  });

  test("an agent's archival is refused while a human holds a claim on one of the records it must move", async () => {
    const fixture = await released();
    // A human takes one of the catch-all records — the claim covers it and
    // everything under it, and the choke point refuses agent mutations there.
    // Recorded through the store as the human (`nahel claim` also captures a
    // git baseline, which a temp store has no repo for).
    const human = await createStoreContext(fixture.root, fixture.env, {
      actorOverride: "human:jim",
    });
    const claimed = await readItem(fixture.layout, fixture.others[0]);
    await mutate(human, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemClaimed,
      frontmatter: { ...claimed.frontmatter, claimed_by: "jim" },
      body: claimed.body,
    });

    const said = await fails(fixture.env, fixture.root, ["archive", fixture.nodeName]);
    expect(said).toContain(fixture.others[0]);
    expect(said).toContain("claim");
    // A refusal writes NOTHING: not the event, not the move, not one reference.
    expect(await text(fixture.root, PRD_PATH)).not.toBeNull();
    expect(await text(fixture.root, ARCHIVED_PATH)).toBeNull();
    expect(await prdRefs(fixture)).toEqual({
      [fixture.node]: PRD_PATH,
      [fixture.plan]: PRD_PATH,
      [fixture.epic]: PRD_PATH,
      [fixture.others[0]]: PRD_PATH,
      [fixture.others[1]]: PRD_PATH,
    });
    expect(
      (await events(fixture.layout)).filter(
        (event) => event.type === CORE_EVENT_TYPES.prdArchived,
      ),
    ).toHaveLength(0);
    // And the human, whose claim it is, closes the delta themselves.
    expect(await roadmapCommand.run(["archive", fixture.nodeName], fixture.env, fixture.root, "human:jim")).toBe(0);
    expect(await text(fixture.root, ARCHIVED_PATH)).not.toBeNull();
  });

  test("a node with no PRD, and a ref that names nothing, are refused by name", async () => {
    const fixture = await released();
    expect(await fails(fixture.env, fixture.root, ["archive", "nahel"])).toContain("no `prd`");
    expect(await fails(fixture.env, fixture.root, ["archive", "no-such-node"])).toContain(
      "does not name a roadmap node",
    );
  });
});

/**
 * F10's crash shape: archival is a SEQUENCE — one write-ahead event, then the
 * PRD's move-and-stamp, the feature node's link, the authoring plan item, the
 * epic, each further record sharing the path, and finally the product design
 * doc's line. The criterion is that a process killed at EVERY one of those
 * boundaries leaves a recoverable partial state: `validate` names it,
 * `validate --repair` completes it, and re-running archival afterwards changes
 * nothing — the header stamped once, no reference rewritten twice.
 *
 * How each kill is injected: an interruption point IS a write that never
 * happened, so each case makes exactly one write fail and leaves every read
 * working. Where the step writes into a directory of its own — the archive
 * directory, the roadmap dir, the design doc's dir — the directory is chmod'ed
 * read-only, F7's technique. The catch-all steps all write into `nahel/items`,
 * so a directory cannot separate them: those fail the Nth item write instead,
 * which is the only way to reach the N+1 sub-boundaries the PRD names (after
 * ANY prefix of the catch-all updates), and leaves disk in byte-for-byte the
 * state a SIGKILL at that instant would.
 */

/** Make every write under `dir` fail while every read still succeeds. */
async function freeze(dir: string): Promise<void> {
  await chmod(dir, 0o555);
}

async function thaw(dir: string): Promise<void> {
  await chmod(dir, 0o755);
}

/** Run `act` with the store frozen at `dir`, restoring the mode afterwards. */
async function withFrozen(dir: string, act: () => Promise<void>): Promise<void> {
  await freeze(dir);
  try {
    await act();
  } finally {
    await thaw(dir);
  }
}

/** Run `act` with the Nth (1-based) item record write failing — a kill at that step. */
async function withKilledItemWrite(nth: number, act: () => Promise<void>): Promise<void> {
  const original = store.writeItem;
  let calls = 0;
  const spy = spyOn(store, "writeItem").mockImplementation(async (layout, record, body) => {
    calls += 1;
    if (calls === nth) throw new Error("killed between two item writes");
    return original(layout, record, body);
  });
  try {
    await act();
  } finally {
    spy.mockRestore();
  }
}

/** Run `act` with the move's UNLINK failing — the copy lands, the source stays. */
async function withKilledUnlink(act: () => Promise<void>): Promise<void> {
  const spy = spyOn(store, "removeFile").mockImplementation(async () => {
    throw new Error("killed between the copy and the unlink");
  });
  try {
    await act();
  } finally {
    spy.mockRestore();
  }
}

async function validate(root: string, args: string[] = []): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const code = await validateCommand.run(args, {
    env: seededEnv(),
    cwd: root,
    stdout: (line) => out.push(line),
    stderr: (line) => out.push(line),
  });
  return { code, out: out.join("\n") };
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** The whole answer about one archival, after everything settles. */
async function settled(fixture: Released) {
  const archived = await text(fixture.root, ARCHIVED_PATH);
  const design = await text(fixture.root, DESIGN_DOC);
  return {
    live: await text(fixture.root, PRD_PATH),
    stamps: archived === null ? 0 : occurrences(archived, "> **Archived"),
    carriesDocument: archived?.includes("The delta this PRD states.") ?? false,
    refs: await prdRefs(fixture),
    designNotes: design === null ? 0 : occurrences(design, ARCHIVED_PATH),
    archivals: (await events(fixture.layout)).filter(
      (event) => event.type === CORE_EVENT_TYPES.prdArchived,
    ).length,
  };
}

/** What a completed archival looks like, whatever route the store took to get there. */
async function expectComplete(fixture: Released): Promise<void> {
  expect(await settled(fixture)).toEqual({
    live: null,
    stamps: 1,
    carriesDocument: true,
    refs: {
      [fixture.node]: ARCHIVED_PATH,
      [fixture.plan]: ARCHIVED_PATH,
      [fixture.epic]: ARCHIVED_PATH,
      [fixture.others[0]]: ARCHIVED_PATH,
      [fixture.others[1]]: ARCHIVED_PATH,
    },
    designNotes: 1,
    archivals: 1,
  });
}

describe("archival interrupted at every boundary of the sequence (F10)", () => {
  /**
   * One interruption point: kill the act there, then prove the whole
   * convergence — validate names the partial state, --repair completes it,
   * re-running is refused, and the store ends where a clean archival ends.
   */
  async function interruptedAt(
    kill: (fixture: Released, act: () => Promise<void>) => Promise<void>,
  ): Promise<{ before: string }> {
    const fixture = await released();
    await kill(fixture, async () => {
      expect(await fails(fixture.env, fixture.root, ["archive", fixture.nodeName])).not.toBe("");
    });

    // 1. The journal is ahead of whatever did not land, and validate says so.
    const before = await validate(fixture.root);
    expect(before.code).toBe(1);

    // 2. --repair rolls the sequence forward from the one event holding it.
    const repaired = await validate(fixture.root, ["--repair"]);
    expect(repaired.out).toContain("repaired");
    expect(repaired.code).toBe(0);
    await expectComplete(fixture);

    // 3. Re-running archival afterwards changes nothing: the delta is closed.
    expect(await fails(fixture.env, fixture.root, ["archive", fixture.nodeName])).toContain(
      "already",
    );
    await expectComplete(fixture);

    // 4. And the store is clean — a repaired sequence leaves no error behind.
    const after = await validate(fixture.root);
    expect(after.out).not.toContain("journal.divergence");
    expect(after.out).not.toContain("roadmap.prd-unarchived");
    expect(after.code).toBe(0);
    return { before: before.out };
  }

  test("killed after the event, before the PRD move — nothing landed at all", async () => {
    const { before } = await interruptedAt((fixture, act) =>
      withFrozen(join(fixture.root, "docs", "prds"), act),
    );
    expect(before).toContain("journal.divergence");
    expect(before).toContain(ARCHIVED_PATH);
  });

  test("killed after the event-and-move, before the feature node's link", async () => {
    const { before } = await interruptedAt((fixture, act) =>
      withFrozen(fixture.layout.roadmapDir, act),
    );
    // The document moved; every record still names the old path, which now
    // points at neither location — the partial state, named.
    expect(before).toContain("journal.divergence");
    expect(before).toContain("roadmap.prd-missing");
    expect(before).toContain(PRD_PATH);
  });

  test("killed between the copy and the unlink — the PRD is at BOTH locations", async () => {
    const { before } = await interruptedAt((_fixture, act) => withKilledUnlink(act));
    expect(before).toContain("journal.divergence");
    expect(before).toContain("still exists at both");
  });

  test("killed after the feature node's link, before the authoring plan item", async () => {
    const { before } = await interruptedAt((_fixture, act) => withKilledItemWrite(1, act));
    expect(before).toContain("journal.divergence");
  });

  test("killed after the plan item, before the epic — the second reference kind", async () => {
    const { before } = await interruptedAt((_fixture, act) => withKilledItemWrite(2, act));
    expect(before).toContain("journal.divergence");
  });

  test("killed after the epic, before ANY catch-all update", async () => {
    const { before } = await interruptedAt((_fixture, act) => withKilledItemWrite(3, act));
    expect(before).toContain("journal.divergence");
  });

  test("killed after ONE of the two catch-all updates — a prefix, not the batch", async () => {
    const { before } = await interruptedAt((_fixture, act) => withKilledItemWrite(4, act));
    expect(before).toContain("journal.divergence");
  });

  test("killed after every catch-all update, before the product design doc", async () => {
    const { before } = await interruptedAt((fixture, act) =>
      withFrozen(join(fixture.root, "docs", "design"), act),
    );
    // Every reference has moved and the design doc is stale — the second
    // partial state F10 names by hand.
    expect(before).toContain("journal.divergence");
    expect(before).toContain(DESIGN_DOC);
  });

  test("a PRD at NEITHER location is the one state repair refuses to invent", async () => {
    const fixture = await released();
    await ok(fixture.env, fixture.root, ["archive", fixture.nodeName]);
    await rm(join(fixture.root, ARCHIVED_PATH));

    const findings = await validate(fixture.root);
    expect(findings.code).toBe(1);
    expect(findings.out).toContain("roadmap.document-lost");
    expect(findings.out).toContain("hand deletion");
    const repaired = await validate(fixture.root, ["--repair"]);
    expect(repaired.code).toBe(1);
    expect(await text(fixture.root, ARCHIVED_PATH)).toBeNull();
  });
});

describe("the closed-delta doctrine (F10)", () => {
  async function entry(term: string): Promise<string> {
    const glossary = await Bun.file(join(import.meta.dir, "../../CONTEXT.md")).text();
    const line = glossary.split("\n").find((each) => each.startsWith(`- **${term}** —`));
    expect(line).toBeDefined();
    return line!;
  }

  test("the glossary defines the PRD lifecycle: live until released, archived after, never reopened", async () => {
    const defined = await entry("PRD lifecycle");
    expect(defined).toContain("`docs/prds/archived/`");
    expect(defined).toContain("nahel roadmap archive");
    // The four stamped elements and the pointer that makes the act auditable.
    expect(defined).toContain("journal");
    expect(defined).toContain("code and tests are the truth");
    // The doctrine itself, and the escape hatch it leaves open.
    expect(defined).toContain("never");
    expect(defined).toContain("predecessor");
    // The design doc is the other half of the sentence: permanent, in place.
    expect(defined).toContain("design doc");
    // And the one refusal a reused basename earns: the archive is one file per
    // delta, so a collision is refused rather than resolved.
    expect(defined).toContain("one file per delta");
    expect(defined).toContain("never overwritten");
  });

  test("a new node continuing a released one is lineage, not a reopened delta", async () => {
    const fixture = await released();
    await ok(fixture.env, fixture.root, ["archive", fixture.nodeName]);
    await writeFile(join(fixture.root, "docs/prds/detached-state-v2.md"), PRD_TEXT, "utf8");
    await ok(fixture.env, fixture.root, [
      "node",
      "new",
      "feature",
      "detached-state-repo-v2",
      "--horizon",
      "next",
      "--intent",
      "The next delta on the same feature.",
      "--parent",
      "nahel",
      "--predecessor",
      fixture.nodeName,
      "--prd",
      "docs/prds/detached-state-v2.md",
    ]);

    const report = await validate(fixture.root);
    expect(report.code).toBe(0);
    expect(report.out).not.toContain("roadmap.closed-delta");
    // The archived PRD is untouched by the successor: one stamp, one document.
    expect(occurrences((await text(fixture.root, ARCHIVED_PATH))!, "> **Archived")).toBe(1);
  });

  test("F1's dangling-predecessor warning composes with the closed-delta one — two facts, two findings", async () => {
    const fixture = await released();
    await ok(fixture.env, fixture.root, ["archive", fixture.nodeName]);
    // A node that is NOT released, pointing at the CLOSED delta, and naming a
    // predecessor no record carries: three independent mistakes on one record.
    await ok(fixture.env, fixture.root, [
      "node",
      "new",
      "feature",
      "detached-state-repo-again",
      "--horizon",
      "now",
      "--intent",
      "Continuing work against a closed delta.",
      "--parent",
      "nahel",
      "--predecessor",
      "zzzzzzzz",
      "--prd",
      ARCHIVED_PATH,
    ]);

    const report = await validate(fixture.root);
    expect(report.out).toContain("roadmap.closed-delta");
    expect(report.out).toContain("roadmap.predecessor-missing");
    expect(report.out).toContain("zzzzzzzz");
    // Both are warnings: neither was refused at write time, and validate passes.
    expect(report.code).toBe(0);
  });
});

/**
 * The archive destination is a real path with a real document in it, and a PRD
 * basename is not unique across time: a successor feature that reuses the name
 * its predecessor shipped under points at an archive slot that is already
 * taken. Nothing about "move" may treat an occupied destination as "already
 * done" — that reading unlinks a LIVE document into a stranger's file, which is
 * the one thing F10 forbids outright ("no PRD is ever deleted").
 */
describe("an archive destination that is already occupied (F10)", () => {
  const SUCCESSOR_TEXT = `---
name: detached-state
created: 2026-08-01T00:00:00Z
---

# Detached state, again

The NEXT delta this PRD states.
`;
  const FOREIGN_TEXT = `> **Archived — the delta this PRD stated is closed.**
>
> - Journal: archived by event aaaaaaaa

# Somebody else's closed delta
`;

  test("the verb refuses a destination collision outright, naming both paths — the live PRD is untouched", async () => {
    const fixture = await released();
    await ok(fixture.env, fixture.root, ["archive", fixture.nodeName]);
    // The successor reuses the basename its predecessor shipped under.
    await releasedSuccessor(fixture, PRD_PATH, "detached-state-repo-v2", SUCCESSOR_TEXT);

    const said = await fails(fixture.env, fixture.root, ["archive", "detached-state-repo-v2"]);
    expect(said).toContain(PRD_PATH);
    expect(said).toContain(ARCHIVED_PATH);
    expect(said).toContain("rename");

    // Nothing was deleted and nothing was overwritten: the successor's live PRD
    // is where it was, and the predecessor's archive still holds ITS document.
    expect(await text(fixture.root, PRD_PATH)).toBe(SUCCESSOR_TEXT);
    expect(await text(fixture.root, ARCHIVED_PATH)).toContain("The delta this PRD states.");
    expect(
      (await events(fixture.layout)).filter(
        (event) => event.type === CORE_EVENT_TYPES.prdArchived,
      ),
    ).toHaveLength(1);
  });

  test("repair never unlinks a source into an archive this event did not stamp", async () => {
    const fixture = await released();
    // Kill the move: the event lands, the source stays, the destination is absent.
    await withFrozen(join(fixture.root, "docs", "prds"), async () => {
      expect(await fails(fixture.env, fixture.root, ["archive", fixture.nodeName])).not.toBe("");
    });
    // Then a same-named archived PRD arrives from somewhere else — a merge, a
    // predecessor's archive — carrying a DIFFERENT act's stamp.
    await mkdir(join(fixture.root, "docs", "prds", "archived"), { recursive: true });
    await writeFile(join(fixture.root, ARCHIVED_PATH), FOREIGN_TEXT, "utf8");

    const before = await validate(fixture.root);
    expect(before.code).toBe(1);
    expect(before.out).toContain("roadmap.document-collision");
    expect(before.out).toContain(ARCHIVED_PATH);

    const repaired = await validate(fixture.root, ["--repair"]);
    // Repair completes what it can and REFUSES the move: the live PRD is still
    // there, and the stranger's document is byte-identical.
    expect(await text(fixture.root, PRD_PATH)).not.toBeNull();
    expect(await text(fixture.root, ARCHIVED_PATH)).toBe(FOREIGN_TEXT);
    expect(repaired.code).toBe(1);
    expect((await validate(fixture.root)).out).toContain("roadmap.document-collision");
  });
});

describe("the design doc's line is keyed to the act, not to the path (F10)", () => {
  test("a design doc that already mentions the archive path still gains the release line", async () => {
    const fixture = await released();
    // The path is prose anyone may already have written down — a roadmap note,
    // a link, an earlier paragraph. It says nothing about whether THIS act ran.
    await writeFile(
      join(fixture.root, DESIGN_DOC),
      `${DESIGN_TEXT}\nSee also ${ARCHIVED_PATH} once that delta closes.\n`,
      "utf8",
    );

    await ok(fixture.env, fixture.root, ["archive", fixture.nodeName]);

    const design = (await text(fixture.root, DESIGN_DOC))!;
    // The pre-existing mention did not suppress the line the act owes.
    expect(occurrences(design, ARCHIVED_PATH)).toBe(2);
    expect(design).toContain("shipped");
    const archival = (await events(fixture.layout)).find(
      (event) => event.type === CORE_EVENT_TYPES.prdArchived,
    )!;
    expect(design).toContain(`archival event ${archival.id}`);
    // And convergence is judged by the same sentinel, so validate is clean.
    expect((await validate(fixture.root)).code).toBe(0);
  });

  test("the pre-existing mention does not fake convergence when the append never ran", async () => {
    const fixture = await released();
    await writeFile(
      join(fixture.root, DESIGN_DOC),
      `${DESIGN_TEXT}\nSee also ${ARCHIVED_PATH} once that delta closes.\n`,
      "utf8",
    );
    // Kill the act at the design doc, its final step.
    await withFrozen(join(fixture.root, "docs", "design"), async () => {
      expect(await fails(fixture.env, fixture.root, ["archive", fixture.nodeName])).not.toBe("");
    });

    const before = await validate(fixture.root);
    expect(before.code).toBe(1);
    expect(before.out).toContain("journal.divergence");
    expect(before.out).toContain(DESIGN_DOC);

    expect((await validate(fixture.root, ["--repair"])).code).toBe(0);
    expect(occurrences((await text(fixture.root, DESIGN_DOC))!, ARCHIVED_PATH)).toBe(2);
  });
});

/**
 * The difference between "there is no design doc to update" and "the design doc
 * I was told to update is not there". The first legitimately omits the step —
 * an absent `design_doc` field states nothing was configured. The second is a
 * write that could not happen after the event was already journaled, and it
 * must behave exactly as a failed RECORD write does: the command fails, the
 * journal carries the truth, `validate` names the pending state, and `--repair`
 * completes it as soon as the document is back. What it must never do is exit 0
 * reporting that a file it never touched was updated.
 */
describe("a configured design doc that cannot be written (F10)", () => {
  test("the archive fails loudly, and the journal already carries what is pending", async () => {
    const fixture = await released();
    await rm(join(fixture.root, DESIGN_DOC));

    const said = await fails(fixture.env, fixture.root, ["archive", fixture.nodeName]);
    expect(said).toContain(DESIGN_DOC);
    expect(said).toContain("validate");
    // Everything before the final step DID land — the event, the move, the
    // references — which is precisely why the failure has to be loud.
    expect(await text(fixture.root, ARCHIVED_PATH)).not.toBeNull();
    expect(await text(fixture.root, PRD_PATH)).toBeNull();

    const before = await validate(fixture.root);
    expect(before.code).toBe(1);
    expect(before.out).toContain("roadmap.design-doc-missing");
    expect(before.out).toContain(DESIGN_DOC);

    // Repair cannot append to a document that is not there, and says so
    // rather than inventing one.
    const refused = await validate(fixture.root, ["--repair"]);
    expect(refused.code).toBe(1);
    expect(await text(fixture.root, DESIGN_DOC)).toBeNull();

    // Restore the design doc and the same repair completes the act.
    await writeFile(join(fixture.root, DESIGN_DOC), DESIGN_TEXT, "utf8");
    const repaired = await validate(fixture.root, ["--repair"]);
    expect(repaired.out).toContain("repaired");
    expect(repaired.code).toBe(0);
    expect(await text(fixture.root, DESIGN_DOC)).toContain(ARCHIVED_PATH);
    expect(await fails(fixture.env, fixture.root, ["archive", fixture.nodeName])).toContain(
      "already",
    );
  });
});

describe("the boundary AFTER the last write of the sequence (F10)", () => {
  test("killed after the design doc's line: every step landed, and nothing is repeated", async () => {
    const fixture = await released();
    // The last thing the verb does after the sequence is close its session
    // segment; a kill between the final document write and that close leaves
    // the whole act on disk with the invocation never finished.
    const spy = spyOn(lifecycle, "closeStoreContext").mockImplementation(async () => {
      throw new Error("killed after the final document write");
    });
    try {
      expect(await fails(fixture.env, fixture.root, ["archive", fixture.nodeName])).not.toBe("");
    } finally {
      spy.mockRestore();
    }

    // Every step of the sequence landed — the journal is ahead of nothing.
    await expectComplete(fixture);
    const before = await validate(fixture.root);
    expect(before.out).not.toContain("journal.divergence");
    expect(before.out).not.toContain("roadmap.");
    expect(before.code).toBe(0);

    // --repair has nothing to roll forward, and changes nothing if run.
    const repaired = await validate(fixture.root, ["--repair"]);
    expect(repaired.out).not.toContain("repaired");
    expect(repaired.code).toBe(0);
    await expectComplete(fixture);

    // And re-running the verb is the same refusal a clean run earns.
    expect(await fails(fixture.env, fixture.root, ["archive", fixture.nodeName])).toContain(
      "already",
    );
    await expectComplete(fixture);
  });
});

/**
 * The association rule reads the item TREE, not the ref alone (F2: an event
 * covers a node iff its `item` resolves to that node's epic item or a
 * descendant of it). A node whose epic id names no record resolves to nothing,
 * so it covers nothing — and no lifecycle event aimed at the dead id can carry
 * such a node past its own development. That matters most here: `released` is
 * F10's precondition, and a stage advanced over a missing epic would let an
 * archival close a delta whose work nobody can find.
 */
describe("a dangling epic covers no lifecycle events (F2's rule, F10's gate)", () => {
  test("a release logged at a since-lost epic does not advance the stage, and archival refuses", async () => {
    const fixture = await released();
    await writeFile(join(fixture.root, "docs/prds/ghost-delta.md"), PRD_TEXT, "utf8");
    const epic = await newItem(fixture.env, fixture.root, ["feature", "ghost-epic", "full"]);
    const node = lastId(
      await ok(fixture.env, fixture.root, [
        "node",
        "new",
        "feature",
        "ghost-delta",
        "--horizon",
        "now",
        "--intent",
        "Points at an epic that is not there.",
        "--parent",
        "nahel",
        "--epic",
        epic,
        "--prd",
        "docs/prds/ghost-delta.md",
      ]),
    );
    for (const type of [
      QA_SWEEP_EVENT_TYPE,
      DEPLOY_COMPLETED_EVENT_TYPE,
      RELEASE_ANNOUNCED_EVENT_TYPE,
    ]) {
      await log(fixture.env, fixture.root, [type, "--item", epic, "--data", "version=9.9.9"]);
    }
    // Then the epic record goes — a merge that dropped it, a hand deletion.
    // The events still name it, and the node still points at it.
    await rm(join(fixture.layout.itemsDir, `${epic}.md`));

    // The stage stays at the dev rollup's own word for a missing epic.
    const zoom = await ok(fixture.env, fixture.root, ["ghost-delta"]);
    expect(zoom.join("\n")).toContain("unknown");
    expect(zoom.join("\n")).not.toContain("released");

    const said = await fails(fixture.env, fixture.root, ["archive", "ghost-delta"]);
    expect(said).toContain("stage unknown");
    expect(said).toContain("once its feature is released");
    expect(await text(fixture.root, "docs/prds/ghost-delta.md")).not.toBeNull();
    expect(await text(fixture.root, "docs/prds/archived/ghost-delta.md")).toBeNull();
    // Validate names the missing epic — and does NOT ask anyone to archive a
    // node it never called released.
    const report = await validate(fixture.root);
    expect(report.out).toContain("roadmap.epic-missing");
    expect(report.out).not.toContain(`node ${node} (ghost-delta) is released`);
  });
});

/**
 * A finding's `fix` is an instruction someone will follow literally, so it has
 * to be the sequence that actually converges. Once the archival event is
 * journaled, `--repair` has already advanced the record refs to the archived
 * path — so "re-run `nahel roadmap archive`" walks straight into the
 * already-archived refusal and the store stays broken. What converges is:
 * move the foreign document aside, then repair again, which completes the move
 * the journal has been holding all along.
 */
describe("the collision's recovery actually converges (F10)", () => {
  test("move the foreign document aside, repair again, and validate comes back clean", async () => {
    const fixture = await released();
    await withFrozen(join(fixture.root, "docs", "prds"), async () => {
      expect(await fails(fixture.env, fixture.root, ["archive", fixture.nodeName])).not.toBe("");
    });
    await mkdir(join(fixture.root, "docs", "prds", "archived"), { recursive: true });
    await writeFile(
      join(fixture.root, ARCHIVED_PATH),
      "> **Archived — the delta this PRD stated is closed.**\n>\n> - Journal: archived by event aaaaaaaa\n",
      "utf8",
    );

    // The first repair advances the records and refuses the move.
    expect((await validate(fixture.root, ["--repair"])).code).toBe(1);
    const stuck = await validate(fixture.root);
    expect(stuck.out).toContain("roadmap.document-collision");
    // The instruction must NOT be "re-run the verb": that path is closed now.
    const fix = stuck.out
      .split("\n")
      .find((line) => line.includes("fix:") && line.includes("delta"))!;
    expect(fix).toContain("validate --repair");
    expect(fix).not.toContain("re-run `nahel roadmap archive`");
    // Following the verb instead proves why: the delta already reads closed.
    expect(await fails(fixture.env, fixture.root, ["archive", fixture.nodeName])).toContain(
      "already archived",
    );

    // The prescribed sequence: the stranger moves aside, repair completes.
    await rename(
      join(fixture.root, ARCHIVED_PATH),
      join(fixture.root, "docs/prds/archived/detached-state-2024.md"),
    );
    const repaired = await validate(fixture.root, ["--repair"]);
    expect(repaired.out).toContain("repaired");
    expect(repaired.code).toBe(0);
    await expectComplete(fixture);
    expect(await text(fixture.root, "docs/prds/archived/detached-state-2024.md")).not.toBeNull();
  });
});

/**
 * The archival gate (A3, as the final gate settled it). Archival stamps a
 * document closed forever on a header that cites the release, so it demands a
 * release a reader can follow back — nonblank `version`, `channel` and
 * `announcement`, all three.
 *
 * A3 made that a stricter bar than the stage word and left `stage released`
 * permissive; the final gate closed the gap, so the three keys now decide BOTH
 * and a feature this verb refuses does not read `released` either. What stays
 * permissive is the RENDER: the release column still prints `released ? <ts>`
 * for a release recording nothing, because a column shows the fact the store
 * holds and the stage says what that fact earned.
 *
 * The refusal names the release event and every key it lacks, because the fix
 * is to re-log THAT release, and a refusal that named neither would send
 * someone hunting through the journal for it.
 */
describe("the archival gate: a release a reader can follow back (A3)", () => {
  /** What `nahel roadmap archive` said when it refused the fixture's node. */
  async function refusal(fixture: Released): Promise<string> {
    const said = await fails(fixture.env, fixture.root, ["archive", fixture.nodeName]);
    // Refused means refused: the document did not move.
    expect(await text(fixture.root, PRD_PATH)).not.toBeNull();
    expect(await text(fixture.root, ARCHIVED_PATH)).toBeNull();
    return said;
  }

  /** The id of the one `release.announced` in the store. */
  async function releaseId(fixture: Released): Promise<string> {
    const found = (await events(fixture.layout)).filter(
      (event) => event.type === RELEASE_ANNOUNCED_EVENT_TYPE,
    );
    expect(found).toHaveLength(1);
    return found[0]!.id;
  }

  test("a release carrying only a version is refused, naming the event and BOTH missing keys", async () => {
    const fixture = await released({ release: ["version=0.3.0"] });
    const said = await refusal(fixture);

    expect(said).toContain(await releaseId(fixture));
    expect(said).toContain("channel");
    expect(said).toContain("announcement");
    expect(said).not.toContain("stage unknown");
    // And it does not claim the feature reads `released`: since the final gate
    // a thin release earns no stage word at all, so a refusal saying otherwise
    // would contradict the very view the reader just looked at.
    expect(said).not.toContain("reads stage released");
  });

  test("one missing key is named alone — the refusal lists what is missing, not the shape", async () => {
    const fixture = await released({
      release: ["version=0.3.0", "channel=github"],
    });
    const said = await refusal(fixture);

    // The clause lists exactly what is missing — the key that IS recorded is
    // not among them, however often the re-log instruction below spells it.
    expect(said).toContain("records no announcement —");
  });

  test("a BLANK value is a missing value — a recorded empty string says nothing", async () => {
    const fixture = await released({
      release: ["version=0.3.0", "channel=   ", "announcement="],
    });
    const said = await refusal(fixture);

    expect(said).toContain("channel");
    expect(said).toContain("announcement");
  });

  /**
   * CHANGED by the final gate, which finished what A2 started: the COLUMN is
   * what stays permissive, not the stage word. A2 left the release row
   * advancing on mere existence, so a thin release read `released` — the
   * strongest word on the board, earned by recording nothing. The word and the
   * verb now share ONE predicate, so what the view says and what archival
   * accepts can no longer disagree.
   */
  test("the COLUMN stays permissive; the stage word no longer does", async () => {
    const fixture = await released({ release: ["version=0.3.0"] });

    const zoom = (await ok(fixture.env, fixture.root, [fixture.nodeName])).join("\n");
    // What the store holds, rendered verbatim…
    expect(zoom).toContain("release=released 0.3.0");
    // …under a stage word the release did not earn.
    expect(zoom).toContain("status: built");
    await refusal(fixture);
  });

  test("a complete release archives, and the archival event names the release it rests on", async () => {
    const fixture = await released();
    const release = await releaseId(fixture);
    await ok(fixture.env, fixture.root, ["archive", fixture.nodeName]);

    const archival = (await events(fixture.layout)).find(
      (event) => event.type === CORE_EVENT_TYPES.prdArchived,
    )!;
    expect(archival.payload["release"]).toBe(release);
    // The reserved replay keys still win: the sequence is intact.
    expect(archival.payload["target"]).toBe("sequence");
    expect(Array.isArray(archival.payload["records"])).toBe(true);
  });

  test("a RETRACTED complete release is no release at all — the stage refusal, not the gate", async () => {
    const fixture = await released();
    const release = await releaseId(fixture);
    await log(fixture.env, fixture.root, [
      "roadmap.column-retracted",
      "--data",
      `event=${release}`,
      "--data",
      "reason=announced against the wrong epic",
    ]);

    const said = await refusal(fixture);
    expect(said).toContain("once its feature is released");
    expect(said).toContain("stage built");
  });

  test("validate never asks anyone to archive what the verb refuses", async () => {
    const fixture = await released({ release: ["version=0.3.0"] });

    const report = await validate(fixture.root);
    expect(report.out).not.toContain("roadmap.prd-unarchived");
    // It says what IS wrong instead: the release cannot carry an archival.
    expect(report.out).toContain("roadmap.release-incomplete");
  });
});

/**
 * What the glossary has to teach about archival (A3 as the final gate settled
 * it, superseding the interim reading this block was written against).
 *
 * A3 split `stage released` from ARCHIVAL-QUALIFIED and left the stage word
 * permissive; the final gate closed that, so the two are now ONE fact and the
 * three keys decide both. What stays permissive is the RENDER — the release
 * column still prints `released ? <ts>` for a release recording nothing. A
 * glossary still spelling them as two facts would teach a workflow author that
 * a rendered `released` might not be archivable, which is now backwards: the
 * stage word is exactly the archival predicate, and it is the COLUMN that can
 * show a fact no word rests on.
 */
describe("archival qualification — documented vocabulary", () => {
  test("the glossary states the keys, and that the stage word IS the archival predicate", async () => {
    const glossary = await readFile(join(import.meta.dir, "../../CONTEXT.md"), "utf8");
    const defined = glossary
      .split("\n")
      .find((line) => line.startsWith("- **PRD lifecycle** —"))!;
    expect(defined).toBeDefined();
    expect(defined).toContain("archival-qualified");
    for (const key of ["`version`", "`channel`", "`announcement`"]) {
      expect(defined).toContain(key);
    }
    // The superseded reading, in the words it used: the stage no longer differs
    // from archival qualification, and no longer reads `released` off a release
    // recording nothing.
    expect(defined).not.toContain("are different facts");
    expect(defined).not.toContain("stays permissive: any covering");
    expect(defined).toContain("the same fact");
    // What DOES stay permissive is the column, and the entry has to say so.
    expect(defined).toContain("`released ? <ts>`");
    expect(defined).toContain("column");
  });
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, readdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { CommandContext } from "../../src/cli";
import { itemCommand } from "../../src/commands/item";
import { logCommand } from "../../src/commands/log";
import { roadmapCommand } from "../../src/commands/roadmap";
import { validateCommand } from "../../src/commands/validate";
import type { Env } from "../../src/schema/env";
import { ID_PATTERN } from "../../src/schema/id";
import {
  CORE_EVENT_TYPES,
  MIGRATION_ATTRIBUTION_PAYLOAD_KEY,
  MIGRATION_NODES_PAYLOAD_KEY,
  MIGRATION_SELECTED_EVENT_TYPE,
  MIGRATION_SELECTION_PAYLOAD_KEY,
  MIGRATION_SUPERSEDED_EVENT_TYPE,
  MIGRATION_SUPERSEDED_REASON_KEY,
} from "../../src/schema/events";
import type { JournalEvent } from "../../src/schema/records";
import { readJournal } from "../../src/store/journal";
import * as store from "../../src/store/layout";
import {
  ensureLayout,
  failedRoadmapNodePath,
  listRoadmapNodes,
  roadmapNodePath,
  writeConfig,
  type StoreLayout,
} from "../../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * Migration ATTRIBUTION at the write seam (PR #26 follow-up C2): the migrating
 * agent passes `--migration <selection-event-id>` and the node's creation event
 * carries it, which is the whole join the audit rests on. Ordinary charting
 * omits the flag and stays invisible to the audit — no date heuristic, no
 * "nodes created within an hour of the selection".
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
  const root = await makeTempDir("nahel-cmd-migration-");
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig());
  const env = seededEnv({ tickSeconds: 1 });
  return { root, layout, env };
}

async function ok(env: Env, root: string, args: string[]): Promise<string[]> {
  const before = logs.length;
  const code = await roadmapCommand.run(args, env, root);
  expect(stderr()).toBe("");
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

async function newItem(env: Env, root: string, name: string): Promise<string> {
  const before = logs.length;
  expect(await itemCommand.run(["new", "feature", name, "direct"], env, root)).toBe(0);
  return lastId(logs.slice(before));
}

async function events(layout: StoreLayout): Promise<JournalEvent[]> {
  return Array.fromAsync(readJournal(layout));
}

/**
 * Journal one event through the real `nahel log` verb, returning its id. `log`
 * writes an open-extension warning to stderr for every non-core type — the
 * selection type included, deliberately — so stderr is drained, not asserted
 * empty.
 */
async function logged(env: Env, root: string, args: string[]): Promise<string> {
  const before = logs.length;
  const code = await logCommand.run(args, {
    env,
    cwd: root,
    stdout: (text: string) => logs.push(text),
    stderr: (text: string) => errs.push(text),
  });
  expect(code).toBe(0);
  errs = [];
  const id = logs.slice(before).join("\n").match(/event ([0-9a-z]+) \(seq/)?.[1];
  expect(id).toMatch(ID_PATTERN);
  return id!;
}

/** Journal a selection set the way `nahel/workflows/migrate-roadmap.md` does. */
async function selection(env: Env, root: string, included: readonly string[]): Promise<string> {
  return logged(env, root, [
    MIGRATION_SELECTED_EVENT_TYPE,
    "--data",
    `included=${JSON.stringify(included)}`,
  ]);
}

describe("nahel roadmap node new --migration (C2)", () => {
  test("the creation event carries the selection it was made for", async () => {
    const { root, layout, env } = await setup();
    const epic = await newItem(env, root, "a-feature");
    const selected = await selection(env, root, [epic]);
    const node = lastId(
      await ok(env, root, [
        "node",
        "new",
        "feature",
        "a-feature",
        "--horizon",
        "now",
        "--intent",
        "the feature",
        "--epic",
        epic,
        "--migration",
        selected,
      ]),
    );
    const created = (await events(layout)).filter(
      (event) => event.type === CORE_EVENT_TYPES.roadmapNodeCreated,
    );
    expect(created).toHaveLength(1);
    expect(created[0]!.payload[MIGRATION_ATTRIBUTION_PAYLOAD_KEY]).toBe(selected);
    // The attribution rides the mutation event; it is NOT a node field, so the
    // record itself is unchanged (the node states intent, not its own history).
    expect(created[0]!.payload["record"]).not.toHaveProperty(
      MIGRATION_ATTRIBUTION_PAYLOAD_KEY,
    );
    expect(node).toMatch(ID_PATTERN);
  });

  test("ordinary charting omits the flag, and its event carries no attribution", async () => {
    const { root, layout, env } = await setup();
    const epic = await newItem(env, root, "a-feature");
    await ok(env, root, [
      "node",
      "new",
      "feature",
      "a-feature",
      "--horizon",
      "now",
      "--intent",
      "the feature",
      "--epic",
      epic,
    ]);
    const created = (await events(layout)).filter(
      (event) => event.type === CORE_EVENT_TYPES.roadmapNodeCreated,
    );
    expect(created[0]!.payload).not.toHaveProperty(MIGRATION_ATTRIBUTION_PAYLOAD_KEY);
  });

  test("a --migration id naming no selection event is refused, not recorded", async () => {
    const { root, layout, env } = await setup();
    const epic = await newItem(env, root, "a-feature");
    const message = await fails(env, root, [
      "node",
      "new",
      "feature",
      "a-feature",
      "--horizon",
      "now",
      "--intent",
      "the feature",
      "--epic",
      epic,
      "--migration",
      "zzzzzzzz",
    ]);
    expect(message).toContain("zzzzzzzz");
    expect(message).toContain(MIGRATION_SELECTED_EVENT_TYPE);
    // An attribution nobody can follow back is worse than none: nothing is written.
    expect(
      (await events(layout)).filter((event) => event.type === CORE_EVENT_TYPES.roadmapNodeCreated),
    ).toEqual([]);
  });

  test("a --migration id naming an event of the WRONG type is refused too", async () => {
    const { root, env } = await setup();
    const epic = await newItem(env, root, "a-feature");
    const note = await logged(env, root, ["note", "--data", "summary=not a selection"]);
    const message = await fails(env, root, [
      "node",
      "new",
      "feature",
      "a-feature",
      "--horizon",
      "now",
      "--intent",
      "the feature",
      "--epic",
      epic,
      "--migration",
      note,
    ]);
    expect(message).toContain(note);
    expect(message).toContain(MIGRATION_SELECTED_EVENT_TYPE);
  });

  test("`node update` has no --migration: attribution is a fact about the CREATION", async () => {
    const { root, env } = await setup();
    const epic = await newItem(env, root, "a-feature");
    const selected = await selection(env, root, [epic]);
    const node = lastId(
      await ok(env, root, [
        "node",
        "new",
        "feature",
        "a-feature",
        "--horizon",
        "now",
        "--intent",
        "the feature",
        "--epic",
        epic,
      ]),
    );
    const message = await fails(env, root, ["node", "update", node, "--migration", selected]);
    expect(message).toContain("--migration");
  });
});

/**
 * `nahel roadmap migration supersede` (PR #26 follow-up C3): the recovery a
 * failed migration used to need `git revert` for — on a store whose whole
 * claim is that it records what happened.
 *
 * The act is a write-ahead SEQUENCE (F7/F10 machinery): one journal event
 * naming the retired attempt, the reason, and every node it moves, followed by
 * one document move per attributed node record into
 * `nahel/roadmap/failed/<selection-event-id>/`. The journal keeps the failed
 * attempt exactly where it was — a supersession is a correction, never a
 * deletion — and after it there is NO active selection, so exactly one fresh
 * selection may follow.
 */

async function validate(root: string, args: string[] = []): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const ctx: CommandContext = {
    env: seededEnv(),
    cwd: root,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => out.push(text),
  };
  const code = await validateCommand.run(args, ctx);
  return { code, out: out.join("\n") };
}

/** Run `act` with the Nth (1-based) source unlink failing — a kill mid-sequence. */
async function withKilledUnlink(nth: number, act: () => Promise<void>): Promise<void> {
  const original = store.removeFile;
  let calls = 0;
  const spy = spyOn(store, "removeFile").mockImplementation(async (path: string) => {
    calls += 1;
    if (calls === nth) throw new Error("killed between the copy and the unlink");
    return original(path);
  });
  try {
    await act();
  } finally {
    spy.mockRestore();
  }
}

interface Migrated {
  root: string;
  layout: StoreLayout;
  env: Env;
  selection: string;
  epics: string[];
  nodes: string[];
}

/** A store mid-migration: one product node and two attributed feature nodes. */
async function migrated(): Promise<Migrated> {
  const { root, layout, env } = await setup();
  const epics = [await newItem(env, root, "one"), await newItem(env, root, "two")];
  const selectionId = await selection(env, root, epics);
  await ok(env, root, [
    "node",
    "new",
    "product",
    "the-product",
    "--horizon",
    "now",
    "--intent",
    "what this product is",
  ]);
  const nodes: string[] = [];
  for (const [index, epic] of epics.entries()) {
    nodes.push(
      lastId(
        await ok(env, root, [
          "node",
          "new",
          "feature",
          index === 0 ? "one" : "two",
          "--horizon",
          "now",
          "--parent",
          "the-product",
          "--epic",
          epic,
          "--intent",
          "the feature",
          "--migration",
          selectionId,
        ]),
      ),
    );
  }
  return { root, layout, env, selection: selectionId, epics, nodes };
}

/** The ids still rendering, and the files parked under the failed attempt. */
async function shape(fixture: Migrated): Promise<{ live: string[]; failed: string[] }> {
  const failedDir = dirname(failedRoadmapNodePath(fixture.layout, fixture.selection, "aaaaaaaa"));
  return {
    live: await listRoadmapNodes(fixture.layout),
    failed: (await readdir(failedDir).catch(() => [] as string[])).sort(),
  };
}

describe("nahel roadmap migration supersede — a failed attempt is retired in-store (C3)", () => {
  test("the attributed nodes stop rendering, and the journal keeps every act", async () => {
    const fixture = await migrated();
    const { root, layout, env } = fixture;
    const printed = (
      await ok(env, root, [
        "migration",
        "supersede",
        fixture.selection,
        "--reason",
        "the selection named the wrong epic for two of the three",
      ])
    ).join("\n");
    expect(printed).toContain(fixture.selection);
    expect(printed).toContain("2");

    // One event, carrying the whole act — the attempt, the reason, the nodes.
    const superseded = (await events(layout)).filter(
      (event) => event.type === MIGRATION_SUPERSEDED_EVENT_TYPE,
    );
    expect(superseded).toHaveLength(1);
    expect(superseded[0]!.payload[MIGRATION_SELECTION_PAYLOAD_KEY]).toBe(fixture.selection);
    expect(superseded[0]!.payload[MIGRATION_SUPERSEDED_REASON_KEY]).toContain("wrong epic");
    expect(superseded[0]!.payload[MIGRATION_NODES_PAYLOAD_KEY]).toEqual([...fixture.nodes].sort());

    // The records moved: gone from the roadmap, parked under the attempt.
    const { live, failed } = await shape(fixture);
    for (const node of fixture.nodes) expect(live).not.toContain(node);
    expect(failed).toEqual([...fixture.nodes].sort().map((id) => `${id}.md`));
    // The product node — never attributed — is untouched.
    expect(live).toHaveLength(1);

    // Nothing rendered, nothing addressable, nothing left half-done.
    const rendered = (await ok(env, root, [])).join("\n");
    expect(rendered).not.toContain("  one  ");
    expect(rendered).not.toContain("  two  ");
    expect(await fails(env, root, ["node", "show", fixture.nodes[0]!])).toContain("not found");
    const validated = await validate(root);
    expect(validated.code).toBe(0);
    expect(validated.out).not.toContain("error [");

    // The journal is intact: the selection and both creations are still there.
    const kept = await events(layout);
    expect(kept.filter((event) => event.type === MIGRATION_SELECTED_EVENT_TYPE)).toHaveLength(1);
    expect(
      kept.filter((event) => event.type === CORE_EVENT_TYPES.roadmapNodeCreated),
    ).toHaveLength(3);
  });

  test("after supersession there is no active selection, and exactly one fresh one may follow", async () => {
    const fixture = await migrated();
    const { root, env } = fixture;
    await ok(env, root, ["migration", "supersede", fixture.selection, "--reason", "tainted"]);
    // A store with a retired attempt and no replacement is not a store with a
    // pending migration: validate invents no authority from the failed one.
    expect((await validate(root)).out).not.toContain("migration-audit");

    const redo = await selection(env, root, fixture.epics);
    for (const [index, epic] of fixture.epics.entries()) {
      await ok(env, root, [
        "node",
        "new",
        "feature",
        index === 0 ? "one-again" : "two-again",
        "--horizon",
        "now",
        "--epic",
        epic,
        "--intent",
        "the feature",
        "--migration",
        redo,
      ]);
    }
    const validated = await validate(root);
    expect(validated.code).toBe(0);
    expect(validated.out).not.toContain("migration-audit");
  });

  test("only the unique active attempt: a second supersession of the same id is refused", async () => {
    const fixture = await migrated();
    const { root, env } = fixture;
    await ok(env, root, ["migration", "supersede", fixture.selection, "--reason", "tainted"]);
    const message = await fails(env, root, [
      "migration",
      "supersede",
      fixture.selection,
      "--reason",
      "tainted again",
    ]);
    expect(message).toContain(fixture.selection);
    expect(message).toContain("already superseded");
  });

  test("an id naming no event, and an id naming the wrong kind of event, are both refused", async () => {
    const fixture = await migrated();
    const { root, env } = fixture;
    expect(await fails(env, root, ["migration", "supersede", "zzzzzzzz", "--reason", "x"])).toContain(
      MIGRATION_SELECTED_EVENT_TYPE,
    );
    const note = await logged(env, root, ["note", "--data", "summary=not a selection"]);
    const message = await fails(env, root, ["migration", "supersede", note, "--reason", "x"]);
    expect(message).toContain(note);
    expect(message).toContain(MIGRATION_SELECTED_EVENT_TYPE);
  });

  test("a blank reason is refused — a retirement nobody can account for", async () => {
    const fixture = await migrated();
    const { root, env } = fixture;
    expect(await fails(env, root, ["migration", "supersede", fixture.selection])).toContain(
      "--reason",
    );
    expect(
      await fails(env, root, ["migration", "supersede", fixture.selection, "--reason", "   "]),
    ).toContain("--reason");
    expect((await shape(fixture)).failed).toEqual([]);
  });

  test("an attempt with no attributed node is refused: supersession moves attributed records only", async () => {
    const { root, layout, env } = await setup();
    const epic = await newItem(env, root, "one");
    const legacy = await selection(env, root, [epic]);
    await ok(env, root, [
      "node",
      "new",
      "feature",
      "one",
      "--horizon",
      "now",
      "--epic",
      epic,
      "--intent",
      "the feature",
    ]);
    const message = await fails(env, root, [
      "migration",
      "supersede",
      legacy,
      "--reason",
      "let us undo the legacy migration",
    ]);
    expect(message).toContain(legacy);
    expect(message).toContain("attribut");
    // Nothing journaled, nothing moved: a supersession that retires no record
    // while claiming an attempt is undone is exactly the false history this
    // bundle rules out — and the legacy migration keeps rendering.
    expect(
      (await events(layout)).filter((event) => event.type === MIGRATION_SUPERSEDED_EVENT_TYPE),
    ).toEqual([]);
    expect(await listRoadmapNodes(layout)).toHaveLength(1);
  });
});

describe("supersession refuses to strand what later work points at (C3)", () => {
  test("a node whose parent is an attributed node blocks it, and is named", async () => {
    const fixture = await migrated();
    const { root, env } = fixture;
    await ok(env, root, [
      "node",
      "new",
      "feature",
      "charted-later",
      "--horizon",
      "now",
      "--parent",
      fixture.nodes[0]!,
      "--intent",
      "later work under the migrated node",
    ]);
    const message = await fails(env, root, [
      "migration",
      "supersede",
      fixture.selection,
      "--reason",
      "tainted",
    ]);
    expect(message).toContain(fixture.nodes[0]!);
    expect(message).toContain("charted-later");
    expect((await shape(fixture)).failed).toEqual([]);
  });

  test("a predecessor link blocks it too", async () => {
    const fixture = await migrated();
    const { root, env } = fixture;
    await ok(env, root, [
      "node",
      "new",
      "feature",
      "the-successor",
      "--horizon",
      "now",
      "--predecessor",
      fixture.nodes[1]!,
      "--intent",
      "the delta after the migrated one",
    ]);
    const message = await fails(env, root, [
      "migration",
      "supersede",
      fixture.selection,
      "--reason",
      "tainted",
    ]);
    expect(message).toContain(fixture.nodes[1]!);
    expect(message).toContain("the-successor");
  });

  test("an initiative linking an attributed node blocks it", async () => {
    const fixture = await migrated();
    const { root, env } = fixture;
    await ok(env, root, [
      "node",
      "new",
      "initiative",
      "the-initiative",
      "--horizon",
      "now",
      "--feature",
      fixture.nodes[0]!,
      "--intent",
      "a sideways grouping",
    ]);
    const message = await fails(env, root, [
      "migration",
      "supersede",
      fixture.selection,
      "--reason",
      "tainted",
    ]);
    expect(message).toContain("the-initiative");
  });

  test("a map charting an attributed node blocks it", async () => {
    const fixture = await migrated();
    const { root, env } = fixture;
    const map = lastId(
      await ok(env, root, [
        "map",
        "new",
        fixture.nodes[0]!,
        "--destination",
        "the destination we are charting",
      ]),
    );
    const message = await fails(env, root, [
      "migration",
      "supersede",
      fixture.selection,
      "--reason",
      "tainted",
    ]);
    expect(message).toContain(map);
    expect((await shape(fixture)).failed).toEqual([]);
  });
});

describe("supersession interrupted at every boundary of the sequence (C3)", () => {
  test("killed before the first move: the journal is ahead, repair completes it", async () => {
    const fixture = await migrated();
    const { root, layout, env } = fixture;
    await chmod(layout.roadmapDir, 0o555);
    try {
      expect(
        await roadmapCommand.run(
          ["migration", "supersede", fixture.selection, "--reason", "tainted"],
          env,
          root,
        ),
      ).toBe(1);
    } finally {
      await chmod(layout.roadmapDir, 0o755);
      errs = [];
    }
    // The event landed; not one record moved.
    expect(
      (await events(layout)).filter((event) => event.type === MIGRATION_SUPERSEDED_EVENT_TYPE),
    ).toHaveLength(1);
    expect((await shape(fixture)).failed).toEqual([]);

    const named = await validate(root);
    expect(named.code).not.toBe(0);
    expect(named.out).toContain("journal.divergence");

    const repaired = await validate(root, ["--repair"]);
    expect(repaired.code).toBe(0);
    const settled = await shape(fixture);
    expect(settled.failed).toEqual([...fixture.nodes].sort().map((id) => `${id}.md`));
    for (const node of fixture.nodes) expect(settled.live).not.toContain(node);
    // And repair does not put them back on the next pass: a record the journal
    // records as retired is absent on purpose, not behind its creation event.
    expect((await validate(root, ["--repair"])).code).toBe(0);
    expect((await shape(fixture)).live).toHaveLength(1);
  });

  test("killed between two moves: the first is complete, the second is at both locations", async () => {
    const fixture = await migrated();
    const { root, layout, env } = fixture;
    await withKilledUnlink(2, async () => {
      expect(
        await roadmapCommand.run(
          ["migration", "supersede", fixture.selection, "--reason", "tainted"],
          env,
          root,
        ),
      ).toBe(1);
    });
    errs = [];
    const partial = await shape(fixture);
    expect(partial.failed).toHaveLength(2);
    expect(partial.live).toHaveLength(2); // the product node, and the un-unlinked one

    const named = await validate(root);
    expect(named.code).not.toBe(0);
    expect(named.out).toContain("journal.divergence");
    expect((await validate(root, ["--repair"])).code).toBe(0);
    const settled = await shape(fixture);
    expect(settled.live).toHaveLength(1);
    expect(settled.failed).toEqual([...fixture.nodes].sort().map((id) => `${id}.md`));
  });

  test("a record hand-restored to its old slot is named, and repair removes it again", async () => {
    const fixture = await migrated();
    const { root, layout } = fixture;
    await ok(fixture.env, root, [
      "migration",
      "supersede",
      fixture.selection,
      "--reason",
      "tainted",
    ]);
    const id = fixture.nodes[0]!;
    await Bun.write(
      roadmapNodePath(layout, id),
      await Bun.file(failedRoadmapNodePath(layout, fixture.selection, id)).text(),
    );
    const named = await validate(root);
    expect(named.code).not.toBe(0);
    expect(named.out).toContain("journal.divergence");
    expect((await validate(root, ["--repair"])).code).toBe(0);
    expect((await shape(fixture)).live).toHaveLength(1);
  });

  test("a settled supersession repairs to itself and reports nothing", async () => {
    const fixture = await migrated();
    await ok(fixture.env, fixture.root, [
      "migration",
      "supersede",
      fixture.selection,
      "--reason",
      "tainted",
    ]);
    const repaired = await validate(fixture.root, ["--repair"]);
    expect(repaired.code).toBe(0);
    expect(repaired.out).not.toContain("repaired");
  });
});

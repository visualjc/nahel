import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { itemCommand } from "../../src/commands/item";
import { logCommand } from "../../src/commands/log";
import { roadmapCommand } from "../../src/commands/roadmap";
import type { Env } from "../../src/schema/env";
import { ID_PATTERN } from "../../src/schema/id";
import {
  CORE_EVENT_TYPES,
  MIGRATION_ATTRIBUTION_PAYLOAD_KEY,
  MIGRATION_SELECTED_EVENT_TYPE,
} from "../../src/schema/events";
import type { JournalEvent } from "../../src/schema/records";
import { readJournal } from "../../src/store/journal";
import { ensureLayout, writeConfig, type StoreLayout } from "../../src/store/layout";
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

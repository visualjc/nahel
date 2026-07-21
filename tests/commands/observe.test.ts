import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { observeCommand } from "../../src/commands/observe";
import type { Env } from "../../src/schema/env";
import { ID_PATTERN } from "../../src/schema/id";
import type { Config, JournalEvent } from "../../src/schema/records";
import { appendEvent, listSegments, newSessionSegmentId, readJournal } from "../../src/store/journal";
import {
  ensureLayout,
  listObservations,
  readObservation,
  writeConfig,
  type StoreLayout,
} from "../../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel observe` (PRD F6.1): create one durable observation — a curated
 * fact with provenance journal event ids — through the store's mutate()
 * choke point. Command objects are exercised directly against real temp-dir
 * stores, item.test.ts style; journaling assertions READ the journal.
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

async function setup(options: { actor?: Config["actor"] } = {}) {
  const root = await makeTempDir("nahel-cmd-observe-");
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(
    layout,
    makeConfig(options.actor === undefined ? {} : { actor: options.actor }),
  );
  const env = seededEnv({ tickSeconds: 1 });
  return { root, layout, env };
}

/** Journal a note event to cite as provenance; returns its id. */
async function seedSourceEvent(layout: StoreLayout, env: Env): Promise<string> {
  const event = await appendEvent(layout, env, {
    type: "note",
    actor: { kind: "human", id: "jim" },
    payload: { text: "something worth distilling" },
    session: newSessionSegmentId(env),
  });
  return event.id;
}

async function journalEvents(layout: StoreLayout): Promise<JournalEvent[]> {
  return Array.fromAsync(readJournal(layout));
}

describe("nahel observe — creating an observation", () => {
  test("creates the record via the choke point: printed id, frontmatter fields, write-ahead event", async () => {
    const { root, layout, env } = await setup();
    const source = await seedSourceEvent(layout, env);

    const code = await observeCommand.run(
      [
        "flaky-auth-test",
        "--data",
        `sources=${source}`,
        "--data",
        "body=Auth tests flake when the seed pool is cold.",
        "--data",
        'tags=["auth","testing"]',
      ],
      env,
      root,
    );
    expect(stderr()).toBe("");
    expect(code).toBe(0);
    const id = logs[logs.length - 1]!;
    expect(id).toMatch(ID_PATTERN);

    // Record materialized with the slug, tags, and provenance.
    const record = await readObservation(layout, id);
    expect(record.frontmatter.name).toBe("flaky-auth-test");
    expect(record.frontmatter.tags).toEqual(["auth", "testing"]);
    expect(record.frontmatter.sources).toEqual([source]);
    expect(record.body).toBe("Auth tests flake when the seed pool is cold.\n");

    // Write-ahead journaled through mutate(): full mutation payload, no
    // item/run refs, and the invocation's session closed then archived.
    const events = await journalEvents(layout);
    const created = events.find((event) => event.type === "observation.created")!;
    expect(created).toBeDefined();
    expect(created.item).toBeUndefined();
    expect(created.run).toBeUndefined();
    expect(created.payload["target"]).toBe("observation");
    expect((created.payload["record"] as { id: string }).id).toBe(id);
    expect(created.actor).toEqual({ kind: "agent", id: "claude-code" });
    // observe closed and rotated its own session segment; the seed event's
    // segment was never closed and stays active.
    const segments = await listSegments(layout);
    expect(segments.archived).toHaveLength(1);
    expect(segments.active).toHaveLength(1);
  });

  test("a JSON --data object and repeated key=val entries are equivalent (log's --data dialect)", async () => {
    const { root, layout, env } = await setup();
    const source = await seedSourceEvent(layout, env);

    const code = await observeCommand.run(
      ["one-fact", "--data", `{"sources":["${source}"],"body":"The fact.","tags":"single"}`],
      env,
      root,
    );
    expect(stderr()).toBe("");
    expect(code).toBe(0);
    const record = await readObservation(layout, logs[logs.length - 1]!);
    expect(record.frontmatter.sources).toEqual([source]);
    expect(record.frontmatter.tags).toEqual(["single"]); // bare string normalized
    expect(record.body).toBe("The fact.\n");
  });
});

describe("nahel observe — refusals (nothing written)", () => {
  test("refuses an observation with no provenance sources", async () => {
    const { root, layout, env } = await setup();
    const code = await observeCommand.run(
      ["no-provenance", "--data", "body=A fact from nowhere."],
      env,
      root,
    );
    expect(code).toBe(1);
    expect(stderr()).toContain("sources");
    expect(await listObservations(layout)).toEqual([]);
    expect(await journalEvents(layout)).toEqual([]);
  });

  test("refuses sources that are not in the journal, naming them", async () => {
    const { root, layout, env } = await setup();
    const code = await observeCommand.run(
      ["ghost-source", "--data", "sources=zzzzzzzz", "--data", "body=A fact."],
      env,
      root,
    );
    expect(code).toBe(1);
    expect(stderr()).toContain("zzzzzzzz");
    expect(stderr()).toContain("journal");
    expect(await listObservations(layout)).toEqual([]);
  });

  test("refuses a missing or empty body — an observation IS its fact", async () => {
    const { root, layout, env } = await setup();
    const source = await seedSourceEvent(layout, env);
    const code = await observeCommand.run(
      ["bodyless", "--data", `sources=${source}`],
      env,
      root,
    );
    expect(code).toBe(1);
    expect(stderr()).toContain("body");
    expect(await listObservations(layout)).toEqual([]);
  });

  test("refuses a non-slug name and unknown --data keys, with usage", async () => {
    const { root, env } = await setup();
    expect(
      await observeCommand.run(["Not A Slug", "--data", "body=x", "--data", "sources=aaaaaaaa"], env, root),
    ).toBe(1);
    expect(stderr()).toContain("slug");

    errs = [];
    expect(
      await observeCommand.run(
        ["ok-slug", "--data", "body=x", "--data", "sources=aaaaaaaa", "--data", "titel=typo"],
        env,
        root,
      ),
    ).toBe(1);
    expect(stderr()).toContain("titel");
  });

  test("refuses a malformed source id before touching the journal", async () => {
    const { root, layout, env } = await setup();
    const code = await observeCommand.run(
      ["bad-id", "--data", "body=x", "--data", "sources=not-an-id"],
      env,
      root,
    );
    expect(code).toBe(1);
    expect(stderr()).toContain("not-an-id");
    expect(await listObservations(layout)).toEqual([]);
  });
});

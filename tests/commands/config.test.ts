import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { configCommand, SETTABLE_CONFIG_SECTIONS } from "../../src/commands/config";
import type { JournalEvent } from "../../src/schema/records";
import { listSegments, readJournal } from "../../src/store/journal";
import { ensureLayout, readConfig, writeConfig, type StoreLayout } from "../../src/store/layout";
import { validateStore } from "../../src/validate";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel config set` (PRD F4): atomically replace exactly one OPTIONAL
 * top-level config section, validating the whole config against the schema
 * before any write, journaling the change write-ahead as `config.updated`.
 * This is the CLI path the inception and setup-routing workflows write
 * config through — agents never hand-edit `nahel/config`. Refusals write
 * nothing at all: the config bytes stay untouched and no event is journaled.
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

async function setup(configOverrides: Parameters<typeof makeConfig>[0] = {}) {
  const root = await makeTempDir("nahel-cmd-config-");
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig(configOverrides));
  const env = seededEnv({ tickSeconds: 1 });
  return { root, layout, env };
}

async function journalEvents(layout: StoreLayout): Promise<JournalEvent[]> {
  return Array.fromAsync(readJournal(layout));
}

async function configBytes(layout: StoreLayout): Promise<string> {
  return readFile(layout.configPath, "utf8");
}

describe("nahel config set — writing optional sections", () => {
  test("sets the inception tier: schema-valid on disk, journaled write-ahead, validate green", async () => {
    const { root, layout, env } = await setup();
    const code = await configCommand.run(["set", "inception", "--data", "tier=seed"], env, root);
    expect(errs.join("\n")).toBe("");
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("inception");

    // The recorded tier is committed, schema-validated state (F4 acceptance).
    expect((await readConfig(layout)).inception).toEqual({ tier: "seed" });
    const errors = (await validateStore(layout)).filter((f) => f.severity === "error");
    expect(errors).toEqual([]);

    const act = (await journalEvents(layout)).find((event) => event.type === "config.updated")!;
    expect(act).toBeDefined();
    expect(act.payload).toEqual({ section: "inception", value: { tier: "seed" } });
  });

  test("sets governance from a JSON --data payload", async () => {
    const { root, layout, env } = await setup();
    const code = await configCommand.run(
      ["set", "governance", "--data", '{"product": "human", "architecture": "delegated"}'],
      env,
      root,
    );
    expect(code).toBe(0);
    expect((await readConfig(layout)).governance).toEqual({
      product: "human",
      architecture: "delegated",
    });
  });

  test("key=val entries JSON-parse values (numbers stay numbers) and merge left to right", async () => {
    const { root, layout, env } = await setup();
    const code = await configCommand.run(
      ["set", "compaction", "--data", "max_events=100", "--data", "max_age_days=14"],
      env,
      root,
    );
    expect(code).toBe(0);
    expect((await readConfig(layout)).compaction).toEqual({ max_events: 100, max_age_days: 14 });
  });

  test("replaces exactly the named section: other sections survive, the old section is gone entirely", async () => {
    const { root, layout, env } = await setup({
      contract: { launch: "bun run dev", seed: "bun run seed", test: "bun test" },
      routing: { review: { agent: "codex" }, default: { agent: "claude-code" } },
    });
    const code = await configCommand.run(
      ["set", "routing", "--data", '{"implementation": {"model": "claude-opus-4"}}'],
      env,
      root,
    );
    expect(code).toBe(0);
    const config = await readConfig(layout);
    // Whole-section replacement, not a merge: review/default are gone.
    expect(config.routing).toEqual({ implementation: { model: "claude-opus-4" } });
    // Untargeted sections are untouched.
    expect(config.contract).toEqual({
      launch: "bun run dev",
      seed: "bun run seed",
      test: "bun test",
    });
    expect(config.knowledge).toEqual(makeConfig().knowledge);
    expect(config.actor).toEqual(makeConfig().actor);
  });

  test("re-running the same set changes nothing: identical bytes, no new journal event", async () => {
    const { root, layout, env } = await setup();
    expect(await configCommand.run(["set", "inception", "--data", "tier=standard"], env, root)).toBe(0);
    const bytes = await configBytes(layout);
    const eventCount = (await journalEvents(layout)).length;

    logs = [];
    expect(await configCommand.run(["set", "inception", "--data", "tier=standard"], env, root)).toBe(0);
    expect(logs.join("\n")).toContain("unchanged");
    expect(await configBytes(layout)).toBe(bytes);
    expect((await journalEvents(layout)).length).toBe(eventCount);
  });

  test("the set's own session closes and archives — no active segments linger", async () => {
    const { root, layout, env } = await setup();
    expect(await configCommand.run(["set", "inception", "--data", "tier=seed"], env, root)).toBe(0);
    expect((await listSegments(layout)).active).toEqual([]);
  });
});

describe("nahel config set — refusals (config untouched, nothing journaled)", () => {
  test("an invalid tier is a schema error naming the field; the config bytes stay untouched", async () => {
    const { root, layout, env } = await setup();
    const before = await configBytes(layout);
    const code = await configCommand.run(["set", "inception", "--data", "tier=quick"], env, root);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("inception.tier");
    expect(await configBytes(layout)).toBe(before);
    expect(await journalEvents(layout)).toEqual([]);
  });

  test("a malformed section payload (missing required key) is refused with the schema's reason", async () => {
    const { root, layout, env } = await setup();
    const before = await configBytes(layout);
    const code = await configCommand.run(
      ["set", "contract", "--data", '{"launch": "bun run dev", "test": "bun test"}'],
      env,
      root,
    );
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("contract.seed");
    expect(await configBytes(layout)).toBe(before);
    expect(await journalEvents(layout)).toEqual([]);
  });

  test("an unknown key inside a section payload is refused (strict schema, typo surfaces)", async () => {
    const { root, layout, env } = await setup();
    const code = await configCommand.run(
      ["set", "inception", "--data", "tier=seed", "--data", "upgraded=true"],
      env,
      root,
    );
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("upgraded");
    expect(await journalEvents(layout)).toEqual([]);
  });

  test("refuses an unknown section, listing the settable ones", async () => {
    const { root, layout, env } = await setup();
    const code = await configCommand.run(["set", "telemetry", "--data", "on=true"], env, root);
    expect(code).toBe(1);
    for (const section of SETTABLE_CONFIG_SECTIONS) {
      expect(errs.join("\n")).toContain(section);
    }
    expect(await journalEvents(layout)).toEqual([]);
  });

  test("refuses the core sections (knowledge, actor) outright", async () => {
    const { root, layout, env } = await setup();
    const before = await configBytes(layout);
    for (const section of ["knowledge", "actor"]) {
      errs = [];
      const code = await configCommand.run(
        ["set", section, "--data", '{"kind": "human", "id": "mallory"}'],
        env,
        root,
      );
      expect(code).toBe(1);
      expect(errs.join("\n")).toContain(section);
    }
    expect(await configBytes(layout)).toBe(before);
    expect(await journalEvents(layout)).toEqual([]);
  });

  test("no --data at all is a usage error (an empty replacement must be explicit: --data {})", async () => {
    const { root, env } = await setup();
    const code = await configCommand.run(["set", "compaction"], env, root);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("usage");
  });

  test("a missing or unknown subcommand is a usage error", async () => {
    const { root, env } = await setup();
    expect(await configCommand.run([], env, root)).toBe(1);
    expect(errs.join("\n")).toContain("usage");
    errs = [];
    expect(await configCommand.run(["get", "routing"], env, root)).toBe(1);
    expect(errs.join("\n")).toContain("usage");
  });
});

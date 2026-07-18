import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { COMMANDS, main, VERSION, type CommandContext } from "../src/cli";
import type { JournalEvent } from "../src/schema/records";
import { NAHEL_ACTOR_VAR } from "../src/store/actor";
import { readJournal } from "../src/store/journal";
import { ensureLayout, writeConfig } from "../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "./store/helpers";

/**
 * CLI dispatch (task #4 owns this structure): parseArgs-based, a registry
 * table mapping name → { run, description }. Later commands register with one
 * import + one table entry; these tests pin the dispatch contract they rely on.
 */

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runMain(args: string[], cwd = "/nonexistent-cwd"): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    env: seededEnv(),
    cwd,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  const code = await main(args, ctx);
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

describe("cli", () => {
  test("exposes a semver version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("--version prints the version", async () => {
    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "--version"]);
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out.trim()).toBe(`nahel ${VERSION}`);
  });
});

describe("cli dispatch", () => {
  test("registry entries all carry a run function and a non-empty description", () => {
    expect(Object.keys(COMMANDS).length).toBeGreaterThan(0);
    for (const [name, command] of Object.entries(COMMANDS)) {
      expect(name).toMatch(/^[a-z][a-z-]*$/);
      expect(typeof command.run).toBe("function");
      expect(command.description.length).toBeGreaterThan(0);
    }
  });

  test("init is registered", () => {
    expect(COMMANDS["init"]).toBeDefined();
  });

  test("--version and -v go through main", async () => {
    for (const flag of ["--version", "-v"]) {
      const result = await runMain([flag]);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(`nahel ${VERSION}`);
    }
  });

  test("no arguments prints help listing every registered command, exit 0", async () => {
    const result = await runMain([]);
    expect(result.code).toBe(0);
    for (const [name, command] of Object.entries(COMMANDS)) {
      expect(result.stdout).toContain(name);
      expect(result.stdout).toContain(command.description);
    }
  });

  test("help, --help and -h print the same help", async () => {
    const bare = await runMain([]);
    for (const spelling of [["help"], ["--help"], ["-h"]]) {
      const result = await runMain(spelling);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(bare.stdout);
    }
  });

  test("unknown command exits 1 with the offending name on stderr", async () => {
    const result = await runMain(["frobnicate"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("frobnicate");
    expect(result.stdout).toBe("");
  });

  test("a command error is reported on stderr with exit 1, never a crash", async () => {
    // An unknown flag makes parseArgs throw inside the command; main must
    // contain it as a clean error, not an unhandled exception.
    const result = await runMain(["init", "--definitely-not-a-flag"]);
    expect(result.code).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

describe("cli entry point — NAHEL_ACTOR environment contract", () => {
  // The env var contract lives at the entry point: cli.ts is the single
  // ambient-process reader, so the variable is exercised end-to-end here by
  // spawning the real CLI — commands themselves only ever see the injected
  // actorOverride value (tests/commands/*.test.ts cover that layer).
  // Both actor kinds: the human override AND the fresh-agent self-identify
  // path AGENTS.md instructs (NAHEL_ACTOR=agent:<id> before any command).
  for (const [spec, expected] of [
    ["human:jim", { kind: "human", id: "jim" }],
    ["agent:fresh-agent", { kind: "agent", id: "fresh-agent" }],
  ] as const) {
    test(`NAHEL_ACTOR=${spec} in the process environment overrides the config actor`, async () => {
      const root = await makeTempDir("nahel-cli-actor-");
      try {
        const layout = await ensureLayout(root);
        await writeConfig(layout, makeConfig()); // config actor: agent claude-code

        const proc = Bun.spawn(
          ["bun", "run", join(import.meta.dir, "../src/cli.ts"), "item", "new", "chore", "env-actor", "direct"],
          {
            cwd: root,
            env: { ...process.env, [NAHEL_ACTOR_VAR]: spec },
            stderr: "pipe",
          },
        );
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        expect(stderr).toBe("");
        expect(await proc.exited).toBe(0);
        const id = stdout.trim();
        expect(id.length).toBeGreaterThan(0);

        const events: JournalEvent[] = [];
        for await (const event of readJournal(layout)) events.push(event);
        expect(events).toHaveLength(1);
        expect(events[0]!.type).toBe("item.created");
        expect(events[0]!.item).toBe(id);
        expect(events[0]!.actor).toEqual(expected);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  test("without NAHEL_ACTOR the config actor resolves end-to-end", async () => {
    const root = await makeTempDir("nahel-cli-actor-");
    try {
      const layout = await ensureLayout(root);
      await writeConfig(layout, makeConfig()); // config actor: agent claude-code

      const env = { ...process.env };
      delete env[NAHEL_ACTOR_VAR];
      const proc = Bun.spawn(
        ["bun", "run", join(import.meta.dir, "../src/cli.ts"), "item", "new", "chore", "config-actor", "direct"],
        { cwd: root, env, stderr: "pipe" },
      );
      const stdout = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      const id = stdout.trim();

      const events: JournalEvent[] = [];
      for await (const event of readJournal(layout)) events.push(event);
      expect(events).toHaveLength(1);
      expect(events[0]!.item).toBe(id);
      expect(events[0]!.actor).toEqual({ kind: "agent", id: "claude-code" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

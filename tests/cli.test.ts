import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { COMMANDS, main, VERSION, type CommandContext } from "../src/cli";
import type { JournalEvent } from "../src/schema/records";
import { NAHEL_ACTOR_VAR } from "../src/store/actor";
import { readJournal } from "../src/store/journal";
import { ensureLayout, listItems, storeLayout, writeConfig } from "../src/store/layout";
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

  test("the version IS package.json's — one source of truth, nothing to drift", async () => {
    const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
    expect(VERSION).toBe(pkg.version);
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

describe("cli — store root resolution from a subdirectory", () => {
  // The 2026-07-25 quirk: `nahel distill` run from nahel/journal/archive/ died
  // with "nahel/config not found at <cwd>/nahel/config" because cwd went
  // straight into the layout. Commands over an EXISTING store now walk up to
  // the nearest nahel/config, bounded by the git worktree; init stays strict.
  async function storeRepo(): Promise<string> {
    const root = await makeTempDir("nahel-cli-walkup-");
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    await writeConfig(await ensureLayout(root), makeConfig());
    return root;
  }

  test("a read command run from nahel/journal/archive/ resolves the store above", async () => {
    const root = await storeRepo();
    try {
      const result = await runMain(["status"], join(root, "nahel", "journal", "archive"));
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a mutation command run from a subdirectory writes into the store above", async () => {
    const root = await storeRepo();
    try {
      const sub = join(root, "docs", "adr");
      await mkdir(sub, { recursive: true });
      const result = await runMain(["item", "new", "chore", "from-subdir", "direct"], sub);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(await listItems(storeLayout(root))).toHaveLength(1);
      expect(existsSync(join(sub, "nahel"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("outside any store the failure still names where it looked and points at `nahel init`", async () => {
    const dir = await makeTempDir("nahel-cli-nostore-");
    try {
      expect(spawnSync("git", ["init", "-q"], { cwd: dir }).status).toBe(0);
      const sub = join(dir, "sub");
      await mkdir(sub);
      const result = await runMain(["status"], sub);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(sub);
      expect(result.stderr).toContain("nahel init");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("init stays cwd-strict: it creates the store where it is run, never in the parent", async () => {
    const root = await storeRepo();
    try {
      const sub = join(root, "sub");
      await mkdir(sub);
      const result = await runMain(["init"], sub);
      expect(result.code).toBe(0);
      expect(existsSync(join(sub, "nahel", "config"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("cli entry point — nahel doctor env contract (PRD F2, ADR-0014)", () => {
  // The env-presence check lives at the entry point: cli.ts is the single
  // reader of the ambient process environment, injecting only a presence
  // predicate. This exercises the real wiring end-to-end by spawning the CLI,
  // proving the missing-vs-incomplete exit-code branch AND that a "clone plus
  // a filled .env" passes. The var name is unlikely to collide with the shell.
  const VAR = "NAHEL_DOCTOR_TEST_VAR";
  const contract = { launch: "l", seed: "s", test: "t", env: [VAR], healthcheck: "exit 0" };

  async function spawnDoctor(
    withContract: boolean,
    varValue: string | undefined,
  ): Promise<{ code: number; stdout: string }> {
    const root = await makeTempDir("nahel-cli-doctor-");
    try {
      const layout = await ensureLayout(root);
      await writeConfig(layout, withContract ? makeConfig({ contract }) : makeConfig());
      const env = { ...process.env };
      delete env[VAR];
      if (varValue !== undefined) env[VAR] = varValue;
      const proc = Bun.spawn(
        ["bun", "run", join(import.meta.dir, "../src/cli.ts"), "doctor"],
        { cwd: root, env, stderr: "pipe" },
      );
      const stdout = await new Response(proc.stdout).text();
      const code = await proc.exited;
      return { code, stdout };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test("no contract section exits 2 (contract missing)", async () => {
    const result = await spawnDoctor(false, undefined);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("contract missing");
  });

  test("contract present but the named var unset exits 3 (env incomplete)", async () => {
    const result = await spawnDoctor(true, undefined);
    expect(result.code).toBe(3);
    expect(result.stdout).toContain(VAR);
  });

  test("an empty value is not a filled secret — still exits 3", async () => {
    const result = await spawnDoctor(true, "");
    expect(result.code).toBe(3);
  });

  test("a filled var plus a passing healthcheck exits 0 (contract OK)", async () => {
    const result = await spawnDoctor(true, "postgres://localhost/app");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("contract OK");
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

        // The mutation, then the invocation's session-close marker — both
        // carrying the actor the environment variable resolved.
        const events: JournalEvent[] = [];
        for await (const event of readJournal(layout)) events.push(event);
        expect(events).toHaveLength(2);
        expect(events[0]!.type).toBe("item.created");
        expect(events[0]!.item).toBe(id);
        expect(events[0]!.actor).toEqual(expected);
        expect(events[1]!.type).toBe("session.closed");
        expect(events[1]!.actor).toEqual(expected);
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
      expect(events).toHaveLength(2); // item.created + the session-close marker
      expect(events[0]!.item).toBe(id);
      expect(events[0]!.actor).toEqual({ kind: "agent", id: "claude-code" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

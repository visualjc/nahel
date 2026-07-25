import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { dispatchCommand } from "../../src/commands/dispatch";
import type { Env } from "../../src/schema/env";
import type { Config, JournalEvent, Run, WorkItemFrontmatter } from "../../src/schema/records";
import { readJournal } from "../../src/store/journal";
import {
  ensureLayout,
  listRuns,
  readItem,
  readRun,
  writeConfig,
  writeItem,
  type StoreLayout,
} from "../../src/store/layout";
import { validateStore } from "../../src/validate";
import { makeConfig, makeFrontmatter, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel dispatch` (PRD F1, ADR-0015/0016): the deterministic mechanics of
 * launching a routed executor — resolve the routing map, compose the agent
 * CLI invocation (binary, model flag, NAHEL_ACTOR, orientation preamble),
 * spawn it, record the run. The "agent CLI" here is a stub executable that
 * runs the REAL nahel CLI, so actor attribution is proven end to end: the
 * dispatch events carry the dispatcher's actor, the worker's mutations carry
 * the worker's own. Real agent CLIs cannot run offline; every other part of
 * the invocation is exercised exactly as it ships — the stub is spawned
 * through the real composed argv, never around it.
 */

const CLI_PATH = join(import.meta.dir, "../../src/cli.ts");

const DEFAULT_ROUTING: Config["routing"] = {
  implementation: { agent: "claude", model: "claude-opus-5" },
};

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
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Repo {
  root: string;
  layout: StoreLayout;
  env: Env;
  item: WorkItemFrontmatter;
  stubPath: string;
  /** Where the stub agent CLI records what it was invoked with. */
  recordPath: string;
}

interface SetupOptions {
  /** Routing section to commit; "none" omits the section entirely. */
  routing?: Config["routing"] | "none";
  /** Have the stub worker mutate the item through the real nahel CLI. */
  workerMutates?: boolean;
  /** Exit code the stub worker exits with (default 0). */
  exitCode?: number;
  /** Frontmatter overrides for the repo's work item. */
  item?: Partial<WorkItemFrontmatter>;
  /** Replace the committed config with arbitrary (possibly invalid) YAML. */
  rawConfig?: (base: Config) => unknown;
}

/**
 * A temp repo with an initialized store, one work item, and an executable
 * stub agent CLI wired into `config.dispatch.claude` — the config surface a
 * real deployment uses to point `claude` at its actual binary.
 */
async function setup(options: SetupOptions = {}): Promise<Repo> {
  const root = await makeTempDir("nahel-cmd-dispatch-");
  dirs.push(root);
  const layout = await ensureLayout(root);
  const env = seededEnv({ tickSeconds: 1 });

  const item = makeFrontmatter(env, { name: "dispatch-target", ...options.item });
  await writeItem(layout, item, "The task body.\n");

  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const recordPath = join(binDir, "invocation.json");
  const stubPath = join(binDir, "stub-agent");
  await writeFile(
    stubPath,
    [
      "#!/usr/bin/env bun",
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
      "  argv: Bun.argv.slice(2),",
      "  actor: process.env.NAHEL_ACTOR ?? null,",
      "  cwd: process.cwd(),",
      "}, null, 2));",
      `const item = ${JSON.stringify(options.workerMutates === true ? item.id : null)};`,
      "if (item !== null) {",
      "  const result = Bun.spawnSync(",
      `    [process.execPath, "run", ${JSON.stringify(CLI_PATH)},`,
      '     "item", "update", item, "--status", "in-progress"],',
      '    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },',
      "  );",
      "  if (result.exitCode !== 0) {",
      "    console.error(result.stderr.toString());",
      "    process.exit(90);",
      "  }",
      "}",
      `process.exit(${options.exitCode ?? 0});`,
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(stubPath, 0o755);

  const routing = options.routing === "none" ? undefined : (options.routing ?? DEFAULT_ROUTING);
  const base = makeConfig({
    ...(routing === undefined ? {} : { routing }),
    dispatch: { claude: { binary: stubPath, args: ["-p"], model_flag: "--model" } },
  });
  if (options.rawConfig === undefined) {
    await writeConfig(layout, base);
  } else {
    // Deliberately invalid config: written as raw YAML because writeConfig
    // validates — the point of these tests is what READERS do with it.
    await writeFile(layout.configPath, YAML.stringify(options.rawConfig(base)), "utf8");
  }
  return { root, layout, env, item, stubPath, recordPath };
}

/** Run the verb as the dispatcher (the host runner's own actor). */
function dispatch(repo: Repo, argv: string[], actor = "agent:host-runner"): Promise<number> {
  return dispatchCommand.run(argv, repo.env, repo.root, actor);
}

async function events(layout: StoreLayout): Promise<JournalEvent[]> {
  return Array.fromAsync(readJournal(layout));
}

async function eventOfType(layout: StoreLayout, type: string): Promise<JournalEvent | undefined> {
  return (await events(layout)).find((event) => event.type === type);
}

async function invocationRecord(
  repo: Repo,
): Promise<{ argv: string[]; actor: string | null; cwd: string }> {
  return JSON.parse(await readFile(repo.recordPath, "utf8"));
}

async function onlyRun(layout: StoreLayout): Promise<Run> {
  const ids = await listRuns(layout);
  expect(ids).toHaveLength(1);
  return readRun(layout, ids[0]!);
}

describe("nahel dispatch — spawns the routed agent CLI and records the run (F1.1)", () => {
  test("dispatches the mapped agent with the mapped model and records an attributed run", async () => {
    const repo = await setup();
    const code = await dispatch(repo, [
      "implementation",
      "--item",
      repo.item.id,
      "--",
      "build",
      "it",
    ]);
    console.log("[stdout]", logs.join("\n"), "[stderr]", errs.join("\n"));
    expect(code).toBe(0);

    const invocation = await invocationRecord(repo);
    console.log("[invocation]", invocation.argv.slice(0, 3), invocation.actor);
    expect(invocation.argv.slice(0, 3)).toEqual(["-p", "--model", "claude-opus-5"]);
    expect(invocation.actor).toBe("agent:claude");
    expect(invocation.cwd).toContain(repo.root.split("/").pop()!);

    const run = await onlyRun(repo.layout);
    expect(run.item).toBe(repo.item.id);
    expect(run.actor).toEqual({ kind: "agent", id: "claude" });
    expect(run.status).toBe("ended");
    expect(run.phase).toBe("success");
  });

  test("the journal shows the dispatch under the dispatcher and the worker's mutation under its own actor id", async () => {
    const repo = await setup({ workerMutates: true });
    const code = await dispatch(repo, ["implementation", "--item", repo.item.id, "--", "do work"]);
    console.log("[stderr]", errs.join("\n"));
    expect(code).toBe(0);

    const journal = await events(repo.layout);
    console.log("[journal]", journal.map((event) => `${event.type}:${event.actor.id}`).join(" "));

    const started = journal.find((event) => event.type === "dispatch.started");
    expect(started?.actor).toEqual({ kind: "agent", id: "host-runner" });

    const workerMutation = journal.find(
      (event) => event.type === "item.updated" && event.actor.id === "claude",
    );
    expect(workerMutation).toBeDefined();
    expect(workerMutation!.actor).toEqual({ kind: "agent", id: "claude" });
    expect((await readItem(repo.layout, repo.item.id)).frontmatter.status).toBe("in-progress");

    // The dispatch bracket and the run lifecycle are both journaled.
    for (const type of ["dispatch.ended", "run.started", "run.ended"]) {
      expect(journal.some((event) => event.type === type)).toBe(true);
    }
  });

  test("--item is REQUIRED: an itemless dispatch is a usage error, nothing spawned, nothing journaled", async () => {
    // F1.1's acceptance criterion is a correctly attributed RUN record for
    // every dispatch. Every dispatch belongs to a work item; there is no
    // itemless dispatch in the AFK loop, so the itemless form is refused
    // rather than silently producing an unattributed dispatch.
    const repo = await setup();
    const code = await dispatch(repo, ["implementation", "--", "a standalone errand"]);
    console.log("[itemless]", errs.join("\n"));
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("--item");
    expect(await listRuns(repo.layout)).toEqual([]);
    expect(await events(repo.layout)).toEqual([]);
    expect(await Bun.file(repo.recordPath).exists()).toBe(false);
  });

  test("a compose-time refusal leaves NO ghost run: the probe fires before any state changes", async () => {
    // Schema-valid config that cannot compose: routing names a model, the
    // agent's invocation entry has no model_flag to put it on. Composing
    // after the run opened would leave an active run and a run.started event
    // with nothing ever spawned — a misrouted dispatch must be inert.
    const repo = await setup({
      rawConfig: (base) => ({
        ...base,
        dispatch: { claude: { binary: base.dispatch!.claude!.binary, args: ["-p"] } },
      }),
    });
    const code = await dispatch(repo, ["implementation", "--item", repo.item.id, "--", "go"]);
    const message = errs.join("\n");
    console.log("[no model_flag]", message);
    expect(code).toBe(1);
    expect(message).toContain("model_flag");
    expect(await listRuns(repo.layout)).toEqual([]);
    expect(await events(repo.layout)).toEqual([]);
    expect(await Bun.file(repo.recordPath).exists()).toBe(false);
  });

  test("a worker that exits non-zero ends the run as a failure and exits non-zero", async () => {
    const repo = await setup({ exitCode: 3 });
    expect(await dispatch(repo, ["implementation", "--item", repo.item.id, "--", "try"])).toBe(1);
    const run = await onlyRun(repo.layout);
    expect(run.status).toBe("ended");
    expect(run.phase).toBe("failure");
    const ended = await eventOfType(repo.layout, "dispatch.ended");
    console.log("[dispatch.ended]", ended?.payload);
    expect(ended?.payload["exit_code"]).toBe(3);
    expect(ended?.payload["outcome"]).toBe("failure");
  });

  test("dispatching a claimed item is refused by the claim guard — and nothing is spawned", async () => {
    const repo = await setup({ item: { claimed_by: "human:jim" } });
    expect(await dispatch(repo, ["implementation", "--item", repo.item.id, "--", "sneak in"])).toBe(
      1,
    );
    console.log("[claimed]", errs.join("\n"));
    expect(errs.join("\n")).toContain("claim");
    expect(await Bun.file(repo.recordPath).exists()).toBe(false);
  });

  test("a --item naming no existing item is refused before anything is spawned", async () => {
    const repo = await setup();
    expect(await dispatch(repo, ["implementation", "--item", "0gz8r4cm", "--", "go"])).toBe(1);
    expect(errs.join("\n")).toContain("0gz8r4cm");
    expect(await Bun.file(repo.recordPath).exists()).toBe(false);
  });
});

describe("nahel dispatch — the recorded invocation proves the orientation contract (F1.1 AC)", () => {
  test("the journaled dispatch record carries the composed invocation, brief preamble ahead of the task", async () => {
    const repo = await setup();
    expect(
      await dispatch(repo, ["implementation", "--item", repo.item.id, "--", "ship the thing"]),
    ).toBe(0);

    const started = await eventOfType(repo.layout, "dispatch.started");
    expect(started).toBeDefined();
    const invocation = started!.payload["invocation"] as {
      binary: string;
      args: string[];
      env: Record<string, string>;
    };
    console.log("[recorded invocation]", JSON.stringify(invocation, null, 2));
    expect(invocation.binary).toBe(repo.stubPath);
    expect(invocation.env).toEqual({ NAHEL_ACTOR: "agent:claude" });

    const prompt = invocation.args[invocation.args.length - 1]!;
    const orientation = prompt.indexOf("nahel brief");
    const task = prompt.indexOf("ship the thing");
    expect(orientation).toBeGreaterThanOrEqual(0);
    expect(task).toBeGreaterThanOrEqual(0);
    expect(orientation).toBeLessThan(task);
  });

  test("the invocation the worker actually received is the invocation that was journaled", async () => {
    const repo = await setup();
    expect(await dispatch(repo, ["implementation", "--item", repo.item.id, "--", "ship it"])).toBe(
      0,
    );
    const started = await eventOfType(repo.layout, "dispatch.started");
    const journaled = started!.payload["invocation"] as { args: string[] };
    expect((await invocationRecord(repo)).argv).toEqual(journaled.args);
  });

  test("the preamble names the run so the worker can record its own progress", async () => {
    const repo = await setup();
    expect(await dispatch(repo, ["implementation", "--item", repo.item.id, "--", "work"])).toBe(0);
    const run = await onlyRun(repo.layout);
    const prompt = (await invocationRecord(repo)).argv.at(-1)!;
    console.log("[prompt]\n" + prompt);
    expect(prompt).toContain(repo.item.id);
    expect(prompt).toContain(`nahel run update ${run.id}`);
  });
});

describe("nahel dispatch — routing enforcement (F1.2)", () => {
  test("with no responsibility-specific route but a configured default, dispatch resolves to the default", async () => {
    const repo = await setup({ routing: { default: { agent: "claude", model: "default-model" } } });
    const code = await dispatch(repo, ["implementation", "--item", repo.item.id, "--", "work"]);
    console.log("[stderr]", errs.join("\n"));
    expect(code).toBe(0);
    expect((await invocationRecord(repo)).argv.slice(0, 3)).toEqual([
      "-p",
      "--model",
      "default-model",
    ]);
    expect((await eventOfType(repo.layout, "dispatch.started"))?.payload["via"]).toBe(
      "routing.default",
    );
  });

  test("with neither route, dispatch exits non-zero naming the missing route and the config fix", async () => {
    const repo = await setup({ routing: { review: { agent: "codex" } } });
    const code = await dispatch(repo, ["implementation", "--item", repo.item.id, "--", "work"]);
    const message = errs.join("\n");
    console.log("[no route]", message);
    expect(code).not.toBe(0);
    expect(message).toContain("routing.implementation");
    expect(message).toContain("routing.default");
    expect(message).toContain("nahel config set routing --data");
    // A refusal is inert: nothing spawned, nothing journaled.
    expect(await Bun.file(repo.recordPath).exists()).toBe(false);
    expect(await events(repo.layout)).toEqual([]);
  });

  test("an unconfigured repo (no routing section at all) gets the same actionable refusal", async () => {
    const repo = await setup({ routing: "none" });
    expect(
      await dispatch(repo, ["implementation", "--item", repo.item.id, "--", "work"]),
    ).not.toBe(0);
    expect(errs.join("\n")).toContain("nahel config set routing --data");
  });
});

describe("nahel dispatch — unknown agent kinds fail as schema errors (F1.3)", () => {
  const withGemini = (base: Config) => ({
    ...base,
    dispatch: { gemini: { binary: "gemini", args: [] } },
  });

  test("`nahel validate` reports a dispatch entry with an unknown agent kind as a config schema error", async () => {
    const repo = await setup({ rawConfig: withGemini });
    const findings = (await validateStore(repo.layout, { now: "2026-07-25T12:00:00Z" })).filter(
      (finding) => finding.check === "schema.config",
    );
    console.log("[validate]", findings);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain("gemini");
  });

  test("dispatch itself refuses the same config rather than acting on an unreadable routing map", async () => {
    const repo = await setup({ rawConfig: withGemini });
    const code = await dispatch(repo, ["implementation", "--item", repo.item.id, "--", "work"]);
    console.log("[bad dispatch config]", errs.join("\n"));
    expect(code).not.toBe(0);
    expect(errs.join("\n")).toContain("gemini");
  });

  test("a routing map naming an agent CLI dispatch does not know refuses, listing the known kinds", async () => {
    const repo = await setup({ routing: { implementation: { agent: "opencode", model: "x" } } });
    const code = await dispatch(repo, ["implementation", "--item", repo.item.id, "--", "work"]);
    const message = errs.join("\n");
    console.log("[unknown kind]", message);
    expect(code).not.toBe(0);
    for (const known of ["opencode", "claude", "codex", "cursor-agent"]) {
      expect(message).toContain(known);
    }
    expect(await events(repo.layout)).toEqual([]);
  });
});

describe("nahel dispatch — usage surface", () => {
  test("a responsibility outside the enum is refused, naming the responsibilities", async () => {
    const repo = await setup();
    const code = await dispatch(repo, ["testing", "--", "work"]);
    const message = errs.join("\n");
    console.log("[bad responsibility]", message);
    expect(code).toBe(1);
    for (const expected of ["testing", "architecture", "implementation", "review"]) {
      expect(message).toContain(expected);
    }
  });

  test("`default` is a fallback key, not a dispatchable responsibility", async () => {
    const repo = await setup();
    expect(await dispatch(repo, ["default", "--", "work"])).toBe(1);
    expect(errs.join("\n")).toContain("default");
  });

  test("a dispatch with no task args is refused, naming the `--` form", async () => {
    const repo = await setup();
    expect(await dispatch(repo, ["implementation"])).toBe(1);
    console.log("[no task]", errs.join("\n"));
    expect(errs.join("\n")).toContain("--");
    expect(await Bun.file(repo.recordPath).exists()).toBe(false);
  });

  test("flags after `--` belong to the worker's task, not to nahel", async () => {
    const repo = await setup();
    expect(
      await dispatch(repo, [
        "implementation",
        "--item",
        repo.item.id,
        "--",
        "--item",
        "not-a-flag",
      ]),
    ).toBe(0);
    const prompt = (await invocationRecord(repo)).argv.at(-1)!;
    expect(prompt).toContain("--item not-a-flag");
    // The task's `--item` never displaced nahel's: the run belongs to the real item.
    expect((await onlyRun(repo.layout)).item).toBe(repo.item.id);
  });

  test("--help prints the usage without touching state", async () => {
    const repo = await setup();
    expect(await dispatch(repo, ["--help"])).toBe(0);
    expect(logs.join("\n")).toContain("nahel dispatch");
    expect(await events(repo.layout)).toEqual([]);
  });
});

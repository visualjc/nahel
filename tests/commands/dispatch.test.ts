import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { dispatchCommand } from "../../src/commands/dispatch";
import type { Env } from "../../src/schema/env";
import type {
  Config,
  Contract,
  JournalEvent,
  Run,
  WorkItemFrontmatter,
} from "../../src/schema/records";
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
  /** Have the stub worker die to SIGTERM instead of exiting — evqagdsd's shape. */
  workerDies?: boolean;
  /** Frontmatter overrides for the repo's work item. */
  item?: Partial<WorkItemFrontmatter>;
  /** Replace the committed config with arbitrary (possibly invalid) YAML. */
  rawConfig?: (base: Config) => unknown;
  /** Run contract to commit; its healthcheck is what the preflight probes. */
  contract?: Contract;
  /**
   * Have a HUMAN intervene mid-run, through the real CLI, while the worker is
   * still running — exactly what `nahel pause` / `nahel claim` are for.
   */
  workerIntervenes?: "pause" | "claim";
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
      // A human reaching into the running loop, through the real CLI, from
      // inside the worker's own lifetime — the F6 intervention window.
      `const intervenes = ${JSON.stringify(options.workerIntervenes ?? null)};`,
      `const target = ${JSON.stringify(item.id)};`,
      "if (intervenes !== null) {",
      "  const prompt = Bun.argv[Bun.argv.length - 1];",
      "  const runId = /nahel run update (\\S+) --phase/.exec(prompt)?.[1];",
      '  const args = intervenes === "pause" ? ["pause", runId] : ["claim", target];',
      "  const done = Bun.spawnSync(",
      `    [process.execPath, "run", ${JSON.stringify(CLI_PATH)}, ...args],`,
      "    {",
      "      cwd: process.cwd(),",
      '      stdout: "pipe",',
      '      stderr: "pipe",',
      '      env: { ...process.env, NAHEL_ACTOR: "human:jim" },',
      "    },",
      "  );",
      "  if (done.exitCode !== 0) {",
      "    console.error(done.stderr.toString());",
      "    process.exit(91);",
      "  }",
      "}",
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
      // A worker dying mid-run rather than exiting: the process kills itself,
      // so dispatch sees a signal death, not an exit status (evqagdsd).
      ...(options.workerDies === true ? ['process.kill(process.pid, "SIGTERM");'] : []),
      `process.exit(${options.exitCode ?? 0});`,
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(stubPath, 0o755);

  const routing = options.routing === "none" ? undefined : (options.routing ?? DEFAULT_ROUTING);
  const base = makeConfig({
    ...(routing === undefined ? {} : { routing }),
    ...(options.contract === undefined ? {} : { contract: options.contract }),
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

  test("a worker that DIES to a signal still gets its dispatch.ended and a closed run (evqagdsd)", async () => {
    // The exit test's real failure: a codex worker that never came back left
    // dispatch.started with no terminal event — a bracket the trail could
    // never close. Every started dispatch must end, even when the worker
    // dies instead of exiting.
    const repo = await setup({ workerDies: true });
    expect(await dispatch(repo, ["implementation", "--item", repo.item.id, "--", "try"])).toBe(1);
    console.log("[stderr]", errs.join("\n"));

    const run = await onlyRun(repo.layout);
    expect(run.status).toBe("ended");
    expect(run.phase).toBe("failure");

    const ended = await eventOfType(repo.layout, "dispatch.ended");
    console.log("[dispatch.ended]", ended?.payload);
    expect(ended).toBeDefined();
    expect(ended!.payload["outcome"]).toBe("failure");
    expect(ended!.payload["signal"]).toBe("SIGTERM");
    expect(ended!.payload["exit_code"]).toBe(143);
    expect(errs.join("\n")).toContain("killed by SIGTERM");
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

/**
 * Sandbox preflight (chore f35q1rax). A dispatcher running under an agent
 * CLI's own sandbox hands that sandbox to everything it spawns: the field
 * report is codex's sandbox blocking `ps`, which fails nahel's pgid
 * healthcheck, and the failure then surfaces as strange downstream errors from
 * a worker nobody suspected was caged. So dispatch runs the run contract's
 * healthcheck — doctor's machinery, in the store root, in the environment the
 * worker will inherit — before it spawns anything, and refuses when it fails.
 * Advisory doctrine, not a lock: `--no-preflight` dispatches anyway and the
 * skip is journaled.
 */
describe("nahel dispatch — sandbox preflight (chore f35q1rax)", () => {
  const CONTRACT = { launch: "l", seed: "s", test: "t" };

  test("a failing contract healthcheck refuses the dispatch: nothing spawned, nothing journaled", async () => {
    const repo = await setup({
      contract: { ...CONTRACT, healthcheck: "exit 7" },
    });
    const code = await dispatch(repo, ["implementation", "--item", repo.item.id, "--", "work"]);
    const message = errs.join("\n");
    console.log("[preflight refusal]", message);
    expect(code).toBe(1);
    // The failing probe is NAMED — the whole point is that the operator learns
    // what could not run, instead of debugging the worker's downstream mess.
    expect(message).toContain("exit 7");
    expect(message).toContain("healthcheck");
    // …and is pointed at the sandbox recipes and the escape hatch.
    expect(message.toLowerCase()).toContain("sandbox");
    expect(message).toContain("setup-routing.md");
    expect(message).toContain("--no-preflight");
    // A refusal is inert, like every other dispatch refusal.
    expect(await Bun.file(repo.recordPath).exists()).toBe(false);
    expect(await events(repo.layout)).toEqual([]);
    expect(await listRuns(repo.layout)).toEqual([]);
  });

  test("a healthcheck that hangs past its deadline refuses with a distinct timeout message", async () => {
    const start = Date.now();
    const repo = await setup({
      contract: { ...CONTRACT, healthcheck: "sleep 5", healthcheck_timeout_seconds: 1 },
    });
    const code = await dispatch(repo, ["implementation", "--item", repo.item.id, "--", "work"]);
    const message = errs.join("\n");
    console.log("[preflight timeout]", message, `${Date.now() - start}ms`);
    expect(Date.now() - start).toBeLessThan(4000); // killed at the deadline, not hung
    expect(code).toBe(1);
    expect(message).toContain("timed out after 1s");
    expect(message).toContain("setup-routing.md");
    expect(await Bun.file(repo.recordPath).exists()).toBe(false);
  });

  test("a passing healthcheck dispatches normally and journals that the preflight passed", async () => {
    const repo = await setup({ contract: { ...CONTRACT, healthcheck: "exit 0" } });
    const code = await dispatch(repo, ["implementation", "--item", repo.item.id, "--", "work"]);
    console.log("[preflight pass]", errs.join("\n"));
    expect(code).toBe(0);
    const started = await eventOfType(repo.layout, "dispatch.started");
    expect(started?.payload["preflight"]).toBe("passed");
    expect(await Bun.file(repo.recordPath).exists()).toBe(true);
  });

  test("--no-preflight dispatches a failing-healthcheck repo anyway, and the SKIP is journaled", async () => {
    // Advisory doctrine (ADR-0015's spirit): a deliberate override is
    // permitted, never silent — the trail has to show the gate was skipped, or
    // the next reader cannot tell a clean run from an overridden one.
    const repo = await setup({ contract: { ...CONTRACT, healthcheck: "exit 7" } });
    const code = await dispatch(repo, [
      "implementation",
      "--no-preflight",
      "--item",
      repo.item.id,
      "--",
      "work",
    ]);
    console.log("[preflight skipped]", errs.join("\n"));
    expect(code).toBe(0);
    expect(await Bun.file(repo.recordPath).exists()).toBe(true);
    const started = await eventOfType(repo.layout, "dispatch.started");
    expect(started?.payload["preflight"]).toBe("skipped");
    // And the operator is told, so an override never passes for a pass.
    expect(errs.join("\n")).toContain("preflight skipped");
  });

  test("a repo whose contract defines no healthcheck is not gated — there is nothing to probe", async () => {
    const repo = await setup({ contract: CONTRACT });
    expect(await dispatch(repo, ["implementation", "--item", repo.item.id, "--", "work"])).toBe(0);
    const started = await eventOfType(repo.layout, "dispatch.started");
    expect(started?.payload["preflight"]).toBe("none");
  });

  test("a repo with no contract section at all dispatches exactly as it always did", async () => {
    const repo = await setup();
    expect(await dispatch(repo, ["implementation", "--item", repo.item.id, "--", "work"])).toBe(0);
    const started = await eventOfType(repo.layout, "dispatch.started");
    expect(started?.payload["preflight"]).toBe("none");
  });

  test("the preflight runs in the STORE ROOT, so a root-relative healthcheck passes from a subdirectory", async () => {
    // The contract's healthcheck is written against the repo root, exactly as
    // doctor's is. Running it in whatever subdirectory the dispatcher stood in
    // would refuse a perfectly healthy repo — a false sandbox accusation.
    const repo = await setup({
      contract: { ...CONTRACT, healthcheck: "test -f repo-marker" },
    });
    expect(spawnSync("git", ["init", "-q"], { cwd: repo.root }).status).toBe(0);
    await writeFile(join(repo.root, "repo-marker"), "at the root\n", "utf8");
    const sub = join(repo.root, "nahel", "journal", "archive");
    await mkdir(sub, { recursive: true });

    const code = await dispatchCommand.run(
      ["implementation", "--item", repo.item.id, "--", "work"],
      repo.env,
      sub,
      "agent:host-runner",
    );
    console.log("[preflight subdir]", errs.join("\n"));
    expect(code).toBe(0);
  });

  test("`--help` documents the preflight and its escape hatch", async () => {
    const repo = await setup();
    expect(await dispatch(repo, ["--help"])).toBe(0);
    expect(logs.join("\n")).toContain("--no-preflight");
  });
});

/**
 * A human intervening WHILE the worker runs (PRD F6). `nahel pause` and
 * `nahel claim` are how a person reaches into a running AFK loop, and their
 * whole value is that the state they set survives. Dispatch used to close the
 * run from the PRE-SPAWN run object, so a pause or a claim landing during the
 * worker's lifetime was overwritten with `ended` on the way out — the
 * intervention erased by the very dispatch it was meant to stop.
 */
describe("nahel dispatch — an intervention during the run is never clobbered (F6)", () => {
  test("a pause mid-run leaves the run PAUSED: no run.ended, and dispatch.ended carries the exit", async () => {
    const repo = await setup({ workerIntervenes: "pause" });
    const code = await dispatch(repo, ["implementation", "--item", repo.item.id, "--", "work"]);
    const journal = await events(repo.layout);
    console.log("[journal]", journal.map((event) => `${event.type}:${event.actor.id}`).join(" "));
    console.log("[stderr]", errs.join("\n"));
    expect(code).toBe(0);

    // The human's state stands: paused, not ended.
    const run = await onlyRun(repo.layout);
    expect(run.status).toBe("paused");
    expect(run.ended).toBeUndefined();
    expect(journal.some((event) => event.type === "run.paused")).toBe(true);
    expect(journal.some((event) => event.type === "run.ended")).toBe(false);

    // The worker's exit is still recorded — the trail must show what it did,
    // it just does not close the run the human took over.
    const ended = journal.find((event) => event.type === "dispatch.ended");
    expect(ended).toBeDefined();
    expect(ended!.payload["outcome"]).toBe("success");
    expect(ended!.payload["exit_code"]).toBe(0);
    expect(ended!.payload["intervention"]).toBe("paused");
    expect(ended!.run).toBe(run.id);

    // And the runner is TOLD, or it would carry on as if nothing happened.
    expect(errs.join("\n")).toContain("intervention");
  });

  test("a claim mid-run leaves the claim and the run intact — no refusal storm on the way out", async () => {
    // `nahel run end` is refused under a claim, so the old code path did not
    // merely clobber here: it threw on a worker that had finished cleanly.
    const repo = await setup({ workerIntervenes: "claim" });
    // A claim captures the repo baseline (HEAD + porcelain), so the checkout
    // has to be a real git repo with a commit — as any claimed repo is.
    for (const args of [
      ["init", "--initial-branch=main"],
      ["config", "user.email", "test@nahel.test"],
      ["config", "user.name", "Nahel Dispatch Test"],
      ["add", "-A"],
      ["commit", "-m", "seed"],
    ]) {
      const done = Bun.spawnSync(["git", "-C", repo.root, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (done.exitCode !== 0) throw new Error(`git ${args[0]}: ${done.stderr.toString()}`);
    }
    const code = await dispatch(repo, ["implementation", "--item", repo.item.id, "--", "work"]);
    console.log("[claim stderr]", errs.join("\n"));
    expect(code).toBe(0);

    expect((await readItem(repo.layout, repo.item.id)).frontmatter.claimed_by).toBe("jim");
    const run = await onlyRun(repo.layout);
    expect(run.status).toBe("paused");

    const journal = await events(repo.layout);
    expect(journal.some((event) => event.type === "run.ended")).toBe(false);
    const ended = journal.find((event) => event.type === "dispatch.ended");
    expect(ended!.payload["intervention"]).toBe("claimed");
    expect(ended!.payload["claimed_by"]).toBe("jim");
    expect(errs.join("\n")).toContain("intervention");
  });

  test("with no intervention the run still ends normally — the check costs the happy path nothing", async () => {
    const repo = await setup();
    expect(await dispatch(repo, ["implementation", "--item", repo.item.id, "--", "work"])).toBe(0);
    const run = await onlyRun(repo.layout);
    expect(run.status).toBe("ended");
    expect(run.phase).toBe("success");
    const ended = (await events(repo.layout)).find((event) => event.type === "dispatch.ended");
    expect(ended!.payload["intervention"]).toBeUndefined();
    expect(errs.join("\n")).not.toContain("intervention");
  });
});

/**
 * `--slot 2` (PRD F3.1): the review loop's second reviewer slot, dispatchable.
 * Without it the loop could only be driven by `routing.review2`'s own vendor —
 * every other capable host had to park, which contradicts "any capable agent
 * can be the runner". The flag stays inside the `review` responsibility
 * (ADR-0015: no fourth enum member); only the resolution CHAIN changes.
 */
describe("nahel dispatch — review slot 2 (F3.1)", () => {
  const CROSS_VENDOR: Config["routing"] = {
    implementation: { agent: "codex", model: "gpt-5" },
    review: { agent: "codex", model: "gpt-5" },
    review2: { agent: "claude", model: "claude-opus-5" },
  };

  test("`review --slot 2` resolves through routing.review2 and journals the slot it filled", async () => {
    // Only `claude` is wired to the stub, so a dispatch that resolved through
    // the slot-1 chain (codex) could not even spawn: the run proves the chain.
    const repo = await setup({ routing: CROSS_VENDOR });
    const code = await dispatch(repo, [
      "review",
      "--slot",
      "2",
      "--item",
      repo.item.id,
      "--",
      "review the diff",
    ]);
    console.log("[slot 2 stderr]", errs.join("\n"));
    expect(code).toBe(0);

    const invocation = await invocationRecord(repo);
    console.log("[slot 2 invocation]", invocation.argv.slice(0, 3), invocation.actor);
    expect(invocation.argv.slice(0, 3)).toEqual(["-p", "--model", "claude-opus-5"]);
    // The worker's actor is slot 2's vendor, which is what makes its verdict
    // independent of the loop driver's own.
    expect(invocation.actor).toBe("agent:claude");

    const started = await eventOfType(repo.layout, "dispatch.started");
    expect(started?.payload["responsibility"]).toBe("review");
    expect(started?.payload["via"]).toBe("routing.review2");
    expect(started?.payload["slot"]).toBe(2);
    expect(started?.payload["agent"]).toBe("claude");

    const run = await onlyRun(repo.layout);
    expect(run.actor).toEqual({ kind: "agent", id: "claude" });
    expect(run.phase).toBe("success");
  });

  test("without --slot, `review` still resolves through the slot-1 chain (review, then default)", async () => {
    const repo = await setup({
      routing: {
        review: { agent: "claude", model: "slot-1-model" },
        review2: { agent: "codex", model: "gpt-5" },
      },
    });
    expect(await dispatch(repo, ["review", "--item", repo.item.id, "--", "review it"])).toBe(0);
    expect((await invocationRecord(repo)).argv.slice(0, 3)).toEqual([
      "-p",
      "--model",
      "slot-1-model",
    ]);
    const started = await eventOfType(repo.layout, "dispatch.started");
    expect(started?.payload["via"]).toBe("routing.review");
    // No slot flag, no slot key: the payload says what was asked for.
    expect(started?.payload["slot"]).toBeUndefined();
  });

  test("without --slot, a MODEL-ONLY routing.review falls through to default like the slot-1 chain — not a refusal", async () => {
    // The divergence the final verify round caught: validate's same-vendor
    // warning resolves slot 1 by skipping agent-less entries, so a model-only
    // routing.review lands on routing.default. Plain `dispatch review` must
    // walk the SAME chain — resolveRoute would refuse the entry instead, and
    // a warning that predicts a pairing dispatch cannot spawn is a lie.
    const repo = await setup({
      routing: {
        review: { model: "reviewer-model" },
        default: { agent: "claude", model: "fallback-model" },
      },
    });
    expect(await dispatch(repo, ["review", "--item", repo.item.id, "--", "review it"])).toBe(0);
    const started = await eventOfType(repo.layout, "dispatch.started");
    expect(started?.payload["via"]).toBe("routing.default");
  });

  test("--slot is refused on any responsibility but review — slots are a review-loop concept", async () => {
    const repo = await setup({ routing: CROSS_VENDOR });
    const code = await dispatch(repo, [
      "implementation",
      "--slot",
      "2",
      "--item",
      repo.item.id,
      "--",
      "work",
    ]);
    const message = errs.join("\n");
    console.log("[slot on implementation]", message);
    expect(code).toBe(1);
    expect(message).toContain("--slot");
    expect(message).toContain("review");
    // A refusal is inert: nothing spawned, nothing journaled.
    expect(await Bun.file(repo.recordPath).exists()).toBe(false);
    expect(await events(repo.layout)).toEqual([]);
  });

  test("a slot outside {1, 2} is a usage error naming the two slots", async () => {
    const repo = await setup({ routing: CROSS_VENDOR });
    const code = await dispatch(repo, ["review", "--slot", "3", "--item", repo.item.id, "--", "x"]);
    const message = errs.join("\n");
    console.log("[bad slot]", message);
    expect(code).toBe(1);
    expect(message).toContain("3");
    expect(message).toContain("1");
    expect(message).toContain("2");
    expect(await events(repo.layout)).toEqual([]);
  });

  test("a slot-2 chain no key answers refuses with the config fix, journaling nothing", async () => {
    const repo = await setup({ routing: { review: { agent: "claude", model: "m" } } });
    const code = await dispatch(repo, ["review", "--slot", "2", "--item", repo.item.id, "--", "x"]);
    const message = errs.join("\n");
    console.log("[slot 2 unrouted]", message);
    expect(code).not.toBe(0);
    expect(message).toContain("routing.review2");
    expect(message).toContain("nahel config set routing --data");
    expect(await events(repo.layout)).toEqual([]);
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

describe("nahel dispatch — dispatched from a subdirectory (store root walk-up)", () => {
  test("the worker starts in the STORE ROOT, not in the directory the dispatcher stood in", async () => {
    // The dispatch contract is that the worker starts in the repo being
    // worked on: its prompt names repo-root-relative paths (the mini-PRD, the
    // nahel CLI's own store) and every `nahel` command it runs must land in
    // the same store the dispatch was recorded in.
    const repo = await setup();
    // A git repo: the store-root walk is bounded by the worktree boundary.
    expect(spawnSync("git", ["init", "-q"], { cwd: repo.root }).status).toBe(0);
    const sub = join(repo.root, "nahel", "journal", "archive");
    await mkdir(sub, { recursive: true });

    const code = await dispatchCommand.run(
      ["implementation", "--item", repo.item.id, "--", "build it"],
      repo.env,
      sub,
      "agent:host-runner",
    );
    console.log("[stderr]", errs.join("\n"));
    expect(code).toBe(0);
    expect((await invocationRecord(repo)).cwd).toBe(await realpath(repo.root));
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

  test("`default` and `review2` are routing keys, not dispatchable responsibilities", async () => {
    const repo = await setup();
    expect(await dispatch(repo, ["default", "--", "work"])).toBe(1);
    expect(errs.join("\n")).toContain("default");
    errs = [];
    // review2 names the review loop's second slot, which its driver fills
    // under its own actor — dispatch spawning it would make one vendor two.
    expect(await dispatch(repo, ["review2", "--", "work"])).toBe(1);
    const message = errs.join("\n");
    console.log("[review2 not dispatchable]", message);
    expect(message).toContain("review2");
    expect(message).toContain("second reviewer slot");
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

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DispatchSpawnError, spawnDispatch } from "../../src/store/dispatch";
import { makeTempDir } from "./helpers";

/**
 * Dispatch process spawning (PRD F1.1/F1.4): the store layer's exclusive
 * privilege, joining baseline.ts (git), healthcheck.ts (the run contract) and
 * skills.ts (git/skills) on the allowlist. The child inherits this process's
 * ambient environment — the agent CLI needs its OWN auth, which nahel never
 * reads — plus exactly one addition: NAHEL_ACTOR, so every mutation the
 * spawned worker makes is attributed to the worker, not the dispatcher.
 */

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Write an executable stub agent CLI and return its path. */
async function stub(script: string): Promise<{ dir: string; path: string }> {
  const dir = await makeTempDir("nahel-store-dispatch-");
  dirs.push(dir);
  const path = join(dir, "stub-agent");
  await writeFile(path, `#!/bin/sh\n${script}\n`, "utf8");
  await chmod(path, 0o755);
  return { dir, path };
}

describe("store/dispatch — spawning a routed agent CLI", () => {
  test("runs the binary with its composed args and captures stdout, stderr, and exit 0", async () => {
    const { dir, path } = await stub('echo "argv=$*"\necho "oops" >&2\nexit 0');
    const result = await spawnDispatch({
      binary: path,
      args: ["-p", "--model", "m", "the prompt"],
      actorSpec: "agent:claude",
      cwd: dir,
    });
    console.log("[spawn]", result);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("argv=-p --model m the prompt");
    expect(result.stderr).toContain("oops");
  });

  test("sets NAHEL_ACTOR in the child so the worker mutates under its own actor id", async () => {
    const { dir, path } = await stub('echo "actor=$NAHEL_ACTOR"');
    const result = await spawnDispatch({
      binary: path,
      args: [],
      actorSpec: "agent:codex",
      cwd: dir,
    });
    expect(result.stdout.trim()).toBe("actor=agent:codex");
  });

  test("the child inherits the ambient environment — the agent CLI keeps its own auth and PATH", async () => {
    const { dir, path } = await stub('echo "path=${PATH:-EMPTY}"\necho "home=${HOME:-EMPTY}"');
    const result = await spawnDispatch({
      binary: path,
      args: [],
      actorSpec: "agent:claude",
      cwd: dir,
    });
    expect(result.stdout).not.toContain("path=EMPTY");
    expect(result.stdout).not.toContain("home=EMPTY");
  });

  test("runs the child in the given working directory (the repo being worked on)", async () => {
    const { dir, path } = await stub("pwd -P");
    const result = await spawnDispatch({
      binary: path,
      args: [],
      actorSpec: "agent:claude",
      cwd: dir,
    });
    expect(result.stdout.trim()).toBe(await realpath(dir));
  });

  test("a non-zero exit is a RESULT, not an exception — the caller records the failed run", async () => {
    const { dir, path } = await stub('echo "partial work"\nexit 3');
    const result = await spawnDispatch({
      binary: path,
      args: [],
      actorSpec: "agent:claude",
      cwd: dir,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("partial work");
  });

  test("arguments are passed literally — no shell, so metacharacters cannot inject", async () => {
    const { dir, path } = await stub('echo "first=$1"');
    const result = await spawnDispatch({
      binary: path,
      args: ["$(touch pwned); rm -rf /"],
      actorSpec: "agent:claude",
      cwd: dir,
    });
    expect(result.stdout.trim()).toBe("first=$(touch pwned); rm -rf /");
    expect(await Bun.file(join(dir, "pwned")).exists()).toBe(false);
  });

  test("an actor spec is passed literally too — a hostile config value cannot inject", async () => {
    const { dir, path } = await stub('echo "actor=$NAHEL_ACTOR"');
    const result = await spawnDispatch({
      binary: path,
      args: [],
      actorSpec: "agent:$(touch pwned)",
      cwd: dir,
    });
    expect(result.stdout.trim()).toBe("actor=agent:$(touch pwned)");
    expect(await Bun.file(join(dir, "pwned")).exists()).toBe(false);
  });

  test("a missing agent binary surfaces as a diagnostic non-zero exit naming the binary", async () => {
    // The agent CLI is looked up like any command: absent, the wrapper exits
    // 127 and says so — the caller records the failed run and shows this.
    const dir = await makeTempDir("nahel-store-dispatch-");
    dirs.push(dir);
    const result = await spawnDispatch({
      binary: join(dir, "no-such-agent"),
      args: [],
      actorSpec: "agent:claude",
      cwd: dir,
    });
    console.log("[missing binary]", result);
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("no-such-agent");
  });

  test("a spawn that cannot even start (working directory gone) throws, naming the failure", async () => {
    const { dir, path } = await stub("exit 0");
    let error: unknown;
    try {
      await spawnDispatch({
        binary: path,
        args: [],
        actorSpec: "agent:claude",
        cwd: join(dir, "does-not-exist"),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DispatchSpawnError);
    console.log("[spawn failure]", (error as Error).message);
    expect((error as Error).message).toContain("does-not-exist");
  });
});

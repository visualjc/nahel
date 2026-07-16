import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { hotStatePath, readHotState, writeHotState } from "../../src/store/hotstate";
import { ensureLayout, writeRun } from "../../src/store/layout";
import { makeFrontmatter, makeRun, makeTempDir, seededEnv } from "./helpers";

let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

async function setup() {
  const root = await makeTempDir();
  dirs.push(root);
  const layout = await ensureLayout(root);
  const env = seededEnv();
  const run = makeRun(env, makeFrontmatter(env).id);
  await writeRun(layout, run);
  return { layout, run };
}

describe("hot state", () => {
  test("state.json lives at the run: nahel/runs/{id}/state.json", async () => {
    const { layout, run } = await setup();
    expect(hotStatePath(layout, run.id)).toBe(
      join(layout.runsDir, run.id, "state.json"),
    );
  });

  test("write/read round-trips the hot state object", async () => {
    const { layout, run } = await setup();
    const state = { phase: "diagnosing", statuses: { repro: "pending" } };
    await writeHotState(layout, run.id, state);
    expect(await readHotState(layout, run.id)).toEqual(state);
  });

  test("writes overwrite completely — hot state is small and overwritten, never merged", async () => {
    const { layout, run } = await setup();
    await writeHotState(layout, run.id, { phase: "one", leftover: true });
    await writeHotState(layout, run.id, { phase: "two" });
    expect(await readHotState(layout, run.id)).toEqual({ phase: "two" });
  });

  test("the file on disk is valid pretty JSON with trailing newline", async () => {
    const { layout, run } = await setup();
    await writeHotState(layout, run.id, { phase: "one" });
    const raw = await readFile(hotStatePath(layout, run.id), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual({ phase: "one" });
  });

  test("writeHotState refuses when the run record does not exist (scoped to the run)", async () => {
    const { layout } = await setup();
    expect(writeHotState(layout, "zzzzzzzz", { phase: "x" })).rejects.toThrow(
      /zzzzzzzz/,
    );
  });

  test("readHotState refuses when the run record does not exist", async () => {
    const { layout } = await setup();
    expect(readHotState(layout, "zzzzzzzz")).rejects.toThrow(/zzzzzzzz/);
  });

  test("readHotState names the run when the run exists but has no hot state yet", async () => {
    const { layout, run } = await setup();
    expect(readHotState(layout, run.id)).rejects.toThrow(run.id);
  });

  test("writeHotState refuses a non-object state (hot state is a JSON object)", async () => {
    const { layout, run } = await setup();
    expect(writeHotState(layout, run.id, ["not", "an", "object"] as never)).rejects.toThrow(
      /object/,
    );
  });
});

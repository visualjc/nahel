import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { CommandContext } from "../../src/cli";
import { recallCommand } from "../../src/commands/recall";
import type { ObservationFrontmatter } from "../../src/schema/records";
import { ensureLayout, writeConfig, writeObservation, type StoreLayout } from "../../src/store/layout";
import { makeConfig, makeObservation, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel recall` (PRD F6.3): deterministic keyword search over observation
 * records — case-insensitive substring match on name/body/tags, ranked by
 * match count then recency. Zero LLM, zero network, zero index: identical
 * state must produce identical ranked output on every machine.
 */

let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

async function setup() {
  const root = await makeTempDir("nahel-cmd-recall-");
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig());
  const env = seededEnv({ tickSeconds: 60 });
  return { root, layout, env };
}

interface RecallResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runRecall(args: string[], root: string): Promise<RecallResult> {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    env: seededEnv(),
    cwd: root,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  const code = await recallCommand.run(args, ctx);
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

/** Write an observation record directly (recall is read-only over the store). */
async function seedObservation(
  layout: StoreLayout,
  env: ReturnType<typeof seededEnv>,
  overrides: Partial<ObservationFrontmatter>,
  body: string,
): Promise<ObservationFrontmatter> {
  const frontmatter = makeObservation(env, ["aaaaaaaa"], overrides);
  await writeObservation(layout, frontmatter, body);
  return frontmatter;
}

describe("nahel recall — ranking and determinism", () => {
  test("ranks by match count descending, citing observation ids and provenance event ids", async () => {
    const { root, layout, env } = await setup();
    const once = await seedObservation(
      layout,
      env,
      { name: "seed-pool-note", sources: ["e1e1e1e1"] },
      "The seed pool warms slowly.\n",
    );
    const twice = await seedObservation(
      layout,
      env,
      { name: "auth-seed-flake", tags: ["seed"], sources: ["e2e2e2e2", "e3e3e3e3"] },
      "Seed data races the auth boot.\n",
    );
    await seedObservation(layout, env, { name: "unrelated" }, "Nothing to see.\n");

    const result = await runRecall(["seed"], root);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("2 observation(s) match");
    // The 3-hit observation (name + tag + body) outranks the 2-hit one.
    expect(result.stdout.indexOf(twice.id)).toBeLessThan(result.stdout.indexOf(once.id));
    expect(result.stdout).toContain("e2e2e2e2");
    expect(result.stdout).toContain("e3e3e3e3");
    expect(result.stdout).toContain("e1e1e1e1");
    expect(result.stdout).not.toContain("unrelated");
  });

  test("equal match counts rank by recency (created, newest first)", async () => {
    const { root, layout, env } = await setup();
    const older = await seedObservation(layout, env, { name: "rotate-first" }, "Fact A.\n");
    const newer = await seedObservation(layout, env, { name: "rotate-later" }, "Fact B.\n");
    expect(older.created < newer.created).toBe(true);

    const result = await runRecall(["rotate"], root);
    expect(result.code).toBe(0);
    expect(result.stdout.indexOf(newer.id)).toBeLessThan(result.stdout.indexOf(older.id));
  });

  test("matching is case-insensitive substring across name, body, and tags", async () => {
    const { root, layout, env } = await setup();
    const byName = await seedObservation(layout, env, { name: "auth-flake" }, "x\n");
    const byBody = await seedObservation(layout, env, { name: "b-note" }, "The AUTH layer stalls.\n");
    const byTag = await seedObservation(layout, env, { name: "c-note", tags: ["oauth"] }, "y\n");

    const result = await runRecall(["Auth"], root);
    expect(result.code).toBe(0);
    for (const observation of [byName, byBody, byTag]) {
      expect(result.stdout).toContain(observation.id);
    }
  });

  test("multiple terms accumulate: an observation matching both terms outranks single-term matches", async () => {
    const { root, layout, env } = await setup();
    const both = await seedObservation(layout, env, { name: "journal-rotation" }, "x\n");
    const single = await seedObservation(layout, env, { name: "rotation-only" }, "y\n");

    const result = await runRecall(["journal", "rotation"], root);
    expect(result.code).toBe(0);
    expect(result.stdout.indexOf(both.id)).toBeLessThan(result.stdout.indexOf(single.id));
  });

  test("identical state yields byte-identical output across invocations", async () => {
    const { root, layout, env } = await setup();
    await seedObservation(layout, env, { name: "alpha-fact", tags: ["alpha"] }, "Alpha.\n");
    await seedObservation(layout, env, { name: "alpha-beta" }, "Alpha and beta.\n");

    const first = await runRecall(["alpha", "beta"], root);
    const second = await runRecall(["alpha", "beta"], root);
    expect(first.code).toBe(0);
    expect(second.stdout).toBe(first.stdout);
  });
});

describe("nahel recall — edges", () => {
  test("no matches reports cleanly with exit 0", async () => {
    const { root, layout, env } = await setup();
    await seedObservation(layout, env, { name: "something" }, "else\n");
    const result = await runRecall(["nonexistent-term"], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no observations match");
  });

  test("no terms is a usage error", async () => {
    const { root } = await setup();
    const result = await runRecall([], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("usage");
  });

  test("an uninitialized repo points at nahel init", async () => {
    const root = await makeTempDir("nahel-cmd-recall-");
    dirs.push(root);
    const result = await runRecall(["term"], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("nahel init");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import type { CommandContext } from "../../src/cli";
import { logCommand } from "../../src/commands/log";
import { validateCommand } from "../../src/commands/validate";
import { listSegments } from "../../src/store/journal";
import { CORE_EVENT_TYPES } from "../../src/schema/events";
import type { Finding } from "../../src/validate";
import { itemPath } from "../../src/store/layout";
import { mutate } from "../../src/store/mutate";
import { makeTempDir, seededEnv } from "../store/helpers";
import {
  createItem,
  healItemWrites,
  sabotageItemWrites,
  setupFixture,
  type ValidateFixture,
} from "./helpers";

let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

interface CommandResult {
  code: number;
  stdout: string[];
  stderr: string[];
}

/** Drive the registration-ready command exactly as cli.ts dispatch would. */
async function runValidate(argv: string[], cwd: string): Promise<CommandResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx: CommandContext = {
    env: seededEnv(),
    cwd,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  };
  const code = await validateCommand.run(argv, ctx);
  return { code, stdout, stderr };
}

/** Kill-inject a journal-ahead divergence into a fixture; returns v1/v2. */
async function injectDivergence(fixture: ValidateFixture) {
  const v1 = await createItem(fixture, {}, "version one\n");
  await sabotageItemWrites(fixture.layout.itemsDir);
  const v2 = { ...v1, status: "in-progress" as const, updated: fixture.env.now() };
  expect(
    mutate(fixture.agent, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemUpdated,
      frontmatter: v2,
      body: "version two\n",
    }),
  ).rejects.toThrow();
  await healItemWrites(fixture.layout.itemsDir);
  return { v1, v2 };
}

describe("nahel validate — the command", () => {
  test("a clean repo validates silently: exit 0, no output", async () => {
    const fixture = await setupFixture(dirs);
    await createItem(fixture);

    const result = await runValidate([], fixture.root);
    expect(result.code).toBe(0);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([]);
  });

  test("stays clean (exit 0, no findings) after log-driven rotation archives segments", async () => {
    const fixture = await setupFixture(dirs);
    await createItem(fixture);
    for (const text of ["one", "two"]) {
      const ctx: CommandContext = {
        env: fixture.env,
        cwd: fixture.root,
        stdout: () => {},
        stderr: () => {},
      };
      expect(await logCommand.run(["note", "--data", `text=${text}`], ctx)).toBe(0);
    }
    // log closed + archived its own session segments.
    expect((await listSegments(fixture.layout)).archived).toHaveLength(2);

    const result = await runValidate([], fixture.root);
    expect(result.code).toBe(0);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([]);
  });

  test("errors are reported with check, path, and fix, and exit non-zero", async () => {
    const fixture = await setupFixture(dirs);
    const path = itemPath(fixture.layout, "badbadb1");
    await writeFile(
      path,
      [
        "---",
        "id: badbadb1",
        "name: broken-item",
        "type: feature",
        "status: cooking",
        "lane: direct",
        "depends_on: []",
        "external_refs: []",
        "created: 2026-07-16T12:00:00Z",
        "updated: 2026-07-16T12:00:00Z",
        "---",
        "",
      ].join("\n"),
    );

    const result = await runValidate([], fixture.root);
    expect(result.code).toBe(1);
    const output = result.stdout.join("\n");
    expect(output).toContain("schema.item");
    expect(output).toContain(path);
    expect(output).toContain("status");
    expect(output).toContain("fix:");
    expect(output).toContain("1 error(s), 0 warning(s)");
  });

  test("warnings are reported but do not fail: exit 0", async () => {
    const fixture = await setupFixture(dirs, {
      validate: { compaction_overdue_events: 1 },
    });
    await createItem(fixture);

    const result = await runValidate([], fixture.root);
    expect(result.code).toBe(0);
    const output = result.stdout.join("\n");
    expect(output).toContain("warning");
    expect(output).toContain("compaction.overdue");
    expect(output).toContain("0 error(s), 1 warning(s)");
  });

  test("--json emits the machine shape: repaired + findings", async () => {
    const fixture = await setupFixture(dirs, {
      validate: { compaction_overdue_events: 1 },
    });
    await createItem(fixture);

    const result = await runValidate(["--json"], fixture.root);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout.join("\n")) as {
      repaired: unknown[];
      findings: Finding[];
    };
    expect(parsed.repaired).toEqual([]);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]!.severity).toBe("warning");
    expect(parsed.findings[0]!.check).toBe("compaction.overdue");
    expect(typeof parsed.findings[0]!.message).toBe("string");
  });

  test("without --repair, validate never mutates: the divergent record stays byte-identical", async () => {
    const fixture = await setupFixture(dirs);
    const { v1 } = await injectDivergence(fixture);
    const before = await readFile(itemPath(fixture.layout, v1.id), "utf8");

    const result = await runValidate([], fixture.root);
    expect(result.code).toBe(1);
    expect(result.stdout.join("\n")).toContain("journal.divergence");
    expect(await readFile(itemPath(fixture.layout, v1.id), "utf8")).toBe(before);
  });

  test("--repair replays the journaled mutation, reports it, and the repo then validates clean", async () => {
    const fixture = await setupFixture(dirs);
    const { v1, v2 } = await injectDivergence(fixture);

    const repair = await runValidate(["--repair"], fixture.root);
    expect(repair.code).toBe(0);
    const output = repair.stdout.join("\n");
    expect(output).toContain(`repaired item ${v1.id}`);
    expect(output).not.toContain("journal.divergence");

    // The record now matches the journaled mutation.
    const healed = await readFile(itemPath(fixture.layout, v1.id), "utf8");
    expect(healed).toContain(`status: ${v2.status}`);
    expect(healed).toContain("version two");

    // And a second validate is silently clean.
    const clean = await runValidate([], fixture.root);
    expect(clean.code).toBe(0);
    expect(clean.stdout).toEqual([]);
  });

  test("--repair --json carries the repaired records in the machine shape", async () => {
    const fixture = await setupFixture(dirs);
    const { v1 } = await injectDivergence(fixture);

    const result = await runValidate(["--repair", "--json"], fixture.root);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout.join("\n")) as {
      repaired: Array<{ target: string; id: string; eventId: string }>;
      findings: Finding[];
    };
    expect(parsed.repaired).toHaveLength(1);
    expect(parsed.repaired[0]!.target).toBe("item");
    expect(parsed.repaired[0]!.id).toBe(v1.id);
    expect(parsed.findings).toEqual([]);
  });

  test("an uninitialized directory exits non-zero with the nahel init pointer", async () => {
    const root = await makeTempDir("nahel-validate-uninit-");
    dirs.push(root);

    const result = await runValidate([], root);
    expect(result.code).toBe(1);
    const output = result.stdout.join("\n");
    expect(output).toContain("schema.config");
    expect(output).toContain("nahel init");
  });

  test("an unknown flag is a usage error on stderr, exit non-zero", async () => {
    const fixture = await setupFixture(dirs);
    const result = await runValidate(["--frobnicate"], fixture.root);
    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toContain("usage: nahel validate");
  });

  test("the command is registration-ready: description names the verb's job", async () => {
    expect(validateCommand.description.length).toBeGreaterThan(0);
    expect(validateCommand.description).toContain("repair");
  });
});

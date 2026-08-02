import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { CommandContext } from "../../src/cli";
import { progressCommand } from "../../src/commands/progress";
import { recallCommand } from "../../src/commands/recall";
import { roadmapCommand } from "../../src/commands/roadmap";
import type { Env } from "../../src/schema/env";
import { ID_PATTERN } from "../../src/schema/id";
import type { JournalEvent } from "../../src/schema/records";
import { readJournal } from "../../src/store/journal";
import { ensureLayout, readTicket, writeConfig, type StoreLayout } from "../../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel roadmap ticket distill` (Phase 4 F7): emptying a decided ticket's
 * body THROUGH the CLI. Body deletion is a state mutation like any other —
 * journaled, replayable, attributable — and never a raw file delete.
 *
 * The bar the acceptance criterion sets is what these tests check: after the
 * distill, the decision is still fully readable from `nahel recall` and
 * `nahel progress` alone. Nothing about a decision may live only in the body
 * that gets thrown away.
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

async function ok(env: Env, root: string, args: string[], actor?: string): Promise<string[]> {
  const before = logs.length;
  const code = await roadmapCommand.run(args, env, root, actor);
  expect(errs.join("\n")).toBe("");
  expect(code).toBe(0);
  return logs.slice(before);
}

async function fails(env: Env, root: string, args: string[]): Promise<string> {
  errs = [];
  expect(await roadmapCommand.run(args, env, root)).toBe(1);
  const message = errs.join("\n");
  errs = [];
  return message;
}

function lastId(printed: string[]): string {
  const id = printed[printed.length - 1]!;
  expect(id).toMatch(ID_PATTERN);
  return id;
}

async function journalEvents(layout: StoreLayout): Promise<JournalEvent[]> {
  return Array.fromAsync(readJournal(layout));
}

async function read(
  command: typeof recallCommand,
  root: string,
  args: string[],
): Promise<string> {
  const out: string[] = [];
  const ctx: CommandContext = {
    env: seededEnv(),
    cwd: root,
    stdout: (text) => out.push(text),
    stderr: (text) => out.push(text),
  };
  expect(await command.run(args, ctx)).toBe(0);
  return out.join("\n");
}

const QUESTION = "which deploy target do we own?";
const DECISION = "we own the fly.io deploy and nothing downstream of it";

/** A store whose single ticket has been resolved with DECISION. */
async function resolved() {
  const root = await makeTempDir("nahel-cmd-distill-");
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig());
  const env = seededEnv({ tickSeconds: 1 });
  const node = lastId(
    await ok(env, root, [
      "node",
      "new",
      "feature",
      "deployment-devops-workflows",
      "--horizon",
      "now",
      "--intent",
      "Deploy and release, drivable by a fresh agent.",
    ]),
  );
  const map = lastId(
    await ok(env, root, [
      "map",
      "new",
      "--node",
      node,
      "--destination",
      "a deploy a fresh agent can drive",
    ]),
  );
  const ticket = lastId(
    await ok(env, root, [
      "ticket",
      "new",
      "--map",
      map,
      "--type",
      "research",
      "--question",
      QUESTION,
    ]),
  );
  await ok(env, root, ["ticket", "resolve", ticket, "--decision", DECISION]);
  return { root, layout, env, map, ticket };
}

describe("nahel roadmap ticket distill — the body goes through the CLI", () => {
  test("empties the body, journals the act, and leaves every other field standing", async () => {
    const { root, layout, env, ticket } = await resolved();
    const before = await readTicket(layout, ticket);
    expect(before.body).not.toBe("");

    await ok(env, root, ["ticket", "distill", ticket], "human:jim");

    const after = await readTicket(layout, ticket);
    expect(after.body).toBe("");
    expect(after.frontmatter.state).toBe("resolved");
    expect(after.frontmatter.decision).toBe(DECISION);
    expect(after.frontmatter.resolution).toBe(before.frontmatter.resolution);

    const distilled = (await journalEvents(layout)).find(
      (e) => e.type === "roadmap.ticket-distilled",
    )!;
    expect(distilled.actor).toEqual({ kind: "human", id: "jim" });
    // The event carries the emptied record, so replay materializes exactly the
    // distill rather than restoring the body it removed.
    expect(distilled.payload).toEqual({
      target: "ticket",
      record: after.frontmatter,
      body: "",
    });
  });

  test("afterwards the decision — and the question it answered — read back from recall and progress alone", async () => {
    const { root, env, ticket } = await resolved();
    await ok(env, root, ["ticket", "distill", ticket]);

    const found = await read(recallCommand, root, ["fly.io"]);
    expect(found).toContain(DECISION);
    expect(found).toContain("1 observation(s) match");

    const timeline = await read(progressCommand, root, []);
    expect(timeline).toContain(DECISION);
    expect(timeline).toContain(QUESTION);
  });

  test("a closed ticket distills too; an open or claimed one is refused naming its state", async () => {
    const { root, layout, env, map, ticket } = await resolved();
    const open = lastId(
      await ok(env, root, [
        "ticket",
        "new",
        "--map",
        map,
        "--type",
        "task",
        "--question",
        "who writes the release notes?",
      ]),
    );
    expect(await fails(env, root, ["ticket", "distill", open])).toContain("open");
    await ok(env, root, ["ticket", "claim", open], "agent:codex");
    expect(await fails(env, root, ["ticket", "distill", open])).toContain("claimed");
    await ok(env, root, [
      "ticket",
      "close",
      open,
      "--out-of-scope",
      "--reason",
      "a later phase owns announcements",
    ]);
    await ok(env, root, ["ticket", "distill", open]);
    expect((await readTicket(layout, open)).body).toBe("");
    expect((await readTicket(layout, ticket)).body).not.toBe("");
  });

  test("re-distilling is refused rather than journaling a second empty write", async () => {
    const { root, layout, env, ticket } = await resolved();
    await ok(env, root, ["ticket", "distill", ticket]);
    const before = await readTicket(layout, ticket);
    expect(await fails(env, root, ["ticket", "distill", ticket])).toContain("already");
    expect(await readTicket(layout, ticket)).toEqual(before);
    expect(
      (await journalEvents(layout)).filter((e) => e.type === "roadmap.ticket-distilled"),
    ).toHaveLength(1);
  });
});

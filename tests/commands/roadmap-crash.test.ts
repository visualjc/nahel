import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, rm } from "node:fs/promises";
import type { CommandContext } from "../../src/cli";
import { roadmapCommand } from "../../src/commands/roadmap";
import { validateCommand } from "../../src/commands/validate";
import type { Env } from "../../src/schema/env";
import { ID_PATTERN } from "../../src/schema/id";
import { readJournal } from "../../src/store/journal";
import {
  ensureLayout,
  listObservations,
  readMap,
  readTicket,
  writeConfig,
  type StoreLayout,
} from "../../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * F7's crash shape: `resolve` and `distill` are multi-step sequences, and the
 * acceptance criterion is that a process killed between ANY two steps leaves a
 * recoverable partial state — `validate` names it, `validate --repair` rolls it
 * forward, and re-running the original verb afterwards changes nothing.
 *
 * How the kill is injected: the sequence's steps are `resolve`'s one write-ahead
 * journal event followed by three record writes (ticket → observation → map
 * index line), so an interruption point IS a record write that never happened.
 * Each test makes exactly one of those writes fail — the record's directory is
 * chmod'ed read-only, so every READ in the verb still succeeds and only the
 * write at that step dies — then restores the mode. What is left on disk is
 * byte-for-byte what a SIGKILL at that instant leaves: the journal ahead, the
 * earlier records materialized, the later ones missing. (A real SIGKILL cannot
 * be aimed at a chosen step, and the criterion demands every step.)
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

async function ok(env: Env, root: string, args: string[]): Promise<string[]> {
  const before = logs.length;
  const code = await roadmapCommand.run(args, env, root);
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

interface ValidateResult {
  code: number;
  out: string;
}

async function validate(root: string, args: string[] = []): Promise<ValidateResult> {
  const out: string[] = [];
  const ctx: CommandContext = {
    env: seededEnv(),
    cwd: root,
    stdout: (text) => out.push(text),
    stderr: (text) => out.push(text),
  };
  const code = await validateCommand.run(args, ctx);
  return { code, out: out.join("\n") };
}

/** Make every write under `dir` fail while every read still succeeds. */
async function freeze(dir: string): Promise<void> {
  await chmod(dir, 0o555);
}

async function thaw(dir: string): Promise<void> {
  await chmod(dir, 0o755);
}

const QUESTION = "which deploy target do we own?";
const DECISION = "we own the fly.io deploy and nothing downstream of it";

async function charted() {
  const root = await makeTempDir("nahel-cmd-crash-");
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
  return { root, layout, env, map, ticket };
}

/** The store's whole answer about one resolution, after everything settles. */
async function resolution(layout: StoreLayout, map: string, ticket: string) {
  const observations = await listObservations(layout);
  return {
    state: (await readTicket(layout, ticket)).frontmatter.state,
    decision: (await readTicket(layout, ticket)).frontmatter.decision,
    observations: observations.length,
    decisions: (await readMap(layout, map)).frontmatter.decisions.length,
    resolutions: (await Array.fromAsync(readJournal(layout))).filter(
      (e) => e.type === "roadmap.ticket-resolved",
    ).length,
  };
}

describe("resolve interrupted between any two steps (F7)", () => {
  /**
   * One interruption point: freeze the directory whose write is that step,
   * run the real verb, and prove the whole convergence — validate names it,
   * --repair completes it, re-running is a no-op.
   */
  async function interruptedAt(step: "ticket" | "observation" | "map") {
    const { root, layout, env, map, ticket } = await charted();
    const frozen = {
      ticket: layout.ticketsDir,
      observation: layout.observationsDir,
      map: layout.mapsDir,
    }[step];

    await freeze(frozen);
    expect(await fails(env, root, ["ticket", "resolve", ticket, "--decision", DECISION])).not.toBe(
      "",
    );
    await thaw(frozen);

    // 1. The journal is ahead: the resolution event landed, and validate names
    //    exactly the records the killed sequence never materialized.
    const before = await validate(root);
    expect(before.code).toBe(1);
    expect(before.out).toContain("journal.divergence");
    expect(before.out).toContain("the journal is ahead");

    // 2. --repair rolls the sequence forward from the one event that holds it.
    const repaired = await validate(root, ["--repair"]);
    expect(repaired.out).toContain("repaired");
    expect(repaired.code).toBe(0);
    const settled = await resolution(layout, map, ticket);
    expect(settled).toEqual({
      state: "resolved",
      decision: DECISION,
      observations: 1,
      decisions: 1,
      resolutions: 1,
    });

    // 3. Re-running the original verb afterwards is a no-op: no duplicate
    //    observation, no second index line, and nothing journaled twice.
    expect(await fails(env, root, ["ticket", "resolve", ticket, "--decision", DECISION])).toContain(
      "resolved",
    );
    expect(await resolution(layout, map, ticket)).toEqual(settled);

    // 4. And the store is clean — a repaired sequence leaves no finding behind.
    const after = await validate(root);
    expect(after.out).not.toContain("journal.divergence");
    expect(after.out).not.toContain("roadmap.ticket-body");
    expect(after.code).toBe(0);
  }

  test("killed before the ticket state write — the first record of the sequence", async () => {
    await interruptedAt("ticket");
  });

  test("killed between the ticket state and the observation", async () => {
    await interruptedAt("observation");
  });

  test("killed between the observation and the map's index line", async () => {
    await interruptedAt("map");
  });
});

describe("distill interrupted between its two steps (F7)", () => {
  test("the event lands, the emptied body does not: validate names it, --repair completes it, re-running is a no-op", async () => {
    const { root, layout, env, map, ticket } = await charted();
    await ok(env, root, ["ticket", "resolve", ticket, "--decision", DECISION]);
    const settled = await resolution(layout, map, ticket);

    await freeze(layout.ticketsDir);
    expect(await fails(env, root, ["ticket", "distill", ticket])).not.toBe("");
    await thaw(layout.ticketsDir);

    // The body is still there — the write never happened — and the journal
    // already records that it should be gone.
    expect((await readTicket(layout, ticket)).body).toBe(`${QUESTION}\n`);
    const before = await validate(root);
    expect(before.code).toBe(1);
    expect(before.out).toContain("journal.divergence");

    const repaired = await validate(root, ["--repair"]);
    expect(repaired.code).toBe(0);
    expect((await readTicket(layout, ticket)).body).toBe("");

    // Re-running distills nothing twice, and the decision still stands.
    expect(await fails(env, root, ["ticket", "distill", ticket])).toContain("already");
    expect(await resolution(layout, map, ticket)).toEqual(settled);
    expect(
      (await Array.fromAsync(readJournal(layout))).filter(
        (e) => e.type === "roadmap.ticket-distilled",
      ),
    ).toHaveLength(1);

    // A body emptied by REPAIR is a distilled body, not a hand-edited one:
    // validate must not report the ticket it just healed.
    const after = await validate(root);
    expect(after.out).not.toContain("roadmap.ticket-body");
    expect(after.code).toBe(0);
  });
});

describe("close interrupted between its two steps (F7)", () => {
  test("the out-of-scope line rolls forward from the same one event", async () => {
    const { root, layout, env, map, ticket } = await charted();
    await freeze(layout.mapsDir);
    expect(
      await fails(env, root, [
        "ticket",
        "close",
        ticket,
        "--out-of-scope",
        "--reason",
        "a later phase owns it",
      ]),
    ).not.toBe("");
    await thaw(layout.mapsDir);

    expect((await readMap(layout, map)).frontmatter.out_of_scope).toEqual([]);
    expect((await validate(root)).code).toBe(1);
    expect((await validate(root, ["--repair"])).code).toBe(0);
    expect((await readMap(layout, map)).frontmatter.out_of_scope).toEqual([
      { reason: "a later phase owns it", ticket },
    ]);
    expect(
      await fails(env, root, ["ticket", "close", ticket, "--out-of-scope", "--reason", "again"]),
    ).toContain("closed");
    expect((await readMap(layout, map)).frontmatter.out_of_scope).toHaveLength(1);
  });
});

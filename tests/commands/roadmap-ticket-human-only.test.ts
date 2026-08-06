import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { relative } from "node:path";
import { roadmapCommand } from "../../src/commands/roadmap";
import type { Env } from "../../src/schema/env";
import { ID_PATTERN } from "../../src/schema/id";
import { ensureLayout, readTicket, writeConfig, type StoreLayout } from "../../src/store/layout";
import { validateStore } from "../../src/validate";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * The human-only decision ticket (planning-partner F4 / DD2): an optional
 * boolean on ticket frontmatter saying the question is the human's to answer.
 *
 * The refusals are the point. Under an `agent` actor `resolve`, `close` AND
 * `update --clear-human-only` are all refused — the third because without it an
 * agent clears the flag and then resolves, which is the same hole with one
 * extra step. SETTING it is refused to nobody: restricting a ticket is always
 * safe, and only a human loosens it again.
 *
 * Absent means false, so every ticket written before the flag existed still
 * reads as open to any actor and still validates.
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

function stderr(): string {
  return errs.join("\n");
}

async function ok(env: Env, root: string, args: string[], actor?: string): Promise<string[]> {
  const before = logs.length;
  const code = await roadmapCommand.run(args, env, root, actor);
  expect(stderr()).toBe("");
  expect(code).toBe(0);
  return logs.slice(before);
}

async function fails(env: Env, root: string, args: string[], actor?: string): Promise<string> {
  errs = [];
  expect(await roadmapCommand.run(args, env, root, actor)).toBe(1);
  const message = stderr();
  errs = [];
  return message;
}

function lastId(printed: string[]): string {
  const id = printed[printed.length - 1]!;
  expect(id).toMatch(ID_PATTERN);
  return id;
}

/**
 * A store with a node, a map, and one open research ticket — created WITHOUT
 * the flag, so each test states for itself which tickets are human-only. The
 * config actor is `agent:claude-code` (makeConfig's default), so a call with no
 * actor override runs as an agent.
 */
async function charted(humanOnly = false) {
  const root = await makeTempDir("nahel-cmd-human-only-");
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
      "grilling",
      "--question",
      "which deploy target do we own?",
      ...(humanOnly ? ["--human-only"] : []),
    ]),
  );
  return { root, layout, env, node, map, ticket };
}

/** A store whose one ticket is human-only, ready for the refusal cases. */
async function restricted() {
  return charted(true);
}

describe("setting the human-only flag — any actor, either verb (F4)", () => {
  test("ticket new --human-only records human_only: true on the created record", async () => {
    const { layout, ticket } = await restricted();
    expect((await readTicket(layout, ticket)).frontmatter.human_only).toBe(true);
  });

  test("a ticket created without the flag carries no human_only key at all (absent = false)", async () => {
    const { layout, ticket } = await charted();
    const { frontmatter } = await readTicket(layout, ticket);
    expect(frontmatter.human_only).toBeUndefined();
    expect(Object.keys(frontmatter)).not.toContain("human_only");
  });

  test("an AGENT actor may SET the flag — restricting a ticket is always safe", async () => {
    const { root, layout, env, ticket } = await charted();
    await ok(env, root, ["ticket", "update", ticket, "--human-only"], "agent:codex");
    expect((await readTicket(layout, ticket)).frontmatter.human_only).toBe(true);
  });

  test("the flag round-trips: create plain, update --human-only, clear it away again", async () => {
    const { root, layout, env, ticket } = await charted();
    expect((await readTicket(layout, ticket)).frontmatter.human_only).toBeUndefined();
    await ok(env, root, ["ticket", "update", ticket, "--human-only"], "human:jim");
    expect((await readTicket(layout, ticket)).frontmatter.human_only).toBe(true);
    await ok(env, root, ["ticket", "update", ticket, "--clear-human-only"], "human:jim");
    // Cleared is an ABSENT key, not a stored `false` — the canonical form of
    // "not human-only" is the one every pre-flag ticket already has.
    const cleared = await readTicket(layout, ticket);
    expect(cleared.frontmatter.human_only).toBeUndefined();
    expect(Object.keys(cleared.frontmatter)).not.toContain("human_only");
  });

  test("--human-only and --clear-human-only together are refused as mutually exclusive", async () => {
    const { root, env, ticket } = await charted();
    const message = await fails(
      env,
      root,
      ["ticket", "update", ticket, "--human-only", "--clear-human-only"],
      "human:jim",
    );
    expect(message).toContain("--human-only");
    expect(message).toContain("--clear-human-only");
    expect(message).toContain("mutually exclusive");
  });

  test("--human-only counts as a change on its own — no 'nothing to update'", async () => {
    const { root, env, ticket } = await charted();
    await ok(env, root, ["ticket", "update", ticket, "--human-only"], "human:jim");
  });
});

describe("an agent actor is refused the three acts that would take the question away (F4)", () => {
  test("resolve is refused, naming the ticket and the rule, and changes nothing", async () => {
    const { root, layout, env, ticket } = await restricted();
    const message = await fails(
      env,
      root,
      ["ticket", "resolve", ticket, "--decision", "we deploy to fly.io"],
      "agent:codex",
    );
    expect(message).toContain(ticket);
    expect(message).toContain("human-only");
    expect(message).toContain("agent:codex");
    const unchanged = await readTicket(layout, ticket);
    expect(unchanged.frontmatter.state).toBe("open");
    expect(unchanged.frontmatter.decision).toBeUndefined();
  });

  test("close is refused, naming the ticket and the rule, and changes nothing", async () => {
    const { root, layout, env, ticket } = await restricted();
    const message = await fails(
      env,
      root,
      ["ticket", "close", ticket, "--reason", "no longer ours", "--out-of-scope"],
      "agent:codex",
    );
    expect(message).toContain(ticket);
    expect(message).toContain("human-only");
    expect(message).toContain("agent:codex");
    const unchanged = await readTicket(layout, ticket);
    expect(unchanged.frontmatter.state).toBe("open");
    expect(unchanged.frontmatter.reason).toBeUndefined();
  });

  test("--clear-human-only is refused too, closing the clear-then-resolve hole", async () => {
    const { root, layout, env, ticket } = await restricted();
    const message = await fails(
      env,
      root,
      ["ticket", "update", ticket, "--clear-human-only"],
      "agent:codex",
    );
    expect(message).toContain(ticket);
    expect(message).toContain("human-only");
    expect(message).toContain("agent:codex");
    // The flag is still set, so the resolve the clear was reaching for is
    // still refused — the hole is closed, not merely narrowed.
    expect((await readTicket(layout, ticket)).frontmatter.human_only).toBe(true);
    expect(
      await fails(
        env,
        root,
        ["ticket", "resolve", ticket, "--decision", "we deploy to fly.io"],
        "agent:codex",
      ),
    ).toContain("human-only");
  });

  test("a ticket WITHOUT the flag is untouched by the rule — an agent resolves it freely", async () => {
    const { root, layout, env, ticket } = await charted();
    await ok(
      env,
      root,
      ["ticket", "resolve", ticket, "--decision", "we deploy to fly.io"],
      "agent:codex",
    );
    expect((await readTicket(layout, ticket)).frontmatter.state).toBe("resolved");
  });
});

describe("a human actor may do all three (F4)", () => {
  test("a human resolves a human-only ticket", async () => {
    const { root, layout, env, ticket } = await restricted();
    await ok(
      env,
      root,
      ["ticket", "resolve", ticket, "--decision", "we deploy to fly.io"],
      "human:jim",
    );
    const resolved = await readTicket(layout, ticket);
    expect(resolved.frontmatter.state).toBe("resolved");
    expect(resolved.frontmatter.decision).toBe("we deploy to fly.io");
    // The flag survives the resolution — it is a fact about the question, not
    // about the lifecycle state it is in.
    expect(resolved.frontmatter.human_only).toBe(true);
  });

  test("a human closes a human-only ticket", async () => {
    const { root, layout, env, ticket } = await restricted();
    await ok(
      env,
      root,
      ["ticket", "close", ticket, "--reason", "another team owns deploys", "--out-of-scope"],
      "human:jim",
    );
    const closed = await readTicket(layout, ticket);
    expect(closed.frontmatter.state).toBe("closed");
    expect(closed.frontmatter.reason).toBe("another team owns deploys");
  });

  test("a human clears the flag, and an agent may then resolve the ticket", async () => {
    const { root, layout, env, ticket } = await restricted();
    await ok(env, root, ["ticket", "update", ticket, "--clear-human-only"], "human:jim");
    expect((await readTicket(layout, ticket)).frontmatter.human_only).toBeUndefined();
    await ok(
      env,
      root,
      ["ticket", "resolve", ticket, "--decision", "we deploy to fly.io"],
      "agent:codex",
    );
    expect((await readTicket(layout, ticket)).frontmatter.state).toBe("resolved");
  });
});

describe("the flag is visible everywhere an AFK lane reads (F4)", () => {
  test("ticket show marks a human-only ticket, and says nothing on a plain one", async () => {
    const restrictedStore = await restricted();
    const marked = (
      await ok(restrictedStore.env, restrictedStore.root, [
        "ticket",
        "show",
        restrictedStore.ticket,
      ])
    ).join("\n");
    expect(marked).toContain("[human-only]");

    const plainStore = await charted();
    const plain = (
      await ok(plainStore.env, plainStore.root, ["ticket", "show", plainStore.ticket])
    ).join("\n");
    expect(plain).not.toContain("human-only");
  });

  test("map show marks the ticket on its list line", async () => {
    const { root, env, map, ticket } = await restricted();
    const printed = (await ok(env, root, ["map", "show", map])).join("\n");
    const line = printed.split("\n").find((each) => each.includes(ticket))!;
    expect(line).toContain("[human-only]");
  });

  test("the frontier marks it, so an AFK lane skips it without trying", async () => {
    const { root, env, ticket } = await restricted();
    const printed = (await ok(env, root, ["frontier"])).join("\n");
    const line = printed.split("\n").find((each) => each.includes(ticket))!;
    expect(line).toContain("[human-only]");
  });
});

describe("validate accepts a store with the field and one without (F4)", () => {
  test("the two stores are identical to validate — the optional field adds no finding", async () => {
    const withFlag = await restricted();
    const withoutFlag = await charted();
    // Same seeded env and same command sequence, so the two stores differ in
    // exactly one key: the flag. Any finding the field caused would show up as
    // a difference here.
    expect(await findings(withFlag.layout, withFlag.env, withFlag.root)).toEqual(
      await findings(withoutFlag.layout, withoutFlag.env, withoutFlag.root),
    );
  });
});

/** Validate one store, with each finding's path made root-relative so two stores compare. */
async function findings(layout: StoreLayout, env: Env, root: string) {
  const found = await validateStore(layout, { now: env.now() });
  return found.map((finding) =>
    finding.path === undefined ? finding : { ...finding, path: relative(root, finding.path) },
  );
}

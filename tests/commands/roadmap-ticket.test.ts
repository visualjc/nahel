import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { roadmapCommand } from "../../src/commands/roadmap";
import type { Env } from "../../src/schema/env";
import { ID_PATTERN } from "../../src/schema/id";
import type { JournalEvent } from "../../src/schema/records";
import { readJournal } from "../../src/store/journal";
import {
  ensureLayout,
  readTicket,
  writeConfig,
  type StoreLayout,
} from "../../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel roadmap ticket` — the decision ticket and its four-state lifecycle
 * (Phase 4 F7). Every row of the PRD's transition table is exercised through
 * the verb that owns it, and every act is journaled with actor attribution.
 *
 * Claim here is ADVISORY assignment, deliberately not `nahel intervene claim`'s
 * freeze: it records who is working the ticket so concurrent sessions skip it,
 * refuses a second claim naming the holder, and lets anyone release.
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
  return stderr();
}

function lastId(printed: string[]): string {
  const id = printed[printed.length - 1]!;
  expect(id).toMatch(ID_PATTERN);
  return id;
}

/** A store with a node, a map, and one open research ticket. */
async function charted() {
  const root = await makeTempDir("nahel-cmd-ticket-");
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
      "which deploy target do we own?",
    ]),
  );
  return { root, layout, env, node, map, ticket };
}

async function journalEvents(layout: StoreLayout): Promise<JournalEvent[]> {
  return Array.fromAsync(readJournal(layout));
}

describe("nahel roadmap ticket new — a question hanging off a map", () => {
  test("creates an open ticket of the named type, question in the body, journaled", async () => {
    const { layout, map, ticket } = await charted();
    const record = await readTicket(layout, ticket);
    expect(record.frontmatter).toMatchObject({
      map,
      type: "research",
      state: "open",
      blockers: [],
    });
    expect(record.frontmatter.claimant).toBeUndefined();
    expect(record.body).toBe("which deploy target do we own?\n");
    const created = (await journalEvents(layout)).find(
      (e) => e.type === "roadmap.ticket-created",
    )!;
    expect(created.payload).toEqual({
      target: "ticket",
      record: record.frontmatter,
      body: record.body,
    });
  });

  test("all four types are creatable, and an unknown type is refused naming the set", async () => {
    const { root, env, map } = await charted();
    for (const type of ["prototype", "grilling", "task"]) {
      await ok(env, root, [
        "ticket",
        "new",
        "--map",
        map,
        "--type",
        type,
        "--question",
        `a ${type} question`,
      ]);
    }
    const message = await fails(env, root, [
      "ticket",
      "new",
      "--map",
      map,
      "--type",
      "spike",
      "--question",
      "?",
    ]);
    expect(message).toContain("research");
    expect(message).toContain("grilling");
  });

  test("a ticket without a question is refused — the ticket IS the question", async () => {
    const { root, env, map } = await charted();
    expect(
      await fails(env, root, ["ticket", "new", "--map", map, "--type", "task"]),
    ).toContain("--question");
  });

  test("the map ref may be the map id or the node's slug, and an unknown ref is refused", async () => {
    const { root, layout, env, map } = await charted();
    const id = lastId(
      await ok(env, root, [
        "ticket",
        "new",
        "--map",
        "deployment-devops-workflows",
        "--type",
        "task",
        "--question",
        "by node slug",
      ]),
    );
    expect((await readTicket(layout, id)).frontmatter.map).toBe(map);
    expect(
      await fails(env, root, [
        "ticket",
        "new",
        "--map",
        "no-such-map",
        "--type",
        "task",
        "--question",
        "?",
      ]),
    ).toContain("no-such-map");
  });

  test("blocking edges are wired at creation or in a second pass, and replace as a whole", async () => {
    const { root, layout, env, map, ticket } = await charted();
    const second = lastId(
      await ok(env, root, [
        "ticket",
        "new",
        "--map",
        map,
        "--type",
        "task",
        "--question",
        "wire the deploy event",
        "--blocked-by",
        ticket,
      ]),
    );
    expect((await readTicket(layout, second)).frontmatter.blockers).toEqual([ticket]);
    // The second pass: charting creates the tickets, then wires the edges.
    const third = lastId(
      await ok(env, root, [
        "ticket",
        "new",
        "--map",
        map,
        "--type",
        "grilling",
        "--question",
        "who signs the release?",
      ]),
    );
    await ok(env, root, ["ticket", "update", third, "--blocked-by", ticket, "--blocked-by", second]);
    expect((await readTicket(layout, third)).frontmatter.blockers).toEqual([ticket, second]);
    await ok(env, root, ["ticket", "update", third, "--clear-blockers"]);
    expect((await readTicket(layout, third)).frontmatter.blockers).toEqual([]);
    expect((await journalEvents(layout)).map((e) => e.type)).toContain("roadmap.ticket-updated");
  });
});

describe("the claim is advisory assignment, not the intervention claim (F7)", () => {
  test("claim records the claiming actor and flips the state; release returns it to the frontier", async () => {
    const { root, layout, env, ticket } = await charted();
    await ok(env, root, ["ticket", "claim", ticket], "agent:codex");
    const claimed = await readTicket(layout, ticket);
    expect(claimed.frontmatter.state).toBe("claimed");
    expect(claimed.frontmatter.claimant).toBe("agent:codex");

    // Release by a DIFFERENT actor succeeds — release is always permitted.
    await ok(env, root, ["ticket", "release", ticket], "human:jim");
    const released = await readTicket(layout, ticket);
    expect(released.frontmatter.state).toBe("open");
    expect(released.frontmatter.claimant).toBeUndefined();

    const types = (await journalEvents(layout)).map((e) => e.type);
    expect(types).toContain("roadmap.ticket-claimed");
    expect(types).toContain("roadmap.ticket-released");
  });

  test("claiming a claimed ticket exits non-zero naming the holder — and changes nothing", async () => {
    const { root, layout, env, ticket } = await charted();
    await ok(env, root, ["ticket", "claim", ticket], "agent:codex");
    const before = await readTicket(layout, ticket);
    const message = await fails(env, root, ["ticket", "claim", ticket], "agent:claude-code");
    expect(message).toContain("agent:codex");
    expect(message).toContain("release");
    expect(await readTicket(layout, ticket)).toEqual(before);
  });

  test("a WORK ITEM claim never covers a ticket — an agent charts on through a human's freeze", async () => {
    // The two claims share a spelling and nothing else (F5): the intervention
    // claim freezes a work-item subtree; this one assigns a question.
    const { root, layout, env, ticket } = await charted();
    await ok(env, root, ["ticket", "claim", ticket], "agent:claude-code");
    expect((await readTicket(layout, ticket)).frontmatter.claimant).toBe("agent:claude-code");
  });

  test("a transition outside the table is refused naming the state the ticket is in", async () => {
    const { root, env, ticket } = await charted();
    expect(await fails(env, root, ["ticket", "release", ticket])).toContain("open");
    await ok(env, root, ["ticket", "claim", ticket], "agent:codex");
    expect(await fails(env, root, ["ticket", "distill", ticket])).toContain("claimed");
  });
});

describe("nahel roadmap ticket show — the ticket's own facts", () => {
  test("prints the lifecycle facts F8's frontier reads, and the question", async () => {
    const { root, env, map, ticket } = await charted();
    const blocked = lastId(
      await ok(env, root, [
        "ticket",
        "new",
        "--map",
        map,
        "--type",
        "task",
        "--question",
        "wire the deploy event",
        "--blocked-by",
        ticket,
      ]),
    );
    await ok(env, root, ["ticket", "claim", blocked], "agent:codex");
    const printed = (await ok(env, root, ["ticket", "show", blocked])).join("\n");
    expect(printed).toContain(blocked);
    expect(printed).toContain("task");
    expect(printed).toContain("claimed");
    expect(printed).toContain("claimant=agent:codex");
    expect(printed).toContain(`blockers=${ticket}`);
    expect(printed).toContain("wire the deploy event");
    // Deterministic: two reads of an unchanged store are byte-identical.
    expect((await ok(env, root, ["ticket", "show", blocked])).join("\n")).toBe(printed);
  });

  test("an unknown ticket ref exits non-zero naming the ref", async () => {
    const { root, env } = await charted();
    expect(await fails(env, root, ["ticket", "show", "nope"])).toContain("nope");
  });
});

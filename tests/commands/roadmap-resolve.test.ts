import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { CommandContext } from "../../src/cli";
import { recallCommand } from "../../src/commands/recall";
import { roadmapCommand } from "../../src/commands/roadmap";
import type { Env } from "../../src/schema/env";
import { ID_PATTERN } from "../../src/schema/id";
import type { JournalEvent } from "../../src/schema/records";
import { readJournal } from "../../src/store/journal";
import {
  ensureLayout,
  listObservations,
  readMap,
  readObservation,
  readTicket,
  writeConfig,
  type StoreLayout,
} from "../../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel roadmap ticket resolve` and `close` (Phase 4 F7) — the two terminal
 * transitions, and the only MULTI-RECORD acts in the layer.
 *
 * `resolve` journals the decision, flips the ticket, distills an observation
 * sourcing the resolution event, and writes the map's index line — all under
 * ONE write-ahead event, which is what makes an interruption anywhere in the
 * sequence a recoverable partial state rather than a half-applied one.
 *
 * The point of the observation is permanence: wayfinder's decisions-are-forever
 * principle on nahel's recall design. The ticket body can be thrown away
 * afterwards precisely because nothing about the decision lives only there.
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

async function fails(env: Env, root: string, args: string[], actor?: string): Promise<string> {
  errs = [];
  expect(await roadmapCommand.run(args, env, root, actor)).toBe(1);
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

async function recall(root: string, terms: string[]): Promise<string> {
  const out: string[] = [];
  const ctx: CommandContext = {
    env: seededEnv(),
    cwd: root,
    stdout: (text) => out.push(text),
    stderr: (text) => out.push(text),
  };
  expect(await recallCommand.run(terms, ctx)).toBe(0);
  return out.join("\n");
}

const QUESTION = "which deploy target do we own?";
const DECISION = "we own the fly.io deploy and nothing downstream of it";

/** A store with a node, a map, and one open ticket carrying QUESTION. */
async function charted() {
  const root = await makeTempDir("nahel-cmd-resolve-");
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
  return { root, layout, env, node, map, ticket };
}

describe("nahel roadmap ticket resolve — decision, observation, derived index", () => {
  test("one event carries both records, and the observation sources it", async () => {
    const { root, layout, env, map, ticket } = await charted();
    const before = await readMap(layout, map);
    await ok(env, root, ["ticket", "resolve", ticket, "--decision", DECISION], "human:jim");

    const events = await journalEvents(layout);
    const resolutions = events.filter((e) => e.type === "roadmap.ticket-resolved");
    expect(resolutions).toHaveLength(1);
    const resolution = resolutions[0]!;
    expect(resolution.actor).toEqual({ kind: "human", id: "jim" });

    const record = await readTicket(layout, ticket);
    expect(record.frontmatter.state).toBe("resolved");
    expect(record.frontmatter.decision).toBe(DECISION);
    expect(record.frontmatter.resolution).toBe(resolution.id);

    const observations = await listObservations(layout);
    expect(observations).toHaveLength(1);
    const observation = await readObservation(layout, observations[0]!);
    expect(observation.frontmatter.sources).toContain(resolution.id);
    expect(observation.frontmatter.tags).toContain("decision");
    // The decision is the observation's first line — what `recall` prints as
    // the fact — and the QUESTION travels with it, because `distill` is about
    // to throw the ticket's own copy away.
    expect(observation.body.split("\n")[0]).toBe(DECISION);
    expect(observation.body).toContain(QUESTION);

    // The map record is BYTE-UNTOUCHED: the decision index is composed at read
    // time from the tickets, so resolving never writes the one record every
    // ticket on the map shares (D1 — the shared-file hot spot is gone).
    expect(await readMap(layout, map)).toEqual(before);
    expect((await ok(env, root, ["map", "show", map])).join("\n")).toContain(
      `${ticket}  ${DECISION}`,
    );

    // The sequence is ONE event: no separate observation.created line, so a
    // crash between the steps leaves the journal ahead rather than half-told.
    expect(events.filter((e) => e.type === "observation.created")).toHaveLength(0);
    expect(events.filter((e) => e.type === "roadmap.map-updated")).toHaveLength(0);
  });

  test("`nahel recall` finds the decision by its own terms", async () => {
    const { root, env, ticket } = await charted();
    await ok(env, root, ["ticket", "resolve", ticket, "--decision", DECISION]);
    const found = await recall(root, ["fly.io", "deploy"]);
    expect(found).toContain("1 observation(s) match");
    expect(found).toContain(DECISION);
  });

  test("resolving a CLAIMED ticket works and drops the claim — nothing stays assigned once decided", async () => {
    const { root, layout, env, ticket } = await charted();
    await ok(env, root, ["ticket", "claim", ticket], "agent:codex");
    await ok(env, root, ["ticket", "resolve", ticket, "--decision", DECISION], "agent:codex");
    const record = await readTicket(layout, ticket);
    expect(record.frontmatter.state).toBe("resolved");
    expect(record.frontmatter.claimant).toBeUndefined();
  });

  test("a resolution with no decision is refused — the decision IS the act", async () => {
    const { root, layout, env, ticket } = await charted();
    expect(await fails(env, root, ["ticket", "resolve", ticket])).toContain("--decision");
    expect(await fails(env, root, ["ticket", "resolve", ticket, "--decision", "  "])).toContain(
      "--decision",
    );
    expect((await readTicket(layout, ticket)).frontmatter.state).toBe("open");
    expect(await listObservations(layout)).toEqual([]);
  });

  test("--decision and --reason refuse an embedded newline — an index line is ONE line", async () => {
    // Both texts render as single lines (the map's Decisions so far and Out of
    // scope index, `ticket show`'s fields, the observation's first line), so a
    // smuggled CR or LF would forge extra rows in every one of them.
    const { root, layout, env, map, ticket } = await charted();
    for (const [flag, verb] of [
      ["--decision", "resolve"],
      ["--reason", "close"],
    ] as const) {
      for (const text of [
        `${DECISION}\nand a forged second line`,
        `${DECISION}\rand a forged second line`,
      ]) {
        const args =
          verb === "close"
            ? ["ticket", verb, ticket, "--out-of-scope", flag, text]
            : ["ticket", verb, ticket, flag, text];
        const message = await fails(env, root, args);
        expect(message).toContain(flag);
        expect(message).toContain("one line");
      }
    }
    // Nothing moved: four refusals, no state, no observation, no index line.
    expect((await readTicket(layout, ticket)).frontmatter.state).toBe("open");
    expect((await readMap(layout, map)).frontmatter.out_of_scope).toEqual([]);
    expect((await ok(env, root, ["map", "show", map])).join("\n")).toContain(
      "decisions so far (0)",
    );
    expect(await listObservations(layout)).toEqual([]);
  });

  test("re-resolving is refused: no duplicate observation, no second index line", async () => {
    const { root, layout, env, map, ticket } = await charted();
    await ok(env, root, ["ticket", "resolve", ticket, "--decision", DECISION]);
    const before = await readTicket(layout, ticket);

    const message = await fails(env, root, [
      "ticket",
      "resolve",
      ticket,
      "--decision",
      "something else entirely",
    ]);
    expect(message).toContain("resolved");
    expect(await readTicket(layout, ticket)).toEqual(before);
    expect(await listObservations(layout)).toHaveLength(1);
    expect((await ok(env, root, ["map", "show", map])).join("\n")).toContain(
      "decisions so far (1)",
    );
  });

  test("the derived index follows the RESOLUTION EVENTS, and distilling does not re-shuffle it", async () => {
    // `distill` moves a ticket's `updated`, so an index ordered by the record's
    // own clock would re-order itself every time a body was emptied.
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
        "which region do we deploy to?",
      ]),
    );
    await ok(env, root, ["ticket", "resolve", ticket, "--decision", DECISION]);
    await ok(env, root, ["ticket", "resolve", second, "--decision", "we deploy to iad only"]);
    const index = async (): Promise<string[]> => {
      const lines = (await ok(env, root, ["map", "show", map])).join("\n").split("\n");
      const at = lines.indexOf("decisions so far (2):");
      expect(at).toBeGreaterThan(-1);
      return lines.slice(at + 1, at + 3);
    };

    const before = await index();
    expect(before[0]).toBe(`  ${ticket}  ${DECISION}`);
    expect(before[1]).toBe(`  ${second}  we deploy to iad only`);
    await ok(env, root, ["ticket", "distill", ticket]);
    expect(await index()).toEqual(before);
  });
});

describe("nahel roadmap ticket close — two dispositions, and only one of them is Out of scope", () => {
  test("--out-of-scope renders one Out-of-scope line derived from the ticket, and never a decision", async () => {
    const { root, layout, env, map, ticket } = await charted();
    const before = await readMap(layout, map);
    await ok(
      env,
      root,
      [
        "ticket",
        "close",
        ticket,
        "--out-of-scope",
        "--reason",
        "marketing announcements are a later phase",
      ],
      "human:jim",
    );

    const record = await readTicket(layout, ticket);
    expect(record.frontmatter.state).toBe("closed");
    expect(record.frontmatter.reason).toBe("marketing announcements are a later phase");
    expect(record.frontmatter.decision).toBeUndefined();
    expect(record.frontmatter.invalidated_by).toBeUndefined();

    const closed = (await journalEvents(layout)).find((e) => e.type === "roadmap.ticket-closed")!;
    expect(closed.actor).toEqual({ kind: "human", id: "jim" });
    // The close records the event that took it, exactly as a resolve does — the
    // derived sections order by it.
    expect(record.frontmatter.closure).toBe(closed.id);

    // The map record is BYTE-UNTOUCHED: the line is composed at read time.
    expect(await readMap(layout, map)).toEqual(before);
    const shown = (await ok(env, root, ["map", "show", map])).join("\n");
    expect(shown).toContain(`marketing announcements are a later phase  (${ticket})`);
    expect(shown).toContain("decisions so far (0)");
    // A close records no decision, so it distills no observation either.
    expect(await listObservations(layout)).toEqual([]);
  });

  test("--invalidated-by records the decision that killed the question, and writes NO Out-of-scope line", async () => {
    // An invalidated question was never beyond the destination — filing it
    // under "ruled beyond the destination" would be false. The invalidating
    // ref lives on the ticket; the map renders it beside Decisions so far.
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
        "which region do we deploy to?",
      ]),
    );
    await ok(env, root, ["ticket", "resolve", ticket, "--decision", DECISION]);
    await ok(
      env,
      root,
      [
        "ticket",
        "close",
        second,
        "--invalidated-by",
        ticket,
        "--reason",
        "the fly.io decision already settles the region",
      ],
      "human:jim",
    );

    const record = await readTicket(layout, second);
    expect(record.frontmatter.state).toBe("closed");
    expect(record.frontmatter.invalidated_by).toBe(ticket);
    expect(record.frontmatter.reason).toBe("the fly.io decision already settles the region");

    expect((await readMap(layout, map)).frontmatter.out_of_scope).toEqual([]);

    // The map says why the question died, beside the decision that killed it —
    // and it is not a decision either: the index carries the resolution only.
    const shown = (await ok(env, root, ["map", "show", map])).join("\n");
    expect(shown).toContain("decisions so far (1):");
    expect(shown).toContain(`${ticket}  ${DECISION}`);
    expect(shown).toContain("invalidated by a decision (1)");
    expect(shown).toContain(second);
    expect(shown).toContain(ticket);
    expect(shown).toContain("the fly.io decision already settles the region");
    expect(shown).toContain("out of scope (0)");
    expect((await ok(env, root, ["ticket", "show", second])).join("\n")).toContain(
      `invalidated_by=${ticket}`,
    );
  });

  test("a close states WHICH disposition it is: neither is refused, and both together are refused", async () => {
    const { root, layout, env, map, ticket } = await charted();
    const neither = await fails(env, root, ["ticket", "close", ticket, "--reason", "because"]);
    expect(neither).toContain("--out-of-scope");
    expect(neither).toContain("--invalidated-by");
    const both = await fails(env, root, [
      "ticket",
      "close",
      ticket,
      "--reason",
      "because",
      "--out-of-scope",
      "--invalidated-by",
      "0aaaaaaa",
    ]);
    expect(both).toContain("mutually exclusive");
    // A malformed invalidating ref is refused too — it names a ticket or the
    // journal event whose decision killed the question.
    expect(
      await fails(env, root, [
        "ticket",
        "close",
        ticket,
        "--reason",
        "because",
        "--invalidated-by",
        "not-an-id",
      ]),
    ).toContain("--invalidated-by");
    expect((await readTicket(layout, ticket)).frontmatter.state).toBe("open");
    expect((await readMap(layout, map)).frontmatter.out_of_scope).toEqual([]);
  });

  test("a close with no reason is refused, and re-closing changes nothing", async () => {
    const { root, layout, env, map, ticket } = await charted();
    expect(await fails(env, root, ["ticket", "close", ticket, "--out-of-scope"])).toContain(
      "--reason",
    );
    await ok(env, root, ["ticket", "close", ticket, "--out-of-scope", "--reason", "out of scope"]);
    expect(
      await fails(env, root, ["ticket", "close", ticket, "--out-of-scope", "--reason", "again"]),
    ).toContain("closed");
    expect((await ok(env, root, ["map", "show", map])).join("\n")).toContain("out of scope (1):");
    expect((await readMap(layout, map)).frontmatter.out_of_scope).toEqual([]);
  });

  test("a closed ticket can no longer be resolved — the table has no such row", async () => {
    const { root, env, ticket } = await charted();
    await ok(env, root, ["ticket", "close", ticket, "--out-of-scope", "--reason", "out of scope"]);
    expect(await fails(env, root, ["ticket", "resolve", ticket, "--decision", DECISION])).toContain(
      "closed",
    );
  });
});

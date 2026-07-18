import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Env } from "../../src/schema/env";
import { journalEventSchema, type JournalEvent } from "../../src/schema/records";
import { logCommand, type LogCommandContext } from "../../src/commands/log";
import { appendEvent, listSegments, readJournal, SESSION_CLOSED_EVENT_TYPE } from "../../src/store/journal";
import { ensureLayout, writeConfig, writeItem, writeRun, type StoreLayout } from "../../src/store/layout";
import { makeConfig, makeFrontmatter, makeRun, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel log` (PRD F4, task #6): append a typed journal event — observations
 * about work, as opposed to mutations, which self-record. Tests drive the
 * exported command object directly (cli.ts registration is the orchestrator's;
 * this wave the registry is frozen) against real temp-dir stores — no mocks.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Fresh temp store with the full nahel/ layout and a config actor entry. */
async function makeStore(
  configActor = { kind: "human", id: "maintainer" } as const,
): Promise<{ root: string; layout: StoreLayout }> {
  const root = await makeTempDir("nahel-log-");
  tempDirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig({ actor: configActor }));
  return { root, layout };
}

interface LogResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Drive the exported command object directly with captured output. */
async function runLog(
  args: string[],
  root: string,
  options: { env?: Env; actorOverride?: string } = {},
): Promise<LogResult> {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: LogCommandContext = {
    env: options.env ?? seededEnv(),
    cwd: root,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    ...(options.actorOverride === undefined ? {} : { actorOverride: options.actorOverride }),
  };
  const code = await logCommand.run(args, ctx);
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

/** Every event currently in the store, in merged total order. */
async function allEvents(layout: StoreLayout): Promise<JournalEvent[]> {
  return Array.fromAsync(readJournal(layout));
}

describe("nahel log — segment resolution", () => {
  test("a --run event lands in that run's segment carrying run and item refs", async () => {
    const { root, layout } = await makeStore();
    const env = seededEnv();
    const item = makeFrontmatter(env, { name: "the-item" });
    await writeItem(layout, item, "body\n");
    const run = makeRun(env, item.id);
    await writeRun(layout, run);

    const result = await runLog(
      ["note", "--run", run.id, "--item", item.id],
      root,
      { env },
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const segments = await listSegments(layout);
    expect(segments.active).toEqual([`run-${run.id}.jsonl`]);

    const events = await allEvents(layout);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(() => journalEventSchema.parse(event)).not.toThrow();
    expect(event.type).toBe("note");
    expect(event.run).toBe(run.id);
    expect(event.item).toBe(item.id);
    expect(event.payload).toEqual({});
    expect(result.stdout).toContain(event.id);
    expect(result.stdout).toContain(`run-${run.id}`);
  });

  test("a non-run event lands in a writer-scoped session segment, closed and archived by the same invocation", async () => {
    const { root, layout } = await makeStore();
    expect((await listSegments(layout)).active).toEqual([]);

    const result = await runLog(["note", "--data", "text=observed"], root);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    // log is single-use by design: it closes its own session segment after
    // appending, so the segment is rotation-eligible and archived on the spot.
    const segments = await listSegments(layout);
    expect(segments.active).toEqual([]);
    expect(segments.archived).toHaveLength(1);
    expect(segments.archived[0]).toMatch(/^session-[0-9a-z]{8}\.jsonl$/);

    const events = await allEvents(layout);
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("note");
    expect(events[0]!.run).toBeUndefined();
    expect(events[0]!.payload).toEqual({ text: "observed" });
    expect(events[1]!.type).toBe(SESSION_CLOSED_EVENT_TYPE);
    expect(result.stdout).toContain(segments.archived[0]!.replace(".jsonl", ""));
  });

  test("separate invocations mint separate session segments — no two writers share an active segment", async () => {
    const { root, layout } = await makeStore();
    // One env shared across invocations: its RNG state advances, so the two
    // minted segment ids differ (as two real CLI processes' would).
    const env = seededEnv();
    expect((await runLog(["note"], root, { env })).code).toBe(0);
    expect((await runLog(["note"], root, { env })).code).toBe(0);

    const segments = await listSegments(layout);
    expect(segments.active).toEqual([]);
    expect(segments.archived).toHaveLength(2);
    expect(new Set(segments.archived).size).toBe(2);
    for (const name of segments.archived) {
      expect(name).toMatch(/^session-[0-9a-z]{8}\.jsonl$/);
    }
  });
});

describe("nahel log — actor resolution", () => {
  test("the config actor entry is the default identity on every event", async () => {
    const { root, layout } = await makeStore({ kind: "human", id: "maintainer" });
    const result = await runLog(["note"], root);
    expect(result.code).toBe(0);
    const events = await allEvents(layout);
    expect(events[0]!.actor).toEqual({ kind: "human", id: "maintainer" });
  });

  test("the NAHEL_ACTOR override value wins over the config entry", async () => {
    const { root, layout } = await makeStore({ kind: "human", id: "maintainer" });
    const result = await runLog(["note"], root, {
      actorOverride: "agent:claude-code:sess-42",
    });
    expect(result.code).toBe(0);
    const events = await allEvents(layout);
    expect(events[0]!.actor).toEqual({
      kind: "agent",
      id: "claude-code",
      session: "sess-42",
    });
  });

  test("a malformed NAHEL_ACTOR override is a hard error with the expected format spelled out, and writes nothing", async () => {
    const { root, layout } = await makeStore();
    const result = await runLog(["note"], root, { actorOverride: "wizard" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("actor spec");
    expect(result.stderr).toContain("<human|agent>:<id>");
    expect((await listSegments(layout)).active).toEqual([]);
  });

  test("an uninitialized repo (no nahel/config, so no actor) is a hard error pointing at nahel init", async () => {
    const root = await makeTempDir("nahel-log-bare-");
    tempDirs.push(root);
    await ensureLayout(root); // layout without config: no actor identity source
    const result = await runLog(["note"], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("nahel init");
  });
});

describe("nahel log — event types (core set open to extension)", () => {
  // Core MUTATION types (run.started, item.claimed, …) are refused here —
  // mutations self-record through mutate() (see the write-seam describe
  // below); `note` is the core observation type log accepts silently.
  test("the core observation type is accepted by name with no unknown-type flag", async () => {
    const { root, layout } = await makeStore();
    const env = seededEnv();
    const item = makeFrontmatter(env, { name: "an-item" });
    await writeItem(layout, item, "body\n");
    const run = makeRun(env, item.id);
    await writeRun(layout, run);

    const result = await runLog(["note", "--run", run.id], root, { env });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("note");
    expect((await allEvents(layout)).map((e) => e.type)).toEqual(["note"]);
  });

  test("an unknown type is logged (open extension) but flagged distinctly in the output", async () => {
    const { root, layout } = await makeStore();
    const result = await runLog(["deploy.finished"], root);
    expect(result.code).toBe(0);
    // The flag is distinct: a warning naming the type as outside the core set.
    expect(result.stderr).toContain("deploy.finished");
    expect(result.stderr).toContain("core");
    const events = await allEvents(layout);
    expect(events.map((e) => e.type)).toEqual(["deploy.finished", SESSION_CLOSED_EVENT_TYPE]);
  });

  test("the store's session.closed marker is reserved — refused with an error, nothing written", async () => {
    const { root, layout } = await makeStore();
    const result = await runLog([SESSION_CLOSED_EVENT_TYPE], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(SESSION_CLOSED_EVENT_TYPE);
    expect((await listSegments(layout)).active).toEqual([]);
  });

  test("a missing event type is a usage error", async () => {
    const { root, layout } = await makeStore();
    const result = await runLog([], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("usage: nahel log");
    expect((await listSegments(layout)).active).toEqual([]);
  });

  test("extra positionals and unknown flags are usage errors", async () => {
    const { root } = await makeStore();
    const extra = await runLog(["note", "surprise"], root);
    expect(extra.code).toBe(1);
    expect(extra.stderr).toContain("surprise");

    const unknown = await runLog(["note", "--bogus"], root);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr.length).toBeGreaterThan(0);
  });
});

describe("nahel log — ref validation", () => {
  test("--item must reference an existing item record", async () => {
    const { root, layout } = await makeStore();
    const result = await runLog(["note", "--item", "zzzzzzzz"], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("zzzzzzzz");
    expect((await listSegments(layout)).active).toEqual([]);
  });

  test("--run must reference an existing run record", async () => {
    const { root, layout } = await makeStore();
    const result = await runLog(["note", "--run", "zzzzzzzz"], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("zzzzzzzz");
    expect((await listSegments(layout)).active).toEqual([]);
  });

  // PR #12 review blocker 2: --item/--run are user input joined into store
  // paths; traversal ids must be refused with an invalid-id error before any
  // read or write, even when a plausible file exists at the escaped path.
  test("--item with a traversal id refuses with an invalid-id error", async () => {
    const { root, layout } = await makeStore();
    await writeFile(join(root, "PRODUCT.md"), "# canary - not an item\n");
    const result = await runLog(["note", "--item", "../../PRODUCT"], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("invalid item id");
    expect((await listSegments(layout)).active).toEqual([]);
  });

  test("--run with a traversal id refuses; no segment lands outside nahel/journal", async () => {
    const { root, layout } = await makeStore();
    const env = seededEnv();
    // Plant a valid run.json outside nahel/runs, reachable via `../../plant`.
    await mkdir(join(root, "plant"), { recursive: true });
    const planted = makeRun(env, makeFrontmatter(env).id);
    await writeFile(join(root, "plant", "run.json"), `${JSON.stringify(planted)}\n`);

    const result = await runLog(["note", "--run", "../../plant"], root, { env });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("invalid run id");
    expect((await listSegments(layout)).active).toEqual([]);
    // The escaped join normalizes run-../../plant.jsonl to a segment file
    // nahel never minted — it must not exist.
    expect(existsSync(join(layout.journalDir, "plant.jsonl"))).toBe(false);
  });

  test("an existing --item ref is carried on a non-run event", async () => {
    const { root, layout } = await makeStore();
    const env = seededEnv();
    const item = makeFrontmatter(env, { name: "ref-item" });
    await writeItem(layout, item, "body\n");
    const result = await runLog(["note", "--item", item.id], root, { env });
    expect(result.code).toBe(0);
    const events = await allEvents(layout);
    expect(events[0]!.item).toBe(item.id);
    expect(events[0]!.run).toBeUndefined();
  });
});

describe("nahel log — --data payloads", () => {
  test("a JSON object --data becomes the event payload verbatim", async () => {
    const { root, layout } = await makeStore();
    const result = await runLog(
      ["note", "--data", '{"suite":"store","failures":2,"flaky":false}'],
      root,
    );
    expect(result.code).toBe(0);
    const events = await allEvents(layout);
    expect(events[0]!.payload).toEqual({ suite: "store", failures: 2, flaky: false });
  });

  test("key=val --data entries merge into the payload with JSON-typed values", async () => {
    const { root, layout } = await makeStore();
    const result = await runLog(
      ["note", "--data", "count=3", "--data", "name=alpha", "--data", "ok=true"],
      root,
    );
    expect(result.code).toBe(0);
    const events = await allEvents(layout);
    expect(events[0]!.payload).toEqual({ count: 3, name: "alpha", ok: true });
  });

  test("JSON and key=val --data entries merge left to right", async () => {
    const { root, layout } = await makeStore();
    const result = await runLog(
      ["note", "--data", '{"a":1,"b":1}', "--data", "b=2"],
      root,
    );
    expect(result.code).toBe(0);
    const events = await allEvents(layout);
    expect(events[0]!.payload).toEqual({ a: 1, b: 2 });
  });

  test("malformed --data is a hard error naming the bad entry, nothing written", async () => {
    const { root, layout } = await makeStore();
    for (const bad of ["{not json", "[1,2]", "no-equals-sign"]) {
      const result = await runLog(["note", "--data", bad], root);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("--data");
    }
    expect((await listSegments(layout)).active).toEqual([]);
  });

  test("no --data means an empty object payload", async () => {
    const { root, layout } = await makeStore();
    expect((await runLog(["note"], root)).code).toBe(0);
    expect((await allEvents(layout))[0]!.payload).toEqual({});
  });
});

describe("nahel log — mutation forgery is refused at the write seam", () => {
  // PR #12 review blocker: --data merged arbitrary JSON into the payload, so
  // `nahel log note --data '{"target":"item","record":{...},"body":"..."}'`
  // forged a mutation-shaped event that validate read as journal-ahead
  // divergence and --repair replayed over the real record. The reserved
  // replay keys are banned at the log seam; mutations self-record through
  // the store's mutate() choke point (nahel item / nahel run).
  test("--data carrying the full forged mutation payload is refused naming the reserved key, nothing written", async () => {
    const { root, layout } = await makeStore();
    const env = seededEnv();
    const item = makeFrontmatter(env, { name: "real-item" });
    await writeItem(layout, item, "the real body\n");

    const forged = JSON.stringify({
      target: "item",
      record: { ...item, status: "done" },
      body: "forged body\n",
    });
    const result = await runLog(["note", "--item", item.id, "--data", forged], root, { env });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("reserved");
    expect(result.stderr).toContain("target");
    expect(result.stderr).toContain("nahel item");
    expect((await listSegments(layout)).active).toEqual([]);
  });

  test("each reserved key (target, record, body) is refused individually, in JSON and key=val forms", async () => {
    const { root, layout } = await makeStore();
    const entries: [string, string][] = [
      ['{"target":"item"}', "target"],
      ['{"record":{"id":"x"}}', "record"],
      ['{"body":"forged"}', "body"],
      ["target=item", "target"],
      ["record=x", "record"],
      ["body=forged", "body"],
    ];
    for (const [entry, key] of entries) {
      const result = await runLog(["note", "--data", entry], root);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("reserved");
      expect(result.stderr).toContain(key);
    }
    expect((await listSegments(layout)).active).toEqual([]);
  });

  test("core mutation event types are refused — mutations self-record; log is for observations", async () => {
    const { root, layout } = await makeStore();
    for (const type of [
      "item.created",
      "item.updated",
      "item.claimed",
      "item.handback",
      "run.started",
      "run.updated",
      "run.ended",
      "run.paused",
    ]) {
      const result = await runLog([type], root);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(type);
      expect(result.stderr).toContain("mutation");
    }
    expect((await listSegments(layout)).active).toEqual([]);
  });

  test("the reserved words remain fine NESTED in --data — only top-level keys are banned", async () => {
    const { root, layout } = await makeStore();
    const result = await runLog(
      ["note", "--data", '{"context":{"target":"staging","body":"of evidence"}}'],
      root,
    );
    expect(result.code).toBe(0);
    const events = await allEvents(layout);
    expect(events[0]!.payload).toEqual({
      context: { target: "staging", body: "of evidence" },
    });
  });
});

describe("nahel log — round-trip through the merged journal", () => {
  test("logged events across run and session segments appear in merge-read in correct total order", async () => {
    const { root, layout } = await makeStore();
    // One ticking env shared by every invocation: strictly increasing
    // timestamps, so the merged total order must equal invocation order.
    const env = seededEnv({ tickSeconds: 1 });
    const item = makeFrontmatter(env, { name: "journey-item" });
    await writeItem(layout, item, "body\n");
    const run = makeRun(env, item.id);
    await writeRun(layout, run);

    // Observation types only: log refuses core mutation types (mutations
    // self-record), and run-segment routing follows --run, not the type.
    const invocations: string[][] = [
      ["test.failed", "--run", run.id, "--item", item.id],
      ["note", "--item", item.id, "--data", "text=looking around"],
      ["decision.made", "--run", run.id, "--data", "phase=building"],
      ["assumption.logged", "--data", '{"assume":"bun installed"}'],
      ["review.requested", "--run", run.id],
    ];
    const loggedIds: string[] = [];
    for (const argv of invocations) {
      const result = await runLog(argv, root, { env });
      expect(result.code).toBe(0);
      const match = /event ([0-9a-z]{8})/.exec(result.stdout);
      expect(match).not.toBeNull();
      loggedIds.push(match![1]!);
    }

    // The observations come back in invocation order; the store's
    // session.closed markers interleave but never displace them.
    const merged = await allEvents(layout);
    const observations = merged.filter((e) => e.type !== SESSION_CLOSED_EVENT_TYPE);
    expect(observations.map((e) => e.id)).toEqual(loggedIds);
    expect(observations.map((e) => e.type)).toEqual([
      "test.failed",
      "note",
      "decision.made",
      "assumption.logged",
      "review.requested",
    ]);
    // Run-ref'd events share the run segment, which stays ACTIVE while the
    // run is open; each non-run invocation's session segment is closed and
    // archived by that invocation.
    const segments = await listSegments(layout);
    expect(segments.active).toEqual([`run-${run.id}.jsonl`]);
    expect(segments.archived.filter((n) => n.startsWith("session-"))).toHaveLength(2);
    // Every merged event is schema-valid.
    for (const event of merged) {
      expect(() => journalEventSchema.parse(event)).not.toThrow();
    }
  });
});

describe("nahel log — session close + opportunistic rotation (PRD F1)", () => {
  const human = { kind: "human", id: "maintainer" } as const;

  test("the archived session segment carries the observation, then session.closed as its FINAL line, same actor", async () => {
    const { root, layout } = await makeStore();
    const result = await runLog(["note", "--data", "text=closing time"], root);
    expect(result.code).toBe(0);

    const { archived } = await listSegments(layout);
    expect(archived).toHaveLength(1);
    const raw = await readFile(join(layout.journalArchiveDir, archived[0]!), "utf8");
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(2);
    const [note, closed] = lines.map((line) => journalEventSchema.parse(JSON.parse(line)));
    expect(note!.type).toBe("note");
    expect(closed!.type).toBe(SESSION_CLOSED_EVENT_TYPE);
    expect(closed!.actor).toEqual(human);
    expect(closed!.seq).toBe(note!.seq + 1);
  });

  test("the sweep archives other provably-closed segments: an ended run's segment left behind", async () => {
    const { root, layout } = await makeStore();
    const env = seededEnv({ tickSeconds: 1 });
    const item = makeFrontmatter(env, { name: "swept-item" });
    await writeItem(layout, item, "body\n");
    const endedRun = makeRun(env, item.id, { status: "ended", ended: env.now() });
    await writeRun(layout, endedRun);
    await appendEvent(layout, env, { type: "run.ended", actor: human, run: endedRun.id, payload: {} });
    expect((await listSegments(layout)).active).toEqual([`run-${endedRun.id}.jsonl`]);

    const result = await runLog(["note"], root, { env });
    expect(result.code).toBe(0);

    const segments = await listSegments(layout);
    expect(segments.active).toEqual([]);
    expect(segments.archived).toContain(`run-${endedRun.id}.jsonl`);
    expect(segments.archived.filter((n) => n.startsWith("session-"))).toHaveLength(1);
  });

  test("a --run invocation sweeps eligible segments but never touches the ACTIVE run it wrote to", async () => {
    const { root, layout } = await makeStore();
    const env = seededEnv({ tickSeconds: 1 });
    const item = makeFrontmatter(env, { name: "live-item" });
    await writeItem(layout, item, "body\n");
    const activeRun = makeRun(env, item.id);
    await writeRun(layout, activeRun);
    const endedRun = makeRun(env, item.id, { status: "ended", ended: env.now() });
    await writeRun(layout, endedRun);
    await appendEvent(layout, env, { type: "run.ended", actor: human, run: endedRun.id, payload: {} });

    const result = await runLog(["note", "--run", activeRun.id], root, { env });
    expect(result.code).toBe(0);

    const segments = await listSegments(layout);
    expect(segments.active).toEqual([`run-${activeRun.id}.jsonl`]);
    expect(segments.archived).toEqual([`run-${endedRun.id}.jsonl`]);
  });

  test("history survives rotation: every logged event remains readable through the merged journal", async () => {
    const { root, layout } = await makeStore();
    const env = seededEnv({ tickSeconds: 1 });
    for (const text of ["one", "two", "three"]) {
      expect((await runLog(["note", "--data", `text=${text}`], root, { env })).code).toBe(0);
    }
    expect((await listSegments(layout)).active).toEqual([]);
    const notes = (await allEvents(layout)).filter((e) => e.type === "note");
    expect(notes.map((e) => e.payload)).toEqual([
      { text: "one" },
      { text: "two" },
      { text: "three" },
    ]);
  });
});

describe("nahel log — command shape", () => {
  test("exports a registration-ready Command: a description and a run function", () => {
    expect(typeof logCommand.description).toBe("string");
    expect(logCommand.description.length).toBeGreaterThan(0);
    expect(typeof logCommand.run).toBe("function");
  });
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { distillCommand } from "../../src/commands/distill";
import type { Env } from "../../src/schema/env";
import type { JournalEvent } from "../../src/schema/records";
import {
  appendEvent,
  closeSession,
  listSegments,
  newSessionSegmentId,
  readJournal,
} from "../../src/store/journal";
import {
  ensureLayout,
  readDistilled,
  readDistilledText,
  writeConfig,
  type StoreLayout,
} from "../../src/store/layout";
import { rotateJournal } from "../../src/store/rotate";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel distill` (PRD F6.1): mark ARCHIVED journal segments as distilled —
 * additive union into nahel/journal/distilled.json, the act itself
 * journaled. Compaction never edits or deletes journal events (the F6
 * acceptance bar): these tests prove archived segments stay byte-identical
 * and a re-run changes nothing.
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

async function setup() {
  const root = await makeTempDir("nahel-cmd-distill-");
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig());
  const env = seededEnv({ tickSeconds: 1 });
  return { root, layout, env };
}

/** Journal one note in a fresh session segment; optionally close + archive it. */
async function seedSegment(
  layout: StoreLayout,
  env: Env,
  options: { archive: boolean },
): Promise<string> {
  const session = newSessionSegmentId(env);
  const actor = { kind: "human", id: "jim" } as const;
  await appendEvent(layout, env, {
    type: "note",
    actor,
    payload: { text: "raw happenings" },
    session,
  });
  const name = `session-${session}.jsonl`;
  if (options.archive) {
    await closeSession(layout, env, actor, session);
    const { archived } = await rotateJournal(layout);
    expect(archived).toContain(name);
  }
  return name;
}

async function journalEvents(layout: StoreLayout): Promise<JournalEvent[]> {
  return Array.fromAsync(readJournal(layout));
}

describe("nahel distill — marking archived segments", () => {
  test("adds archived segments to distilled.json and journals the act write-ahead", async () => {
    const { root, layout, env } = await setup();
    const name = await seedSegment(layout, env, { archive: true });
    const archiveBytes = await readFile(join(layout.journalArchiveDir, name), "utf8");

    const code = await distillCommand.run([name], env, root);
    expect(errs.join("\n")).toBe("");
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain(name);

    expect(await readDistilled(layout)).toEqual([name]);
    const act = (await journalEvents(layout)).find(
      (event) => event.type === "journal.distilled",
    )!;
    expect(act).toBeDefined();
    expect(act.payload).toEqual({ segments: [name] });

    // Append/mark only: the archived segment is byte-identical.
    expect(await readFile(join(layout.journalArchiveDir, name), "utf8")).toBe(archiveBytes);
  });

  test("a re-run changes nothing: no new distilled entries, no new journal events, identical bytes", async () => {
    const { root, layout, env } = await setup();
    const name = await seedSegment(layout, env, { archive: true });
    expect(await distillCommand.run([name], env, root)).toBe(0);
    const distilledBytes = await readFile(layout.distilledPath, "utf8");
    const eventCount = (await journalEvents(layout)).length;

    logs = [];
    expect(await distillCommand.run([name], env, root)).toBe(0);
    expect(logs.join("\n")).toContain("already distilled");
    expect(await readFile(layout.distilledPath, "utf8")).toBe(distilledBytes);
    expect((await journalEvents(layout)).length).toBe(eventCount);
  });

  test("a mix of new and already-distilled segments journals only the new ones", async () => {
    const { root, layout, env } = await setup();
    const first = await seedSegment(layout, env, { archive: true });
    const second = await seedSegment(layout, env, { archive: true });
    expect(await distillCommand.run([first], env, root)).toBe(0);

    expect(await distillCommand.run([first, second], env, root)).toBe(0);
    expect(await readDistilled(layout)).toEqual([first, second].sort());
    const acts = (await journalEvents(layout)).filter(
      (event) => event.type === "journal.distilled",
    );
    expect(acts.map((event) => event.payload)).toEqual([
      { segments: [first] },
      { segments: [second] },
    ]);
  });
});

describe("nahel distill — refusals", () => {
  test("refuses a segment that is still active (not yet rotated), writing nothing", async () => {
    const { root, layout, env } = await setup();
    const name = await seedSegment(layout, env, { archive: false });

    const code = await distillCommand.run([name], env, root);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("still active");
    expect(errs.join("\n")).toContain(name);
    expect(await readDistilledText(layout)).toBeNull();
  });

  test("refuses a segment that is not in the archive at all", async () => {
    const { root, layout, env } = await setup();
    const code = await distillCommand.run(["session-zzzzzzzz.jsonl"], env, root);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("not in the journal archive");
    expect(await readDistilledText(layout)).toBeNull();
  });

  test("one bad name refuses the whole invocation — no partial marking", async () => {
    const { root, layout, env } = await setup();
    const good = await seedSegment(layout, env, { archive: true });
    const code = await distillCommand.run([good, "session-zzzzzzzz.jsonl"], env, root);
    expect(code).toBe(1);
    expect(await readDistilledText(layout)).toBeNull();
    expect(
      (await journalEvents(layout)).filter((event) => event.type === "journal.distilled"),
    ).toEqual([]);
  });

  test("no segment arguments is a usage error", async () => {
    const { root, env } = await setup();
    expect(await distillCommand.run([], env, root)).toBe(1);
    expect(errs.join("\n")).toContain("usage");
  });

  test("archiving state does not leak: the distill act's own session closes and archives", async () => {
    const { root, layout, env } = await setup();
    const name = await seedSegment(layout, env, { archive: true });
    expect(await distillCommand.run([name], env, root)).toBe(0);
    // The act's session segment was closed by the command and swept into the
    // archive — no active segments linger.
    expect((await listSegments(layout)).active).toEqual([]);
  });
});

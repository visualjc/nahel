import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { CommandContext } from "../../src/cli";
import { logCommand, type LogCommandContext } from "../../src/commands/log";
import { roadmapCommand } from "../../src/commands/roadmap";
import { parseWorkflowDoc } from "../../src/install/workflow";
import type { Env } from "../../src/schema/env";
import { ID_PATTERN } from "../../src/schema/id";
import type { JournalEvent } from "../../src/schema/records";
import { readFrontmatterFile } from "../../src/store/frontmatter";
import { readJournal } from "../../src/store/journal";
import {
  ensureLayout,
  listObservations,
  readObservation,
  readTicket,
  writeConfig,
} from "../../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel/workflows/plan-frontier.md` (planning-partner F5 / DD4) — the AFK lane
 * that works ONE map's frontier unattended.
 *
 * Two halves, and neither substitutes for the other. The first checks the
 * canonical doc itself: a workflow that drifted from the CLI would instruct an
 * unattended agent to run commands that do not exist, and there is no human in
 * the loop to notice. The second is F5's scripted dry-run — the lane's own
 * sequence driven through the CLI against a temp store, proving the MACHINERY
 * it rests on composes: frontier → claim → two `ticket=`-keyed lens notes →
 * resolve citing both → provenance intact, plus the release that hands a
 * question back and the human-only refusal that backstops the skip matrix.
 *
 * Each verb has its own unit coverage elsewhere (roadmap-frontier, roadmap-
 * resolve, roadmap-ticket-human-only, log). What is untested until here is the
 * COMPOSITION: that one agent actor can walk the whole lane end to end and the
 * store it leaves behind still validates the links the next briefing reads.
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

/** The lane's actor: a DISTINCT agent id, as the doc's Scheduling section says. */
const LANE_ACTOR = "agent:afk-frontier";

async function shippedWorkflow(file: string) {
  const path = join(import.meta.dir, "../../nahel/workflows", file);
  const { frontmatter, body } = await readFrontmatterFile(path);
  return { parsed: parseWorkflowDoc(file, frontmatter), body };
}

async function ok(env: Env, root: string, args: string[], actor = LANE_ACTOR): Promise<string[]> {
  const before = logs.length;
  const code = await roadmapCommand.run(args, env, root, actor);
  expect(errs.join("\n")).toBe("");
  expect(code).toBe(0);
  return logs.slice(before);
}

async function fails(env: Env, root: string, args: string[], actor = LANE_ACTOR): Promise<string> {
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

/**
 * Journal one lens note the way the lane's step 4 does — carrying the
 * `ticket=<id>` key that puts it in the ticket's briefing window — and return
 * the event id it printed, which then travels to `resolve --source`.
 */
async function lensNote(
  env: Env,
  root: string,
  ticket: string,
  lens: string,
  summary: string,
): Promise<string> {
  const out: string[] = [];
  // The STORE's env, not a fresh one: a seeded RNG restarted from its seed
  // mints the same id twice, and two lens notes must be two events.
  const ctx: LogCommandContext = {
    env,
    cwd: root,
    stdout: (text) => out.push(text),
    stderr: (text) => out.push(text),
    actorOverride: LANE_ACTOR,
  };
  expect(
    await logCommand.run(
      ["note", "--data", `ticket=${ticket}`, "--data", `lens=${lens}`, "--data", `summary=${summary}`],
      ctx,
    ),
  ).toBe(0);
  const id = /event ([0-9a-z]{8})/.exec(out.join("\n"))?.[1];
  expect(id).toMatch(ID_PATTERN);
  return id!;
}

async function journalEvents(root: string): Promise<JournalEvent[]> {
  return Array.fromAsync(readJournal(await ensureLayout(root)));
}

/** The frontier as the lane reads it, one string. */
async function frontier(env: Env, root: string, node: string): Promise<string> {
  return (await ok(env, root, ["frontier", node])).join("\n");
}

const QUESTION = "which deploy target do we own?";
const DECISION = "we own the fly.io deploy and nothing downstream of it";

/**
 * A charted map with three tickets, which is the shape a frontier has to sort:
 * one takeable research ticket, one the lane will claim out from under the
 * frontier, and one flagged human-only. The config actor is `agent:claude-code`
 * (makeConfig's default) but every call below names LANE_ACTOR explicitly —
 * the lane's distinct id is part of what is under test.
 */
async function charted() {
  const root = await makeTempDir("nahel-plan-frontier-");
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig());
  const env = seededEnv({ tickSeconds: 1 });
  const node = "deployment-devops-workflows";
  await ok(env, root, [
    "node",
    "new",
    "feature",
    node,
    "--horizon",
    "now",
    "--intent",
    "Deploy and release, drivable by a fresh agent.",
  ]);
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
  const research = lastId(
    await ok(env, root, ["ticket", "new", "--map", map, "--type", "research", "--question", QUESTION]),
  );
  const other = lastId(
    await ok(env, root, [
      "ticket",
      "new",
      "--map",
      map,
      "--type",
      "task",
      "--question",
      "who owns the staging DNS record?",
    ]),
  );
  const restricted = lastId(
    await ok(env, root, [
      "ticket",
      "new",
      "--map",
      map,
      "--type",
      "grilling",
      "--question",
      "how much are we willing to spend on staging?",
      "--human-only",
    ]),
  );
  return { root, layout, env, node, map, research, other, restricted };
}

describe("plan-frontier.md — the canonical AFK lane doc (F5)", () => {
  test("valid canonical doc: frontmatter parses, the name matches the stem, it takes a map ref", async () => {
    const { parsed } = await shippedWorkflow("plan-frontier.md");
    expect(parsed.name).toBe("plan-frontier");
    expect(parsed.description.length).toBeGreaterThan(0);
    expect(parsed.args).toContain("<");
  });

  test("scopes itself to ONE map's frontier and loops while tickets remain", async () => {
    const { body } = await shippedWorkflow("plan-frontier.md");
    expect(body).toContain("nahel roadmap frontier <node-slug>");
    expect(body).toContain("standalone");
    // The loop is what separates this lane from work-map's one-ticket session.
    expect(body).toContain("Loop");
    expect(body).toContain("go back to step 3");
    // Decision tickets only — the work items the frontier also lists are not ours.
    expect(body).toContain("decision tickets");
  });

  test("states the per-type answers: two-lens research, the prototype bridge, task", async () => {
    const { body } = await shippedWorkflow("plan-frontier.md");
    // D7: two lenses, each its own note, both cited.
    expect(body).toContain("outside-in");
    expect(body).toContain("inside-out");
    expect(body).toContain("--data ticket=<ticket-id>");
    expect(body).toContain("--source");
    // DD5: the bridge runs prototype-lane as written and leaves the ticket open.
    expect(body).toContain("nahel/workflows/prototype-lane.md");
    expect(body).toContain("nahel item new prototype");
    expect(body).toContain("Do not\n   resolve the ticket");
    expect(body).toContain("park");
    // task: do it, then record what doing it settled.
    expect(body).toContain("`task` — do it");
  });

  test("carries the governance skip matrix, and names the CLI refusal as the BACKSTOP", async () => {
    const { body } = await shippedWorkflow("plan-frontier.md");
    for (const mode of ["human", "delegated", "agent"]) expect(body).toContain(mode);
    expect(body).toContain("nahel brief");
    // grilling: skipped under human; under delegated/agent the posture survives
    // as a cross-agent grill, and answering alone is a disclosed fallback, not
    // a choice (ticket jhxg756e).
    expect(body).toContain("SKIP");
    expect(body).toContain("cross-agent grill");
    expect(body).toContain("recorded fallback");
    expect(body).toContain("defended later");
    // human-only: never, under any mode — and the refusal is the net, not the rule.
    expect(body).toContain("NEVER touch");
    expect(body).toContain("--clear-human-only");
    expect(body).toContain("backstop");
  });

  test("states the claim discipline and that the journal IS the report", async () => {
    const { body } = await shippedWorkflow("plan-frontier.md");
    expect(body).toContain("nahel roadmap ticket claim");
    expect(body).toContain("nahel roadmap ticket release");
    expect(body).toContain("Never work a\n   ticket you did not claim");
    expect(body).toContain("There is no report file");
    expect(body).toContain("since your last session");
  });

  test("the Scheduling section says nahel never schedules, and shows who does", async () => {
    const { body } = await shippedWorkflow("plan-frontier.md");
    expect(body).toContain("## Scheduling");
    expect(body).toContain("nahel never schedules");
    expect(body).toContain("no daemon");
    // Concrete, runnable examples for both vendors, plus the harness-native path.
    expect(body).toContain('claude -p "/nd:plan-frontier');
    expect(body).toContain("codex exec");
    expect(body).toContain("Harness-native scheduled agents");
    // afk-run dispatch is the recorded successor delta, not this doc's job.
    expect(body).toContain("successor delta");
  });

  test("keeps the sibling preamble and the fallback section", async () => {
    const { body } = await shippedWorkflow("plan-frontier.md");
    expect(body).toContain("NAHEL_ACTOR=agent:<your-id>");
    expect(body).toContain("never hand-edit");
    expect(body).toContain("Fallback (degraded environment)");
  });
});

describe("the lane's scripted dry-run — the machinery it rests on, composed (F5)", () => {
  test("the whole lane walks: frontier → claim → two lens notes → resolve → provenance", async () => {
    const { root, layout, env, node, research } = await charted();

    // Step 2: the frontier offers the research ticket, and holds back the
    // human-only one nowhere — it is marked, not hidden, because the SKIP is
    // the lane's discipline and the mark is what it reads.
    const offered = await frontier(env, root, node);
    expect(offered).toContain(research);
    expect(offered).toContain("[human-only]");

    // Step 3: claim it, and it leaves the frontier for every other session.
    await ok(env, root, ["ticket", "claim", research]);
    expect(await frontier(env, root, node)).not.toContain(research);

    // Step 4: BOTH lenses, each its own note carrying the ticket key.
    const outside = await lensNote(
      env,
      root,
      research,
      "outside-in",
      "fly.io docs: regions are per-app, not per-org",
    );
    const inside = await lensNote(
      env,
      root,
      research,
      "inside-out",
      "our deploy script already targets fly",
    );

    // Step 5: the decision, citing every note id the lane collected.
    await ok(env, root, [
      "ticket",
      "resolve",
      research,
      "--decision",
      DECISION,
      "--rationale",
      "Both lenses agree, and nothing downstream of the deploy is ours to own.",
      "--source",
      outside,
      "--source",
      inside,
    ]);

    const resolved = await readTicket(layout, research);
    expect(resolved.frontmatter.state).toBe("resolved");
    expect(resolved.frontmatter.decision).toBe(DECISION);

    // Provenance intact: the resolution first, then both lenses in cited order.
    // This is the link that makes the decision reach the research after the
    // ticket body is distilled away — the lane's only durable output.
    const observation = await readObservation(layout, (await listObservations(layout))[0]!);
    expect(observation.frontmatter.sources).toEqual([
      resolved.frontmatter.resolution!,
      outside,
      inside,
    ]);

    // And the acts are attributed to the LANE's actor, not the config default —
    // which is what keeps AFK work inside the human's briefing window.
    const resolution = (await journalEvents(root)).find(
      (event) => event.id === resolved.frontmatter.resolution,
    )!;
    expect(resolution.actor).toEqual({ kind: "agent", id: "afk-frontier" });
  });

  test("each lens note round-trips its ticket= key, so the briefing can find it", async () => {
    // DD1's linkage: a note without this key is research nobody will find, and
    // the lane writes no report file to make up for it.
    const { root, env, research } = await charted();
    const outside = await lensNote(env, root, research, "outside-in", "prior art: three of four use fly");

    const note = (await journalEvents(root)).find((event) => event.id === outside)!;
    expect(note.type).toBe("note");
    expect(note.payload.ticket).toBe(research);
    expect(note.payload.lens).toBe("outside-in");
    expect(note.actor).toEqual({ kind: "agent", id: "afk-frontier" });
  });

  test("release hands a question back: the ticket returns to the frontier, notes still attached", async () => {
    // The lane's honest exit when it cannot finish. The released ticket is the
    // next session's, and the research already journaled stays reachable by its
    // ticket= key — which is why releasing beats a thin resolution.
    const { root, layout, env, node, research } = await charted();
    await ok(env, root, ["ticket", "claim", research]);
    const partial = await lensNote(env, root, research, "inside-out", "our store says nothing yet");
    expect(await frontier(env, root, node)).not.toContain(research);

    await ok(env, root, ["ticket", "release", research]);

    expect(await frontier(env, root, node)).toContain(research);
    expect((await readTicket(layout, research)).frontmatter.state).toBe("open");
    const note = (await journalEvents(root)).find((event) => event.id === partial)!;
    expect(note.payload.ticket).toBe(research);
  });

  test("the human-only backstop refuses the lane's own actor at resolve AND at close", async () => {
    // The skip matrix is discipline; this is the net under it. A lane that
    // reached here has already spent research it is about to throw away, which
    // is exactly why the doc tells it to skip rather than to try.
    const { root, layout, env, restricted } = await charted();

    const onResolve = await fails(env, root, ["ticket", "resolve", restricted, "--decision", DECISION]);
    expect(onResolve).toContain(restricted);
    expect(onResolve).toContain("human-only");
    expect(onResolve).toContain(LANE_ACTOR);

    const onClose = await fails(env, root, [
      "ticket",
      "close",
      restricted,
      "--out-of-scope",
      "--reason",
      "another team owns spend",
    ]);
    expect(onClose).toContain("human-only");

    const unchanged = await readTicket(layout, restricted);
    expect(unchanged.frontmatter.state).toBe("open");
    expect(unchanged.frontmatter.decision).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { CommandContext } from "../../src/cli";
import { configCommand } from "../../src/commands/config";
import { itemCommand } from "../../src/commands/item";
import { logCommand, type LogCommandContext } from "../../src/commands/log";
import { planCommand } from "../../src/commands/plan";
import { roadmapCommand } from "../../src/commands/roadmap";
import { validateCommand } from "../../src/commands/validate";
import type { Env } from "../../src/schema/env";
import { CORE_EVENT_TYPES } from "../../src/schema/events";
import { ID_PATTERN } from "../../src/schema/id";
import type { JournalEvent, ObservationFrontmatter } from "../../src/schema/records";
import { readJournal } from "../../src/store/journal";
import {
  ensureLayout,
  listObservations,
  listTickets,
  readItem,
  readMap,
  readObservation,
  readRoadmapNode,
  readTicket,
  writeConfig,
  type StoreLayout,
} from "../../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * The planning-partner EXIT TEST: the PRD's two exit scenarios, composed.
 *
 * Every feature this delta shipped has its own tests — `plan` renders its five
 * goldens (tests/commands/plan.test.ts), the since-window has its unit table
 * (tests/views/plan-since.test.ts), the human-only refusals have theirs
 * (tests/commands/roadmap-ticket-human-only.test.ts), the two lane docs have
 * theirs (tests/workflows/). What NOTHING tests until here is whether they add
 * up to the thing the PRD promised: a planning session a partner can actually
 * conduct end to end, at three altitudes, under three governance postures,
 * leaving a store whose links the NEXT session reads back.
 *
 * So this file asserts no new behavior. It drives the same CLI a real session
 * drives — mutation verbs under explicit actors, reads through `nahel plan` —
 * against fresh temp stores, in the exact order the PRD's exit text narrates,
 * and checks that each step's output is the next step's input. A regression
 * that leaves every unit test green and still breaks the session — a note that
 * stops linking, a window that buries AFK work, a refusal that stops refusing —
 * fails HERE and nowhere else.
 *
 * One store per scenario, save where the PRD itself calls for a second: the
 * governance postures are store-level config, so `delegated` and `human` are
 * necessarily separate stores.
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

/** The human product owner. */
const HUMAN = "human:jim";

/** The AFK lane's actor — a DISTINCT agent id, per plan-frontier's Scheduling. */
const LANE = "agent:afk-frontier";

/** The in-session planning partner, the actor `/nd:plan` runs as. */
const PARTNER = "agent:claude-code";

// ---------------------------------------------------------------------------
// Driving the CLI, exactly as the existing integration tests do.
// ---------------------------------------------------------------------------

/** Run a roadmap verb under `actor`, expect success, return what it printed. */
async function ok(env: Env, root: string, args: string[], actor: string): Promise<string[]> {
  const before = logs.length;
  const code = await roadmapCommand.run(args, env, root, actor);
  expect(errs.join("\n")).toBe("");
  expect(code).toBe(0);
  return logs.slice(before);
}

/** Run one expecting a refusal; returns what it wrote to stderr. */
async function refused(env: Env, root: string, args: string[], actor: string): Promise<string> {
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
 * Journal one note through `nahel log` and return the event id it printed.
 *
 * The STORE's env, never a fresh one: a seeded RNG restarted from its seed
 * mints the same id twice, and two notes must be two events.
 */
async function note(env: Env, root: string, args: string[], actor: string): Promise<string> {
  const out: string[] = [];
  const ctx: LogCommandContext = {
    env,
    cwd: root,
    stdout: (text) => out.push(text),
    stderr: (text) => out.push(text),
    actorOverride: actor,
  };
  expect(await logCommand.run(["note", ...args], ctx)).toBe(0);
  const id = /event ([0-9a-z]{8})/.exec(out.join("\n"))?.[1];
  expect(id).toMatch(ID_PATTERN);
  return id!;
}

/** A frozen read context — `nahel plan` must never read a clock. */
function readContext(root: string): CommandContext {
  return {
    env: seededEnv({ now: "2026-08-09T09:00:00Z", tickSeconds: 0 }),
    cwd: root,
    stdout: (text: string) => logs.push(text),
    stderr: (text: string) => errs.push(text),
  };
}

/** `nahel plan [ref]` — the briefing page, as one string. */
async function plan(root: string, args: string[] = []): Promise<string> {
  const before = logs.length;
  const code = await planCommand.run(args, readContext(root));
  expect(errs.join("\n")).toBe("");
  expect(code).toBe(0);
  return logs.slice(before).join("\n");
}

/** `nahel validate` — the exit code and its report, as the verb itself sees them. */
async function validate(root: string): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const code = await validateCommand.run([], {
    env: seededEnv({ now: "2026-08-09T09:00:00Z", tickSeconds: 0 }),
    cwd: root,
    stdout: (text) => out.push(text),
    stderr: (text) => out.push(text),
  });
  return { code, out: out.join("\n") };
}

/** Assert `nahel validate` reports zero errors (warnings are permitted). */
async function validatesClean(root: string, when: string): Promise<void> {
  const { code, out } = await validate(root);
  expect(`${when}: ${out}`).not.toContain("error [");
  expect(code).toBe(0);
}

/** A fresh store whose config names `agent:claude-code` and declares no governance. */
async function freshStore(prefix: string): Promise<{ root: string; layout: StoreLayout }> {
  const root = await makeTempDir(prefix);
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig());
  return { root, layout };
}

/** Write `config.governance` the way `nahel config set` does, under the human. */
async function setGovernance(
  env: Env,
  root: string,
  product: "human" | "delegated" | "agent",
): Promise<void> {
  const code = await configCommand.run(
    ["set", "governance", "--data", JSON.stringify({ product, architecture: "human" })],
    env,
    root,
    HUMAN,
  );
  expect(errs.join("\n")).toBe("");
  expect(code).toBe(0);
}

async function journal(layout: StoreLayout): Promise<JournalEvent[]> {
  return Array.fromAsync(readJournal(layout));
}

/** The ticket id one mutation event carries, read the way mutate() writes both payloads. */
function ticketOf(event: JournalEvent): string | undefined {
  const steps: unknown[] = [event.payload];
  const records = event.payload["records"];
  if (Array.isArray(records)) steps.push(...records);
  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue;
    const fields = step as Record<string, unknown>;
    if (fields["target"] !== "ticket") continue;
    const record = fields["record"];
    if (typeof record === "object" && record !== null) {
      const id = (record as Record<string, unknown>)["id"];
      if (typeof id === "string") return id;
    }
  }
  return undefined;
}

/** The one act of `type` that touched `ticket` — ambiguity is a fixture bug. */
function act(events: readonly JournalEvent[], type: string, ticket: string): JournalEvent {
  const found = events.filter((event) => event.type === type && ticketOf(event) === ticket);
  expect(found.length).toBe(1);
  return found[0]!;
}

/**
 * The decision a resolved ticket left behind, read the way a PRD writer reads
 * it: the ticket's one-liner, and the observation the resolution distilled —
 * which is the ONLY place the rationale and the provenance survive `distill`.
 */
async function decisionRecord(
  layout: StoreLayout,
  ticket: string,
): Promise<{ decision: string; body: string; sources: ObservationFrontmatter["sources"] }> {
  const record = (await readTicket(layout, ticket)).frontmatter;
  expect(record.state).toBe("resolved");
  const resolution = record.resolution;
  expect(resolution).toMatch(ID_PATTERN);
  const matches = [];
  for (const id of await listObservations(layout)) {
    const observation = await readObservation(layout, id);
    if (observation.frontmatter.sources[0] === resolution) matches.push(observation);
  }
  expect(matches.length).toBe(1);
  return {
    decision: record.decision!,
    body: matches[0]!.body,
    sources: matches[0]!.frontmatter.sources,
  };
}

/** The briefing's "since your last session" block, from its header to the blank line. */
function sinceBlock(page: string): string[] {
  const lines = page.split("\n");
  const start = lines.findIndex((line) => line.startsWith("since your last session"));
  expect(start).toBeGreaterThanOrEqual(0);
  const end = lines.indexOf("", start);
  expect(end).toBeGreaterThan(start);
  return lines.slice(start, end);
}

// ===========================================================================
// SCENARIO 1 — feature altitude, end to end.
// ===========================================================================

const DESTINATION = "a payment a fresh agent can take";
const INSIDE_FOG = "how do we roll back a capture?";
const OUTSIDE_FOG = "what does multi-currency settlement cost us?";

/**
 * The store the first scenario opens on: a product and one feature node under
 * it, charted by nothing yet. Built by the HUMAN, because the default briefing
 * reader is the store's human side (DD1) — everything the partner and the lane
 * do after this has to land inside the window that opens here.
 */
async function featureStore() {
  const { root, layout } = await freshStore("nahel-exit-feature-");
  const human = seededEnv({ seed: 3, now: "2026-08-01T09:00:00Z", tickSeconds: 1 });
  const product = lastId(
    await ok(
      human,
      root,
      ["node", "new", "product", "paperbird", "--horizon", "now", "--intent",
        "A product that takes money for folded paper."],
      HUMAN,
    ),
  );
  const node = lastId(
    await ok(
      human,
      root,
      ["node", "new", "feature", "payments-rails", "--horizon", "now", "--parent", product,
        "--intent", "Take a payment without a queue."],
      HUMAN,
    ),
  );
  return { root, layout, human, product, node };
}

/**
 * The charting session: the map, its two fog lines, and one ticket of each of
 * the four types — the grilling one flagged human-only, because "how much are
 * we willing to lose to fraud" is a question no partner may answer for us.
 */
async function chartFeature(fixture: Awaited<ReturnType<typeof featureStore>>) {
  const { root, human } = fixture;
  const map = lastId(
    await ok(
      human,
      root,
      ["map", "new", "--node", "payments-rails", "--destination", DESTINATION,
        "--fog", INSIDE_FOG, "--fog", OUTSIDE_FOG],
      HUMAN,
    ),
  );
  const cut = async (type: string, question: string, ...extra: string[]): Promise<string> =>
    lastId(
      await ok(
        human,
        root,
        ["ticket", "new", "--map", map, "--type", type, "--question", question, ...extra],
        HUMAN,
      ),
    );
  const research = await cut("research", "which processor do we own the integration with?");
  const task = await cut("task", "what does our current checkout POST to?");
  const prototype = await cut("prototype", "does a one-tap capture feel fast enough?");
  const grilling = await cut(
    "grilling",
    "how much fraud loss are we willing to eat per month?",
    "--human-only",
  );
  return { ...fixture, map, research, task, prototype, grilling };
}

describe("Scenario 1 — feature altitude, end to end (the PRD's first exit scenario)", () => {
  test("an uncharted feature node briefs as uncharted and points the session at charting", async () => {
    const fixture = await featureStore();

    const page = await plan(fixture.root, ["payments-rails"]);

    // F1's no-map case: the briefing is rendered, not refused — refusing would
    // make the verb useless at exactly the moment a planning session starts.
    expect(page).toContain("no map yet — this node is not charted");
    expect(page).toContain(
      '↳ nahel roadmap map new --node payments-rails --destination "<where this is going>"  — chart it',
    );
    expect(page).toContain("↳ nahel/workflows/chart-map.md  — the charting session that fills it");
    // And it still places the altitude and states the posture, so the session
    // knows which conversation it is in before the map exists.
    expect(page).toContain("feature definition (this node)");
    expect(page).toContain("↳ nahel/workflows/plan.md  — the workflow that conducts this session");
    await validatesClean(fixture.root, "uncharted");
  });

  test("a charting session records one map, two fog lines, and one ticket of each type — the grilling one human-only", async () => {
    const fixture = await chartFeature(await featureStore());

    const map = await readMap(fixture.layout, fixture.map);
    expect(map.frontmatter.node).toBe(fixture.node);
    expect(map.frontmatter.destination).toBe(DESTINATION);
    expect(map.frontmatter.fog).toEqual([INSIDE_FOG, OUTSIDE_FOG]);

    const types = [];
    for (const id of [fixture.research, fixture.task, fixture.prototype, fixture.grilling]) {
      types.push((await readTicket(fixture.layout, id)).frontmatter.type);
    }
    expect(types).toEqual(["research", "task", "prototype", "grilling"]);
    // DD2: absent means false, so only the one flagged carries the field.
    expect((await readTicket(fixture.layout, fixture.grilling)).frontmatter.human_only).toBe(true);
    expect((await readTicket(fixture.layout, fixture.research)).frontmatter.human_only)
      .toBeUndefined();
    // The frontier and the briefing both MARK it rather than hiding it: the
    // skip is the lane's discipline, and the mark is what it reads.
    expect(await plan(fixture.root, ["payments-rails"])).toContain(
      `${fixture.grilling}  grilling  map=payments-rails  [human-only]`,
    );
    await validatesClean(fixture.root, "charted");
  });

  test("the AFK lane resolves research two-lens, executes the task, bridges the prototype, and is refused the human-only ticket", async () => {
    const fixture = await chartFeature(await featureStore());
    const { root, layout } = fixture;
    const lane = seededEnv({ seed: 11, now: "2026-08-02T09:00:00Z", tickSeconds: 1 });

    // --- research: D7's two lenses, each its own `ticket=`-keyed note ---------
    await ok(lane, root, ["ticket", "claim", fixture.research], LANE);
    const outsideIn = await note(
      lane,
      root,
      ["--data", `ticket=${fixture.research}`, "--data", "lens=outside-in",
        "--data", "summary=stripe and adyen both settle T+2; adyen has no test-mode refunds"],
      LANE,
    );
    const insideOut = await note(
      lane,
      root,
      ["--data", `ticket=${fixture.research}`, "--data", "lens=inside-out",
        "--data", "summary=our checkout already holds a stripe publishable key"],
      LANE,
    );
    await ok(
      lane,
      root,
      ["ticket", "resolve", fixture.research, "--decision", "stripe, and nothing behind it",
        "--rationale",
        "Outside-in: adyen cannot refund in test mode, which we need weekly.\n\n" +
          "Inside-out: the stripe key is already in the checkout, so this costs us nothing.",
        "--source", outsideIn, "--source", insideOut],
      LANE,
    );

    // --- task: do it, then record what doing it settled ----------------------
    await ok(lane, root, ["ticket", "claim", fixture.task], LANE);
    const executed = await note(
      lane,
      root,
      ["--data", `ticket=${fixture.task}`,
        "--data", "summary=read src/checkout: it POSTs to /api/pay with a bare amount"],
      LANE,
    );
    await ok(
      lane,
      root,
      ["ticket", "resolve", fixture.task, "--decision", "checkout POSTs /api/pay with a bare amount",
        "--rationale", "Read it. There is no idempotency key, which is a fog line, not this ticket.",
        "--source", executed],
      LANE,
    );

    // --- prototype: DD5's bridge — started, NOT finished ---------------------
    await ok(lane, root, ["ticket", "claim", fixture.prototype], LANE);
    const before = logs.length;
    expect(
      await itemCommand.run(["new", "prototype", "one-tap-capture", "direct"], lane, root, LANE),
    ).toBe(0);
    const item = lastId(logs.slice(before));
    const bridge = await note(
      lane,
      root,
      ["--item", item, "--data", `ticket=${fixture.prototype}`,
        "--data", `summary=prototype ${item} opened to answer ${fixture.prototype}`],
      LANE,
    );
    // The claim is HANDED BACK and the ticket stays open: AFK "resolves" a
    // prototype ticket only as far as building the variants, and the verdict is
    // prototype-lane's to land. D4's "started, not awaited", made literal.
    await ok(lane, root, ["ticket", "release", fixture.prototype], LANE);

    // --- the human-only grilling ticket: refused, not skipped silently -------
    const refusal = await refused(
      lane,
      root,
      ["ticket", "resolve", fixture.grilling, "--decision", "we eat up to $2k/month"],
      LANE,
    );

    // Research: resolved, and the provenance is resolution-then-both-lenses.
    const researched = await decisionRecord(layout, fixture.research);
    expect(researched.decision).toBe("stripe, and nothing behind it");
    expect(researched.body).toContain("adyen cannot refund in test mode");
    expect(researched.sources.slice(1)).toEqual([outsideIn, insideOut]);
    // Task: resolved, citing what executing it turned up.
    expect((await decisionRecord(layout, fixture.task)).sources.slice(1)).toEqual([executed]);
    // Prototype: OPEN, unclaimed, with a note pointing at the waiting item.
    const bridged = (await readTicket(layout, fixture.prototype)).frontmatter;
    expect(bridged.state).toBe("open");
    expect(bridged.claimant).toBeUndefined();
    expect(bridged.decision).toBeUndefined();
    expect((await readItem(layout, item)).frontmatter.type).toBe("prototype");
    const linking = (await journal(layout)).find((event) => event.id === bridge)!;
    expect(linking.payload["ticket"]).toBe(fixture.prototype);
    expect(linking.item).toBe(item);
    // Grilling: refused by name, by rule, and by actor — and untouched.
    expect(refusal).toContain(fixture.grilling);
    expect(refusal).toContain("human-only");
    expect(refusal).toContain(LANE);
    const untouched = (await readTicket(layout, fixture.grilling)).frontmatter;
    expect(untouched.state).toBe("open");
    expect(untouched.decision).toBeUndefined();
    // Every act is attributed to the LANE's own id, which is what keeps AFK
    // work inside the human's window rather than under their own baseline.
    expect(
      act(await journal(layout), CORE_EVENT_TYPES.ticketResolved, fixture.research).actor,
    ).toEqual({ kind: "agent", id: "afk-frontier" });
    await validatesClean(root, "after the AFK pass");
  });

  test("the human's next briefing debriefs EXACTLY the lane's movements, and nothing it already knew", async () => {
    const fixture = await chartFeature(await featureStore());
    const { root, layout } = fixture;
    const lane = seededEnv({ seed: 11, now: "2026-08-02T09:00:00Z", tickSeconds: 1 });

    await ok(lane, root, ["ticket", "claim", fixture.research], LANE);
    const outsideIn = await note(
      lane, root,
      ["--data", `ticket=${fixture.research}`, "--data", "lens=outside-in", "--data", "summary=T+2"],
      LANE,
    );
    const insideOut = await note(
      lane, root,
      ["--data", `ticket=${fixture.research}`, "--data", "lens=inside-out", "--data", "summary=key"],
      LANE,
    );
    await ok(
      lane, root,
      ["ticket", "resolve", fixture.research, "--decision", "stripe, and nothing behind it",
        "--source", outsideIn, "--source", insideOut],
      LANE,
    );
    await ok(lane, root, ["ticket", "claim", fixture.task], LANE);
    const executed = await note(
      lane, root,
      ["--data", `ticket=${fixture.task}`, "--data", "summary=/api/pay, bare amount"],
      LANE,
    );
    await ok(
      lane, root,
      ["ticket", "resolve", fixture.task, "--decision", "checkout POSTs /api/pay with a bare amount",
        "--source", executed],
      LANE,
    );
    await ok(lane, root, ["ticket", "claim", fixture.prototype], LANE);
    const itemLine = logs.length;
    expect(
      await itemCommand.run(["new", "prototype", "one-tap-capture", "direct"], lane, root, LANE),
    ).toBe(0);
    const item = lastId(logs.slice(itemLine));
    const bridge = await note(
      lane, root,
      ["--item", item, "--data", `ticket=${fixture.prototype}`, "--data", "summary=opened"],
      LANE,
    );
    await ok(lane, root, ["ticket", "release", fixture.prototype], LANE);

    const events = await journal(layout);
    // The human's baseline is their own last subject act — cutting the last
    // ticket — so the window is precisely everything the lane did after it.
    const baseline = act(events, CORE_EVENT_TYPES.ticketCreated, fixture.grilling);
    const resolvedResearch = act(events, CORE_EVENT_TYPES.ticketResolved, fixture.research);
    const resolvedTask = act(events, CORE_EVENT_TYPES.ticketResolved, fixture.task);
    const at = (id: string): string => events.find((event) => event.id === id)!.ts;

    const page = await plan(root, ["payments-rails"]);

    expect(sinceBlock(page)).toEqual([
      `since your last session (after your last act here, ${baseline.ts}):`,
      `  ${resolvedResearch.ts}  resolved  ${fixture.research}  stripe, and nothing behind it  ` +
        `act=${resolvedResearch.id}`,
      `  ${resolvedTask.ts}  resolved  ${fixture.task}  ` +
        `checkout POSTs /api/pay with a bare amount  act=${resolvedTask.id}`,
      `  ${at(outsideIn)}  noted  ticket=${fixture.research}  act=${outsideIn}`,
      `  ${at(insideOut)}  noted  ticket=${fixture.research}  act=${insideOut}`,
      `  ${at(executed)}  noted  ticket=${fixture.task}  act=${executed}`,
      `  ${at(bridge)}  noted  ticket=${fixture.prototype}  act=${bridge}`,
    ]);
    // The claims and the release moved the LANE's baseline and are reported to
    // nobody — the frontier section below already shows every current claim.
    // The equality above already pins this; naming it is what makes a future
    // extra debrief line read as the rule it broke.
    expect(sinceBlock(page).join("\n")).not.toContain("claimed");
    expect(sinceBlock(page).join("\n")).not.toContain("released");
    // And the reader override still works over the same store: the lane's own
    // acts stop being news to the lane.
    const asLane = await plan(root, ["payments-rails", "--reader", LANE]);
    expect(sinceBlock(asLane).at(-1)).toBe("  nothing new since your last touch");
    await validatesClean(root, "after the debrief");
  });

  test("the human resolves the human-only ticket, the cut check leaves one outside-delta fog line, and a --predecessor successor carries it", async () => {
    const fixture = await chartFeature(await featureStore());
    const { root, layout } = fixture;
    const lane = seededEnv({ seed: 11, now: "2026-08-02T09:00:00Z", tickSeconds: 1 });
    await ok(
      lane, root,
      ["ticket", "resolve", fixture.research, "--decision", "stripe, and nothing behind it",
        "--rationale", "Adyen cannot refund in test mode, and the stripe key is already here."],
      LANE,
    );
    await ok(
      lane, root,
      ["ticket", "resolve", fixture.task, "--decision", "checkout POSTs /api/pay with a bare amount",
        "--rationale", "Read it end to end; nothing else calls the endpoint."],
      LANE,
    );

    // The human comes back and answers what only they could answer.
    const closing = seededEnv({ seed: 23, now: "2026-08-03T09:00:00Z", tickSeconds: 1 });
    await ok(
      closing, root,
      ["ticket", "resolve", fixture.grilling, "--decision", "up to $2k of fraud loss a month",
        "--rationale", "Below $2k the chargeback fees cost more than the fraud does."],
      HUMAN,
    );
    expect((await readTicket(layout, fixture.grilling)).frontmatter.state).toBe("resolved");

    // --- the cut check (D5), door one: RESOLVE NOW ---------------------------
    // The inside-delta fog line is sharp enough to ticket now, so it is cut and
    // answered inside this delta rather than carried.
    const capture = lastId(
      await ok(
        closing, root,
        ["ticket", "new", "--map", fixture.map, "--type", "grilling", "--question", INSIDE_FOG],
        HUMAN,
      ),
    );
    await ok(
      closing, root,
      ["ticket", "resolve", capture, "--decision", "a capture rolls back as a full refund, never partial",
        "--rationale", "Partial refunds need a ledger we do not have and are not building here."],
      HUMAN,
    );
    // …and the fog section is re-stated to what is LEFT, which is how a fog
    // line graduates. What remains is the OUTSIDE-delta question: it stays on
    // the map, keeps resolving, and sharpens into a successor node.
    await ok(closing, root, ["map", "update", fixture.map, "--fog", OUTSIDE_FOG], HUMAN);
    expect((await readMap(layout, fixture.map)).frontmatter.fog).toEqual([OUTSIDE_FOG]);
    expect(await plan(root, ["payments-rails"])).toContain(`not yet specified (1):\n  ${OUTSIDE_FOG}`);

    // --- what prd-new's map-fed path reads (F6) ------------------------------
    // Writing the PRD is judgment; what MACHINERY owes it is the settled set,
    // each with the reasoning behind it and the events it rests on — the three
    // things `distill` would otherwise throw away with the ticket body.
    for (const [ticket, decision, rationale] of [
      [fixture.research, "stripe, and nothing behind it",
        "Adyen cannot refund in test mode, and the stripe key is already here."],
      [fixture.task, "checkout POSTs /api/pay with a bare amount",
        "Read it end to end; nothing else calls the endpoint."],
      [fixture.grilling, "up to $2k of fraud loss a month",
        "Below $2k the chargeback fees cost more than the fraud does."],
      [capture, "a capture rolls back as a full refund, never partial",
        "Partial refunds need a ledger we do not have and are not building here."],
    ] as const) {
      const record = await decisionRecord(layout, ticket);
      expect(record.decision).toBe(decision);
      // The WHY, verbatim — the one thing a PRD's cited section cannot be
      // written from the map row alone.
      expect(record.body).toContain(rationale);
      expect(record.sources[0]).toBe((await readTicket(layout, ticket)).frontmatter.resolution);
    }
    // All four read back off the map's derived index, in resolution order.
    const shown = (await ok(closing, root, ["map", "show", fixture.map], HUMAN)).join("\n");
    for (const id of [fixture.research, fixture.task, fixture.grilling, capture]) {
      expect(shown).toContain(id);
    }
    // The one ticket still open is the prototype's — outside this delta by
    // construction (its verdict is prototype-lane's), so it never enters a PRD.
    const open = [];
    for (const id of await listTickets(layout)) {
      if ((await readTicket(layout, id)).frontmatter.state === "open") open.push(id);
    }
    expect(open).toEqual([fixture.prototype]);

    // --- the successor node the outside-delta line sharpens into (D5) --------
    const successor = lastId(
      await ok(
        closing, root,
        ["node", "new", "feature", "multi-currency-settlement", "--horizon", "next",
          "--parent", fixture.product, "--intent", OUTSIDE_FOG,
          "--predecessor", "payments-rails"],
        HUMAN,
      ),
    );
    expect((await readRoadmapNode(layout, successor)).frontmatter.predecessor).toBe(fixture.node);
    await validatesClean(root, "at handoff");
  });
});

// ===========================================================================
// SCENARIO 2 — altitude coverage.
// ===========================================================================

const PRODUCT_DESTINATION = "one product a fresh agent can hold in its head";

/**
 * A charted PRODUCT node with one feature child — the subject of both the
 * roadmap-shaping and the ideation passes. The human charts it, so the human's
 * baseline sits here and everything the partner does next is news.
 */
async function productStore() {
  const { root, layout } = await freshStore("nahel-exit-altitude-");
  const human = seededEnv({ seed: 7, now: "2026-08-01T09:00:00Z", tickSeconds: 1 });
  const product = lastId(
    await ok(
      human, root,
      ["node", "new", "product", "paperbird", "--horizon", "now", "--intent",
        "A product that folds paper."],
      HUMAN,
    ),
  );
  const map = lastId(
    await ok(
      human, root,
      ["map", "new", "--node", "paperbird", "--destination", PRODUCT_DESTINATION],
      HUMAN,
    ),
  );
  const child = lastId(
    await ok(
      human, root,
      ["node", "new", "feature", "payments-rails", "--horizon", "next", "--parent", product,
        "--intent", "Take a payment without a queue."],
      HUMAN,
    ),
  );
  return { root, layout, human, product, map, child };
}

describe("Scenario 2 — altitude coverage (the PRD's second exit scenario)", () => {
  test("a roadmap-shaping session cuts no tickets: the node mutations ARE the record, plus one journaled session note (D2)", async () => {
    const fixture = await productStore();
    const { root, layout } = fixture;
    const partner = seededEnv({ seed: 13, now: "2026-08-02T09:00:00Z", tickSeconds: 1 });

    // The session's whole output at this altitude: nodes moved…
    await ok(
      partner, root,
      ["node", "update", fixture.child, "--horizon", "now"],
      PARTNER,
    );
    await ok(
      partner, root,
      ["node", "update", fixture.product, "--intent",
        "A product that folds paper, and charges for the folding."],
      PARTNER,
    );
    const sibling = lastId(
      await ok(
        partner, root,
        ["node", "new", "feature", "folding-ux", "--horizon", "next", "--parent", fixture.product,
          "--intent", "Fold a sheet in one gesture."],
        PARTNER,
      ),
    );
    // …and ONE note at the end saying what the session was.
    const session = await note(
      partner, root,
      ["--data", `node=${fixture.product}`, "--data", "altitude=roadmap-shaping",
        "--data", "summary=split the paperbird product into payments-rails and folding-ux"],
      PARTNER,
    );

    expect((await readRoadmapNode(layout, fixture.child)).frontmatter.horizon).toBe("now");
    expect((await readRoadmapNode(layout, fixture.product)).body).toContain(
      "charges for the folding",
    );
    expect((await readRoadmapNode(layout, sibling)).frontmatter.parent).toBe(fixture.product);
    // Exactly one note for the whole session — the ceremony D2 scales down to.
    const notes = (await journal(layout)).filter((event) => event.type === "note");
    expect(notes.map((event) => event.id)).toEqual([session]);
    expect(notes[0]!.actor).toEqual({ kind: "agent", id: "claude-code" });
    expect(notes[0]!.payload["altitude"]).toBe("roadmap-shaping");
    // And NOT one ticket: full map discipline is the feature altitude's price,
    // not this one's.
    expect(await listTickets(layout)).toEqual([]);

    // The human's briefing over the moved node reads the mutation back as the
    // record it is — no ticket resolved, and the debrief still has the news.
    const created = (await journal(layout)).filter(
      (event) =>
        event.type === CORE_EVENT_TYPES.roadmapNodeCreated &&
        JSON.stringify(event.payload).includes(fixture.child),
    );
    expect(created.length).toBe(1);
    expect(sinceBlock(await plan(root, ["payments-rails"]))).toEqual([
      `since your last session (after your last act here, ${created[0]!.ts}):`,
      "  node  horizon  next → now",
    ]);
    await validatesClean(root, "after roadmap shaping");
  });

  test("an ideation pass blesses one idea into a later-horizon node and parks one reject as an out-of-scope line (D2)", async () => {
    const fixture = await productStore();
    const { root, layout } = fixture;
    const partner = seededEnv({ seed: 17, now: "2026-08-02T09:00:00Z", tickSeconds: 1 });

    // Blessed: "wouldn't it be cool if it folded itself" earns a node, at the
    // horizon that says not now.
    const blessed = lastId(
      await ok(
        partner, root,
        ["node", "new", "feature", "self-folding-paper", "--horizon", "later",
          "--parent", fixture.product, "--intent", "The sheet folds itself on a schedule."],
        PARTNER,
      ),
    );
    // Rejected: it earns a LINE, not a node and not a ticket.
    await ok(
      partner, root,
      ["map", "update", fixture.map, "--out-of-scope", "a paper-folding hardware peripheral"],
      PARTNER,
    );

    const node = (await readRoadmapNode(layout, blessed)).frontmatter;
    expect(node.horizon).toBe("later");
    expect(node.parent).toBe(fixture.product);
    expect((await readMap(layout, fixture.map)).frontmatter.out_of_scope).toEqual([
      "a paper-folding hardware peripheral",
    ]);
    // Ideation's ceremony floor: neither act cut a ticket.
    expect(await listTickets(layout)).toEqual([]);

    const page = await plan(root, ["paperbird"]);
    expect(page).toContain("out of scope (1):\n  a paper-folding hardware peripheral");
    expect(page).toContain("  map  out_of_scope  + a paper-folding hardware peripheral");
    await validatesClean(root, "after ideation");
  });

  test("under `delegated` governance the partner self-resolves a plain grilling ticket with rationale, and the human-only one still refuses (D3 + DD2)", async () => {
    const { root, layout } = await freshStore("nahel-exit-delegated-");
    const setup = seededEnv({ seed: 19, now: "2026-08-01T09:00:00Z", tickSeconds: 1 });
    await setGovernance(setup, root, "delegated");
    await ok(
      setup, root,
      ["node", "new", "feature", "payments-rails", "--horizon", "now", "--intent",
        "Take a payment without a queue."],
      HUMAN,
    );
    const map = lastId(
      await ok(
        setup, root,
        ["map", "new", "--node", "payments-rails", "--destination", DESTINATION],
        HUMAN,
      ),
    );
    const plain = lastId(
      await ok(
        setup, root,
        ["ticket", "new", "--map", map, "--type", "grilling", "--question",
          "do we retry a declined card at all?"],
        HUMAN,
      ),
    );
    const restricted = lastId(
      await ok(
        setup, root,
        ["ticket", "new", "--map", map, "--type", "grilling", "--question",
          "how much fraud loss are we willing to eat per month?", "--human-only"],
        HUMAN,
      ),
    );

    // The briefing states the authority BEFORE the partner uses it, which is
    // what makes the next two acts a rule rather than a guess.
    const page = await plan(root, ["payments-rails"]);
    expect(page).toContain("  product: delegated");
    expect(page).toContain("Grilling tickets too, with a rationale it can defend later.");
    expect(page).toContain(
      "  never: a [human-only] ticket — under an agent actor resolve, close and " +
        "--clear-human-only are all refused.",
    );

    const partner = seededEnv({ seed: 29, now: "2026-08-02T09:00:00Z", tickSeconds: 1 });
    await ok(
      partner, root,
      ["ticket", "resolve", plain, "--decision", "one retry, 24 hours later, then stop",
        "--rationale",
        "A second immediate retry is declined by the same rule that declined the first; " +
          "a day is long enough for a topped-up balance and short enough to still convert."],
      PARTNER,
    );
    const refusal = await refused(
      partner, root,
      ["ticket", "resolve", restricted, "--decision", "we eat up to $2k/month"],
      PARTNER,
    );

    // Delegated governance moved the grilling line, and the flag did not move
    // with it — DD2's refusal is CLI-enforced under EVERY mode.
    const settled = await decisionRecord(layout, plain);
    expect(settled.decision).toBe("one retry, 24 hours later, then stop");
    expect(settled.body).toContain("declined by the same rule");
    expect(act(await journal(layout), CORE_EVENT_TYPES.ticketResolved, plain).actor).toEqual({
      kind: "agent",
      id: "claude-code",
    });
    expect(refusal).toContain(restricted);
    expect(refusal).toContain("human-only");
    expect(refusal).toContain(PARTNER);
    expect((await readTicket(layout, restricted)).frontmatter.state).toBe("open");
    // The other half of the hole: clearing the flag is refused too, so the
    // partner cannot clear-then-resolve.
    expect(
      await refused(partner, root, ["ticket", "update", restricted, "--clear-human-only"], PARTNER),
    ).toContain("human-only");
    await validatesClean(root, "delegated store");
  });

  test("under `human` governance a journaled delegation note lets the partner resolve one named grilling ticket, and the provenance chain reads back (DD6)", async () => {
    const { root, layout } = await freshStore("nahel-exit-delegation-");
    const setup = seededEnv({ seed: 31, now: "2026-08-01T09:00:00Z", tickSeconds: 1 });
    await setGovernance(setup, root, "human");
    await ok(
      setup, root,
      ["node", "new", "feature", "payments-rails", "--horizon", "now", "--intent",
        "Take a payment without a queue."],
      HUMAN,
    );
    const map = lastId(
      await ok(
        setup, root,
        ["map", "new", "--node", "payments-rails", "--destination", DESTINATION],
        HUMAN,
      ),
    );
    const ticket = lastId(
      await ok(
        setup, root,
        ["ticket", "new", "--map", map, "--type", "grilling", "--question",
          "do we retry a declined card at all?"],
        HUMAN,
      ),
    );

    // Under `human` the briefing says these wait — and names the one door out.
    const page = await plan(root, ["payments-rails"]);
    expect(page).toContain("  product: human");
    expect(page).toContain(
      "Grilling tickets wait for you — unless you delegate them by name in this session.",
    );

    // The delegation is RECORDED, not conversational: one note, naming the
    // ticket, written by the human who is handing it over.
    const delegation = await note(
      setup, root,
      ["--data", `ticket=${ticket}`, "--data", "delegation=use your default recommendations",
        "--data", `summary=jim delegated ${ticket} to the partner for this session`],
      HUMAN,
    );

    const partner = seededEnv({ seed: 37, now: "2026-08-02T09:00:00Z", tickSeconds: 1 });
    await ok(
      partner, root,
      ["ticket", "resolve", ticket, "--decision", "one retry, 24 hours later, then stop",
        "--rationale",
        "My default: a second immediate retry hits the same decline rule, and a day " +
          "converts often enough to be worth one attempt.",
        "--source", delegation],
      PARTNER,
    );

    // The chain reads "delegated here, answered so, because": the observation's
    // provenance carries the resolution AND the note that authorized it, and
    // the reasoning is in the body where distill cannot reach it.
    const record = await decisionRecord(layout, ticket);
    expect(record.sources).toEqual([
      (await readTicket(layout, ticket)).frontmatter.resolution!,
      delegation,
    ]);
    expect(record.body).toContain("My default");
    const authorization = (await journal(layout)).find((event) => event.id === delegation)!;
    expect(authorization.actor).toEqual({ kind: "human", id: "jim" });
    expect(authorization.payload["ticket"]).toBe(ticket);
    expect(authorization.payload["delegation"]).toBe("use your default recommendations");
    // The resolution itself is the AGENT's — that is the whole point of DD6.
    expect(act(await journal(layout), CORE_EVENT_TYPES.ticketResolved, ticket).actor).toEqual({
      kind: "agent",
      id: "claude-code",
    });
    await validatesClean(root, "delegation store");
  });
});

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { roadmapCommand } from "../../src/commands/roadmap";
import { CORE_EVENT_TYPES } from "../../src/schema/events";
import { generateId, ID_PATTERN } from "../../src/schema/id";
import type { Actor, Config, JournalEvent } from "../../src/schema/records";
import { appendEvent } from "../../src/store/journal";
import { readTicket } from "../../src/store/layout";
import { mutate } from "../../src/store/mutate";
import { validateStore } from "../../src/validate";
import { findingsFor, setupFixture, signConstitution, type ValidateFixture } from "./helpers";

/**
 * Who was allowed to answer a decision ticket (planning-partner F4/DD2, DD6).
 *
 * Both rules live outside the store today: `human_only` is enforced on the
 * COMMAND PATH only (roadmap-ticket.ts refuses resolve/close/clear under an
 * `agent:*` actor), and the grilling-is-HITL rule is stated in `plan.md` and
 * enforced by nothing at all. A store is the durable artefact — so validate
 * reads the JOURNAL, which is the only place recording WHO acted, and reports
 * what the command path would have refused (or what the workflow forbids).
 *
 * The severity split is the difference between the two:
 *
 * - human-only violations are ERRORS. The CLI refuses those three acts
 *   outright, so a store exhibiting one was mutated outside the CLI or through
 *   a bug — either way nothing about it is legitimate.
 * - an agent-resolved grilling ticket is a WARNING. The CLI permits it (only
 *   the workflow forbids it), `delegated`/`agent` governance permits it
 *   outright, and DD6 delegation makes it legitimate even under `human`. The
 *   warning exists so a human browsing validate output SEES that an interview
 *   question was answered by an agent.
 *
 * Fixture discipline: the legitimate cases are built through the REAL CLI —
 * an agent resolving a non-flagged grilling ticket needs no tampering, because
 * the CLI does not refuse it. The human-only violations cannot be built that
 * way (the CLI refuses them), so they are journaled through the store's
 * mutation path directly, the same out-of-CLI mutation wayfinder.test.ts's
 * hand-emptied body simulates.
 */

let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

/** Human product governance — the posture that makes grilling tickets HITL. */
const HUMAN_GOVERNANCE: Partial<Config> = {
  governance: { product: "human", architecture: "human" },
};

async function setup(overrides: Partial<Config> = {}): Promise<ValidateFixture> {
  const fixture = await setupFixture(dirs, overrides);
  await signConstitution(fixture);
  return fixture;
}

/**
 * One `nahel roadmap …` invocation against the fixture's store, returning what
 * it printed. A non-zero exit throws WITH the command's own stderr, so a
 * fixture that stops building says why rather than failing three asserts later.
 */
async function cli(
  fixture: ValidateFixture,
  args: string[],
  actor?: string,
): Promise<string[]> {
  const printed: string[] = [];
  const errors: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    printed.push(parts.join(" "));
  });
  const errSpy = spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    errors.push(parts.join(" "));
  });
  let code: number;
  try {
    code = await roadmapCommand.run(args, fixture.env, fixture.root, actor);
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  if (code !== 0) {
    throw new Error(
      `\`nahel roadmap ${args.join(" ")}\` (actor ${actor ?? "config default"}) exited ${code}:\n` +
        errors.join("\n"),
    );
  }
  return printed;
}

function lastId(printed: string[]): string {
  const id = printed[printed.length - 1]!;
  expect(id).toMatch(ID_PATTERN);
  return id;
}

/** A node and its map, both built through the CLI. */
async function charted(fixture: ValidateFixture): Promise<string> {
  const node = lastId(
    await cli(fixture, [
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
  return lastId(
    await cli(fixture, [
      "map",
      "new",
      "--node",
      node,
      "--destination",
      "a deploy a fresh agent can drive",
    ]),
  );
}

/** One open ticket on the map, built through the CLI. */
async function newTicket(
  fixture: ValidateFixture,
  map: string,
  type: string,
  humanOnly = false,
): Promise<string> {
  return lastId(
    await cli(fixture, [
      "ticket",
      "new",
      "--map",
      map,
      "--type",
      type,
      "--question",
      "which deploy target do we own?",
      ...(humanOnly ? ["--human-only"] : []),
    ]),
  );
}

/**
 * Journal a resolution the way `ticket resolve` does — one sequence event, the
 * ticket record and the decision observation — but UNDER THE GIVEN CONTEXT,
 * below the command layer that would have refused it. This is the tampering:
 * the bytes a rogue writer (or a bug that skipped the refusal) leaves behind.
 */
async function forgeResolution(
  fixture: ValidateFixture,
  context: ValidateFixture["agent"],
  ticketId: string,
  sources: string[] = [],
): Promise<string> {
  const { frontmatter, body } = await readTicket(fixture.layout, ticketId);
  const eventId = generateId(fixture.env);
  const now = fixture.env.now();
  await mutate(context, {
    target: "sequence",
    eventType: CORE_EVENT_TYPES.ticketResolved,
    eventId,
    writes: [
      {
        target: "ticket",
        frontmatter: {
          ...frontmatter,
          state: "resolved",
          decision: "we deploy to fly.io",
          resolution: eventId,
          updated: now,
        },
        body,
      },
      {
        target: "observation",
        frontmatter: {
          id: generateId(fixture.env),
          name: `decision-${ticketId}`,
          created: now,
          tags: ["decision", frontmatter.type],
          sources: [eventId, ...sources],
        },
        body: "we deploy to fly.io\n",
      },
    ],
  });
  return eventId;
}

/** The same forgery for `close`, whose sequence has the identical shape. */
async function forgeClosure(
  fixture: ValidateFixture,
  context: ValidateFixture["agent"],
  ticketId: string,
): Promise<string> {
  const { frontmatter, body } = await readTicket(fixture.layout, ticketId);
  const eventId = generateId(fixture.env);
  const now = fixture.env.now();
  await mutate(context, {
    target: "sequence",
    eventType: CORE_EVENT_TYPES.ticketClosed,
    eventId,
    writes: [
      {
        target: "ticket",
        frontmatter: {
          ...frontmatter,
          state: "closed",
          reason: "another team owns deploys",
          closure: eventId,
          updated: now,
        },
        body,
      },
      {
        target: "observation",
        frontmatter: {
          id: generateId(fixture.env),
          name: `closed-${ticketId}`,
          created: now,
          tags: ["closed", "out-of-scope"],
          sources: [eventId],
        },
        body: "another team owns deploys\n",
      },
    ],
  });
  return eventId;
}

/**
 * One journaled note naming a ticket by the `ticket=<id>` data key — the same
 * linkage DD6's delegation note and the post-hoc ratification both ride on.
 * Only ACTOR and TIMING separate the two readings: cited-and-earlier is the
 * delegation a resolution points at, human-and-later is the ratification.
 */
async function ticketNote(
  fixture: ValidateFixture,
  ticketId: string,
  actor: Actor = { kind: "human", id: "jim" },
  summary = "use your default recommendations on the remaining grilling questions",
): Promise<JournalEvent> {
  return appendEvent(fixture.layout, fixture.env, {
    type: CORE_EVENT_TYPES.note,
    actor,
    payload: { summary, ticket: ticketId },
    session: fixture.agent.session,
  });
}

const BYPASSED = "roadmap.ticket-human-only-bypassed";
const CLEARED = "roadmap.ticket-human-only-cleared";
const SELF_RESOLVED = "roadmap.ticket-grilling-self-resolved";

describe("validate — a human-only ticket answered by an agent (F4/DD2)", () => {
  test("an agent-attributed RESOLUTION of a human-only ticket is an error naming ticket and actor", async () => {
    const fixture = await setup();
    const map = await charted(fixture);
    const ticket = await newTicket(fixture, map, "grilling", true);
    const event = await forgeResolution(fixture, fixture.agent, ticket);

    const findings = findingsFor(await validateStore(fixture.layout), BYPASSED);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain(ticket);
    expect(findings[0]!.message).toContain("agent:claude-code");
    expect(findings[0]!.message).toContain(event);
    expect(findings[0]!.message).toContain("human-only");
    expect(findings[0]!.fix).toBeDefined();
  });

  test("an agent-attributed CLOSE of a human-only ticket is the same error", async () => {
    const fixture = await setup();
    const map = await charted(fixture);
    const ticket = await newTicket(fixture, map, "task", true);
    const event = await forgeClosure(fixture, fixture.agent, ticket);

    const findings = findingsFor(await validateStore(fixture.layout), BYPASSED);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain(ticket);
    expect(findings[0]!.message).toContain(event);
    expect(findings[0]!.message).toContain(CORE_EVENT_TYPES.ticketClosed);
  });

  test("a HUMAN resolving a human-only ticket through the CLI reports nothing", async () => {
    const fixture = await setup();
    const map = await charted(fixture);
    const ticket = await newTicket(fixture, map, "grilling", true);
    await cli(
      fixture,
      ["ticket", "resolve", ticket, "--decision", "we deploy to fly.io"],
      "human:jim",
    );
    expect((await readTicket(fixture.layout, ticket)).frontmatter.state).toBe("resolved");
    expect(findingsFor(await validateStore(fixture.layout), BYPASSED)).toEqual([]);
  });

  test("a HUMAN closing a human-only ticket through the CLI reports nothing", async () => {
    const fixture = await setup();
    const map = await charted(fixture);
    const ticket = await newTicket(fixture, map, "task", true);
    await cli(
      fixture,
      ["ticket", "close", ticket, "--reason", "another team owns deploys", "--out-of-scope"],
      "human:jim",
    );
    expect(findingsFor(await validateStore(fixture.layout), BYPASSED)).toEqual([]);
  });

  test("an agent resolving a ticket that was never human-only reports nothing", async () => {
    const fixture = await setup();
    const map = await charted(fixture);
    const ticket = await newTicket(fixture, map, "task");
    await cli(fixture, ["ticket", "resolve", ticket, "--decision", "we deploy to fly.io"]);
    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, BYPASSED)).toEqual([]);
    expect(findingsFor(findings, CLEARED)).toEqual([]);
  });
});

describe("validate — the human-only flag cleared by an agent (F4/DD2)", () => {
  test("an agent-attributed update dropping the flag is an error naming the clearing event", async () => {
    const fixture = await setup();
    const map = await charted(fixture);
    const ticket = await newTicket(fixture, map, "grilling", true);

    // The forgery: the same record the CLI would write for
    // `update --clear-human-only`, journaled under the agent actor the CLI
    // refuses. The flag going true → absent is what makes it a clearing.
    const { frontmatter, body } = await readTicket(fixture.layout, ticket);
    const { human_only: _cleared, ...rest } = frontmatter;
    await mutate(fixture.agent, {
      target: "ticket",
      eventType: CORE_EVENT_TYPES.ticketUpdated,
      frontmatter: { ...rest, updated: fixture.env.now() },
      body,
    });

    const findings = findingsFor(await validateStore(fixture.layout), CLEARED);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain(ticket);
    expect(findings[0]!.message).toContain("agent:claude-code");
    expect(findings[0]!.fix).toBeDefined();
  });

  test("clear-then-resolve is reported as the clearing, not as a bypass", async () => {
    // The hole DD2's third refusal closes. Once the flag is gone the
    // resolution's own record carries no flag, so the CLEARING is the finding
    // that names what happened — one act, one finding.
    const fixture = await setup();
    const map = await charted(fixture);
    const ticket = await newTicket(fixture, map, "grilling", true);
    const { frontmatter, body } = await readTicket(fixture.layout, ticket);
    const { human_only: _cleared, ...rest } = frontmatter;
    await mutate(fixture.agent, {
      target: "ticket",
      eventType: CORE_EVENT_TYPES.ticketUpdated,
      frontmatter: { ...rest, updated: fixture.env.now() },
      body,
    });
    await cli(fixture, ["ticket", "resolve", ticket, "--decision", "we deploy to fly.io"]);

    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, CLEARED)).toHaveLength(1);
    expect(findingsFor(findings, BYPASSED)).toEqual([]);
  });

  test("a HUMAN clearing the flag through the CLI reports nothing", async () => {
    const fixture = await setup();
    const map = await charted(fixture);
    const ticket = await newTicket(fixture, map, "grilling", true);
    await cli(fixture, ["ticket", "update", ticket, "--clear-human-only"], "human:jim");
    expect((await readTicket(fixture.layout, ticket)).frontmatter.human_only).toBeUndefined();
    expect(findingsFor(await validateStore(fixture.layout), CLEARED)).toEqual([]);
  });

  test("an AGENT SETTING the flag reports nothing — restricting a ticket is always safe", async () => {
    const fixture = await setup();
    const map = await charted(fixture);
    const ticket = await newTicket(fixture, map, "grilling");
    await cli(fixture, ["ticket", "update", ticket, "--human-only"], "agent:codex");
    expect((await readTicket(fixture.layout, ticket)).frontmatter.human_only).toBe(true);
    expect(findingsFor(await validateStore(fixture.layout), CLEARED)).toEqual([]);
  });
});

describe("validate — a grilling ticket the partner answered itself (DD6)", () => {
  test("an agent resolution under human product governance, citing no human source, warns", async () => {
    // Built entirely through the CLI: an agent CAN resolve a non-flagged
    // grilling ticket — only plan.md forbids it — so this store is exactly
    // what an AFK lane ignoring the HITL rule leaves behind.
    const fixture = await setup(HUMAN_GOVERNANCE);
    const map = await charted(fixture);
    const ticket = await newTicket(fixture, map, "grilling");
    await cli(
      fixture,
      ["ticket", "resolve", ticket, "--decision", "we deploy to fly.io"],
      "agent:codex",
    );

    const findings = findingsFor(await validateStore(fixture.layout), SELF_RESOLVED);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.message).toContain(ticket);
    expect(findings[0]!.message).toContain("agent:codex");
    expect(findings[0]!.message).toContain("grilling");
    expect(findings[0]!.fix).toContain("--source");
  });

  test("a DD6-delegated resolution — citing the human's delegation note — does NOT warn", async () => {
    const fixture = await setup(HUMAN_GOVERNANCE);
    const map = await charted(fixture);
    const ticket = await newTicket(fixture, map, "grilling");
    const note = await ticketNote(fixture, ticket);
    await cli(
      fixture,
      [
        "ticket",
        "resolve",
        ticket,
        "--decision",
        "we deploy to fly.io",
        "--rationale",
        "the default recommendation, delegated in session",
        "--source",
        note.id,
      ],
      "agent:codex",
    );

    expect(findingsFor(await validateStore(fixture.layout), SELF_RESOLVED)).toEqual([]);
  });

  test("a resolution citing only an AGENT's own research note still warns", async () => {
    // DD6's chain is what makes a delegation auditable: the note must be the
    // HUMAN's act. An agent's own research note cites nobody's permission.
    const fixture = await setup(HUMAN_GOVERNANCE);
    const map = await charted(fixture);
    const ticket = await newTicket(fixture, map, "grilling");
    const research = await ticketNote(
      fixture,
      ticket,
      { kind: "agent", id: "codex" },
      "two-lens research",
    );
    await cli(
      fixture,
      ["ticket", "resolve", ticket, "--decision", "we deploy to fly.io", "--source", research.id],
      "agent:codex",
    );

    expect(findingsFor(await validateStore(fixture.layout), SELF_RESOLVED)).toHaveLength(1);
  });

  test("under DELEGATED product governance the same store does NOT warn", async () => {
    // The default posture (GOVERNANCE_DEFAULTS.product) and the declared one
    // both: the partner already holds this authority, so there is nothing to
    // surface.
    for (const overrides of [
      {},
      { governance: { product: "delegated", architecture: "human" } } as Partial<Config>,
      { governance: { product: "agent", architecture: "human" } } as Partial<Config>,
    ]) {
      const fixture = await setup(overrides);
      const map = await charted(fixture);
      const ticket = await newTicket(fixture, map, "grilling");
      await cli(
        fixture,
        ["ticket", "resolve", ticket, "--decision", "we deploy to fly.io"],
        "agent:codex",
      );
      expect(findingsFor(await validateStore(fixture.layout), SELF_RESOLVED)).toEqual([]);
    }
  });

  test("a HUMAN resolving a grilling ticket under human governance never warns", async () => {
    const fixture = await setup(HUMAN_GOVERNANCE);
    const map = await charted(fixture);
    const ticket = await newTicket(fixture, map, "grilling");
    await cli(
      fixture,
      ["ticket", "resolve", ticket, "--decision", "we deploy to fly.io"],
      "human:jim",
    );
    expect(findingsFor(await validateStore(fixture.layout), SELF_RESOLVED)).toEqual([]);
  });

  test("non-grilling types agent-resolved under human governance never warn", async () => {
    // The HITL rule is about the INTERVIEW. Research, prototype and task
    // tickets are the AFK lane's whole job (F5).
    const fixture = await setup(HUMAN_GOVERNANCE);
    const map = await charted(fixture);
    for (const type of ["research", "prototype", "task"]) {
      const ticket = await newTicket(fixture, map, type);
      await cli(
        fixture,
        ["ticket", "resolve", ticket, "--decision", `${type} settled`],
        "agent:codex",
      );
    }
    expect(findingsFor(await validateStore(fixture.layout), SELF_RESOLVED)).toEqual([]);
  });

  test("an agent-CLOSED grilling ticket never warns — a close rules the question away, it does not answer it", async () => {
    const fixture = await setup(HUMAN_GOVERNANCE);
    const map = await charted(fixture);
    const ticket = await newTicket(fixture, map, "grilling");
    await cli(
      fixture,
      ["ticket", "close", ticket, "--reason", "the destination moved", "--out-of-scope"],
      "agent:codex",
    );
    expect(findingsFor(await validateStore(fixture.layout), SELF_RESOLVED)).toEqual([]);
  });

  test("a human-only grilling ticket forged open by an agent is the ERROR, not the warning", async () => {
    // One act, one finding: the human-only bypass is the whole story, and a
    // second warning about the same event would be noise.
    const fixture = await setup(HUMAN_GOVERNANCE);
    const map = await charted(fixture);
    const ticket = await newTicket(fixture, map, "grilling", true);
    await forgeResolution(fixture, fixture.agent, ticket);

    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, BYPASSED)).toHaveLength(1);
    expect(findingsFor(findings, SELF_RESOLVED)).toEqual([]);
  });
});

/**
 * The SECOND door out of the grilling warning.
 *
 * DD6's door — the resolution CITES a human-attributed source — is shut the
 * moment the resolution lands: the journal is append-only and a resolved
 * ticket's sources are written once, inside the resolve sequence. So a store
 * where the human ruled verbally and the agent relayed the ruling under its
 * own actor can never buy its way out of the warning, however honest it was.
 * That is not hypothetical: the check's first live run flagged all 16 grill
 * resolutions on nahel's own planning-partner map, every one of them a human's
 * actual ruling.
 *
 * Ratification is the way back: a human, AFTERWARDS, journaling a note that
 * names the ticket — saying on the record that this decision was theirs. Four
 * things make a note ratifying, and each is load-bearing:
 *
 *   - HUMAN-attributed. An agent vouching for its own answer vouches for
 *     nothing, exactly as DD6 refuses an agent's own research note.
 *   - a LOGGED type, the same hand-written-event boundary the plan-since
 *     linkage draws. `nahel log` refuses the self-recorded types, so a
 *     `ticket=` key on one of those is coincidence or forgery.
 *   - naming THAT ticket. One note, one ticket — the linkage convention.
 *   - STRICTLY LATER than the resolution. A note written before the decision
 *     cannot vouch for a decision not yet made; earlier-and-cited is the DD6
 *     path, and earlier-and-uncited is the warning doing its job.
 */
describe("validate — post-hoc human ratification of a self-resolved grilling ticket", () => {
  /** An agent resolving a fresh grilling ticket: the store that warns. */
  async function selfResolved(fixture: ValidateFixture, map: string): Promise<string> {
    const ticket = await newTicket(fixture, map, "grilling");
    await cli(
      fixture,
      ["ticket", "resolve", ticket, "--decision", "we deploy to fly.io"],
      "agent:codex",
    );
    return ticket;
  }

  test("a human note naming the ticket, journaled AFTER the resolution, clears the warning", async () => {
    const fixture = await setup(HUMAN_GOVERNANCE);
    const map = await charted(fixture);
    const ticket = await selfResolved(fixture, map);
    expect(findingsFor(await validateStore(fixture.layout), SELF_RESOLVED)).toHaveLength(1);

    await ticketNote(fixture, ticket, { kind: "human", id: "jim" }, "ratified: fly.io is right");

    expect(findingsFor(await validateStore(fixture.layout), SELF_RESOLVED)).toEqual([]);
  });

  test("the same note journaled BEFORE the resolution ratifies nothing", async () => {
    // Uncited, it is not the DD6 delegation either — and a note that predates
    // the decision cannot vouch for it.
    const fixture = await setup(HUMAN_GOVERNANCE);
    const map = await charted(fixture);
    const ticket = await newTicket(fixture, map, "grilling");
    await ticketNote(fixture, ticket, { kind: "human", id: "jim" }, "thinking out loud");
    await cli(
      fixture,
      ["ticket", "resolve", ticket, "--decision", "we deploy to fly.io"],
      "agent:codex",
    );

    expect(findingsFor(await validateStore(fixture.layout), SELF_RESOLVED)).toHaveLength(1);
  });

  test("an AGENT-attributed note after the resolution ratifies nothing", async () => {
    const fixture = await setup(HUMAN_GOVERNANCE);
    const map = await charted(fixture);
    const ticket = await selfResolved(fixture, map);
    await ticketNote(fixture, ticket, { kind: "agent", id: "codex" }, "ratified: I agree with me");

    expect(findingsFor(await validateStore(fixture.layout), SELF_RESOLVED)).toHaveLength(1);
  });

  test("a human note naming a DIFFERENT ticket ratifies nothing", async () => {
    const fixture = await setup(HUMAN_GOVERNANCE);
    const map = await charted(fixture);
    const resolved = await selfResolved(fixture, map);
    const other = await newTicket(fixture, map, "grilling");
    await ticketNote(fixture, other, { kind: "human", id: "jim" }, "ratified: the other one");

    const findings = findingsFor(await validateStore(fixture.layout), SELF_RESOLVED);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain(resolved);
  });

  test("a note under a SELF-RECORDED event type ratifies nothing, whatever its payload says", async () => {
    // The boundary plan-since draws: `nahel log` refuses the self-recorded
    // types precisely so readers can trust them by TYPE. A ratification an
    // agent could hand-append under a reserved type is no ratification.
    const fixture = await setup(HUMAN_GOVERNANCE);
    const map = await charted(fixture);
    const ticket = await selfResolved(fixture, map);
    await appendEvent(fixture.layout, fixture.env, {
      type: CORE_EVENT_TYPES.ticketUpdated,
      actor: { kind: "human", id: "jim" },
      payload: { ticket, summary: "ratified" },
      session: fixture.agent.session,
    });

    expect(findingsFor(await validateStore(fixture.layout), SELF_RESOLVED)).toHaveLength(1);
  });

  test("one note ratifies ONE ticket — the second flagged ticket stays warned", async () => {
    const fixture = await setup(HUMAN_GOVERNANCE);
    const map = await charted(fixture);
    const first = await selfResolved(fixture, map);
    const second = await selfResolved(fixture, map);
    expect(findingsFor(await validateStore(fixture.layout), SELF_RESOLVED)).toHaveLength(2);

    await ticketNote(fixture, first, { kind: "human", id: "jim" }, "ratified: fly.io is right");

    const findings = findingsFor(await validateStore(fixture.layout), SELF_RESOLVED);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain(second);
    expect(findings[0]!.message).not.toContain(first);
  });

  test("the warning's fix teaches BOTH doors — cite a source, or ratify post-hoc", async () => {
    const fixture = await setup(HUMAN_GOVERNANCE);
    const map = await charted(fixture);
    const ticket = await selfResolved(fixture, map);

    const findings = findingsFor(await validateStore(fixture.layout), SELF_RESOLVED);
    expect(findings).toHaveLength(1);
    const fix = findings[0]!.fix!;
    expect(fix).toContain("--source");
    expect(fix).toContain(`nahel log note --data ticket=${ticket}`);
    expect(fix).toContain("ratif");
  });
});

describe("validate — the new checks are silent on an untouched chart", () => {
  test("a charted map with open tickets under human governance reports none of the three", async () => {
    const fixture = await setup(HUMAN_GOVERNANCE);
    const map = await charted(fixture);
    await newTicket(fixture, map, "grilling");
    await newTicket(fixture, map, "grilling", true);
    await newTicket(fixture, map, "research");

    const findings = await validateStore(fixture.layout);
    for (const check of [BYPASSED, CLEARED, SELF_RESOLVED]) {
      expect(findingsFor(findings, check)).toEqual([]);
    }
  });
});

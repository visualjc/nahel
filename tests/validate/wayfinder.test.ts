import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { CORE_EVENT_TYPES } from "../../src/schema/events";
import { generateId } from "../../src/schema/id";
import type { MapFrontmatter, TicketFrontmatter } from "../../src/schema/records";
import { serializeFrontmatter } from "../../src/store/frontmatter";
import { mapPath, readTicket, ticketPath } from "../../src/store/layout";
import { mutate } from "../../src/store/mutate";
import { validateStore } from "../../src/validate";
import { findingsFor, setupFixture, signConstitution, type ValidateFixture } from "./helpers";

/**
 * Map and decision-ticket integrity (Phase 4 F7). Every fixture is built
 * through the real mutation path; the corruptions a merge or a hand edit really
 * produces are seeded on top.
 *
 * The load-bearing one is the HAND-EMPTIED BODY: emptying a ticket's question
 * with a text editor is exactly the act `distill` exists to replace, and the
 * only thing that tells them apart is whether the journal carries a distill
 * event for it (HC3 — agents mutate through the CLI).
 */

let dirs: string[] = [];

afterEach(async () => {
  dirs = [];
});

async function setup(): Promise<ValidateFixture> {
  const fixture = await setupFixture(dirs);
  await signConstitution(fixture);
  return fixture;
}

async function createNode(fixture: ValidateFixture, name: string): Promise<string> {
  const ts = fixture.env.now();
  const frontmatter = {
    id: generateId(fixture.env),
    name,
    kind: "product" as const,
    horizon: "now" as const,
    adrs: [],
    features: [],
    created: ts,
    updated: ts,
  };
  await mutate(fixture.agent, {
    target: "roadmap-node",
    eventType: CORE_EVENT_TYPES.roadmapNodeCreated,
    frontmatter,
    body: "intent\n",
  });
  return frontmatter.id;
}

async function createMap(
  fixture: ValidateFixture,
  overrides: Partial<MapFrontmatter> & { node: string },
): Promise<MapFrontmatter> {
  const ts = fixture.env.now();
  const frontmatter: MapFrontmatter = {
    id: generateId(fixture.env),
    destination: "somewhere worth going",
    decisions: [],
    fog: [],
    out_of_scope: [],
    created: ts,
    updated: ts,
    ...overrides,
  };
  await mutate(fixture.agent, {
    target: "map",
    eventType: CORE_EVENT_TYPES.mapCreated,
    frontmatter,
    body: "notes\n",
  });
  return frontmatter;
}

async function createTicket(
  fixture: ValidateFixture,
  overrides: Partial<TicketFrontmatter> & { map: string },
  body = "a question?\n",
): Promise<TicketFrontmatter> {
  const ts = fixture.env.now();
  const frontmatter: TicketFrontmatter = {
    id: generateId(fixture.env),
    type: "research",
    state: "open",
    blockers: [],
    created: ts,
    updated: ts,
    ...overrides,
  };
  await mutate(fixture.agent, {
    target: "ticket",
    eventType: CORE_EVENT_TYPES.ticketCreated,
    frontmatter,
    body,
  });
  return frontmatter;
}

/** A node, its map, and one open ticket — the well-formed baseline. */
async function charted(fixture: ValidateFixture) {
  const node = await createNode(fixture, "a-product");
  const map = await createMap(fixture, { node });
  const ticket = await createTicket(fixture, { map: map.id });
  return { node, map, ticket };
}

describe("validate — a well-formed chart reports nothing", () => {
  test("a node, its map, and wired tickets: no wayfinder finding at all", async () => {
    const fixture = await setup();
    const { map, ticket } = await charted(fixture);
    await createTicket(fixture, { map: map.id, blockers: [ticket.id], type: "task" });
    const findings = await validateStore(fixture.layout);
    expect(
      findings.filter((f) => f.check.includes("map") || f.check.includes("ticket")),
    ).toEqual([]);
  });
});

describe("validate — refs the store owns are errors", () => {
  test("a map whose node does not exist is named with both ends", async () => {
    const fixture = await setup();
    await createMap(fixture, { node: "0aaaaaaa" });
    const findings = findingsFor(await validateStore(fixture.layout), "refs.map-node");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain("0aaaaaaa");
  });

  test("a ticket whose map does not exist is named with both ends", async () => {
    const fixture = await setup();
    const ticket = await createTicket(fixture, { map: "0aaaaaaa" });
    const findings = findingsFor(await validateStore(fixture.layout), "refs.ticket-map");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain(ticket.id);
  });

  test("two maps charting one node — what a merge produces — names both", async () => {
    const fixture = await setup();
    const node = await createNode(fixture, "a-product");
    const first = await createMap(fixture, { node });
    const second = await createMap(fixture, { node });
    const findings = findingsFor(await validateStore(fixture.layout), "roadmap.duplicate-map");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain(first.id);
    expect(findings[0]!.message).toContain(second.id);
  });
});

describe("validate — the advisory shapes are warnings", () => {
  test("a blocking edge naming no ticket is a warning, never an error (blocking refuses nothing)", async () => {
    const fixture = await setup();
    const node = await createNode(fixture, "a-product");
    const map = await createMap(fixture, { node });
    const ticket = await createTicket(fixture, { map: map.id, blockers: ["0aaaaaaa"] });
    const findings = findingsFor(
      await validateStore(fixture.layout),
      "roadmap.ticket-blocker-missing",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.message).toContain(ticket.id);
    expect(findings[0]!.message).toContain("0aaaaaaa");
  });

  test("a ticket blocking itself is a warning — a well-formed id link, and an odd shape", async () => {
    const fixture = await setup();
    const node = await createNode(fixture, "a-product");
    const map = await createMap(fixture, { node });
    const ts = fixture.env.now();
    const id = generateId(fixture.env);
    await mutate(fixture.agent, {
      target: "ticket",
      eventType: CORE_EVENT_TYPES.ticketCreated,
      frontmatter: {
        id,
        map: map.id,
        type: "task",
        state: "open",
        blockers: [id],
        created: ts,
        updated: ts,
      },
      body: "?\n",
    });
    const findings = findingsFor(await validateStore(fixture.layout), "roadmap.ticket-shape");
    expect(findings.map((f) => f.severity)).toEqual(["warning"]);
    expect(findings[0]!.message).toContain("own blocker");
  });

  test("claimant and state must agree: claimed needs a holder, and nothing else may carry one", async () => {
    const fixture = await setup();
    const node = await createNode(fixture, "a-product");
    const map = await createMap(fixture, { node });
    const orphanClaim = await createTicket(fixture, {
      map: map.id,
      state: "claimed",
    });
    const strayClaim = await createTicket(fixture, {
      map: map.id,
      state: "resolved",
      decision: "decided",
      claimant: "agent:codex",
    });
    const findings = findingsFor(await validateStore(fixture.layout), "roadmap.ticket-shape");
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.severity === "warning")).toBe(true);
    expect(findings.map((f) => f.message).join("\n")).toContain(orphanClaim.id);
    expect(findings.map((f) => f.message).join("\n")).toContain(strayClaim.id);
  });
});

describe("validate — a ticket body emptied outside the CLI (F7)", () => {
  /** Resolve a ticket the way the CLI does: one sequence event, three records. */
  async function resolve(fixture: ValidateFixture, ticket: TicketFrontmatter, map: MapFrontmatter) {
    const eventId = generateId(fixture.env);
    const now = fixture.env.now();
    await mutate(fixture.agent, {
      target: "sequence",
      eventType: CORE_EVENT_TYPES.ticketResolved,
      eventId,
      writes: [
        {
          target: "ticket",
          frontmatter: {
            ...ticket,
            state: "resolved",
            decision: "we decided",
            resolution: eventId,
            updated: now,
          },
          body: "a question?\n",
        },
        {
          target: "observation",
          frontmatter: {
            id: generateId(fixture.env),
            name: `decision-${ticket.id}`,
            created: now,
            tags: ["decision"],
            sources: [eventId],
          },
          body: "we decided\n",
        },
        {
          target: "map",
          frontmatter: {
            ...map,
            decisions: [{ ticket: ticket.id, decision: "we decided" }],
            updated: now,
          },
          body: "notes\n",
        },
      ],
    });
  }

  test("an empty body with no distill event is reported, naming the verb that owns the act", async () => {
    const fixture = await setup();
    const { map, ticket } = await charted(fixture);
    await resolve(fixture, ticket, map);

    // The hand edit: a text editor empties the question. Nothing else changes.
    const record = await readTicket(fixture.layout, ticket.id);
    await writeFile(
      ticketPath(fixture.layout, ticket.id),
      serializeFrontmatter(record.frontmatter, ""),
    );

    const findings = findingsFor(await validateStore(fixture.layout), "roadmap.ticket-body");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain(ticket.id);
    expect(findings[0]!.fix).toContain("distill");
  });

  test("a body emptied THROUGH the CLI reports nothing", async () => {
    const fixture = await setup();
    const { map, ticket } = await charted(fixture);
    await resolve(fixture, ticket, map);
    const resolvedRecord = await readTicket(fixture.layout, ticket.id);
    await mutate(fixture.agent, {
      target: "ticket",
      eventType: CORE_EVENT_TYPES.ticketDistilled,
      frontmatter: { ...resolvedRecord.frontmatter, updated: fixture.env.now() },
      body: "",
    });
    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, "roadmap.ticket-body")).toEqual([]);
    expect(findingsFor(findings, "journal.divergence")).toEqual([]);
  });
});

describe("validate — a crashed sequence is named, record by record", () => {
  test("the resolve event's un-materialized records are each reported as journal-ahead", async () => {
    const fixture = await setup();
    const { map, ticket } = await charted(fixture);
    // The journal event lands; the map's index line is written by hand-rolling
    // only the ticket record, exactly as a kill between the two writes leaves it.
    const eventId = generateId(fixture.env);
    const now = fixture.env.now();
    const observationId = generateId(fixture.env);
    await mutate(fixture.agent, {
      target: "sequence",
      eventType: CORE_EVENT_TYPES.ticketResolved,
      eventId,
      writes: [
        {
          target: "ticket",
          frontmatter: {
            ...ticket,
            state: "resolved",
            decision: "we decided",
            resolution: eventId,
            updated: now,
          },
          body: "a question?\n",
        },
        {
          target: "observation",
          frontmatter: {
            id: observationId,
            name: `decision-${ticket.id}`,
            created: now,
            tags: ["decision"],
            sources: [eventId],
          },
          body: "we decided\n",
        },
        {
          target: "map",
          frontmatter: {
            ...map,
            decisions: [{ ticket: ticket.id, decision: "we decided" }],
            updated: now,
          },
          body: "notes\n",
        },
      ],
    });
    // Roll the map record back to its pre-resolution state: the crash shape
    // where the third write never happened.
    await writeFile(mapPath(fixture.layout, map.id), serializeFrontmatter(map, "notes\n"));

    const findings = findingsFor(await validateStore(fixture.layout), "journal.divergence");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain(map.id);
    expect(findings[0]!.message).toContain(eventId);
    expect(findings[0]!.fix).toContain("--repair");
  });
});

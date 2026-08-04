import { afterEach, describe, expect, test } from "bun:test";
import { readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CORE_EVENT_TYPES } from "../../src/schema/events";
import { generateId, InvalidIdError } from "../../src/schema/id";
import type {
  MapFrontmatter,
  ObservationFrontmatter,
  RoadmapNodeFrontmatter,
  TicketFrontmatter,
} from "../../src/schema/records";
import { readJournal } from "../../src/store/journal";
import {
  ensureLayout,
  listMaps,
  listTickets,
  mapPath,
  readMap,
  readMaps,
  readObservation,
  readTicket,
  readTickets,
  resolveMap,
  storeLayout,
  ticketPath,
  ticketsForMap,
  writeConfig,
  writeMap,
  writeRoadmapNode,
  writeTicket,
} from "../../src/store/layout";
import { createStoreContext, mutate, replayPending } from "../../src/store/mutate";
import { makeConfig, makeTempDir, seededEnv } from "./helpers";

/**
 * Map and decision-ticket storage and their mutation paths (Phase 4 F7). Both
 * are per-record markdown files in their own directories — the disjoint-file
 * shape items, observations and roadmap nodes already use, so two worktrees
 * charting different parts of a map merge as a directory union (ADR-0012).
 *
 * The load-bearing new shape here is the SEQUENCE mutation: `resolve` writes
 * three records (ticket, observation, map index line) under ONE write-ahead
 * event, so an interruption anywhere between them leaves the journal ahead of
 * the records — the one crash shape replayPending already knows how to heal.
 */

let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

async function setup() {
  const root = await makeTempDir("nahel-wayfinder-store-");
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig());
  const env = seededEnv({ tickSeconds: 1 });
  const ctx = await createStoreContext(root, env);
  return { root, layout, env, ctx };
}

type SeededEnv = ReturnType<typeof seededEnv>;

function makeNode(env: SeededEnv, overrides: Partial<RoadmapNodeFrontmatter> = {}) {
  const ts = env.now();
  return {
    id: generateId(env),
    name: "deployment-devops-workflows",
    kind: "feature",
    horizon: "now",
    adrs: [],
    features: [],
    created: ts,
    updated: ts,
    ...overrides,
  } satisfies RoadmapNodeFrontmatter;
}

function makeMap(env: SeededEnv, node: string, overrides: Partial<MapFrontmatter> = {}) {
  const ts = env.now();
  return {
    id: generateId(env),
    node,
    destination: "a deploy a fresh agent can drive with no tribal knowledge",
    fog: [],
    out_of_scope: [],
    created: ts,
    updated: ts,
    ...overrides,
  } satisfies MapFrontmatter;
}

function makeTicket(env: SeededEnv, map: string, overrides: Partial<TicketFrontmatter> = {}) {
  const ts = env.now();
  return {
    id: generateId(env),
    map,
    type: "research",
    state: "open",
    blockers: [],
    created: ts,
    updated: ts,
    ...overrides,
  } satisfies TicketFrontmatter;
}

describe("map and ticket records on disk (F7)", () => {
  test("maps live at nahel/maps/{id}.md and tickets at nahel/tickets/{id}.md", () => {
    const layout = storeLayout("/repo");
    expect(layout.mapsDir).toBe(join("/repo", "nahel", "maps"));
    expect(layout.ticketsDir).toBe(join("/repo", "nahel", "tickets"));
    expect(mapPath(layout, "kqm3vx7t")).toBe(join("/repo", "nahel", "maps", "kqm3vx7t.md"));
    expect(ticketPath(layout, "kqm3vx7t")).toBe(join("/repo", "nahel", "tickets", "kqm3vx7t.md"));
  });

  test("the path helpers validate the id before any join — a crafted ref never reaches a path", () => {
    const layout = storeLayout("/repo");
    expect(() => mapPath(layout, "../../PRODUCT")).toThrow(InvalidIdError);
    expect(() => ticketPath(layout, "../../PRODUCT")).toThrow(InvalidIdError);
  });

  test("write/read round-trips a map with every section it OWNS populated", async () => {
    const { layout, env } = await setup();
    const node = makeNode(env);
    const map = makeMap(env, node.id, {
      fog: ["how does a rollback get journaled?"],
      out_of_scope: ["no tracker mirrors"],
    });
    await writeMap(layout, map, "notes prose\n");
    const read = await readMap(layout, map.id);
    expect(read.frontmatter).toEqual(map);
    expect(read.body).toBe("notes prose\n");
  });

  test("write/read round-trips a ticket, question in the body", async () => {
    const { layout, env } = await setup();
    const ticket = makeTicket(env, "kqm3vx7t", { state: "claimed", claimant: "agent:codex" });
    await writeTicket(layout, ticket, "which deploy target do we own?\n");
    const read = await readTicket(layout, ticket.id);
    expect(read.frontmatter).toEqual(ticket);
    expect(read.body).toBe("which deploy target do we own?\n");
  });

  test("listMaps / listTickets are sorted, and an ABSENT directory reads as no records", async () => {
    const { layout, env } = await setup();
    // Neither directory exists until the first record lands (the on-demand
    // shape nahel/roadmap/ has — git cannot track an empty directory).
    expect(await listMaps(layout)).toEqual([]);
    expect(await listTickets(layout)).toEqual([]);
    const map = makeMap(env, "9m38trg4");
    const other = makeMap(env, "9m38trg4", { id: "0aaaaaaa" });
    await writeMap(layout, map, "");
    await writeMap(layout, other, "");
    expect(await listMaps(layout)).toEqual([map.id, other.id].sort());
  });

  test("readMaps / readTickets return every record in id order", async () => {
    const { layout, env } = await setup();
    const map = makeMap(env, "9m38trg4");
    await writeMap(layout, map, "");
    const a = makeTicket(env, map.id, { id: "zzzzzzzz" });
    const b = makeTicket(env, map.id, { id: "0aaaaaaa" });
    await writeTicket(layout, a, "a\n");
    await writeTicket(layout, b, "b\n");
    expect((await readMaps(layout)).map((r) => r.frontmatter.id)).toEqual([map.id]);
    expect((await readTickets(layout)).map((r) => r.frontmatter.id)).toEqual([b.id, a.id]);
    expect((await ticketsForMap(layout, map.id)).map((r) => r.frontmatter.id)).toEqual([
      b.id,
      a.id,
    ]);
    expect(await ticketsForMap(layout, "9m38trg4")).toEqual([]);
  });

  test("resolveMap addresses a map by its own id, by its node's id, and by its node's slug", async () => {
    const { layout, env } = await setup();
    const node = makeNode(env);
    await writeRoadmapNode(layout, node, "chart the deploy story\n");
    const map = makeMap(env, node.id);
    await writeMap(layout, map, "");
    for (const ref of [map.id, node.id, node.name]) {
      expect((await resolveMap(layout, ref))?.frontmatter.id).toBe(map.id);
    }
    expect(await resolveMap(layout, "no-such-thing")).toBeNull();
    // A well-formed id naming nothing resolves to nothing, rather than throwing.
    expect(await resolveMap(layout, "0aaaaaaa")).toBeNull();
  });
});

describe("map and ticket mutations ride the write-ahead choke point (F7)", () => {
  test("a map mutation journals the full record first, then writes it", async () => {
    const { layout, env, ctx } = await setup();
    const map = makeMap(env, "9m38trg4");
    const { event } = await mutate(ctx, {
      target: "map",
      eventType: CORE_EVENT_TYPES.mapCreated,
      frontmatter: map,
      body: "notes\n",
    });
    expect(event.type).toBe("roadmap.map-created");
    expect(event.payload).toEqual({ target: "map", record: map, body: "notes\n" });
    // Maps and tickets hang off ROADMAP nodes, never work items: no item ref
    // travels on the event, so no work-item claim can ever cover one.
    expect(event.item).toBeUndefined();
    expect((await readMap(layout, map.id)).frontmatter).toEqual(map);
  });

  test("a ticket mutation journals and writes the same way", async () => {
    const { layout, env, ctx } = await setup();
    const ticket = makeTicket(env, "9m38trg4");
    const { event } = await mutate(ctx, {
      target: "ticket",
      eventType: CORE_EVENT_TYPES.ticketCreated,
      frontmatter: ticket,
      body: "why?\n",
    });
    expect(event.payload).toEqual({ target: "ticket", record: ticket, body: "why?\n" });
    expect((await readTicket(layout, ticket.id)).frontmatter).toEqual(ticket);
  });

  test("a claimed WORK ITEM never freezes a ticket — ticket claim is advisory assignment, not the intervention claim", async () => {
    const { layout, env, ctx } = await setup();
    // The store has a claimed item; the ticket layer is a different tree
    // entirely, so an agent may keep charting through a human's claim.
    const ticket = makeTicket(env, "9m38trg4");
    await mutate(ctx, {
      target: "ticket",
      eventType: CORE_EVENT_TYPES.ticketCreated,
      frontmatter: ticket,
      body: "why?\n",
    });
    expect(ctx.actor.kind).toBe("agent");
    const claimed = { ...ticket, state: "claimed" as const, claimant: "agent:claude-code" };
    await mutate(ctx, {
      target: "ticket",
      eventType: CORE_EVENT_TYPES.ticketClaimed,
      frontmatter: claimed,
      body: "why?\n",
    });
    expect((await readTicket(layout, ticket.id)).frontmatter.claimant).toBe("agent:claude-code");
  });
});

describe("the resolve sequence: one event, two records (F7)", () => {
  /** The two-record resolve sequence, as the command layer composes it. */
  async function resolveSequence(
    ctx: Awaited<ReturnType<typeof setup>>["ctx"],
    env: SeededEnv,
    ticket: TicketFrontmatter,
  ) {
    // The observation cites the resolution event id, and it travels INSIDE
    // that event's payload — so the id is minted before the append.
    const eventId = generateId(env);
    const resolved: TicketFrontmatter = {
      ...ticket,
      state: "resolved",
      decision: "one shim generator",
      resolution: eventId,
      updated: env.now(),
    };
    const observation: ObservationFrontmatter = {
      id: generateId(env),
      name: "decision-one-shim-generator",
      created: env.now(),
      tags: ["decision"],
      sources: [eventId],
    };
    const result = await mutate(ctx, {
      target: "sequence",
      eventType: CORE_EVENT_TYPES.ticketResolved,
      eventId,
      writes: [
        { target: "ticket", frontmatter: resolved, body: "why?\n" },
        { target: "observation", frontmatter: observation, body: "one shim generator\n" },
      ],
    });
    return { eventId, resolved, observation, result };
  }

  async function chartedStore() {
    const { root, layout, env, ctx } = await setup();
    const map = makeMap(env, "9m38trg4");
    await mutate(ctx, {
      target: "map",
      eventType: CORE_EVENT_TYPES.mapCreated,
      frontmatter: map,
      body: "notes\n",
    });
    const ticket = makeTicket(env, map.id);
    await mutate(ctx, {
      target: "ticket",
      eventType: CORE_EVENT_TYPES.ticketCreated,
      frontmatter: ticket,
      body: "why?\n",
    });
    return { root, layout, env, ctx, map, ticket };
  }

  test("the sequence event carries every record, and its id is the one the observation cites", async () => {
    const { layout, env, ctx, map, ticket } = await chartedStore();
    const before = await readMap(layout, map.id);
    const { eventId, resolved, observation, result } = await resolveSequence(ctx, env, ticket);

    expect(result.event.id).toBe(eventId);
    expect(result.event.type).toBe("roadmap.ticket-resolved");
    expect(result.event.payload).toEqual({
      target: "sequence",
      records: [
        { target: "ticket", record: resolved, body: "why?\n" },
        { target: "observation", record: observation, body: "one shim generator\n" },
      ],
    });
    expect(observation.sources).toEqual([result.event.id]);

    // Both records materialized, in the order the sequence lists them — and the
    // map, whose index is derived from the tickets, is untouched.
    expect((await readTicket(layout, ticket.id)).frontmatter).toEqual(resolved);
    expect((await readObservation(layout, observation.id)).frontmatter).toEqual(observation);
    expect(await readMap(layout, map.id)).toEqual(before);
  });

  test("a sequence interrupted at its SECOND record leaves the journal ahead, and replay rolls it forward", async () => {
    const { layout, env, ctx, map, ticket } = await chartedStore();
    // The kill lands between the ticket write and the observation write: the
    // observations directory is replaced by a plain file, so the second record
    // write is the fs op that dies (tests/store/crash-window.test.ts's method).
    await rename(layout.observationsDir, `${layout.observationsDir}.parked`);
    await writeFile(layout.observationsDir, "not a directory");
    let sequence: Awaited<ReturnType<typeof resolveSequence>> | undefined;
    await expect(
      (async () => {
        sequence = await resolveSequence(ctx, env, ticket);
      })(),
    ).rejects.toThrow();
    await rm(layout.observationsDir);
    await rename(`${layout.observationsDir}.parked`, layout.observationsDir);

    // Partial: the ticket landed, the observation did not.
    expect((await readTicket(layout, ticket.id)).frontmatter.state).toBe("resolved");
    expect(await readdir(layout.observationsDir)).toEqual([]);

    const repaired = await replayPending(layout);
    expect(repaired.map((r) => r.target).sort()).toEqual(["observation"]);
    const events = await Array.fromAsync(readJournal(layout));
    const resolution = events.find((e) => e.type === "roadmap.ticket-resolved")!;
    expect(repaired.every((r) => r.eventId === resolution.id)).toBe(true);
    expect((await readdir(layout.observationsDir)).length).toBe(1);

    // Replay never journals: it only makes real what the journal records.
    expect((await Array.fromAsync(readJournal(layout))).length).toBe(events.length);
    // And it is idempotent — a healed store reports nothing to repair.
    expect(await replayPending(layout)).toEqual([]);
    expect(sequence).toBeUndefined();
  });

  test("a sequence interrupted at its FIRST record materializes both from the one event", async () => {
    const { layout, env, ctx, ticket } = await chartedStore();
    await rename(layout.ticketsDir, `${layout.ticketsDir}.parked`);
    await writeFile(layout.ticketsDir, "not a directory");
    await expect(resolveSequence(ctx, env, ticket)).rejects.toThrow();
    await rm(layout.ticketsDir);
    await rename(`${layout.ticketsDir}.parked`, layout.ticketsDir);

    expect((await readTicket(layout, ticket.id)).frontmatter.state).toBe("open");
    const repaired = await replayPending(layout);
    expect(repaired.map((r) => r.target).sort()).toEqual(["observation", "ticket"]);
    expect((await readTicket(layout, ticket.id)).frontmatter.state).toBe("resolved");
    expect(await replayPending(layout)).toEqual([]);
  });

  test("a forged sequence payload under an open-extension type never replays", async () => {
    const { layout, env, ctx, ticket } = await chartedStore();
    const { appendEvent } = await import("../../src/store/journal");
    await appendEvent(layout, env, {
      type: "note",
      actor: ctx.actor,
      session: ctx.session,
      payload: {
        target: "sequence",
        records: [
          {
            target: "ticket",
            record: { ...ticket, state: "resolved", decision: "forged" },
            body: "",
          },
        ],
      },
    });
    expect(await replayPending(layout)).toEqual([]);
    expect((await readTicket(layout, ticket.id)).frontmatter.state).toBe("open");
  });
});

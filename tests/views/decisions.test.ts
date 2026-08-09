import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandContext } from "../../src/cli";
import { logCommand } from "../../src/commands/log";
import { roadmapCommand } from "../../src/commands/roadmap";
import type { Env } from "../../src/schema/env";
import { ID_PATTERN } from "../../src/schema/id";
import { listSegments } from "../../src/store/journal";
import {
  ensureLayout,
  listObservations,
  mapPath,
  observationPath,
  readObservation,
  readTicket,
  roadmapNodePath,
  writeConfig,
  type StoreLayout,
} from "../../src/store/layout";
import { reconstructDecisionRows } from "../../src/views/decisions";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

let dirs: string[] = [];
let logs: string[] = [];
let errors: string[] = [];
let logSpy: { mockRestore(): void };
let errorSpy: { mockRestore(): void };

beforeEach(() => {
  logs = [];
  errors = [];
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.join(" "));
  });
  errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.join(" "));
  });
});

afterEach(async () => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

async function roadmap(env: Env, root: string, args: string[], actor?: string): Promise<string[]> {
  const before = logs.length;
  expect(await roadmapCommand.run(args, env, root, actor)).toBe(0);
  expect(errors).toEqual([]);
  return logs.slice(before);
}

function printedId(output: string[]): string {
  const id = output.at(-1);
  expect(id).toMatch(ID_PATTERN);
  return id!;
}

async function removeEventField(
  layout: StoreLayout,
  eventId: string,
  field: "actor" | "ts",
): Promise<void> {
  const segments = await listSegments(layout);
  const paths = [
    ...segments.active.map((name) => join(layout.journalDir, name)),
    ...segments.archived.map((name) => join(layout.journalArchiveDir, name)),
  ];
  for (const path of paths) {
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    let found = false;
    const rewritten = lines.map((line) => {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.id !== eventId) return line;
      found = true;
      delete event[field];
      return JSON.stringify(event);
    });
    if (found) {
      await writeFile(path, `${rewritten.join("\n")}\n`, "utf8");
      return;
    }
  }
  throw new Error(`event ${eventId} not found`);
}

interface DetachedEvent {
  path: string;
  index: number;
  line: string;
}

async function detachEvent(layout: StoreLayout, eventId: string): Promise<DetachedEvent> {
  const segments = await listSegments(layout);
  const paths = [
    ...segments.active.map((name) => join(layout.journalDir, name)),
    ...segments.archived.map((name) => join(layout.journalArchiveDir, name)),
  ];
  for (const path of paths) {
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    const index = lines.findIndex(
      (line) => (JSON.parse(line) as { id?: string }).id === eventId,
    );
    if (index === -1) continue;
    const [line] = lines.splice(index, 1);
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");
    return { path, index, line: line! };
  }
  throw new Error(`event ${eventId} not found`);
}

async function restoreEvent(detached: DetachedEvent): Promise<void> {
  const lines = (await readFile(detached.path, "utf8")).trimEnd().split("\n");
  lines.splice(detached.index, 0, detached.line);
  await writeFile(detached.path, `${lines.join("\n")}\n`, "utf8");
}

async function setupStore(prefix: string, seed: number) {
  const root = await makeTempDir(prefix);
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig());
  return { root, layout, env: seededEnv({ seed, tickSeconds: 1 }) };
}

async function chart(env: Env, root: string, name: string) {
  const node = printedId(
    await roadmap(env, root, [
      "node",
      "new",
      "feature",
      name,
      "--horizon",
      "now",
      "--intent",
      `Intent for ${name}.`,
    ]),
  );
  const map = printedId(
    await roadmap(env, root, [
      "map",
      "new",
      "--node",
      node,
      "--destination",
      `destination for ${name}`,
    ]),
  );
  return { node, map };
}

async function createTicket(
  env: Env,
  root: string,
  map: string,
  type: "research" | "prototype" | "grilling" | "task",
  label: string,
): Promise<string> {
  return printedId(
    await roadmap(env, root, [
      "ticket",
      "new",
      "--map",
      map,
      "--type",
      type,
      "--question",
      `Question for ${label}?`,
    ]),
  );
}

async function resolveTicket(
  env: Env,
  root: string,
  ticket: string,
  decision: string,
  sources: string[] = [],
): Promise<void> {
  await roadmap(env, root, [
    "ticket",
    "resolve",
    ticket,
    "--decision",
    decision,
    ...sources.flatMap((source) => ["--source", source]),
  ]);
}

async function note(env: Env, root: string, summary: string): Promise<string> {
  const output: string[] = [];
  const ctx: CommandContext = {
    env,
    cwd: root,
    stdout: (text) => output.push(text),
    stderr: (text) => errors.push(text),
  };
  expect(await logCommand.run(["note", "--data", `summary=${summary}`], ctx)).toBe(0);
  const id = /event ([0-9a-z]{8})/.exec(output.join("\n"))?.[1];
  expect(id).toMatch(ID_PATTERN);
  return id!;
}

async function observationIdFor(layout: StoreLayout, ticket: string): Promise<string> {
  for (const id of await listObservations(layout)) {
    if ((await readObservation(layout, id)).frontmatter.name === `decision-${ticket}`) return id;
  }
  throw new Error(`decision observation for ${ticket} not found`);
}

describe("decision-row reconstruction", () => {
  test("reconstructs a healthy resolved ticket through the public read interface", async () => {
    const root = await makeTempDir("nahel-decisions-view-");
    dirs.push(root);
    const layout = await ensureLayout(root);
    await writeConfig(layout, makeConfig());
    const env = seededEnv({ now: "2026-08-08T12:00:00Z", tickSeconds: 1 });

    const node = printedId(
      await roadmap(env, root, [
        "node",
        "new",
        "feature",
        "durable-decisions",
        "--horizon",
        "now",
        "--intent",
        "Keep decisions durable.",
      ]),
    );
    const map = printedId(
      await roadmap(env, root, [
        "map",
        "new",
        "--node",
        node,
        "--destination",
        "a durable decision ledger",
      ]),
    );
    const ticket = printedId(
      await roadmap(env, root, [
        "ticket",
        "new",
        "--map",
        map,
        "--type",
        "research",
        "--question",
        "Which records define a decision row?",
      ]),
    );
    await roadmap(
      env,
      root,
      ["ticket", "resolve", ticket, "--decision", "Use current durable store facts."],
      "human:jim:planning",
    );

    const rows = await reconstructDecisionRows(layout);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.resolutionEventId).toMatch(ID_PATTERN);
    expect(rows[0]?.observationId).toMatch(ID_PATTERN);
    expect(rows[0]).toEqual({
      ticketId: ticket,
      ticketType: "research",
      decision: "Use current durable store facts.",
      mapId: map,
      nodeId: node,
      nodeName: "durable-decisions",
      resolutionEventId: rows[0]?.resolutionEventId,
      resolvedAt: "2026-08-08T12:00:10Z",
      resolutionOrder: {
        ts: "2026-08-08T12:00:10Z",
        seq: 0,
        id: rows[0]?.resolutionEventId,
      },
      resolver: { kind: "human", id: "jim", session: "planning" },
      observationId: rows[0]?.observationId,
      citedSourceEventIds: [],
      sourceEvents: [],
      missingSourceEventIds: [],
      missing: [],
      incomplete: false,
    });
  });

  test("keeps a linked decision incomplete when its resolution actor or time is malformed", async () => {
    for (const field of ["actor", "ts"] as const) {
      const root = await makeTempDir(`nahel-decisions-missing-${field}-`);
      dirs.push(root);
      const layout = await ensureLayout(root);
      await writeConfig(layout, makeConfig());
      const env = seededEnv({ seed: field === "actor" ? 101 : 202, tickSeconds: 1 });
      const node = printedId(
        await roadmap(env, root, [
          "node",
          "new",
          "feature",
          `missing-${field}`,
          "--horizon",
          "now",
          "--intent",
          "Keep incomplete decisions visible.",
        ]),
      );
      const map = printedId(
        await roadmap(env, root, [
          "map",
          "new",
          "--node",
          node,
          "--destination",
          "visible incomplete decisions",
        ]),
      );
      const ticket = printedId(
        await roadmap(env, root, [
          "ticket",
          "new",
          "--map",
          map,
          "--type",
          "task",
          "--question",
          `What if the resolution ${field} is missing?`,
        ]),
      );
      await roadmap(env, root, [
        "ticket",
        "resolve",
        ticket,
        "--decision",
        `Preserve the row without an invented ${field}.`,
      ]);
      const healthy = (await reconstructDecisionRows(layout))[0]!;

      await removeEventField(layout, healthy.resolutionEventId!, field);
      const rows = await reconstructDecisionRows(layout);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        ticketId: ticket,
        decision: `Preserve the row without an invented ${field}.`,
        mapId: map,
        nodeId: node,
        nodeName: `missing-${field}`,
        resolutionEventId: healthy.resolutionEventId,
        missing: ["resolution-event"],
        incomplete: true,
      });
      expect(rows[0]).not.toHaveProperty("resolver");
      expect(rows[0]).not.toHaveProperty("resolvedAt");
      expect(rows[0]).not.toHaveProperty("resolutionOrder");
    }
  });

  test("includes every resolved ticket type across maps and excludes every other state", async () => {
    const { root, layout, env } = await setupStore("nahel-decisions-types-", 303);
    const first = await chart(env, root, "first-feature");
    const second = await chart(env, root, "second-feature");
    const resolved: string[] = [];
    for (const [index, type] of ["research", "prototype", "grilling", "task"].entries()) {
      const ticket = await createTicket(
        env,
        root,
        index % 2 === 0 ? first.map : second.map,
        type as "research" | "prototype" | "grilling" | "task",
        type,
      );
      await resolveTicket(env, root, ticket, `${type} produced a durable decision.`);
      resolved.push(ticket);
    }
    const open = await createTicket(env, root, first.map, "task", "open");
    const claimed = await createTicket(env, root, first.map, "research", "claimed");
    await roadmap(env, root, ["ticket", "claim", claimed]);
    const outOfScope = await createTicket(env, root, first.map, "prototype", "out-of-scope");
    await roadmap(env, root, [
      "ticket",
      "close",
      outOfScope,
      "--out-of-scope",
      "--reason",
      "Outside this delta.",
    ]);
    const invalidated = await createTicket(env, root, second.map, "grilling", "invalidated");
    await roadmap(env, root, [
      "ticket",
      "close",
      invalidated,
      "--invalidated-by",
      resolved[0]!,
      "--reason",
      "The research decision answered it.",
    ]);

    const rows = await reconstructDecisionRows(layout);

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.ticketId).sort()).toEqual([...resolved].sort());
    expect(rows.map((row) => row.ticketType).sort()).toEqual([
      "grilling",
      "prototype",
      "research",
      "task",
    ]);
    for (const excluded of [open, claimed, outOfScope, invalidated]) {
      expect(rows.some((row) => row.ticketId === excluded)).toBe(false);
    }
    expect(new Set(rows.map((row) => row.mapId))).toEqual(new Set([first.map, second.map]));
  });

  test("survives ticket distillation and archived resolution history", async () => {
    const { root, layout, env } = await setupStore("nahel-decisions-durable-", 404);
    const { node, map } = await chart(env, root, "archived-feature");
    const ticket = await createTicket(env, root, map, "prototype", "durability");
    await resolveTicket(env, root, ticket, "Rebuild from the durable graph.");
    const resolution = (await readTicket(layout, ticket)).frontmatter.resolution!;
    await roadmap(env, root, ["ticket", "distill", ticket]);

    expect((await readTicket(layout, ticket)).body).toBe("");
    const archived = await listSegments(layout);
    expect(archived.archived.length).toBeGreaterThan(0);
    expect(archived.active).toEqual([]);
    expect(
      await Promise.all(
        archived.archived.map(async (name) =>
          (await readFile(join(layout.journalArchiveDir, name), "utf8")).includes(resolution),
        ),
      ),
    ).toContain(true);
    expect(await reconstructDecisionRows(layout)).toEqual([
      expect.objectContaining({
        ticketId: ticket,
        decision: "Rebuild from the durable graph.",
        mapId: map,
        nodeId: node,
        nodeName: "archived-feature",
        resolutionEventId: resolution,
        incomplete: false,
      }),
    ]);
  });

  test("preserves proved facts at every missing durable join", async () => {
    for (const boundary of [
      "resolution-event",
      "map",
      "node",
      "observation",
      "source-event",
    ] as const) {
      const { root, layout, env } = await setupStore(
        `nahel-decisions-missing-${boundary}-`,
        500 + boundary.length,
      );
      const { node, map } = await chart(env, root, `boundary-${boundary}`);
      const source = await note(env, root, `Source for ${boundary}.`);
      const ticket = await createTicket(env, root, map, "research", boundary);
      await resolveTicket(env, root, ticket, `Keep ${boundary} failures visible.`, [source]);
      const resolution = (await readTicket(layout, ticket)).frontmatter.resolution!;
      const observation = await observationIdFor(layout, ticket);

      if (boundary === "resolution-event") await detachEvent(layout, resolution);
      if (boundary === "map") await rm(mapPath(layout, map));
      if (boundary === "node") await rm(roadmapNodePath(layout, node));
      if (boundary === "observation") await rm(observationPath(layout, observation));
      if (boundary === "source-event") await detachEvent(layout, source);

      const rows = await reconstructDecisionRows(layout);
      const row = rows[0]!;
      expect(rows).toHaveLength(1);
      expect(row).toMatchObject({
        ticketId: ticket,
        decision: `Keep ${boundary} failures visible.`,
        mapId: map,
        resolutionEventId: resolution,
        missing: [boundary],
        incomplete: true,
      });
      if (boundary === "map") {
        expect(row).not.toHaveProperty("nodeId");
        expect(row).not.toHaveProperty("nodeName");
      } else {
        expect(row.nodeId).toBe(node);
        if (boundary === "node") expect(row).not.toHaveProperty("nodeName");
        else expect(row.nodeName).toBe(`boundary-${boundary}`);
      }
      if (boundary === "resolution-event") {
        expect(row).not.toHaveProperty("resolver");
        expect(row).not.toHaveProperty("resolvedAt");
      }
      if (boundary === "observation") {
        expect(row).not.toHaveProperty("observationId");
        expect(row.citedSourceEventIds).toEqual([]);
      }
      if (boundary === "source-event") {
        expect(row.citedSourceEventIds).toEqual([source]);
        expect(row.sourceEvents).toEqual([]);
        expect(row.missingSourceEventIds).toEqual([source]);
      }
    }
  });

  test("an incomplete row does not hide a healthy row from the same read", async () => {
    const { root, layout, env } = await setupStore("nahel-decisions-mixed-", 606);
    const { map } = await chart(env, root, "mixed-feature");
    const healthyTicket = await createTicket(env, root, map, "research", "healthy");
    const incompleteTicket = await createTicket(env, root, map, "task", "incomplete");
    await resolveTicket(env, root, healthyTicket, "Healthy evidence stays healthy.");
    await resolveTicket(env, root, incompleteTicket, "Incomplete evidence stays visible.");
    await rm(observationPath(layout, await observationIdFor(layout, incompleteTicket)));

    const rows = await reconstructDecisionRows(layout);

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.ticketId === healthyTicket)).toMatchObject({
      missing: [],
      incomplete: false,
    });
    expect(rows.find((row) => row.ticketId === incompleteTicket)).toMatchObject({
      missing: ["observation"],
      incomplete: true,
    });
  });

  test("a repaired join upgrades the same ticket row on the next call without a duplicate", async () => {
    const { root, layout, env } = await setupStore("nahel-decisions-repair-", 707);
    const { node, map } = await chart(env, root, "repair-feature");
    const ticket = await createTicket(env, root, map, "grilling", "repair");
    await resolveTicket(env, root, ticket, "Read current durable state on every call.");
    const resolution = (await readTicket(layout, ticket)).frontmatter.resolution!;
    const detached = await detachEvent(layout, resolution);

    const before = await reconstructDecisionRows(layout);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      ticketId: ticket,
      mapId: map,
      nodeId: node,
      resolutionEventId: resolution,
      missing: ["resolution-event"],
      incomplete: true,
    });
    expect(before[0]).not.toHaveProperty("resolver");

    await restoreEvent(detached);
    const after = await reconstructDecisionRows(layout);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      ticketId: ticket,
      mapId: map,
      nodeId: node,
      resolutionEventId: resolution,
      resolver: { kind: "agent", id: "claude-code" },
      missing: [],
      incomplete: false,
    });
    expect(after[0]?.resolvedAt).toMatch(/^2026-/);
  });
});

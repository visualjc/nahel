import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { roadmapCommand } from "../../src/commands/roadmap";
import type { Env } from "../../src/schema/env";
import { ID_PATTERN } from "../../src/schema/id";
import { listSegments } from "../../src/store/journal";
import { ensureLayout, writeConfig, type StoreLayout } from "../../src/store/layout";
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
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { roadmapCommand } from "../../src/commands/roadmap";
import type { Env } from "../../src/schema/env";
import { ID_PATTERN } from "../../src/schema/id";
import { ensureLayout, writeConfig } from "../../src/store/layout";
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
    expect(rows[0]).toEqual({
      ticketId: ticket,
      ticketType: "research",
      decision: "Use current durable store facts.",
      mapId: map,
      nodeId: node,
      nodeName: "durable-decisions",
      resolutionEventId: expect.stringMatching(ID_PATTERN),
      resolvedAt: "2026-08-08T12:00:03Z",
      resolutionOrder: {
        ts: "2026-08-08T12:00:03Z",
        seq: 0,
        id: expect.stringMatching(ID_PATTERN),
      },
      resolver: { kind: "human", id: "jim", session: "planning" },
      observationId: expect.stringMatching(ID_PATTERN),
      citedSourceEventIds: [],
      sourceEvents: [],
      missingSourceEventIds: [],
      missing: [],
      incomplete: false,
    });
  });
});

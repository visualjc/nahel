import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { ensureLayout, type StoreLayout } from "../../src/store/layout";
import {
  queryDecisionRows,
  type DecisionRow,
} from "../../src/views/decision-query";
import { makeTempDir } from "../store/helpers";

const NOW = "2026-08-08T12:00:00Z";

let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

async function layout(): Promise<StoreLayout> {
  const root = await makeTempDir("nahel-decision-query-");
  dirs.push(root);
  return ensureLayout(root);
}

function datedRow(ticketId: string, resolvedAt: string): DecisionRow {
  return {
    ticketId,
    ticketType: "task",
    decision: `Decision ${ticketId}`,
    mapId: "map00001",
    resolutionEventId: ticketId,
    resolvedAt,
    resolutionOrder: { ts: resolvedAt, seq: 0, id: ticketId },
    resolver: { kind: "agent", id: "codex" },
    citedSourceEventIds: [],
    sourceEvents: [],
    missingSourceEventIds: [],
    missing: [],
    incomplete: false,
    provenance: ["agent"],
  };
}

describe("decision query", () => {
  test("--since accepts relative whole-hour and equivalent ISO UTC windows", async () => {
    const store = await layout();
    const rows = [
      datedRow("ticket01", "2026-08-08T09:59:59Z"),
      datedRow("ticket02", "2026-08-08T10:00:00Z"),
      datedRow("ticket03", "2026-08-08T11:00:00Z"),
    ];

    const relative = await queryDecisionRows(rows, ["--since", "2h"], {
      layout: store,
      now: NOW,
    });
    const absolute = await queryDecisionRows(rows, ["--since", "2026-08-08T10:00:00Z"], {
      layout: store,
      now: NOW,
    });

    expect(relative.map((row) => row.ticketId)).toEqual(["ticket02", "ticket03"]);
    expect(absolute).toEqual(relative);
  });

  test("--by accepts kind selectors and exact kind:id[:session] actors", async () => {
    const store = await layout();
    const human = datedRow("ticket11", "2026-08-08T09:00:00Z");
    human.resolver = { kind: "human", id: "jim", session: "review" };
    human.provenance = ["direct-human"];
    const agent = datedRow("ticket12", "2026-08-08T10:00:00Z");
    const sessionAgent = datedRow("ticket13", "2026-08-08T11:00:00Z");
    sessionAgent.resolver = { kind: "agent", id: "codex", session: "pairing" };
    const rows = [human, agent, sessionAgent];
    const ids = async (selector: string) =>
      (
        await queryDecisionRows(rows, ["--by", selector], {
          layout: store,
          now: NOW,
        })
      ).map((row) => row.ticketId);

    expect(await ids("human")).toEqual(["ticket11"]);
    expect(await ids("agent")).toEqual(["ticket12", "ticket13"]);
    expect(await ids("human:jim:review")).toEqual(["ticket11"]);
    expect(await ids("agent:codex")).toEqual(["ticket12"]);
    expect(await ids("agent:codex:pairing")).toEqual(["ticket13"]);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import {
  ensureLayout,
  writeMap,
  writeRoadmapNode,
  type StoreLayout,
} from "../../src/store/layout";
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

function undatedRow(ticketId: string): DecisionRow {
  const row = datedRow(ticketId, NOW);
  delete row.resolvedAt;
  delete row.resolutionOrder;
  delete row.resolver;
  row.missing = ["resolution-event"];
  row.incomplete = true;
  row.provenance = ["incomplete"];
  return row;
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

  test("--map accepts a map id or its roadmap node id or slug", async () => {
    const store = await layout();
    await writeRoadmapNode(
      store,
      {
        id: "n0de0001",
        name: "first-feature",
        kind: "feature",
        horizon: "now",
        created: NOW,
        updated: NOW,
      },
      "First feature.",
    );
    await writeMap(
      store,
      {
        id: "map00001",
        node: "n0de0001",
        destination: "First destination.",
        fog: [],
        out_of_scope: [],
        created: NOW,
        updated: NOW,
      },
      "",
    );
    const first = datedRow("ticket21", "2026-08-08T10:00:00Z");
    const second = datedRow("ticket22", "2026-08-08T11:00:00Z");
    second.mapId = "map00002";
    const rows = [first, second];
    const ids = async (ref: string) =>
      (
        await queryDecisionRows(rows, ["--map", ref], {
          layout: store,
          now: NOW,
        })
      ).map((row) => row.ticketId);

    expect(await ids("map00001")).toEqual(["ticket21"]);
    expect(await ids("n0de0001")).toEqual(["ticket21"]);
    expect(await ids("first-feature")).toEqual(["ticket21"]);
  });

  test("--provenance matches each of the five settled additive badges", async () => {
    const store = await layout();
    const direct = datedRow("ticket31", "2026-08-08T08:00:00Z");
    direct.provenance = ["direct-human"];
    const delegated = datedRow("ticket32", "2026-08-08T09:00:00Z");
    delegated.provenance = ["delegated", "ratified"];
    const agent = datedRow("ticket33", "2026-08-08T10:00:00Z");
    const incomplete = datedRow("ticket34", "2026-08-08T11:00:00Z");
    incomplete.provenance = ["agent", "incomplete"];
    const rows = [direct, delegated, agent, incomplete];
    const ids = async (badge: string) =>
      (
        await queryDecisionRows(rows, ["--provenance", badge], {
          layout: store,
          now: NOW,
        })
      ).map((row) => row.ticketId);

    expect(await ids("direct-human")).toEqual(["ticket31"]);
    expect(await ids("delegated")).toEqual(["ticket32"]);
    expect(await ids("ratified")).toEqual(["ticket32"]);
    expect(await ids("agent")).toEqual(["ticket33", "ticket34"]);
    expect(await ids("incomplete")).toEqual(["ticket34"]);
  });

  test("--limit keeps the newest positive-N slice and returns it oldest to newest", async () => {
    const store = await layout();
    const rows = [
      datedRow("ticket44", "2026-08-08T11:00:00Z"),
      datedRow("ticket41", "2026-08-08T08:00:00Z"),
      datedRow("ticket43", "2026-08-08T10:00:00Z"),
      datedRow("ticket42", "2026-08-08T09:00:00Z"),
    ];

    const selected = await queryDecisionRows(rows, ["--limit", "2"], {
      layout: store,
      now: NOW,
    });

    expect(selected.map((row) => row.ticketId)).toEqual(["ticket43", "ticket44"]);
  });

  test("defaults to newest 10 for 0, 1, 10, and more than 10 candidates", async () => {
    const store = await layout();
    const rows = Array.from({ length: 12 }, (_, index) =>
      datedRow(
        `tick${String(index).padStart(4, "0")}`,
        `2026-08-08T${String(index).padStart(2, "0")}:00:00Z`,
      ),
    );
    const ids = async (candidates: DecisionRow[]) =>
      (
        await queryDecisionRows(candidates, [], {
          layout: store,
          now: NOW,
        })
      ).map((row) => row.ticketId);

    expect(await ids([])).toEqual([]);
    expect(await ids(rows.slice(0, 1))).toEqual(["tick0000"]);
    expect(await ids(rows.slice(0, 10))).toEqual(rows.slice(0, 10).map((row) => row.ticketId));
    expect(await ids([...rows].reverse())).toEqual(rows.slice(2).map((row) => row.ticketId));
  });

  test("filters intersect while an incomplete undated row remains eligible", async () => {
    const store = await layout();
    await writeRoadmapNode(
      store,
      {
        id: "n0de0002",
        name: "intersection-feature",
        kind: "feature",
        horizon: "now",
        created: NOW,
        updated: NOW,
      },
      "Intersection feature.",
    );
    await writeMap(
      store,
      {
        id: "map00002",
        node: "n0de0002",
        destination: "Intersection destination.",
        fog: [],
        out_of_scope: [],
        created: NOW,
        updated: NOW,
      },
      "",
    );
    const target = undatedRow("ticket51");
    target.mapId = "map00002";
    const wrongMap = undatedRow("ticket52");
    const wrongProvenance = datedRow("ticket53", "2026-08-08T11:00:00Z");
    wrongProvenance.mapId = "map00002";

    const selected = await queryDecisionRows(
      [wrongMap, wrongProvenance, target],
      [
        "--since",
        "2h",
        "--map",
        "intersection-feature",
        "--provenance",
        "incomplete",
        "--limit",
        "1",
      ],
      { layout: store, now: NOW },
    );

    expect(selected.map((row) => row.ticketId)).toEqual(["ticket51"]);
  });

  test("same-time dated rows order by resolution seq then event id", async () => {
    const store = await layout();
    const timestamp = "2026-08-08T11:00:00Z";
    const seqOneHighId = datedRow("aaaaaa01", timestamp);
    seqOneHighId.resolutionOrder = { ts: timestamp, seq: 1, id: "zzzzzz01" };
    const seqZero = datedRow("zzzzzz01", timestamp);
    seqZero.resolutionOrder = { ts: timestamp, seq: 0, id: "zzzzzz02" };
    const seqOneLowId = datedRow("mmmmmm01", timestamp);
    seqOneLowId.resolutionOrder = { ts: timestamp, seq: 1, id: "aaaaaa01" };

    const selected = await queryDecisionRows(
      [seqOneHighId, seqZero, seqOneLowId],
      [],
      { layout: store, now: NOW },
    );

    expect(selected.map((row) => row.ticketId)).toEqual([
      "zzzzzz01",
      "mmmmmm01",
      "aaaaaa01",
    ]);
  });

  test("multiple undated rows follow dated rows, tie by ticket id, and survive the default boundary", async () => {
    const store = await layout();
    const dated = Array.from({ length: 10 }, (_, index) =>
      datedRow(
        `date${String(index).padStart(4, "0")}`,
        `2026-08-08T${String(index).padStart(2, "0")}:00:00Z`,
      ),
    );
    const laterId = undatedRow("zzzzzz02");
    const earlierId = undatedRow("aaaaaa02");

    const selected = await queryDecisionRows(
      [laterId, ...dated, earlierId],
      [],
      { layout: store, now: NOW },
    );

    expect(selected.map((row) => row.ticketId)).toEqual([
      ...dated.slice(2).map((row) => row.ticketId),
      "aaaaaa02",
      "zzzzzz02",
    ]);
  });

  test("filters apply before the default limit", async () => {
    const store = await layout();
    const matching = [
      datedRow("hyman001", "2026-08-07T08:00:00Z"),
      datedRow("hyman002", "2026-08-07T09:00:00Z"),
    ];
    for (const row of matching) {
      row.resolver = { kind: "human", id: "jim" };
      row.provenance = ["direct-human"];
    }
    const newerNonmatching = Array.from({ length: 12 }, (_, index) =>
      datedRow(
        `agn${String(index).padStart(5, "0")}`,
        `2026-08-08T${String(index).padStart(2, "0")}:00:00Z`,
      ),
    );

    const selected = await queryDecisionRows(
      [...newerNonmatching, ...matching],
      ["--by", "human"],
      { layout: store, now: NOW },
    );

    expect(selected.map((row) => row.ticketId)).toEqual(["hyman001", "hyman002"]);
  });
});

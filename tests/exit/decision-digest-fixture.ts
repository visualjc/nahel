import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Env } from "../../src/schema/env";
import { ID_PATTERN } from "../../src/schema/id";
import { listSegments, scanSegments } from "../../src/store/journal";
import {
  listObservations,
  observationPath,
  openStore,
  readObservation,
  readTicket,
  type StoreLayout,
} from "../../src/store/layout";
import { seededEnv } from "../store/helpers";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DriveOptions {
  actor?: string;
  env?: Env;
}

export type DriveNahel = (
  args: string[],
  options?: DriveOptions,
) => Promise<CliResult>;

export interface ChartedDecisionMaps {
  primary: { node: string; map: string; slug: "decision-digest" };
  secondary: { node: string; map: string; slug: "decision-evidence" };
}

export interface ResolvedDecisionSet {
  tickets: string[];
  distilled: string;
}

export interface ProvenanceCases {
  directHuman: string;
  delegated: string;
  ratified: string;
  agent: string;
  incomplete: string;
}

export interface ExcludedClosures {
  outOfScope: string;
  invalidated: string;
}

export interface ArchivedResolution {
  ticket: string;
  resolutionEvent: string;
}

export interface SameTimestampTie {
  timestamp: string;
  seq: number;
  ticketsInOrder: [string, string];
}

export interface IncompleteJoin {
  ticket: string;
  observation: string;
}

function requireOk(result: CliResult, label: string): CliResult {
  if (result.code !== 0 || result.stderr !== "") {
    throw new Error(
      `${label} failed (exit ${result.code})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

function printedId(result: CliResult, label: string): string {
  requireOk(result, label);
  const id = result.stdout.trim().split("\n").at(-1);
  if (id === undefined || !ID_PATTERN.test(id)) {
    throw new Error(`${label} did not print an id: ${JSON.stringify(result.stdout)}`);
  }
  return id;
}

async function roadmapId(
  drive: DriveNahel,
  args: string[],
  label: string,
  options?: DriveOptions,
): Promise<string> {
  return printedId(await drive(["roadmap", ...args], options), label);
}

async function createAndResolve(
  drive: DriveNahel,
  map: string,
  type: "research" | "prototype" | "grilling" | "task",
  question: string,
  decision: string,
  options: DriveOptions = {},
  sources: string[] = [],
): Promise<string> {
  const ticket = await roadmapId(
    drive,
    ["ticket", "new", "--map", map, "--type", type, "--question", question],
    `create ticket: ${question}`,
    options,
  );
  requireOk(
    await drive(
      [
        "roadmap",
        "ticket",
        "resolve",
        ticket,
        "--decision",
        decision,
        ...sources.flatMap((source) => ["--source", source]),
      ],
      options,
    ),
    `resolve ticket ${ticket}`,
  );
  return ticket;
}

async function note(
  drive: DriveNahel,
  summary: string,
  actor: string,
  ticket?: string,
): Promise<string> {
  const result = requireOk(
    await drive(
      [
        "log",
        "note",
        "--data",
        `summary=${summary}`,
        ...(ticket === undefined ? [] : ["--data", `ticket=${ticket}`]),
      ],
      { actor },
    ),
    `log note: ${summary}`,
  );
  const id = /event ([0-9a-z]{8})/.exec(result.stdout)?.[1];
  if (id === undefined) throw new Error(`note did not print an event id: ${result.stdout}`);
  return id;
}

export async function createFreshDecisionStore(
  drive: DriveNahel,
  root: string,
): Promise<StoreLayout> {
  requireOk(await drive(["init"]), "initialize fresh decision store");
  return openStore(root);
}

export async function chartDecisionMaps(
  drive: DriveNahel,
): Promise<ChartedDecisionMaps> {
  const primaryNode = await roadmapId(
    drive,
    [
      "node",
      "new",
      "feature",
      "decision-digest",
      "--horizon",
      "now",
      "--intent",
      "Expose a compact durable decision ledger.",
    ],
    "create primary decision node",
  );
  const primaryMap = await roadmapId(
    drive,
    [
      "map",
      "new",
      "--node",
      primaryNode,
      "--destination",
      "a compact store-wide decision digest",
    ],
    "create primary decision map",
  );
  const secondaryNode = await roadmapId(
    drive,
    [
      "node",
      "new",
      "feature",
      "decision-evidence",
      "--horizon",
      "next",
      "--intent",
      "Keep decision evidence independently zoomable.",
    ],
    "create secondary decision node",
  );
  const secondaryMap = await roadmapId(
    drive,
    [
      "map",
      "new",
      "--node",
      secondaryNode,
      "--destination",
      "durable evidence for every decision row",
    ],
    "create secondary decision map",
  );
  return {
    primary: { node: primaryNode, map: primaryMap, slug: "decision-digest" },
    secondary: { node: secondaryNode, map: secondaryMap, slug: "decision-evidence" },
  };
}

export async function createResolvedDecisionSet(
  drive: DriveNahel,
  maps: ChartedDecisionMaps,
): Promise<ResolvedDecisionSet> {
  const specs: Array<{
    map: string;
    type: "research" | "prototype" | "grilling" | "task";
    question: string;
    decision: string;
  }> = [
    {
      map: maps.primary.map,
      type: "research",
      question: "Which durable records seed the oldest row?",
      decision: "Use ticket identity as the oldest durable row key.",
    },
    {
      map: maps.primary.map,
      type: "prototype",
      question: "How should a second row remain compact?",
      decision: "Keep one-line decisions compact in the ledger.",
    },
    {
      map: maps.primary.map,
      type: "grilling",
      question: "Can archived resolution history remain readable?",
      decision: "Reconstruct archived decisions from durable links.",
    },
    {
      map: maps.primary.map,
      type: "task",
      question: "What belongs just outside the default slice?",
      decision: "Omit the fourth-oldest row from the newest-ten default.",
    },
    {
      map: maps.secondary.map,
      type: "research",
      question: "Which evidence row begins the retained slice?",
      decision: "Begin the retained slice with its oldest surviving row.",
    },
    {
      map: maps.primary.map,
      type: "prototype",
      question: "How do current map titles appear?",
      decision: "Pair current map titles with stable identifiers.",
    },
    {
      map: maps.secondary.map,
      type: "task",
      question: "How are evidence zooms presented?",
      decision: "Print executable ticket, map, and recall zooms.",
    },
  ];
  const tickets: string[] = [];
  for (const spec of specs) {
    tickets.push(
      await createAndResolve(
        drive,
        spec.map,
        spec.type,
        spec.question,
        spec.decision,
        { actor: "agent:codex:baseline" },
      ),
    );
  }
  return { tickets, distilled: tickets[2]! };
}

export async function addProvenanceCases(
  drive: DriveNahel,
  maps: ChartedDecisionMaps,
): Promise<ProvenanceCases> {
  const directHuman = await createAndResolve(
    drive,
    maps.primary.map,
    "research",
    "What should humans discover first in Decision Digest?",
    "Decision Digest remains a compact read-only ledger.",
    { actor: "human:jim:planning" },
  );

  const delegation = await note(
    drive,
    "Delegate the compact widening choice to the agent.",
    "human:jim:planning",
  );
  const delegated = await createAndResolve(
    drive,
    maps.primary.map,
    "grilling",
    "How should delegated widening work?",
    "Widen with explicit time and positive-limit filters.",
    { actor: "agent:codex:delegated" },
    [delegation],
  );

  const ratified = await createAndResolve(
    drive,
    maps.secondary.map,
    "prototype",
    "May the agent propose an evidence layout?",
    "Use one shared footer for executable evidence paths.",
    { actor: "agent:codex:ratified" },
  );
  await note(
    drive,
    "Ratified after reviewing the evidence layout.",
    "human:jim:review",
    ratified,
  );

  const agent = await createAndResolve(
    drive,
    maps.primary.map,
    "task",
    "Which ordinary agent fact needs no human proof?",
    "Show exact agent resolver identity without inference.",
    { actor: "agent:codex:ordinary" },
  );
  const incomplete = await createAndResolve(
    drive,
    maps.secondary.map,
    "task",
    "What survives a temporarily missing observation?",
    "Keep the durable ticket row visible until repair.",
    { actor: "agent:codex:repair" },
  );
  return { directHuman, delegated, ratified, agent, incomplete };
}

export async function addExcludedClosures(
  drive: DriveNahel,
  maps: ChartedDecisionMaps,
  invalidatingTicket: string,
): Promise<ExcludedClosures> {
  const outOfScope = await roadmapId(
    drive,
    [
      "ticket",
      "new",
      "--map",
      maps.primary.map,
      "--type",
      "prototype",
      "--question",
      "Should the digest edit decisions?",
    ],
    "create out-of-scope ticket",
  );
  requireOk(
    await drive([
      "roadmap",
      "ticket",
      "close",
      outOfScope,
      "--out-of-scope",
      "--reason",
      "Decision editing is outside this read-only delta.",
    ]),
    "close out-of-scope ticket",
  );

  const invalidated = await roadmapId(
    drive,
    [
      "ticket",
      "new",
      "--map",
      maps.secondary.map,
      "--type",
      "grilling",
      "--question",
      "Does the digest need a second human-source rule?",
    ],
    "create invalidated ticket",
  );
  requireOk(
    await drive([
      "roadmap",
      "ticket",
      "close",
      invalidated,
      "--invalidated-by",
      invalidatingTicket,
      "--reason",
      "The direct-human resolution already settled it.",
    ]),
    "close invalidated ticket",
  );
  return { outOfScope, invalidated };
}

export async function distillAndLocateArchivedResolution(
  drive: DriveNahel,
  layout: StoreLayout,
  resolved: ResolvedDecisionSet,
): Promise<ArchivedResolution> {
  const ticket = await readTicket(layout, resolved.distilled);
  const resolutionEvent = ticket.frontmatter.resolution;
  if (resolutionEvent === undefined) throw new Error("distill target has no resolution event");
  requireOk(
    await drive(["roadmap", "ticket", "distill", resolved.distilled]),
    "distill resolved ticket",
  );
  const segments = await listSegments(layout);
  const archived = await Promise.all(
    segments.archived.map((name) => readFile(join(layout.journalArchiveDir, name), "utf8")),
  );
  if (!archived.some((body) => body.includes(resolutionEvent))) {
    throw new Error(`resolution event ${resolutionEvent} was not archived`);
  }
  return { ticket: resolved.distilled, resolutionEvent };
}

export async function addSameTimestampTie(
  drive: DriveNahel,
  layout: StoreLayout,
  maps: ChartedDecisionMaps,
): Promise<SameTimestampTie> {
  const timestamp = "2026-08-09T11:30:00Z";
  const tieEnv = seededEnv({ seed: 99_081, now: timestamp, tickSeconds: 0 });
  const first = await createAndResolve(
    drive,
    maps.primary.map,
    "task",
    "Which tied decision sorts first?",
    "Order timestamp ties by canonical event order.",
    { actor: "agent:codex:tie", env: tieEnv },
  );
  const second = await createAndResolve(
    drive,
    maps.secondary.map,
    "research",
    "Which tied decision sorts second?",
    "Keep tied decisions deterministic across maps.",
    { actor: "agent:codex:tie", env: tieEnv },
  );
  const resolutionIds = await Promise.all(
    [first, second].map(async (ticket) => {
      const resolution = (await readTicket(layout, ticket)).frontmatter.resolution;
      if (resolution === undefined) throw new Error(`tie ticket ${ticket} has no resolution`);
      return { ticket, resolution };
    }),
  );
  const events = (await scanSegments(layout)).flatMap((segment) => segment.events);
  const tied = resolutionIds.map(({ ticket, resolution }) => {
    const event = events.find((candidate) => candidate.id === resolution);
    if (event === undefined) throw new Error(`tie resolution ${resolution} not found`);
    return { ticket, event };
  });
  if (tied.some(({ event }) => event.ts !== timestamp)) {
    throw new Error("tie fixture did not produce one shared timestamp");
  }
  tied.sort((left, right) => left.event.seq - right.event.seq || left.event.id.localeCompare(right.event.id));
  return {
    timestamp,
    seq: tied[0]!.event.seq,
    ticketsInOrder: [tied[0]!.ticket, tied[1]!.ticket],
  };
}

export async function introduceIncompleteJoin(
  layout: StoreLayout,
  ticket: string,
): Promise<IncompleteJoin> {
  let observation: string | undefined;
  for (const id of await listObservations(layout)) {
    if ((await readObservation(layout, id)).frontmatter.name === `decision-${ticket}`) {
      observation = id;
      break;
    }
  }
  if (observation === undefined) throw new Error(`decision observation for ${ticket} not found`);
  await rm(observationPath(layout, observation));
  return { ticket, observation };
}

export async function installWorkflowShims(drive: DriveNahel): Promise<void> {
  requireOk(await drive(["install", "--agent", "claude"]), "install workflow shims");
}

export async function repairIncompleteJoin(drive: DriveNahel): Promise<CliResult> {
  return drive(["validate", "--repair"]);
}

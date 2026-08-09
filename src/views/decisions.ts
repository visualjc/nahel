import { CORE_EVENT_TYPES } from "../schema/events";
import type { DecisionTicketType } from "../schema/enums";
import type { Actor, JournalEvent } from "../schema/records";
import { scanSegments } from "../store/journal";
import {
  listObservations,
  readMaps,
  readObservation,
  readRoadmapNodes,
  readTickets,
  type StoreLayout,
} from "../store/layout";

export type DecisionRowMissingJoin =
  | "decision"
  | "resolution-event"
  | "map"
  | "node"
  | "observation"
  | "source-event";

export type DecisionProvenance =
  | "direct-human"
  | "delegated"
  | "ratified"
  | "agent"
  | "incomplete";

export interface DecisionRow {
  ticketId: string;
  ticketType: DecisionTicketType;
  decision?: string;
  mapId: string;
  nodeId?: string;
  nodeName?: string;
  resolutionEventId?: string;
  resolvedAt?: string;
  resolutionOrder?: { ts: string; seq: number; id: string };
  resolver?: Actor;
  observationId?: string;
  citedSourceEventIds: string[];
  sourceEvents: JournalEvent[];
  missingSourceEventIds: string[];
  missing: DecisionRowMissingJoin[];
  incomplete: boolean;
  provenance: DecisionProvenance[];
}

function formatActor(actor: Actor): string {
  const base = `${actor.kind}:${actor.id}`;
  return actor.session === undefined ? base : `${base}:${actor.session}`;
}

/** Render the compact human ledger after selection has fixed its row order. */
export function renderDecisionRows(
  rows: readonly DecisionRow[],
  summary: { matching: number; limit: number } = { matching: rows.length, limit: 10 },
): string {
  const omitted = summary.matching - rows.length;
  const omission = omitted === 0 ? "none omitted" : `${omitted} older omitted`;
  if (rows.length === 0) {
    return [
      `decisions: no decisions matched · limit ${summary.limit} · oldest → newest · ${omission}`,
      "",
      "↳ nahel decisions --help  — filter or widen this ledger",
    ].join("\n");
  }
  const lines = [
    `decisions: ${summary.matching} matching · showing ${rows.length} · limit ${summary.limit} · oldest → newest · ${omission}`,
  ];
  for (const row of rows) {
    const heading = [row.resolvedAt, row.decision].filter((part) => part !== undefined).join("  ");
    const mapIdentity =
      row.nodeName !== undefined
        ? `map ${row.nodeName} (${row.mapId}) · node ${row.nodeId}`
        : row.nodeId !== undefined
          ? `map ${row.mapId} · node ${row.nodeId}`
          : `map ${row.mapId}`;
    const proof = [
      ...(row.resolver === undefined ? [] : [`resolver ${formatActor(row.resolver)}`]),
      ...(row.provenance.length === 0
        ? []
        : [`badges ${row.provenance.map((badge) => `[${badge}]`).join(" ")}`]),
    ];
    lines.push("");
    if (heading !== "") lines.push(heading);
    lines.push(`  ticket ${row.ticketId} · ${mapIdentity}`);
    if (proof.length > 0) lines.push(`  ${proof.join(" · ")}`);
  }
  const zoomRow = rows.find((row) => !row.missing.includes("map")) ?? rows[0]!;
  lines.push(
    "",
    `↳ nahel roadmap ticket show ${zoomRow.ticketId}  — inspect the question and decision`,
    ...(zoomRow.missing.includes("map")
      ? []
      : [`↳ nahel roadmap map show ${zoomRow.mapId}  — inspect the map and nearby decisions`]),
    `↳ nahel recall ${zoomRow.ticketId}  — inspect the decision observation and source events`,
    ...(rows.some((row) => row.incomplete)
      ? ["↳ nahel validate  — inspect or repair incomplete store links"]
      : []),
    "↳ nahel decisions --help  — filter or widen this ledger",
  );
  return lines.join("\n");
}

function resolutionForTicket(
  event: JournalEvent | undefined,
  ticketId: string,
): JournalEvent | undefined {
  if (event?.type !== CORE_EVENT_TYPES.ticketResolved) return undefined;
  const records = event.payload["records"];
  if (event.payload["target"] !== "sequence" || !Array.isArray(records)) return undefined;
  const belongs = records.some((entry) => {
    if (entry === null || typeof entry !== "object") return false;
    const fields = entry as Record<string, unknown>;
    if (fields["target"] !== "ticket") return false;
    const record = fields["record"];
    return (
      record !== null &&
      typeof record === "object" &&
      (record as Record<string, unknown>)["id"] === ticketId
    );
  });
  return belongs ? event : undefined;
}

function observationIdForResolution(
  event: JournalEvent,
  ticketId: string,
): string | undefined {
  const records = event.payload["records"];
  if (!Array.isArray(records)) return undefined;
  const ids = records.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const fields = entry as Record<string, unknown>;
    if (fields["target"] !== "observation") return [];
    const record = fields["record"];
    if (record === null || typeof record !== "object") return [];
    const observation = record as Record<string, unknown>;
    if (observation["name"] !== `decision-${ticketId}`) return [];
    const id = observation["id"];
    return typeof id === "string" ? [id] : [];
  });
  return ids.length === 1 ? ids[0] : undefined;
}

/**
 * Rebuild the decision candidates from current durable store facts. This read
 * has no cache or materialized-row lifecycle: a repaired join is visible on
 * the next call, and the resolved ticket id remains the row identity.
 */
export async function reconstructDecisionRows(layout: StoreLayout): Promise<DecisionRow[]> {
  const tickets = (await readTickets(layout)).filter(
    ({ frontmatter }) => frontmatter.state === "resolved",
  );
  const maps = new Map((await readMaps(layout)).map((record) => [record.frontmatter.id, record]));
  const nodes = new Map(
    (await readRoadmapNodes(layout)).map((record) => [record.frontmatter.id, record]),
  );
  const events = new Map<string, JournalEvent>();
  const ambiguousEventIds = new Set<string>();
  for (const event of (await scanSegments(layout)).flatMap((segment) => segment.events)) {
    if (events.has(event.id) || ambiguousEventIds.has(event.id)) {
      events.delete(event.id);
      ambiguousEventIds.add(event.id);
    } else {
      events.set(event.id, event);
    }
  }
  const observations = await Promise.all(
    (await listObservations(layout)).map((id) => readObservation(layout, id)),
  );
  const observationsById = new Map(
    observations.map((observation) => [observation.frontmatter.id, observation]),
  );

  return tickets.map(({ frontmatter: ticket }) => {
    const map = maps.get(ticket.map);
    const node = map === undefined ? undefined : nodes.get(map.frontmatter.node);
    const resolution =
      ticket.resolution === undefined ? undefined : events.get(ticket.resolution);
    const validResolution = resolutionForTicket(resolution, ticket.id);
    const matchingObservations = observations.filter(
      ({ frontmatter }) =>
        frontmatter.name === `decision-${ticket.id}` &&
        (ticket.resolution === undefined || frontmatter.sources.includes(ticket.resolution)),
    );
    const embeddedObservationId =
      validResolution === undefined
        ? undefined
        : observationIdForResolution(validResolution, ticket.id);
    const embeddedObservation =
      embeddedObservationId === undefined ? undefined : observationsById.get(embeddedObservationId);
    const observation =
      validResolution === undefined
        ? matchingObservations.length === 1
          ? matchingObservations[0]
          : undefined
        : embeddedObservation?.frontmatter.name === `decision-${ticket.id}` &&
            ticket.resolution !== undefined &&
            embeddedObservation.frontmatter.sources.includes(ticket.resolution)
          ? embeddedObservation
          : undefined;
    const citedSourceEventIds =
      observation?.frontmatter.sources.filter((id) => id !== ticket.resolution) ?? [];
    const sourceEvents = citedSourceEventIds.flatMap((id) => {
      const event = events.get(id);
      return event === undefined ? [] : [event];
    });
    const missingSourceEventIds = citedSourceEventIds.filter((id) => !events.has(id));
    const delegated =
      validResolution?.actor.kind === "agent" &&
      sourceEvents.some((event) => event.actor.kind === "human");
    const ratified =
      validResolution !== undefined &&
      [...events.values()].some(
        (event) =>
          event.type === CORE_EVENT_TYPES.note &&
          event.actor.kind === "human" &&
          event.payload["ticket"] === ticket.id &&
          event.ts > validResolution.ts,
      );
    const missing: DecisionRowMissingJoin[] = [];
    if (ticket.decision === undefined) missing.push("decision");
    if (validResolution === undefined) missing.push("resolution-event");
    if (map === undefined) missing.push("map");
    else if (node === undefined) missing.push("node");
    if (observation === undefined) missing.push("observation");
    if (missingSourceEventIds.length > 0) missing.push("source-event");
    const provenance: DecisionProvenance[] = [];
    if (validResolution?.actor.kind === "human") provenance.push("direct-human");
    if (delegated) provenance.push("delegated");
    if (ratified) provenance.push("ratified");
    if (validResolution?.actor.kind === "agent" && !delegated) provenance.push("agent");
    if (missing.length > 0) provenance.push("incomplete");

    return {
      ticketId: ticket.id,
      ticketType: ticket.type,
      ...(ticket.decision === undefined ? {} : { decision: ticket.decision }),
      mapId: ticket.map,
      ...(map === undefined ? {} : { nodeId: map.frontmatter.node }),
      ...(node === undefined ? {} : { nodeName: node.frontmatter.name }),
      ...(ticket.resolution === undefined ? {} : { resolutionEventId: ticket.resolution }),
      ...(validResolution === undefined
        ? {}
        : {
            resolvedAt: validResolution.ts,
            resolutionOrder: {
              ts: validResolution.ts,
              seq: validResolution.seq,
              id: validResolution.id,
            },
            resolver: validResolution.actor,
          }),
      ...(observation === undefined ? {} : { observationId: observation.frontmatter.id }),
      citedSourceEventIds,
      sourceEvents,
      missingSourceEventIds,
      missing,
      incomplete: missing.length > 0,
      provenance,
    };
  });
}

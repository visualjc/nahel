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
  const events = new Map(
    (await scanSegments(layout)).flatMap(({ events }) => events.map((event) => [event.id, event])),
  );
  const observations = await Promise.all(
    (await listObservations(layout)).map((id) => readObservation(layout, id)),
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
    const observation = matchingObservations.length === 1 ? matchingObservations[0] : undefined;
    const citedSourceEventIds =
      observation?.frontmatter.sources.filter((id) => id !== ticket.resolution) ?? [];
    const sourceEvents = citedSourceEventIds.flatMap((id) => {
      const event = events.get(id);
      return event === undefined ? [] : [event];
    });
    const missingSourceEventIds = citedSourceEventIds.filter((id) => !events.has(id));
    const missing: DecisionRowMissingJoin[] = [];
    if (ticket.decision === undefined) missing.push("decision");
    if (validResolution === undefined) missing.push("resolution-event");
    if (map === undefined) missing.push("map");
    else if (node === undefined) missing.push("node");
    if (observation === undefined) missing.push("observation");
    if (missingSourceEventIds.length > 0) missing.push("source-event");

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
    };
  });
}

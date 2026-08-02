import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Env } from "../schema/env";
import { MUTATION_EVENT_TYPES } from "../schema/events";
import {
  documentEditSchema,
  mapFrontmatterSchema,
  observationFrontmatterSchema,
  roadmapNodeFrontmatterSchema,
  runSchema,
  ticketFrontmatterSchema,
  workItemFrontmatterSchema,
  type Actor,
  type DocumentEdit,
  type JournalEvent,
  type MapFrontmatter,
  type ObservationFrontmatter,
  type RoadmapNodeFrontmatter,
  type Run,
  type TicketFrontmatter,
  type WorkItemFrontmatter,
} from "../schema/records";
import { resolveActor } from "./actor";
import { writeFileAtomic } from "./frontmatter";
import {
  appendEvent,
  closeSession,
  latestCandidates,
  listSegments,
  mergeSegments,
  newSessionSegmentId,
  readJournal,
  sessionSegmentPath,
} from "./journal";
import {
  itemExists,
  openStore,
  readConfig,
  readItem,
  readMap,
  readObservation,
  readRoadmapNode,
  readRun,
  readTextFile,
  readTicket,
  removeFile,
  writeItem,
  writeMap,
  writeObservation,
  writeRoadmapNode,
  writeRun,
  writeTicket,
  type StoreLayout,
} from "./layout";
import { rotateJournal } from "./rotate";

/**
 * The mutation choke point (epic architecture decision): EVERY item/run
 * mutation flows through mutate(), which (1) acts as the resolved actor from
 * the injected context, (2) refuses agent mutations on claimed items —
 * including descendants of a claimed ancestor (claim covers the subtree,
 * PRD F9) on both the current and the post-mutation parent chain — moving an
 * item INTO a claimed subtree is refused too, (3) appends the journal event
 * FIRST, carrying the full mutation
 * payload (write-ahead, PRD F1), and (4) applies the record write. The only
 * crash window leaves the journal ahead of the record — never an unjournaled
 * mutation — and replayPending() heals it deterministically from the payload.
 *
 * Claim enforcement here is a cooperative guardrail against
 * cooperating-but-fallible agents; the journal makes any bypass auditable.
 * There is deliberately NO auth machinery (hard constraint 1).
 */

/** An agent mutation hit a claimed item (or a descendant of one). */
export class ClaimViolationError extends Error {}

/** Everything a mutation needs, resolved once at the entry point. */
export interface StoreContext {
  layout: StoreLayout;
  env: Env;
  actor: Actor;
  /** Writer-scoped session segment id for this context's non-run events. */
  session: string;
}

/**
 * Build a store context: resolves the store root by walking up from the
 * directory the command was run in (openStore — the store may be an ancestor
 * of cwd), reads nahel/config, resolves the actor (config entry, overridden by
 * the NAHEL_ACTOR value the entry point read from its environment), and mints
 * the writer-scoped session segment unless the caller carries one across CLI
 * invocations. Everything downstream derives from `layout.root`, so a command
 * run from a subdirectory acts on exactly the store one run from the root does.
 */
export async function createStoreContext(
  cwd: string,
  env: Env,
  options: { actorOverride?: string; session?: string } = {},
): Promise<StoreContext> {
  const layout = await openStore(cwd);
  const config = await readConfig(layout);
  return {
    layout,
    env,
    actor: resolveActor(config.actor, options.actorOverride),
    session: options.session ?? newSessionSegmentId(env),
  };
}

/**
 * End one invocation's store lifecycle: if the context's session segment
 * received events (item mutations land there; run mutations go to the run's
 * own segment, which closes via run end), append the session.closed marker as
 * its final line so rotation can prove it closed, then run the opportunistic
 * archive sweep (PRD F1: rotation enforced by the CLI). The per-invocation
 * session id is otherwise unrecoverable, so an unclosed segment would stay
 * active forever. Called once per SUCCESSFUL command lifecycle — never on
 * error paths, where a close must not mask the original failure; a
 * crash-abandoned segment stays active for validate to report. The segment
 * file exists only if something was appended to it, so existence is the
 * "was this session used" test. session.closed is not a mutation type:
 * replay and validation ignore it as a lifecycle marker.
 */
export async function closeStoreContext(ctx: StoreContext): Promise<void> {
  const used = await stat(sessionSegmentPath(ctx.layout, ctx.session)).then(
    () => true,
    () => false,
  );
  if (used) {
    await closeSession(ctx.layout, ctx.env, ctx.actor, ctx.session);
  }
  await rotateJournal(ctx.layout);
}

/** A state change, as data — the event payload carries all of it. */
export type Mutation =
  | {
      target: "item";
      eventType: string;
      frontmatter: WorkItemFrontmatter;
      body: string;
      /**
       * Extra fields merged into the journal event payload alongside the
       * mutation itself — how item.claimed carries its git baseline and
       * item.handback its evidence (PRD F9) while still flowing write-ahead
       * through this choke point. The reserved replay keys (target, record,
       * body) always win over extras.
       */
      extraPayload?: Record<string, unknown>;
    }
  | { target: "run"; eventType: string; run: Run }
  /**
   * Observation creation (`nahel observe`, PRD F6): journaled write-ahead
   * like every mutation. Observations ref no item or run — provenance lives
   * in the record's `sources` (journal event ids) — so the event lands in
   * the writer's session segment and claims never cover it.
   */
  | {
      target: "observation";
      eventType: string;
      frontmatter: ObservationFrontmatter;
      body: string;
    }
  /**
   * Roadmap node creation and update (`nahel roadmap node`, Phase 4 F1):
   * journaled write-ahead like every mutation. The event carries NO item ref
   * even when the node names an epic — the node→item relationship is stored
   * one way, on the node, so nothing about it reaches the work item (F1's
   * canonical direction). Claims cover work items, never the intent above
   * them, so a claimed epic does not freeze its node.
   */
  | {
      target: "roadmap-node";
      eventType: string;
      frontmatter: RoadmapNodeFrontmatter;
      body: string;
    }
  /**
   * Map and decision-ticket writes (`nahel roadmap map` / `ticket`, Phase 4
   * F7). Like roadmap nodes they carry no item ref: maps and tickets hang off
   * the intent layer, and a work-item claim never covers one — a ticket's own
   * `claim` is advisory assignment, a different word that shares a spelling.
   */
  | { target: "map"; eventType: string; frontmatter: MapFrontmatter; body: string }
  | { target: "ticket"; eventType: string; frontmatter: TicketFrontmatter; body: string }
  /**
   * A MULTI-RECORD sequence under one write-ahead event (F7): `resolve` writes
   * the ticket, the decision observation and the map's index line; `close`
   * writes the ticket and the map's out-of-scope line. One event carrying every
   * record is what makes the sequence recoverable — a process killed between
   * any two of the writes leaves the journal ahead of the records, which is the
   * single crash shape replayPending already heals, rather than a half-applied
   * sequence nothing could complete without inventing state.
   *
   * `eventId` is pre-minted by the caller so a record inside the payload can
   * cite the event carrying it: the resolution's observation sources the
   * resolution event id (F7's acceptance criterion), which cannot be read back
   * from an event that does not exist yet.
   */
  | { target: "sequence"; eventType: string; eventId: string; writes: SequenceWrite[] };

/**
 * One step inside a sequence mutation (see Mutation's `sequence`) — a record
 * write, or a DOCUMENT edit: the file work an act does outside the store's
 * records (Phase 4 F10's PRD move-and-stamp and product design doc line). The
 * steps apply in list order, which is the order the journal event records them
 * in, so "killed after step k" is a state the event fully describes.
 */
export type SequenceWrite =
  | { target: "ticket"; frontmatter: TicketFrontmatter; body: string }
  | { target: "observation"; frontmatter: ObservationFrontmatter; body: string }
  | { target: "map"; frontmatter: MapFrontmatter; body: string }
  | { target: "item"; frontmatter: WorkItemFrontmatter; body: string }
  | { target: "roadmap-node"; frontmatter: RoadmapNodeFrontmatter; body: string }
  | { target: "document"; edit: DocumentEdit };

export interface MutationResult {
  /** The write-ahead journal event recording this mutation. */
  event: JournalEvent;
}

/**
 * Walk one ancestor chain (starting at `startId`, inclusive) looking for a
 * claim. Reads DISK records only, so incoming frontmatter can never drop a
 * claim to slip past the check; a record not on disk cannot carry a claim
 * and ends the walk. `seen` is shared across chains: a node a previous walk
 * passed through without returning is proven claim-free upward.
 */
async function findClaimOnChain(
  layout: StoreLayout,
  startId: string | undefined,
  seen: Set<string>,
): Promise<{ id: string; claimedBy: string } | undefined> {
  let current = startId;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (!(await itemExists(layout, current))) return undefined;
    const { frontmatter } = await readItem(layout, current);
    if (frontmatter.claimed_by !== undefined) {
      return { id: frontmatter.id, claimedBy: frontmatter.claimed_by };
    }
    current = frontmatter.parent;
  }
  return undefined;
}

/**
 * Find the claim covering `itemId`, if any: the item's own claim or the
 * nearest claimed ancestor (claims cover the whole subtree). BOTH parent
 * chains are checked — the one the record has now (its on-disk parent) and
 * the one it will have after the mutation (`incomingParent`) — so an agent
 * can neither mutate anything currently under a claim nor move an item INTO
 * a claimed subtree. For records not yet on disk the incoming parent is the
 * only chain.
 */
async function findCoveringClaim(
  layout: StoreLayout,
  itemId: string,
  incomingParent: string | undefined,
): Promise<{ id: string; claimedBy: string } | undefined> {
  const seen = new Set<string>();
  const current = await findClaimOnChain(layout, itemId, seen);
  if (current !== undefined) return current;
  return findClaimOnChain(layout, incomingParent, seen);
}

/**
 * The payload keys mutationEventFields writes and replay reads: `target` plus
 * either the single-record pair (`record`, `body`) or a sequence's `records`
 * list. Reserved at every non-mutation write seam: `nahel log` refuses --data
 * carrying them at top level, so an observation can never masquerade as a
 * mutation payload.
 */
export const MUTATION_PAYLOAD_KEYS = ["target", "record", "body", "records"] as const;

/**
 * One validated record write — the unit both a single-record mutation and a
 * sequence's steps reduce to, and the unit replay materializes.
 */
interface RecordWrite {
  target: RecordTarget;
  record: { id: string };
  /** Empty for runs, the one record with no markdown body. */
  body: string;
}

/** One applied step of a mutation: a record write, or a document edit (F10). */
type MutationStep = RecordWrite | { target: "document"; edit: DocumentEdit };

/** Every record kind a mutation event can carry. */
export type RecordTarget =
  | "item"
  | "run"
  | "observation"
  | "roadmap-node"
  | "map"
  | "ticket";

/**
 * How one record kind is parsed from a payload, read back from disk, and
 * written. The table below is the ONLY place a target maps to its schema and
 * its store functions, so mutate() and replayPending() cannot drift apart —
 * and a seventh record kind is one entry, not a seventh copy of both loops.
 */
interface RecordKind {
  /** Validate a payload record; throws when it is not this record type. */
  parse(value: unknown): { id: string };
  /** Read the record from disk; throws when it is absent or invalid. */
  read(layout: StoreLayout, id: string): Promise<RecordWrite["record"] & { body?: string }>;
  /** Validate and atomically write it. */
  write(layout: StoreLayout, record: { id: string }, body: string): Promise<void>;
  /** False for runs — a JSON record with no body to compare or replay. */
  hasBody: boolean;
}

const RECORD_KINDS: Record<RecordTarget, RecordKind> = {
  item: {
    parse: (value) => workItemFrontmatterSchema.parse(value),
    read: async (layout, id) => {
      const { frontmatter, body } = await readItem(layout, id);
      return { ...frontmatter, body };
    },
    write: (layout, record, body) => writeItem(layout, record as WorkItemFrontmatter, body),
    hasBody: true,
  },
  run: {
    parse: (value) => runSchema.parse(value),
    read: (layout, id) => readRun(layout, id),
    write: (layout, record) => writeRun(layout, record as Run),
    hasBody: false,
  },
  observation: {
    parse: (value) => observationFrontmatterSchema.parse(value),
    read: async (layout, id) => {
      const { frontmatter, body } = await readObservation(layout, id);
      return { ...frontmatter, body };
    },
    write: (layout, record, body) =>
      writeObservation(layout, record as ObservationFrontmatter, body),
    hasBody: true,
  },
  "roadmap-node": {
    parse: (value) => roadmapNodeFrontmatterSchema.parse(value),
    read: async (layout, id) => {
      const { frontmatter, body } = await readRoadmapNode(layout, id);
      return { ...frontmatter, body };
    },
    write: (layout, record, body) =>
      writeRoadmapNode(layout, record as RoadmapNodeFrontmatter, body),
    hasBody: true,
  },
  map: {
    parse: (value) => mapFrontmatterSchema.parse(value),
    read: async (layout, id) => {
      const { frontmatter, body } = await readMap(layout, id);
      return { ...frontmatter, body };
    },
    write: (layout, record, body) => writeMap(layout, record as MapFrontmatter, body),
    hasBody: true,
  },
  ticket: {
    parse: (value) => ticketFrontmatterSchema.parse(value),
    read: async (layout, id) => {
      const { frontmatter, body } = await readTicket(layout, id);
      return { ...frontmatter, body };
    },
    write: (layout, record, body) => writeTicket(layout, record as TicketFrontmatter, body),
    hasBody: true,
  },
};

/**
 * The order repair reports and applies records in: creation order of the
 * record kinds, ids sorted within each. Fixed rather than derived, so a repair
 * report is byte-identical on every machine.
 */
const REPLAY_ORDER: readonly RecordTarget[] = [
  "item",
  "run",
  "observation",
  "roadmap-node",
  "map",
  "ticket",
];

/** The steps one mutation carries, in the order they are applied. */
function mutationWrites(mutation: Mutation): MutationStep[] {
  if (mutation.target === "run") {
    return [{ target: "run", record: runSchema.parse(mutation.run), body: "" }];
  }
  if (mutation.target === "sequence") {
    return mutation.writes.map((write) =>
      write.target === "document"
        ? { target: "document" as const, edit: documentEditSchema.parse(write.edit) }
        : {
            target: write.target,
            record: RECORD_KINDS[write.target].parse(write.frontmatter),
            body: write.body,
          },
    );
  }
  return [
    {
      target: mutation.target,
      record: RECORD_KINDS[mutation.target].parse(mutation.frontmatter),
      body: mutation.body,
    },
  ];
}

/**
 * The payload one step contributes: the replay triple for a record (minus a
 * run's body), and the edit itself for a document — everything repair needs to
 * finish that step, written down before the step is taken.
 */
function writePayload(write: MutationStep): Record<string, unknown> {
  if (write.target === "document") return { target: "document", ...write.edit };
  return {
    target: write.target,
    record: write.record,
    ...(RECORD_KINDS[write.target].hasBody ? { body: write.body } : {}),
  };
}

function mutationEventFields(
  mutation: Mutation,
  writes: readonly MutationStep[],
): {
  item?: string;
  run?: string;
  payload: Record<string, unknown>;
} {
  if (mutation.target === "item") {
    return {
      item: mutation.frontmatter.id,
      payload: { ...mutation.extraPayload, ...writePayload(writes[0]!) },
    };
  }
  if (mutation.target === "run") {
    return {
      item: mutation.run.item,
      run: mutation.run.id,
      payload: writePayload(writes[0]!),
    };
  }
  if (mutation.target === "sequence") {
    // One event, every record — see Mutation's `sequence`. The list is the
    // apply order, and replay reads it as one pending write per entry.
    return { payload: { target: "sequence", records: writes.map(writePayload) } };
  }
  // Observations, roadmap nodes, maps and tickets carry no item/run refs — an
  // observation's link is its `sources`, a node's is its own `epic` field, and
  // a map or ticket hangs off the intent layer entirely.
  return { payload: writePayload(writes[0]!) };
}

/**
 * Every item a mutation touches, with the parent it will have afterwards — the
 * pairs the claim check walks. A run names the item it belongs to; a sequence
 * contributes one pair per ITEM write it carries, in write order, so the
 * refusal names the first claimed record the act would have touched.
 */
function claimedItemTargets(
  mutation: Mutation,
): { id: string; parent: string | undefined }[] {
  if (mutation.target === "item") {
    return [{ id: mutation.frontmatter.id, parent: mutation.frontmatter.parent }];
  }
  if (mutation.target === "run") return [{ id: mutation.run.item, parent: undefined }];
  if (mutation.target === "sequence") {
    return mutation.writes
      .filter((write) => write.target === "item")
      .map((write) => ({ id: write.frontmatter.id, parent: write.frontmatter.parent }));
  }
  return [];
}

/**
 * Apply one mutation: validate → claim check → write-ahead journal event →
 * record write(s). Refusals and validation failures write nothing at all.
 */
export async function mutate(ctx: StoreContext, mutation: Mutation): Promise<MutationResult> {
  // Validate every incoming record before anything touches disk.
  const writes = mutationWrites(mutation);

  // Claim enforcement: agents may not mutate a claimed item or anything in a
  // claimed subtree. Humans pass — the claim is theirs. Observations, roadmap
  // nodes, maps and tickets touch no item, so no claim can cover them — but a
  // SEQUENCE that writes items (F10's archival moves their `prd` paths) is an
  // item mutation like any other, and is checked write by write: a claim that
  // one act could step around is not a guardrail.
  if (ctx.actor.kind === "agent") {
    for (const { id, parent } of claimedItemTargets(mutation)) {
      const claim = await findCoveringClaim(ctx.layout, id, parent);
      if (claim !== undefined) {
        const via = claim.id === id ? "" : ` via claimed ancestor ${claim.id}`;
        throw new ClaimViolationError(
          `refusing agent mutation: item ${id} is covered by a claim${via} (claimed_by ${claim.claimedBy}) — ` +
            `a human must \`nahel handback ${claim.id}\` first`,
        );
      }
    }
  }

  // Write-ahead: the journal event carries the full mutation and lands first.
  const fields = mutationEventFields(mutation, writes);
  const event = await appendEvent(ctx.layout, ctx.env, {
    type: mutation.eventType,
    actor: ctx.actor,
    ...(mutation.target === "sequence" ? { id: mutation.eventId } : {}),
    ...(fields.item === undefined ? {} : { item: fields.item }),
    ...(fields.run === undefined ? { session: ctx.session } : { run: fields.run }),
    payload: fields.payload,
  });

  // Then the writes, in the sequence's order. If any dies, the journal is
  // ahead — replayPending materializes exactly what the event already records
  // for the RECORDS, replayDocuments for the documents, whichever had landed.
  for (const write of writes) {
    if (write.target === "document") {
      // A document step that cannot be applied FAILS the mutation, exactly as
      // a failed record write does: the journal already records what should
      // have happened, so the honest outcome is a loud error over a store the
      // journal is ahead of — never a success reporting a file nobody touched.
      if ((await applyDocumentEdit(ctx.layout, write.edit)) === "unrepairable") {
        throw new Error(
          `document ${documentPath(write.edit)} could not be written, and event ${event.id} already ` +
            "records that it should be — `nahel validate` names the pending state and " +
            "`nahel validate --repair` completes it once the document is there",
        );
      }
    } else {
      await RECORD_KINDS[write.target].write(ctx.layout, write.record, write.body);
    }
  }
  return { event };
}

/** The path a document step writes — its destination, or its append target. */
function documentPath(edit: DocumentEdit): string {
  return edit.op === "move" ? edit.to : edit.path;
}

/** What applying a document edit did — repair reports only what it changed. */
type DocumentOutcome = "applied" | "already" | "unrepairable";

/**
 * Prepend the archival stamp to a document, BELOW its frontmatter when it has
 * some (the frontmatter must stay the first thing in the file for every reader
 * that parses it) and at the very top when it does not. Already-stamped text
 * comes back untouched, which is what makes "stamped once, not twice" hold
 * however many times repair or the verb passes over the same document.
 */
function stampDocument(text: string, header: string): string {
  if (text.includes(header)) return text;
  const block = header.endsWith("\n") ? header : `${header}\n`;
  if (text.startsWith("---\n")) {
    const close = text.indexOf("\n---\n", 3);
    if (close !== -1) {
      const cut = close + 5;
      return `${text.slice(0, cut)}\n${block}${text.slice(cut)}`;
    }
  }
  return `${block}\n${text}`;
}

/** Append one line, keeping a blank line between it and what came before. */
function appendLine(text: string, line: string): string {
  if (text === "" || text.endsWith("\n\n")) return `${text}${line}\n`;
  return `${text}${text.endsWith("\n") ? "\n" : "\n\n"}${line}\n`;
}

/**
 * Apply one document step (F10). Both ops converge rather than assume: they
 * read what is on disk first, so applying an edit that already landed changes
 * nothing and returns `already`. That is the whole recovery story for the file
 * work — repair simply applies every document step the journal records, and
 * the ones the original act completed are no-ops.
 *
 * A `move` writes the destination BEFORE unlinking the source, so no kill can
 * leave the document at neither location: the reachable partial state is the
 * document at BOTH, and the next pass removes the source. `unrepairable` means
 * the source is gone and the destination was never written (a hand deletion —
 * `validate` names it), or an `append` target that does not exist; nothing is
 * invented in either case.
 *
 * "The destination already exists" is NOT the same fact as "this move already
 * happened", and conflating them deletes documents: a PRD basename is not
 * unique across time, so a successor feature reusing the name its predecessor
 * shipped under points at an archive slot another act filled. The move is
 * therefore judged COMPLETE only when the destination carries THIS event's
 * stamp — the header names the archival event id, so the test is exact — and
 * an occupied-by-someone-else destination is `unrepairable`, with the source
 * left exactly where it is.
 */
async function applyDocumentEdit(
  layout: StoreLayout,
  edit: DocumentEdit,
): Promise<DocumentOutcome> {
  if (edit.op === "move") {
    const to = join(layout.root, edit.to);
    const from = join(layout.root, edit.from);
    const landed = await readTextFile(to);
    if (landed !== null && !landed.includes(edit.header)) return "unrepairable";
    if (landed === null) {
      const source = await readTextFile(from);
      if (source === null) return "unrepairable";
      await writeFileAtomic(to, stampDocument(source, edit.header));
    }
    const sourceRemains = (await readTextFile(from)) !== null;
    if (sourceRemains) await removeFile(from);
    return landed === null || sourceRemains ? "applied" : "already";
  }
  const path = join(layout.root, edit.path);
  const text = await readTextFile(path);
  if (text === null) return "unrepairable";
  if (text.includes(edit.marker)) return "already";
  await writeFileAtomic(path, appendLine(text, edit.line));
  return "applied";
}

/**
 * The document steps one journal event carries: the edits that parsed, and the
 * reason each one that did not. PURE — no I/O — so `validate`'s checks read the
 * payload through the same function repair applies it through, and the two can
 * never disagree about what an event says the filesystem should hold.
 */
export function eventDocuments(event: JournalEvent): {
  edits: DocumentEdit[];
  invalid: string[];
} {
  const edits: DocumentEdit[] = [];
  const invalid: string[] = [];
  if (!MUTATION_EVENT_TYPES.has(event.type)) return { edits, invalid };
  const records = event.payload["records"];
  if (event.payload["target"] !== "sequence" || !Array.isArray(records)) return { edits, invalid };
  for (const entry of records) {
    if (entry === null || typeof entry !== "object") continue;
    const payload = entry as Record<string, unknown>;
    if (payload["target"] !== "document") continue;
    const { target: _target, ...edit } = payload;
    // An unparseable edit is reported, never guessed at: repair only makes
    // real what the journal actually states.
    const parsed = documentEditSchema.safeParse(edit);
    if (parsed.success) edits.push(parsed.data);
    else invalid.push(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  return { edits, invalid };
}

/**
 * The document half of `validate --repair` (F10): roll every journaled document
 * step forward. The record half is replayPending; this one exists separately
 * because a document is not a record — it has no id, no schema and no
 * "behind its latest event" comparison, only the edit's own convergence rule.
 *
 * Events are walked in the journal's total order, and each step is idempotent,
 * so a store where nothing crashed repairs to itself and reports nothing.
 */
export async function replayDocuments(layout: StoreLayout): Promise<RepairedRecord[]> {
  const repaired: RepairedRecord[] = [];
  for await (const event of readJournal(layout)) {
    for (const edit of eventDocuments(event).edits) {
      // `unrepairable` is not an error here: repair completes what it can and
      // leaves what it cannot to `validate`, which names it rather than
      // inventing a document (a lost PRD, an occupied archive slot, a design
      // doc that is not on disk).
      if ((await applyDocumentEdit(layout, edit)) === "applied") {
        repaired.push({ target: "document", id: documentPath(edit), eventId: event.id });
      }
    }
  }
  return repaired;
}

/** One record materialized by replayPending, or document by replayDocuments. */
export interface RepairedRecord {
  target: RecordTarget | "document";
  /** The record's id, or — for a document — the repo-relative path written. */
  id: string;
  /** The mutation event whose payload was replayed. */
  eventId: string;
}

/** One record write a mutation event records, with the event that carries it. */
interface PendingWrite extends RecordWrite {
  event: JournalEvent;
}

/**
 * The record writes one journal event carries, or [] when it is not a
 * mutation. Mutations are identified by event TYPE (the choke point's core
 * mutation types), never by payload shape — a mutation-shaped payload under
 * `note` or any open extension type (a forged `nahel log`, a rogue writer) is
 * inert data, not a replayable mutation.
 */
function eventWrites(event: JournalEvent): PendingWrite[] {
  if (!MUTATION_EVENT_TYPES.has(event.type)) return [];
  const entries =
    event.payload["target"] === "sequence"
      ? Array.isArray(event.payload["records"])
        ? (event.payload["records"] as unknown[])
        : []
      : [event.payload];
  const writes: PendingWrite[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const payload = entry as Record<string, unknown>;
    const target = payload["target"];
    if (typeof target !== "string" || !(target in RECORD_KINDS)) continue;
    if (payload["record"] === undefined) continue;
    const kind = RECORD_KINDS[target as RecordTarget];
    const record = kind.parse(payload["record"]);
    const body = payload["body"];
    if (kind.hasBody && typeof body !== "string") {
      throw new Error(
        `mutation event ${event.id} has a ${target} payload without a string body — cannot replay`,
      );
    }
    writes.push({
      event,
      target: target as RecordTarget,
      record,
      body: typeof body === "string" ? body : "",
    });
  }
  return writes;
}

/**
 * Detect records behind their latest mutation event (the write-ahead crash
 * window) and materialize them deterministically from the event payloads.
 * Never journals anything itself — it only makes real what the journal
 * already records. Consumed by `validate --repair` (PRD F8).
 *
 * A multi-record sequence event (F7's `resolve` and `close`) contributes one
 * pending write per record, so a sequence interrupted between any two of its
 * writes is healed by the same rule as a single record: whatever the event
 * records and disk does not carry gets written.
 *
 * "Latest" is segment-aware: within a segment seq is causal, so each
 * segment's LAST mutation event per record supersedes its earlier ones;
 * across segments, a same-second tie between finalists is genuinely
 * ambiguous (per-invocation session segments, second-precision timestamps —
 * see latestCandidates), so a record matching ANY max-ts finalist is in
 * sync. Only a record matching none is repaired — to the total-order-latest
 * candidate, identical on every machine.
 */
export async function replayPending(layout: StoreLayout): Promise<RepairedRecord[]> {
  // Keyed by target and id: two record kinds may legitimately share an id
  // space, and the sequence writes of one event span several kinds.
  const finalists = new Map<string, PendingWrite[]>();

  const segments = await listSegments(layout);
  const paths = [
    ...segments.active.map((name) => join(layout.journalDir, name)),
    ...segments.archived.map((name) => join(layout.journalArchiveDir, name)),
  ];
  for (const path of paths) {
    // Per segment, append order is causal order: later overwrites earlier.
    const latest = new Map<string, PendingWrite>();
    for await (const event of mergeSegments([path])) {
      for (const write of eventWrites(event)) {
        latest.set(`${write.target}:${write.record.id}`, write);
      }
    }
    for (const [key, pending] of latest) {
      finalists.set(key, [...(finalists.get(key) ?? []), pending]);
    }
  }

  const repaired: RepairedRecord[] = [];
  for (const target of REPLAY_ORDER) {
    const kind = RECORD_KINDS[target];
    const keys = [...finalists.keys()]
      .filter((key) => key.startsWith(`${target}:`))
      .sort();
    for (const key of keys) {
      const id = key.slice(target.length + 1);
      // An unreadable or schema-invalid current record is simply out of sync:
      // the journal holds the truth, so repair restores it rather than choking
      // on the corruption.
      let current: (RecordWrite["record"] & { body?: string }) | undefined;
      try {
        current = await kind.read(layout, id);
      } catch {
        current = undefined;
      }
      const candidates = latestCandidates(finalists.get(key)!);
      const inSync =
        current !== undefined &&
        candidates.some((candidate) => sameRecord(kind, current!, candidate));
      if (!inSync) {
        const pending = candidates[candidates.length - 1]!;
        await kind.write(layout, pending.record, pending.body);
        repaired.push({ target, id, eventId: pending.event.id });
      }
    }
  }
  return repaired;
}

/** True when the record on disk already carries what the event records. */
function sameRecord(
  kind: RecordKind,
  current: RecordWrite["record"] & { body?: string },
  candidate: RecordWrite,
): boolean {
  if (!kind.hasBody) return JSON.stringify(current) === JSON.stringify(candidate.record);
  const { body, ...frontmatter } = current;
  return JSON.stringify(frontmatter) === JSON.stringify(candidate.record) && body === candidate.body;
}

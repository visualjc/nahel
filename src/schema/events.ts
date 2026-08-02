/**
 * Core journal event types. Mutations are write-ahead-journaled (PRD F1), so
 * every CLI mutation verb has a corresponding event type here; intervention
 * ops (pause/claim/handback) journal under their glossary names. The set is
 * open: the journal event schema accepts any non-empty type string, so
 * workflows can log new event types without a code change (PRD F4).
 */
export const CORE_EVENT_TYPES = {
  itemCreated: "item.created",
  itemUpdated: "item.updated",
  runStarted: "run.started",
  runUpdated: "run.updated",
  runEnded: "run.ended",
  runPaused: "run.paused",
  itemClaimed: "item.claimed",
  itemHandback: "item.handback",
  observationCreated: "observation.created",
  roadmapNodeCreated: "roadmap.node-created",
  roadmapNodeUpdated: "roadmap.node-updated",
  mapCreated: "roadmap.map-created",
  mapUpdated: "roadmap.map-updated",
  ticketCreated: "roadmap.ticket-created",
  ticketUpdated: "roadmap.ticket-updated",
  ticketClaimed: "roadmap.ticket-claimed",
  ticketReleased: "roadmap.ticket-released",
  ticketResolved: "roadmap.ticket-resolved",
  ticketClosed: "roadmap.ticket-closed",
  ticketDistilled: "roadmap.ticket-distilled",
  note: "note",
} as const;

export type CoreEventType = (typeof CORE_EVENT_TYPES)[keyof typeof CORE_EVENT_TYPES];

/**
 * The config-replacement event (`nahel config set`, PRD F4). Deliberately
 * NOT a core mutation type — it replaces a `nahel/config` section, not a
 * record mutate() replays — but named here because more than one layer keys
 * on it: `config set` writes it, and the merge-authority provenance check
 * (PRD F3.4) reads it to prove WHO flipped `merge: on-approve`. Payload:
 * `{section, value}`.
 */
export const CONFIG_UPDATED_EVENT_TYPE = "config.updated";

/**
 * The mutation subset of the core types: exactly the events the store's
 * mutate() choke point write-ahead journals (item and run record changes).
 * Replay and validation key mutation detection on membership HERE — payload
 * shape (target/record/body) is a validity check WITHIN these types, never
 * the trigger — so a mutation-shaped payload under `note` or any open
 * extension type is inert data, not a replayable mutation. `nahel log`
 * refuses these types outright: mutations self-record through mutate().
 */
export const MUTATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  CORE_EVENT_TYPES.itemCreated,
  CORE_EVENT_TYPES.itemUpdated,
  CORE_EVENT_TYPES.itemClaimed,
  CORE_EVENT_TYPES.itemHandback,
  CORE_EVENT_TYPES.runStarted,
  CORE_EVENT_TYPES.runUpdated,
  CORE_EVENT_TYPES.runEnded,
  CORE_EVENT_TYPES.runPaused,
  CORE_EVENT_TYPES.observationCreated,
  CORE_EVENT_TYPES.roadmapNodeCreated,
  CORE_EVENT_TYPES.roadmapNodeUpdated,
  CORE_EVENT_TYPES.mapCreated,
  CORE_EVENT_TYPES.mapUpdated,
  CORE_EVENT_TYPES.ticketCreated,
  CORE_EVENT_TYPES.ticketUpdated,
  CORE_EVENT_TYPES.ticketClaimed,
  CORE_EVENT_TYPES.ticketReleased,
  CORE_EVENT_TYPES.ticketResolved,
  CORE_EVENT_TYPES.ticketClosed,
  CORE_EVENT_TYPES.ticketDistilled,
]);

/**
 * The wayfinder mutation types (F7), each named by the verb that writes it —
 * the PRD's transition table, one row per entry. Three of them are MULTI-RECORD
 * sequences: `resolve` writes the ticket, the decision observation and the
 * map's index line under one event, and `close` writes the ticket and the map's
 * out-of-scope line, so an interruption anywhere in the sequence leaves the
 * journal ahead of the records — the one crash shape replay already heals.
 */
export const WAYFINDER_EVENT_TYPES: ReadonlyMap<string, string> = new Map([
  [CORE_EVENT_TYPES.mapCreated, "`nahel roadmap map new`"],
  [CORE_EVENT_TYPES.mapUpdated, "`nahel roadmap map update`"],
  [CORE_EVENT_TYPES.ticketCreated, "`nahel roadmap ticket new`"],
  [CORE_EVENT_TYPES.ticketUpdated, "`nahel roadmap ticket update`"],
  [CORE_EVENT_TYPES.ticketClaimed, "`nahel roadmap ticket claim`"],
  [CORE_EVENT_TYPES.ticketReleased, "`nahel roadmap ticket release`"],
  [CORE_EVENT_TYPES.ticketResolved, "`nahel roadmap ticket resolve`"],
  [CORE_EVENT_TYPES.ticketClosed, "`nahel roadmap ticket close`"],
  [CORE_EVENT_TYPES.ticketDistilled, "`nahel roadmap ticket distill`"],
]);

/**
 * `nahel roadmap ack` (Phase 4 F5): the human saying "seen" about the roadmap.
 * Deliberately NOT a core mutation type — it changes no record, which is the
 * whole point of the verb — but reserved all the same, because the
 * awaiting-your-eyes surface reads it by TYPE to decide whether agent-authored
 * roadmap acts have been looked at, exactly as merge authority reads
 * `config.updated` to decide who authorized auto-merge. Payload: `{}`.
 */
export const ROADMAP_ACKED_EVENT_TYPE = "roadmap.acked";

/** The dispatch bracket: intent (carrying the composed invocation) and outcome. */
export const DISPATCH_STARTED_EVENT_TYPE = "dispatch.started";
export const DISPATCH_ENDED_EVENT_TYPE = "dispatch.ended";

/** One-per-invocation summary of what the import did (the config.updated precedent). */
export const IMPORT_COMPLETED_EVENT_TYPE = "import.completed";
/** A per-anomaly note: unmappable status, github-mapping mismatch, dropped dependency, unreferenced PRD. */
export const IMPORT_NOTE_EVENT_TYPE = "import.note";
/** A PRD relocated into docs/prds/, its stripped status preserved in this event (ADR-0013 as amended). */
export const IMPORT_PRD_RELOCATED_EVENT_TYPE = "import.prd-relocated";
/** The open-extension event type recording a distill act. */
export const DISTILLED_EVENT_TYPE = "journal.distilled";

/**
 * The three OPEN-EXTENSION types the roadmap's event-sourced columns read
 * (Phase 4 F2). All three are recorded by workflows through `nahel log`, never
 * self-recorded by a command, so none belongs in SELF_RECORDED_EVENT_TYPES —
 * a logged event can therefore never masquerade as a record mutation.
 *
 * `qa.sweep-completed` is the whole-sweep summary, written exactly once per
 * sweep (Phase 3 F6, qa-lane.md). The per-case types (`qa.result`,
 * `qa.finding`, `qa.probe`) are a different SCOPE and are deliberately never
 * read as a sweep — promoting a per-case event would report one case as if it
 * were the whole run. The constant lives HERE rather than beside one reader
 * because two views now key on it: `brief`'s QA line and the roadmap's QA
 * column.
 *
 * `deploy.completed` and `release.announced` are F9's lifecycle types, carrying
 * a feature past its own development; F2 owns the derivation that reads them.
 */
export const QA_SWEEP_EVENT_TYPE = "qa.sweep-completed";
export const DEPLOY_COMPLETED_EVENT_TYPE = "deploy.completed";
export const RELEASE_ANNOUNCED_EVENT_TYPE = "release.announced";

/**
 * The one payload key of each lifecycle type that a VIEW renders (F9's shapes,
 * F2's render table): a deploy's `environment` and a release's `version`. The
 * rest of each documented shape — a deploy's `ref` and `shipped`, a release's
 * `channel` and `announcement` — is recorded and read by people, so no constant
 * claims otherwise. These two are named here, beside the types, because the
 * renderer and the glossary that teaches the vocabulary must not drift: a key
 * renamed in code with the docs left behind teaches workflow authors to record
 * a fact no column will ever show.
 */
export const DEPLOY_ENVIRONMENT_PAYLOAD_KEY = "environment";
export const RELEASE_VERSION_PAYLOAD_KEY = "version";

/**
 * The prototype lane's acts (Phase 2 F5). Two of them are read back by
 * machinery, not just by humans, which is why they are reserved types rather
 * than free-form notes:
 *
 * - `prototype.variants-created` carries each variant's BASE commit, and the
 *   never-merge check joins on it to tell a freshly created branch (sitting at
 *   its base, trivially reachable from the default branch) apart from one whose
 *   code was actually merged. A forgeable base is a forgeable acquittal.
 * - `prototype.merge-refused` and `prototype.promotion-refused` are the audit
 *   trail of the refusals F5.2/F5.4 demand: a refusal nobody can read back is
 *   prose, not mechanism.
 */
export const PROTOTYPE_VARIANTS_CREATED_EVENT_TYPE = "prototype.variants-created";
/** A merge-bound status flip refused because the item is a prototype (F5.2). */
export const PROTOTYPE_MERGE_REFUSED_EVENT_TYPE = "prototype.merge-refused";
/** A winning variant's mini-PRD handed to the plan lane (F5.3). */
export const PROTOTYPE_PROMOTED_EVENT_TYPE = "prototype.promoted";
/** A promotion refused by the tier ratchet (F5.4). */
export const PROTOTYPE_PROMOTION_REFUSED_EVENT_TYPE = "prototype.promotion-refused";
/** A variant's workspace disposed of, winner or loser (F5.3). */
export const PROTOTYPE_DISPOSED_EVENT_TYPE = "prototype.disposed";

/**
 * Every event type a nahel COMMAND records for itself: the record mutations
 * mutate() journals, the config replacement `config set` journals, and the
 * dispatch bracket `dispatch` journals. `nahel log` refuses all of them, and
 * the reservation is a security boundary, not tidiness: readers trust these
 * types by TYPE alone — the merge-authority provenance check (PRD F3.4) reads
 * `config.updated` to prove WHO authorized auto-merge — so a type an agent
 * could hand-append through `log` is a type an agent could forge. Same
 * discipline as the reserved mutation payload keys (store/mutate.ts).
 */
export const SELF_RECORDED_EVENT_TYPES: ReadonlyMap<string, string> = new Map([
  ...[...MUTATION_EVENT_TYPES].map(
    (type) => [type, "`nahel item`/`nahel run`"] as [string, string],
  ),
  // Later entries win: the roadmap mutations are journaled by their own verb,
  // not by `nahel item`/`nahel run` like the rest of the mutation set.
  [CORE_EVENT_TYPES.roadmapNodeCreated, "`nahel roadmap node`"],
  [CORE_EVENT_TYPES.roadmapNodeUpdated, "`nahel roadmap node`"],
  ...WAYFINDER_EVENT_TYPES,
  [ROADMAP_ACKED_EVENT_TYPE, "`nahel roadmap ack`"],
  [CONFIG_UPDATED_EVENT_TYPE, "`nahel config set`"],
  [DISPATCH_STARTED_EVENT_TYPE, "`nahel dispatch`"],
  [DISPATCH_ENDED_EVENT_TYPE, "`nahel dispatch`"],
  [IMPORT_COMPLETED_EVENT_TYPE, "`nahel import`"],
  [IMPORT_NOTE_EVENT_TYPE, "`nahel import`"],
  [IMPORT_PRD_RELOCATED_EVENT_TYPE, "`nahel import`"],
  [DISTILLED_EVENT_TYPE, "`nahel distill`"],
  [PROTOTYPE_VARIANTS_CREATED_EVENT_TYPE, "`nahel prototype`"],
  [PROTOTYPE_PROMOTED_EVENT_TYPE, "`nahel prototype`"],
  [PROTOTYPE_PROMOTION_REFUSED_EVENT_TYPE, "`nahel prototype`"],
  [PROTOTYPE_DISPOSED_EVENT_TYPE, "`nahel prototype`"],
  [PROTOTYPE_MERGE_REFUSED_EVENT_TYPE, "`nahel item`"],
]);

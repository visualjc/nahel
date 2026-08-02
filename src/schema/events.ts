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
]);

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

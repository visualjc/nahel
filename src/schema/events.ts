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
]);

/** The dispatch bracket: intent (carrying the composed invocation) and outcome. */
export const DISPATCH_STARTED_EVENT_TYPE = "dispatch.started";
export const DISPATCH_ENDED_EVENT_TYPE = "dispatch.ended";

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
  [CONFIG_UPDATED_EVENT_TYPE, "`nahel config set`"],
  [DISPATCH_STARTED_EVENT_TYPE, "`nahel dispatch`"],
  [DISPATCH_ENDED_EVENT_TYPE, "`nahel dispatch`"],
]);

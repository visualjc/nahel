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
  note: "note",
} as const;

export type CoreEventType = (typeof CORE_EVENT_TYPES)[keyof typeof CORE_EVENT_TYPES];

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
]);

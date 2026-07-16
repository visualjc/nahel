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

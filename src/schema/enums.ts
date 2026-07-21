/**
 * Domain enums. CONTEXT.md (the ubiquitous language) is normative: values
 * here must match the glossary exactly — types, statuses, lanes, actor kinds.
 */

/** What kind of work an item is; picks the workflow. */
export const WORK_ITEM_TYPES = [
  "feature",
  "bug",
  "chore",
  "plan",
  "prototype",
  "qa",
] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

/** The coarse universal lifecycle every work item shares, regardless of type. */
export const WORK_ITEM_STATUSES = [
  "backlog",
  "in-progress",
  "blocked",
  "in-review",
  "done",
  "dropped",
] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

/** How much ceremony the work gets; scales ceremony within a type. */
export const LANES = ["direct", "epic-lite", "full"] as const;
export type Lane = (typeof LANES)[number];

/** Who performed an event or mutation. */
export const ACTOR_KINDS = ["human", "agent"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/**
 * Run lifecycle status. Per the glossary, `pause` suspends a run and
 * `run end` closes it; fine-grained position within an active run is the
 * workflow-owned `phase`, not this enum.
 */
export const RUN_STATUSES = ["active", "paused", "ended"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * Inception tier a project founded at (glossary: Inception). `full` is a
 * valid recorded value even while its workflow is deferred (PRD F4.1) — the
 * tier ratchet needs the value representable before the workflow ships.
 */
export const INCEPTION_TIERS = ["seed", "standard", "full"] as const;
export type InceptionTier = (typeof INCEPTION_TIERS)[number];

/**
 * Who owns legislation for a governance area (glossary: Delegated
 * governance): `human` — agents propose, the human approves; `delegated` —
 * agent roles decide via consensus. Recorded in Phase 1, enforced later.
 */
export const GOVERNANCE_MODES = ["human", "delegated"] as const;
export type GovernanceMode = (typeof GOVERNANCE_MODES)[number];

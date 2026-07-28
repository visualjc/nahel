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
 * How a founding is RUN (glossary: Inception; PRD F9.4): `guided` — the human
 * is grilled and corrects the drafts; `hands-off` — the human hands over one
 * paragraph and leaves. These are INTERACTION modes of the one inception
 * workflow, never two workflows and never two mining procedures: mining is
 * knowledge-first in both, and the mode decides only who answers the questions
 * the drafts raise — and, under `hands-off`, what those answers are worth
 * (only the human's paragraph is signed constitutional content, F9.5).
 */
export const FOUNDING_MODES = ["guided", "hands-off"] as const;
export type FoundingMode = (typeof FOUNDING_MODES)[number];

/**
 * Who owns legislation for a governance area (glossary: Delegated
 * governance): `human` — agents propose, the human approves; `delegated` —
 * agent roles decide via consensus. Recorded in Phase 1, enforced later.
 */
export const GOVERNANCE_MODES = ["human", "delegated"] as const;
export type GovernanceMode = (typeof GOVERNANCE_MODES)[number];

/**
 * Who may merge a reviewed PR (glossary: Merge authority; PRD F3.4):
 * `human` — the PR waits for a person, the default everywhere; `on-approve` —
 * reviewer sign-off merges. `on-approve` is an opt-in to be used SPARINGLY
 * (small items, or changes QA testing covers well) and is legitimate under
 * hard constraint 6 / ADR-0011 only as a human-granted standing
 * authorization: the committed config flip IS the authorization, so it counts
 * only when the journal proves a human actor made it (governance/authority.ts).
 */
export const MERGE_AUTHORITIES = ["human", "on-approve"] as const;
export type MergeAuthority = (typeof MERGE_AUTHORITIES)[number];

/**
 * Responsibility (glossary): the kind of judgment routing maps to an
 * executor. Exactly the keys of `config.routing` minus its `default`
 * fallback — `default` is what resolution falls back TO, never something
 * `nahel dispatch <responsibility>` can be asked for (ADR-0015).
 */
export const ROUTING_RESPONSIBILITIES = ["architecture", "implementation", "review"] as const;
export type RoutingResponsibility = (typeof ROUTING_RESPONSIBILITIES)[number];

/**
 * The agent CLIs `nahel dispatch` knows how to invoke (PRD F1.3). Each kind
 * ships an invocation default (src/dispatch/invocation.ts) that the optional
 * `config.dispatch` section may override; a kind outside this list is a
 * schema error, so teaching nahel a new agent CLI is a deliberate change
 * here — routing's vocabulary discipline (ADR-0015) applied to executors.
 */
export const DISPATCH_AGENT_KINDS = ["claude", "codex", "cursor-agent"] as const;
export type DispatchAgentKind = (typeof DISPATCH_AGENT_KINDS)[number];

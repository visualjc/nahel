import type { GovernanceMode, MergeAuthority } from "../schema/enums";
import { CONFIG_UPDATED_EVENT_TYPE } from "../schema/events";
import type { Actor, Config, Governance, JournalEvent } from "../schema/records";
import { readJournal } from "../store/journal";
import type { StoreLayout } from "../store/layout";

/**
 * Governance posture and merge authority, resolved (PRD F2.2 config
 * semantics, F3.4). The ONE place the codebase answers two questions, so no
 * caller invents its own default or its own idea of what authorizes a merge:
 *
 *   1. Who owns legislation here? A project with NO governance config behaves
 *      as `delegated` on product — pushing forward is the default unless told
 *      not to, and `governance: human` is the explicit brake — while
 *      architecture stays `human` until the Phase 4 architect slice ships.
 *
 *   2. Is `merge: on-approve` actually in force? Only when the journal proves
 *      a HUMAN actor made the config mutation that set it. Hard constraint 6
 *      and ADR-0011 (as amended 2026-07-25) permit `on-approve` precisely
 *      because the committed flip is the human's standing authorization — so
 *      an agent-set flag authorizes nothing: it resolves back to
 *      `merge: human` and `nahel validate` warns.
 *
 * Deterministic throughout: committed config plus journal events in, an
 * answer out. No clock, no network, no judgment.
 */

/**
 * The governance posture of a project that declared none (PRD F2.2). Per
 * AREA, not per section: a caller holding half a posture still gets the right
 * answer for the half it lacks.
 */
export const GOVERNANCE_DEFAULTS: Governance = {
  product: "delegated",
  architecture: "human",
};

/** One area's resolved mode, and whether it came from absence. */
export interface ResolvedGovernanceArea {
  mode: GovernanceMode;
  /** True when the mode is the default because config declared nothing. */
  defaulted: boolean;
}

/** The whole posture in force, area by area. */
export interface ResolvedGovernance {
  product: ResolvedGovernanceArea;
  architecture: ResolvedGovernanceArea;
}

/**
 * Resolve the governance posture. Accepts a PARTIAL because the rule is
 * per-area: the config schema demands both areas together (a half-declared
 * posture is ambiguity, not state), but resolution stays total so a caller
 * mid-write — or a future half-section — never falls through to `undefined`.
 */
export function resolveGovernance(
  governance: Partial<Governance> | undefined,
): ResolvedGovernance {
  const area = (key: keyof Governance): ResolvedGovernanceArea => {
    const mode = governance?.[key];
    return mode === undefined
      ? { mode: GOVERNANCE_DEFAULTS[key], defaulted: true }
      : { mode, defaulted: false };
  };
  return { product: area("product"), architecture: area("architecture") };
}

/** Merge authority when `config.merge` is absent (PRD F3.4: human everywhere). */
export const MERGE_AUTHORITY_DEFAULT: MergeAuthority = "human";

/** What `nahel/config` SAYS the merge authority is — provenance not consulted. */
export function resolveMergeAuthority(merge: Config["merge"]): MergeAuthority {
  return merge?.authority ?? MERGE_AUTHORITY_DEFAULT;
}

/** Why a configured `on-approve` is not in force. */
export type MergeAuthorityDefect =
  /** The config mutation that set it was made by an agent actor. */
  | "agent-set"
  /** No journaled config mutation sets it — the flip's provenance is unprovable. */
  | "unrecorded";

/** The merge authority in force, with the provenance that decided it. */
export interface MergeAuthorityStatus {
  /** What config says (human when the section is absent). */
  configured: MergeAuthority;
  /** True when `configured` came from absence rather than a committed value. */
  defaulted: boolean;
  /**
   * The authority actually in force. `on-approve` ONLY when provenance is
   * human; otherwise `human`, the safe fallback. This field is the answer to
   * "may reviewer sign-off merge?" — nothing else is.
   */
  effective: MergeAuthority;
  /** The journal event that last set `config.merge`, when one is findable. */
  setBy?: { event: string; actor: Actor };
  /** Present exactly when `configured` is on-approve but `effective` is not. */
  defect?: MergeAuthorityDefect;
}

/** Payload shape `config set` journals; read defensively — events are data. */
function settledAuthority(event: JournalEvent): unknown {
  const value = event.payload["value"];
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)["authority"];
}

/**
 * Resolve the merge authority against the journal (PRD F3.4). `events` must
 * arrive in the journal's total order (oldest → newest) — the LAST config
 * mutation of the `merge` section is the one that governs, exactly as the
 * config file's current value does.
 *
 * Mutations are identified by event TYPE, never by payload shape: a `note`
 * (or any other logged event) carrying a merge-shaped payload is inert data,
 * not an authorization — the same rule the store's replay uses for mutations.
 * A config whose latest journaled merge mutation does NOT set on-approve
 * (a hand edit, a journal that lost the flip) is `unrecorded`: unprovable is
 * not authorized.
 */
export function mergeAuthorityStatus(
  merge: Config["merge"],
  events: Iterable<JournalEvent>,
): MergeAuthorityStatus {
  const configured = resolveMergeAuthority(merge);
  const defaulted = merge?.authority === undefined;
  if (configured !== "on-approve") return { configured, defaulted, effective: configured };

  let latest: JournalEvent | undefined;
  for (const event of events) {
    if (event.type !== CONFIG_UPDATED_EVENT_TYPE) continue;
    if (event.payload["section"] !== "merge") continue;
    latest = event;
  }

  if (latest === undefined || settledAuthority(latest) !== "on-approve") {
    return { configured, defaulted, effective: "human", defect: "unrecorded" };
  }
  const setBy = { event: latest.id, actor: latest.actor };
  if (latest.actor.kind !== "human") {
    return { configured, defaulted, effective: "human", setBy, defect: "agent-set" };
  }
  return { configured, defaulted, effective: "on-approve", setBy };
}

/**
 * The store-facing answer: read the journal and resolve. Only `config.updated`
 * events are retained, so memory stays proportional to config history rather
 * than to the journal.
 */
export async function readMergeAuthority(
  layout: StoreLayout,
  config: Config,
): Promise<MergeAuthorityStatus> {
  const configEvents: JournalEvent[] = [];
  for await (const event of readJournal(layout)) {
    if (event.type === CONFIG_UPDATED_EVENT_TYPE) configEvents.push(event);
  }
  return mergeAuthorityStatus(config.merge, configEvents);
}

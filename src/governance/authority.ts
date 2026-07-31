import type { GovernanceMode, MergeAuthority } from "../schema/enums";
import { CONFIG_UPDATED_EVENT_TYPE } from "../schema/events";
import type { Actor, Config, Governance, JournalEvent } from "../schema/records";
import { readJournal } from "../store/journal";
import type { StoreLayout } from "../store/layout";

/**
 * Governance posture, merge authority, and founding signature, resolved (PRD
 * F2.2 config semantics, F3.4, F9.5). The ONE place the codebase answers three
 * questions, so no caller invents its own default or its own idea of what
 * authorizes a merge or signs a constitution:
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
 *   3. Is the hands-off founding paragraph SIGNED? Only when the journal
 *      proves a HUMAN actor made the config mutation that recorded it — the
 *      same provenance rule, applied to the one piece of constitutional text
 *      an agent never authors (F9.5, nahel/workflows/inception.md). An
 *      agent-run founding act signs nothing.
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
  | "unrecorded"
  /** Two or more same-second setters disagree; ordering cannot decide between them. */
  | "ambiguous";

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
  /**
   * The same-second setters that could not be ordered — present exactly when
   * `defect` is "ambiguous", so a human can see what needs breaking apart.
   */
  tied?: { event: string; actor: Actor }[];
  /** Present exactly when `configured` is on-approve but `effective` is not. */
  defect?: MergeAuthorityDefect;
}

/** One field of the section payload `config set` journals; events are data. */
function settledField(event: JournalEvent, field: string): unknown {
  const value = event.payload["value"];
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[field];
}

/** Payload shape `config set` journals; read defensively — events are data. */
function settledAuthority(event: JournalEvent): unknown {
  return settledField(event, "authority");
}

/** The paragraph a founding act RECORDED — the bytes that act actually signs. */
function settledParagraph(event: JournalEvent): unknown {
  return settledField(event, "paragraph");
}

/**
 * Every `config.updated` act on `section` carrying the maximal timestamp —
 * the candidates for "the act that governs". More than one means a same-second
 * tie, which the callers resolve by their own rule. Mutations are identified
 * by event TYPE, never by payload shape: a `note` carrying a config-shaped
 * payload is inert data, not an act.
 */
function latestSectionActs(section: string, events: Iterable<JournalEvent>): JournalEvent[] {
  let finalists: JournalEvent[] = [];
  for (const event of events) {
    if (event.type !== CONFIG_UPDATED_EVENT_TYPE) continue;
    if (event.payload["section"] !== section) continue;
    const maxTs = finalists[0]?.ts;
    if (maxTs === undefined || event.ts > maxTs) finalists = [event];
    else if (event.ts === maxTs) finalists.push(event);
  }
  return finalists;
}

/** The actor attribution of an act, as the status shapes report it. */
function attribution(event: JournalEvent): { event: string; actor: Actor } {
  return { event: event.id, actor: event.actor };
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
 *
 * "Latest" is decided by TIMESTAMP alone, and a same-second tie between
 * DISAGREEING setters is not decided at all. Every CLI invocation mints its
 * own session segment, so config sets from different sessions in the same
 * second all carry seq 0 and the total order falls through to the random
 * event id — a lottery that could rank an earlier human set above a later
 * agent one and wrongly enable auto-merge. Ambiguity therefore fails safe
 * (`ambiguous`, effective human) and is broken the only deterministic way
 * there is: a fresh human set, a second later. Same-second setters that AGREE
 * carry no ambiguity — there is nothing for the order to change.
 */
export function mergeAuthorityStatus(
  merge: Config["merge"],
  events: Iterable<JournalEvent>,
): MergeAuthorityStatus {
  const configured = resolveMergeAuthority(merge);
  const defaulted = merge?.authority === undefined;
  if (configured !== "on-approve") return { configured, defaulted, effective: configured };

  const finalists = latestSectionActs("merge", events);
  const latest = finalists[finalists.length - 1];
  if (
    finalists.length > 1 &&
    finalists.some(
      (event) =>
        event.actor.kind !== latest!.actor.kind ||
        settledAuthority(event) !== settledAuthority(latest!),
    )
  ) {
    return {
      configured,
      defaulted,
      effective: "human",
      tied: finalists.map(attribution),
      defect: "ambiguous",
    };
  }

  if (latest === undefined || settledAuthority(latest) !== "on-approve") {
    return { configured, defaulted, effective: "human", defect: "unrecorded" };
  }
  const setBy = attribution(latest);
  if (latest.actor.kind !== "human") {
    return { configured, defaulted, effective: "human", setBy, defect: "agent-set" };
  }
  return { configured, defaulted, effective: "on-approve", setBy };
}

/** Why a recorded founding paragraph carries no human signature. */
export type FoundingSignatureDefect =
  /** The config mutation that recorded it was made by an agent actor. */
  | "agent-recorded"
  /** No journaled config mutation records it — provenance is unprovable. */
  | "unrecorded"
  /** Same-second recorders of different actor kinds; ordering cannot decide. */
  | "ambiguous";

/** Whether the founding paragraph is human-signed, and the act that decided it. */
export interface FoundingSignatureStatus {
  /** True ONLY when a human-attributed act wrote the `founding` section. */
  signed: boolean;
  /** The journal act that last recorded `config.founding`, when findable. */
  recordedBy?: { event: string; actor: Actor };
  /** The same-second recorders that could not be ordered ("ambiguous" only). */
  tied?: { event: string; actor: Actor }[];
  /** Present exactly when `signed` is false. */
  defect?: FoundingSignatureDefect;
}

/**
 * Resolve the founding paragraph's signature against the journal (PRD F9.5,
 * nahel/workflows/inception.md): "the human-attributed `config.updated` act
 * that wrote the `founding` section IS the paragraph's signature. An agent-run
 * founding act signs nothing."
 *
 * Undefined when there is nothing to sign — no founding section, or a founding
 * recorded with no paragraph (a `guided` founding records which door the
 * project came through and nothing more; only the paragraph carries
 * authority). A hands-off founding always has one: the schema refuses the mode
 * without it.
 *
 * The provenance rule is merge authority's, act for act (`events` must arrive
 * in the journal's total order, oldest → newest): the LAST act on the section
 * governs, "last" is decided by TIMESTAMP alone, and a same-second tie between
 * acts that DISAGREE — on actor kind or on the paragraph recorded — is not
 * decided at all; a lottery must never decide whether a constitution is
 * signed. Ties that agree on both carry no ambiguity: there is nothing for the
 * order to change.
 *
 * An act signs the bytes ITS OWN payload records, compared verbatim against
 * the committed paragraph — nothing trims, reflows, or case-folds, exactly as
 * F9.5 stores it. Without that comparison an old human act would launder any
 * later hand-edit of the text, which is precisely what the signature exists to
 * prevent.
 */
export function foundingSignatureStatus(
  founding: Config["founding"],
  events: Iterable<JournalEvent>,
): FoundingSignatureStatus | undefined {
  if (founding?.paragraph === undefined) return undefined;

  const finalists = latestSectionActs("founding", events);
  const latest = finalists[finalists.length - 1];
  if (
    finalists.length > 1 &&
    finalists.some(
      (event) =>
        event.actor.kind !== latest!.actor.kind ||
        settledParagraph(event) !== settledParagraph(latest!),
    )
  ) {
    return { signed: false, tied: finalists.map(attribution), defect: "ambiguous" };
  }

  // The act signs the bytes ITS OWN payload carries. A latest act recording
  // some OTHER text does not sign what config holds now — the paragraph moved
  // out from under the signature (a hand edit, a lost act), and unprovable is
  // not signed.
  if (latest === undefined || settledParagraph(latest) !== founding.paragraph) {
    return { signed: false, defect: "unrecorded" };
  }
  const recordedBy = attribution(latest);
  if (latest.actor.kind !== "human") {
    return { signed: false, recordedBy, defect: "agent-recorded" };
  }
  return { signed: true, recordedBy };
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

import type { GovernanceMode, MergeAuthority, ProductGovernanceMode } from "../schema/enums";
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
 *      architecture stays `human` until the Phase 5 architect slice ships
 *      (Roles & governance, renumbered 4→5 on 2026-08-01).
 *
 *   2. Is `merge: on-approve` actually in force? Only when the journal proves
 *      a HUMAN actor made the config mutation that set it. Hard constraint 6
 *      and ADR-0011 (as amended 2026-07-25) permit `on-approve` precisely
 *      because the committed flip is the human's standing authorization — so
 *      an agent-set flag authorizes nothing: it resolves back to
 *      `merge: human` and `nahel validate` warns.
 *
 *   3. Is the constitution SIGNED? Only when the journal proves a HUMAN actor
 *      made the config mutation that recorded the signature — the same
 *      provenance rule, applied to the one thing an agent never authors (F7.2,
 *      F9.5, nahel/workflows/inception.md). WHICH act carries it depends on
 *      the door the project came through: a hands-off founding's paragraph is
 *      signed by the act that recorded it, and every other project's signature
 *      is the act that recorded `inception.constitution_signed_by`. An
 *      agent-run act signs nothing either way.
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

/**
 * One area's resolved mode, and whether it came from absence. Generic in the
 * mode because the two areas no longer share a value set (Phase 4 F5): only
 * product takes `agent`, and a caller narrowing on it must not be told the
 * architecture side might carry it.
 */
export interface ResolvedGovernanceArea<Mode extends string = ProductGovernanceMode> {
  mode: Mode;
  /** True when the mode is the default because config declared nothing. */
  defaulted: boolean;
}

/** The whole posture in force, area by area. */
export interface ResolvedGovernance {
  product: ResolvedGovernanceArea<ProductGovernanceMode>;
  architecture: ResolvedGovernanceArea<GovernanceMode>;
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
  const area = <Key extends keyof Governance>(
    key: Key,
  ): ResolvedGovernanceArea<Governance[Key]> => {
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

/** The founding door an act RECORDED — the only mode the journal attests. */
function settledMode(event: JournalEvent): unknown {
  return settledField(event, "mode");
}

/** The signer an inception act RECORDED — the field that act actually signs. */
function settledSigner(event: JournalEvent): unknown {
  return settledField(event, "constitution_signed_by");
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
  /**
   * The latest founding act records DIFFERENT paragraph bytes than config
   * holds — the text moved after it was signed. Distinct from `unrecorded`:
   * the act exists and `recordedBy` names it, so callers must say "this act
   * records other bytes", never "no act exists".
   */
  | "paragraph-mismatch"
  /**
   * The latest founding act records a DIFFERENT `mode` than config holds —
   * the door moved after the act. Outranks `paragraph-mismatch`: the mode
   * decides whether the paragraph carries any authority at all, so an
   * unauthenticated mode is the outer question, and it is the one that would
   * otherwise announce a hands-off founding no act ever recorded.
   */
  | "mode-mismatch"
  /** No journaled config mutation records it at all — nothing to point at. */
  | "unrecorded"
  /** Same-second acts that disagree on actor kind or bytes; ordering cannot decide. */
  | "ambiguous";

/**
 * One axis a same-second founding tie can disagree on. All three are
 * load-bearing: who acted decides whether anything was signed, the mode
 * decides which door the project came through (and so whether the inception
 * record answers for its own provenance), and the paragraph is the signed
 * content itself.
 */
export type FoundingDisagreement = "actor" | "mode" | "paragraph";

/** Whether the founding paragraph is human-signed, and the act that decided it. */
export interface FoundingSignatureStatus {
  /** True ONLY when a human-attributed act wrote the `founding` section. */
  signed: boolean;
  /** The journal act that last recorded `config.founding`, when findable. */
  recordedBy?: { event: string; actor: Actor };
  /** The same-second recorders that could not be ordered ("ambiguous" only). */
  tied?: { event: string; actor: Actor }[];
  /**
   * WHICH axes the tied acts disagree on ("ambiguous" only): who acted, the
   * door they recorded, the paragraph they recorded, or any combination. A
   * list in a fixed order, never empty — callers state the disagreements at
   * hand instead of asserting one that does not apply.
   */
  disagreement?: FoundingDisagreement[];
  /**
   * The `mode` the governing act actually recorded ("mode-mismatch" only), so
   * callers can name the door the journal attests beside the one config
   * declares. Typed loosely because events are data: a payload may carry
   * anything, and the renderer quotes whatever is there.
   */
  recordedMode?: unknown;
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
 * acts that DISAGREE — on actor kind, on the mode, or on the paragraph
 * recorded — is not decided at all; a lottery must never decide whether a
 * constitution is signed, nor which door it was founded through. Ties that
 * agree on ALL THREE carry no ambiguity: there is nothing for the order to
 * change.
 *
 * An act signs the bytes ITS OWN payload records, compared verbatim against
 * the committed paragraph — nothing trims, reflows, or case-folds, exactly as
 * F9.5 stores it. Without that comparison an old human act would launder any
 * later hand-edit of the text, which is precisely what the signature exists to
 * prevent. The `mode` is compared the same way and FIRST: it decides whether
 * the paragraph carries authority at all, so a founding whose declared door is
 * not the one its act recorded proves nothing about either.
 */
export function foundingSignatureStatus(
  founding: Config["founding"],
  events: Iterable<JournalEvent>,
): FoundingSignatureStatus | undefined {
  if (founding?.paragraph === undefined) return undefined;

  const finalists = latestSectionActs("founding", events);
  const latest = finalists[finalists.length - 1];
  if (finalists.length > 1) {
    // Every axis of the fail-safe, tracked separately so the caller names the
    // disagreements at hand instead of asserting one that does not apply. The
    // MODE belongs here as much as the other two: it decides which door the
    // project came through, and letting the order pick it would hand a
    // hands-off exemption to a tie that never established one.
    const differs = (field: (event: JournalEvent) => unknown): boolean =>
      finalists.some((event) => field(event) !== field(latest!));
    const disagreement: FoundingDisagreement[] = [];
    if (differs((event) => event.actor.kind)) disagreement.push("actor");
    if (differs(settledMode)) disagreement.push("mode");
    if (differs(settledParagraph)) disagreement.push("paragraph");
    if (disagreement.length > 0) {
      return {
        signed: false,
        tied: finalists.map(attribution),
        disagreement,
        defect: "ambiguous",
      };
    }
  }

  if (latest === undefined) return { signed: false, defect: "unrecorded" };

  // The act signs the bytes ITS OWN payload carries. A latest act recording
  // some OTHER text does not sign what config holds now — the paragraph moved
  // out from under the signature (a hand edit, a lost act). The act is kept in
  // the status: it exists, and callers must name it rather than claim none
  // does. Mismatch outranks actor kind — an act recording other bytes says
  // nothing about THIS paragraph, whoever made it.
  const recordedBy = attribution(latest);
  // The MODE first: it is the claim that decides what the paragraph means (and
  // whether the inception record is exempt from the provenance rule), so a
  // door config declares but no act recorded settles nothing beneath it.
  if (settledMode(latest) !== founding.mode) {
    return {
      signed: false,
      recordedBy,
      recordedMode: settledMode(latest),
      defect: "mode-mismatch",
    };
  }
  if (settledParagraph(latest) !== founding.paragraph) {
    return { signed: false, recordedBy, defect: "paragraph-mismatch" };
  }
  if (latest.actor.kind !== "human") {
    return { signed: false, recordedBy, defect: "agent-recorded" };
  }
  return { signed: true, recordedBy };
}

/** Why the inception record carries no human constitution signature. */
export type InceptionSignatureDefect =
  /** No `inception` section at all — nothing records the tier, let alone a signer. */
  | "absent"
  /** The section is recorded, but carries no `constitution_signed_by`. */
  | "unsigned"
  /** The config mutation that recorded the signer was made by an agent actor. */
  | "agent-recorded"
  /**
   * The latest inception act recorded a DIFFERENT `constitution_signed_by`
   * than config holds — the signer moved after it was recorded. Distinct from
   * `unrecorded`: the act exists and `recordedBy` names it, so callers must
   * say "this act recorded another signer", never "no act exists".
   */
  | "signer-mismatch"
  /**
   * No journaled config mutation records the signer — either none wrote the
   * section at all, or the latest one recorded no signer field (a hand edit,
   * a journal that lost the act). Unprovable is not signed.
   */
  | "unrecorded"
  /** Same-second acts that disagree on actor kind or signer; ordering cannot decide. */
  | "ambiguous";

/** Whether the inception record is human-signed, and the act that decided it. */
export interface InceptionSignatureStatus {
  /**
   * True when the inception record satisfies everything the autonomy gate asks
   * of IT: the section exists, it carries `constitution_signed_by`, and —
   * outside a hands-off founding, where the human's single act was spent on
   * the paragraph — a human-attributed act recorded that field.
   */
  signed: boolean;
  /** The journal act that last wrote `config.inception`, when findable. */
  recordedBy?: { event: string; actor: Actor };
  /** The same-second writers that could not be ordered ("ambiguous" only). */
  tied?: { event: string; actor: Actor }[];
  /** Present exactly when `signed` is false. */
  defect?: InceptionSignatureDefect;
}

/** The whole constitution-signature verdict: both halves, both founding doors. */
export interface ConstitutionSignatureStatus {
  /**
   * The hands-off paragraph's signature — present exactly when config records
   * a founding paragraph, the only content such a founding signs. Undefined
   * under a guided or legacy founding, where there is no paragraph.
   */
  founding?: FoundingSignatureStatus;
  /** The inception record's half, required under BOTH doors. */
  inception: InceptionSignatureStatus;
  /**
   * True when the JOURNAL proves the hands-off door: config declares it AND a
   * single governing founding act recorded that same mode. The door config
   * declares alone never suffices — it is editable text, and only the act is
   * journaled. Callers read THIS wherever the answer turns on which door the
   * project came through (who may repair the tier record, above all).
   */
  foundedHandsOff: boolean;
}

/**
 * Resolve the inception record's half of the signature (PRD F7.2,
 * nahel/workflows/afk-run.md gate 1a): "its `inception` section must carry
 * `constitution_signed_by`, and the `config.updated` act that wrote that
 * section must be attributed to a HUMAN actor."
 *
 * The provenance rule is merge authority's, act for act: the LAST act on the
 * section governs, "last" is decided by TIMESTAMP alone, and a same-second tie
 * between acts that DISAGREE — on actor kind or on the signer recorded — is
 * not decided at all.
 *
 * An act signs the VALUE its own payload recorded, compared against the signer
 * config holds — the founding half's rule (F9.5), for the same reason: without
 * it, one old human act would authenticate every later hand-edit of the field,
 * which is precisely what a signature exists to prevent. A latest act with no
 * signer field records nothing at all (`unrecorded`, merge's verdict for a
 * flip its latest act does not set); one recording ANOTHER signer is a
 * `signer-mismatch`, and that outranks actor kind — an act naming someone else
 * says nothing about THIS signer, whoever made it. What is never compared is
 * the signer against the ACTOR's id: the field is who signed, the actor is
 * provenance, and a legacy project may label the same human either way.
 *
 * `provenanceRequired` is false under a hands-off founding, where the human's
 * single act was spent on the paragraph and the tier record may legitimately
 * be agent-attributed (gate 1a) — the FIELD is still asked of it, because the
 * paragraph does not record who signed.
 */
function inceptionSignatureStatus(
  inception: Config["inception"],
  events: Iterable<JournalEvent>,
  provenanceRequired: boolean,
): InceptionSignatureStatus {
  if (inception === undefined) return { signed: false, defect: "absent" };
  if (inception.constitution_signed_by === undefined) return { signed: false, defect: "unsigned" };
  if (!provenanceRequired) return { signed: true };

  const finalists = latestSectionActs("inception", events);
  const latest = finalists[finalists.length - 1];
  if (
    finalists.length > 1 &&
    finalists.some(
      (event) =>
        event.actor.kind !== latest!.actor.kind || settledSigner(event) !== settledSigner(latest!),
    )
  ) {
    return {
      signed: false,
      tied: finalists.map(attribution),
      defect: "ambiguous",
    };
  }

  if (latest === undefined || settledSigner(latest) === undefined) {
    return { signed: false, defect: "unrecorded" };
  }
  const recordedBy = attribution(latest);
  if (settledSigner(latest) !== inception.constitution_signed_by) {
    return { signed: false, recordedBy, defect: "signer-mismatch" };
  }
  if (latest.actor.kind !== "human") {
    return { signed: false, recordedBy, defect: "agent-recorded" };
  }
  return { signed: true, recordedBy };
}

/**
 * The COMPLETE constitution-signature verdict — the ONE place both founding
 * doors are answered, so no caller reconstructs half the rule (PRD F7.2, F9.5,
 * nahel/workflows/afk-run.md gate 1a).
 *
 * A hands-off founding spends the human's single act on the paragraph: that
 * act is the signature, and the tier record beside it needs only to carry the
 * signer field. Every other project — guided, or founded before the field
 * existed — signs with the act that recorded
 * `inception.constitution_signed_by` instead. Both halves are reported: they
 * fail independently and are repaired by different acts.
 *
 * The exemption keys off the MODE, never off a paragraph existing: the schema
 * requires a paragraph OF hands-off but permits one on a guided founding too,
 * and a guided founding never spent the human's act on it — they were present
 * throughout and sign the tier record themselves. Keying off the paragraph
 * would hand any guided project a free pass for one optional field.
 *
 * And it keys off the mode the JOURNAL records, not the one config declares:
 * a guided founding hand-edited to `mode: hands-off` would otherwise announce
 * the zero-return door and excuse an agent-transcribed signature, on the
 * strength of a text edit no act attests. `mode-mismatch` (and an act that
 * cannot be singled out at all) therefore exempts nothing — unprovable is not
 * a door, exactly as unprovable is not a signature.
 *
 * `events` is an ARRAY, not an iterable: both halves scan it.
 */
export function constitutionSignatureStatus(
  config: Pick<Config, "founding" | "inception"> | undefined,
  events: readonly JournalEvent[],
): ConstitutionSignatureStatus {
  const founding = foundingSignatureStatus(config?.founding, events);
  // `recordedBy` present means ONE act governs (an unrecorded founding and an
  // undecidable tie both leave it unset), and no mode mismatch means that act
  // recorded the very door config declares.
  const foundedHandsOff =
    config?.founding?.mode === "hands-off" &&
    founding?.recordedBy !== undefined &&
    founding.defect !== "mode-mismatch";
  return {
    founding,
    inception: inceptionSignatureStatus(config?.inception, events, !foundedHandsOff),
    foundedHandsOff,
  };
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

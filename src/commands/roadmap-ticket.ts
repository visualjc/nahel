import { parseArgs } from "node:util";
import { DECISION_TICKET_TYPES } from "../schema/enums";
import type { Env } from "../schema/env";
import { CORE_EVENT_TYPES } from "../schema/events";
import { generateId, ID_PATTERN } from "../schema/id";
import {
  ticketFrontmatterSchema,
  type ObservationFrontmatter,
  type TicketFrontmatter,
} from "../schema/records";
import {
  openStore,
  readMap,
  readTickets,
  type StoreLayout,
  type TicketRecord,
} from "../store/layout";
import { missingEventIds } from "../store/journal";
import { closeStoreContext, mutate, type StoreContext } from "../store/mutate";
import { renderTicket } from "../views/roadmap";
import { commandContext, requireValid, UsageError } from "./item";
import { requireMap } from "./roadmap-map";
import { requireSingleLine } from "./roadmap-ref";

/**
 * `nahel roadmap ticket` (Phase 4 F7): the decision ticket and the six verbs
 * that move it through its four states. Thin over the store, every mutation
 * through mutate()'s write-ahead choke point.
 *
 * The transition table is TOTAL here: a verb whose `from` state does not match
 * the ticket's current one is refused, naming the state the ticket is actually
 * in. That is what makes every verb idempotent after a crash repair — re-running
 * it changes nothing rather than recording the act twice.
 *
 * `claim` is advisory assignment (F5's distinction): it records the claiming
 * actor so concurrent sessions skip the ticket, refuses a second claim naming
 * the holder, and freezes nothing — release is permitted to any actor, and no
 * command anywhere refuses work because a ticket is claimed or blocked.
 */

const TYPE_FIELD = ticketFrontmatterSchema.shape.type;
const QUESTION_HINT =
  "a ticket IS its question — pass a non-empty --question (the one thing the ticket exists to answer)";

export const TICKET_USAGE = `  nahel roadmap ticket new --map <ref> --type <t> --question <text>
                           [--blocked-by <ticket-id>]... [--human-only]
    Create an open ticket on a map and print its generated id.
      --map: the map it hangs off (a map id, or its node's slug or id)
      --type: ${DECISION_TICKET_TYPES.join(" | ")}
      --question: the question itself, stored as the record body
      --blocked-by: a sibling ticket this one waits on (repeatable, ADVISORY)
      --human-only: the question is the human's to answer. Under an agent actor
        \`resolve\`, \`close\` and \`--clear-human-only\` are then all REFUSED —
        unlike blocking, this one really does refuse. Any actor may set it;
        only a human may clear it.

  nahel roadmap ticket update <ref> [--type <t>] [--question <text>]
                              [--blocked-by <ticket-id>]... [--clear-blockers]
                              [--human-only | --clear-human-only]
    Re-state the question, the type, the blocking edges, or the human-only flag
    (the second pass of charting). Repeatable --blocked-by replaces the whole
    list.

  nahel roadmap ticket show <ref>
    Print one ticket: its state, claimant, blockers, decision, and question.

  nahel roadmap ticket claim <ref>
    Take the ticket: records the claiming actor so other sessions skip it.
    Advisory only — nothing is frozen, and a claimed ticket refuses only a
    second claim, naming the holder.

  nahel roadmap ticket release <ref>
    Hand it back to the frontier. Permitted to any actor, always.

  nahel roadmap ticket resolve <ref> --decision <one-liner> [--rationale <prose>]
                              [--source <event-id>]...
    Record the decision: journals it and distills an observation citing the
    resolution event — so \`nahel recall\` finds it. The map's Decisions so far
    index is derived from this ticket; no map record is written.
      --decision: the decision itself, in one line
      --rationale: WHY, in as many lines as it takes. Stored verbatim in the
        observation body (paragraphs kept), never as a map row — the one place
        the reasoning survives \`distill\`.
      --source: a journal event the decision rests on — the research you
        logged while answering (repeatable). Recorded in the observation's
        provenance beside the resolution event, so the link outlives the
        ticket body. Must name an event this store already recorded.

  nahel roadmap ticket close <ref> --reason <why> (--out-of-scope | --invalidated-by <ref>)
    Rule the question away, stating WHICH disposition it is. Under either one
    it never becomes a decision, and no map record is written. Distills an
    observation too, so the question survives \`distill\` and \`nahel recall\`
    still finds what was ruled away.
      --out-of-scope: ruled beyond the destination — the reason renders as one
        line under the map's Out of scope section, which never graduates.
      --invalidated-by <ticket-or-event-id>: another decision answered the
        question out of existence — records that ref on the ticket, and the map
        shows it beside Decisions so far. It was never beyond the destination,
        so it earns no line in the section above.

  nahel roadmap ticket distill <ref>
    Empty a resolved or closed ticket's body through the CLI, once the decision
    is readable from \`nahel recall\` and \`nahel progress\` alone.`;

/** The question IS the record body, so it must say something. */
function requireQuestion(value: string | undefined): string {
  if (value === undefined || value.trim() === "") throw new UsageError(QUESTION_HINT);
  return value.endsWith("\n") ? value : `${value}\n`;
}

/** Resolve a ticket ref to its record, or refuse it by name. */
async function requireTicket(
  layout: StoreLayout,
  ref: string,
): Promise<TicketRecord> {
  if (ID_PATTERN.test(ref)) {
    const tickets = await readTickets(layout);
    const found = tickets.find((record) => record.frontmatter.id === ref);
    if (found !== undefined) return found;
  }
  throw new UsageError(
    `decision ticket ${JSON.stringify(ref)} not found — pass a ticket id ` +
      "(`nahel roadmap map show <ref>` lists a map's tickets)",
  );
}

/**
 * Resolve a blocking edge. Like every roadmap ref, a well-formed id is recorded
 * as given even when no ticket carries it yet (it may arrive by a later merge,
 * ADR-0012) — a dangling blocker is a `validate` warning, never a refusal, and
 * blocking never refuses anything anyway.
 */
function requireTicketRef(ref: string): string {
  if (ID_PATTERN.test(ref)) return ref;
  throw new UsageError(
    `--blocked-by ${JSON.stringify(ref)} is not a ticket id — blocking edges name sibling tickets by id`,
  );
}

/**
 * Refuse a transition the table does not have, naming the state the ticket is
 * in. One message shape for all six verbs, so "what can I do from here" is
 * answered by the refusal itself.
 */
function requireState(
  ticket: TicketFrontmatter,
  allowed: readonly TicketFrontmatter["state"][],
  verb: string,
): void {
  if (allowed.includes(ticket.state)) return;
  throw new UsageError(
    `ticket ${ticket.id} is ${ticket.state}, and ${verb} moves a ticket that is ` +
      `${allowed.join(" or ")} — nothing was changed`,
  );
}

/** The actor id a claim records: the same `kind:id` spelling NAHEL_ACTOR uses. */
function actorRef(ctx: StoreContext): string {
  return `${ctx.actor.kind}:${ctx.actor.id}`;
}

/**
 * The human-only refusal (DD2) — the one place this layer really does refuse
 * over a ticket's own state, unlike blocking and claiming, which are advisory
 * throughout. Three acts are covered because two would leave the hole open:
 * `resolve` and `close` take the question away from the human, and clearing the
 * flag is the same act with one extra step.
 *
 * One message shape for all three, and it names the ACTOR as well as the
 * ticket: the refusal an AFK lane reads has to say what identity it is running
 * under, or the operator cannot tell a rule from a misconfiguration.
 */
function requireHumanActor(ctx: StoreContext, ticket: TicketFrontmatter, verb: string): void {
  if (ticket.human_only !== true || ctx.actor.kind !== "agent") return;
  throw new UsageError(
    `ticket ${ticket.id} is human-only, and ${verb} under agent actor ${actorRef(ctx)} is refused — ` +
      "the question is the human's to answer, so leave it on the frontier for them; nothing was changed",
  );
}

async function ticketNew(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      map: { type: "string" },
      type: { type: "string" },
      question: { type: "string" },
      "blocked-by": { type: "string", multiple: true },
      "human-only": { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (positionals.length > 0) {
    throw new UsageError(
      `roadmap ticket new takes no positional arguments — the map is named by --map (got ${JSON.stringify(positionals[0])})`,
    );
  }
  if (values.map === undefined) {
    throw new UsageError("a ticket hangs off one map — pass --map <map-id|node-slug|node-id>");
  }
  if (values.type === undefined) {
    throw new UsageError(
      `a ticket states what kind of work answers it — pass --type ${DECISION_TICKET_TYPES.join("|")}`,
    );
  }
  const type = requireValid(TYPE_FIELD, values.type, "--type");
  const body = requireQuestion(values.question);
  const blockers = (values["blocked-by"] ?? []).map(requireTicketRef);

  const ctx = await commandContext(cwd, env, actorOverride);
  const map = await requireMap(ctx.layout, values.map);
  const created = env.now();
  const frontmatter: TicketFrontmatter = {
    id: generateId(env),
    map: map.frontmatter.id,
    type,
    state: "open",
    blockers,
    // Absent rather than `false` when the flag is off: "not human-only" has one
    // spelling, the one every ticket written before the flag already carries.
    ...(values["human-only"] === true ? { human_only: true } : {}),
    created,
    updated: created,
  };
  await mutate(ctx, {
    target: "ticket",
    eventType: CORE_EVENT_TYPES.ticketCreated,
    frontmatter,
    body,
  });
  await closeStoreContext(ctx);
  console.log(frontmatter.id);
  return 0;
}

async function ticketUpdate(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      type: { type: "string" },
      question: { type: "string" },
      "blocked-by": { type: "string", multiple: true },
      "clear-blockers": { type: "boolean" },
      "human-only": { type: "boolean" },
      "clear-human-only": { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    throw new UsageError("roadmap ticket update takes exactly one <ref> (a ticket id)");
  }
  // A set flag and its clear flag together are ambiguous — refused outright.
  for (const [setFlag, clearFlag] of [
    ["blocked-by", "clear-blockers"],
    ["human-only", "clear-human-only"],
  ] as const) {
    if (values[setFlag] !== undefined && values[clearFlag] === true) {
      throw new UsageError(
        `--${setFlag} and --${clearFlag} are mutually exclusive — pass one or the other`,
      );
    }
  }
  const setFlags = ["type", "question", "blocked-by", "human-only"] as const;
  const clearFlags = ["clear-blockers", "clear-human-only"] as const;
  if (
    !setFlags.some((flag) => values[flag] !== undefined) &&
    !clearFlags.some((flag) => values[flag] === true)
  ) {
    throw new UsageError(
      "nothing to update — pass at least one of --type, --question, --blocked-by, " +
        "--clear-blockers, --human-only, --clear-human-only",
    );
  }

  const ctx = await commandContext(cwd, env, actorOverride);
  const current = await requireTicket(ctx.layout, positionals[0]!);
  const next: TicketFrontmatter = { ...current.frontmatter };
  let body = current.body;
  if (values.type !== undefined) next.type = requireValid(TYPE_FIELD, values.type, "--type");
  if (values.question !== undefined) body = requireQuestion(values.question);
  if (values["blocked-by"] !== undefined) {
    next.blockers = values["blocked-by"].map(requireTicketRef);
  }
  if (values["clear-blockers"] === true) next.blockers = [];
  if (values["human-only"] === true) next.human_only = true;
  if (values["clear-human-only"] === true) {
    requireHumanActor(ctx, current.frontmatter, "update --clear-human-only");
    delete next.human_only;
  }
  next.updated = env.now();

  await mutate(ctx, {
    target: "ticket",
    eventType: CORE_EVENT_TYPES.ticketUpdated,
    frontmatter: next,
    body,
  });
  await closeStoreContext(ctx);
  return 0;
}

async function ticketShow(args: string[], cwd: string): Promise<number> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  if (positionals.length !== 1) {
    throw new UsageError("roadmap ticket show takes exactly one <ref> (a ticket id)");
  }
  const layout = await openStore(cwd);
  const record = await requireTicket(layout, positionals[0]!);
  // The map's destination is the context a ticket is read in, and it is a fact
  // held by the map — read here rather than duplicated onto every ticket.
  const map = await readMap(layout, record.frontmatter.map).catch(() => null);
  console.log(renderTicket(record, map));
  return 0;
}

/** `claim` and `release`: the two advisory-assignment verbs, one shape each. */
async function ticketClaim(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const ref = onlyRef(args, "claim");
  const ctx = await commandContext(cwd, env, actorOverride);
  const current = await requireTicket(ctx.layout, ref);
  const ticket = current.frontmatter;
  if (ticket.state === "claimed") {
    throw new UsageError(
      `ticket ${ticket.id} is already claimed by ${ticket.claimant ?? "(unrecorded)"} — ` +
        `the claim is advisory, so take it over with \`nahel roadmap ticket release ${ticket.id}\` first ` +
        "if that session is gone",
    );
  }
  requireState(ticket, ["open"], "claim");
  await mutate(ctx, {
    target: "ticket",
    eventType: CORE_EVENT_TYPES.ticketClaimed,
    frontmatter: { ...ticket, state: "claimed", claimant: actorRef(ctx), updated: env.now() },
    body: current.body,
  });
  await closeStoreContext(ctx);
  return 0;
}

async function ticketRelease(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const ref = onlyRef(args, "release");
  const ctx = await commandContext(cwd, env, actorOverride);
  const current = await requireTicket(ctx.layout, ref);
  requireState(current.frontmatter, ["claimed"], "release");
  // Release by ANY actor: a claim is advisory, so a session that died holding
  // one must never be able to strand the question.
  const { claimant: _released, ...rest } = current.frontmatter;
  await mutate(ctx, {
    target: "ticket",
    eventType: CORE_EVENT_TYPES.ticketReleased,
    frontmatter: { ...rest, state: "open", updated: env.now() },
    body: current.body,
  });
  await closeStoreContext(ctx);
  return 0;
}

/**
 * A labelled block of prose in an observation body: the heading on its own
 * line, the text below it. A BLOCK rather than `Label: <text>`, because both
 * things it carries — a question and a rationale — are prose that may run to
 * paragraphs, and folding a paragraph onto a label line loses its shape.
 * Absent text contributes nothing at all, never an empty heading.
 */
function observationBlock(label: string, text: string): string[] {
  return text === "" ? [] : ["", `${label}:`, text];
}

/**
 * The observation `resolve` distills (F7). Its BODY carries the decision on
 * the first line — what `nahel recall` prints as the fact — then where it was
 * decided, the whole question, and the rationale when one was given, because
 * `distill` is about to throw the ticket's own copy of the question away and
 * the decision must stay readable from `recall` and `progress` alone.
 *
 * The RATIONALE is why this record exists at all: the one-liner says what was
 * decided and nothing anywhere else says why. It lives here rather than on the
 * map, whose index is one row per decision, and rather than on the ticket,
 * whose body is the thing distill empties.
 *
 * `sources` is the resolution event followed by whatever `--source` cited — the
 * research the decision rests on, as STRUCTURED refs rather than prose. Passing
 * them here is what keeps them: the note ids an agent journals while answering
 * the question are otherwise reachable only through the ticket body, which
 * `distill` is about to empty.
 *
 * The name is derived from the ticket id rather than from the decision prose:
 * a slug is a schema-hardened field, and no slugification of free text is
 * total. Search reaches the words through the body, which recall scores too.
 */
function decisionObservation(
  ticket: TicketFrontmatter,
  destination: string,
  question: string,
  decision: string,
  rationale: string | undefined,
  sources: readonly string[],
  now: string,
  id: string,
): { frontmatter: ObservationFrontmatter; body: string } {
  const lines = [
    decision,
    "",
    `Decided by resolving ${ticket.type} ticket ${ticket.id}, charting: ${destination}`,
    ...observationBlock("Question", question),
    ...observationBlock("Rationale", rationale ?? ""),
  ];
  return {
    frontmatter: {
      id,
      name: `decision-${ticket.id}`,
      created: now,
      tags: ["decision", ticket.type],
      sources: [...sources],
    },
    body: `${lines.join("\n")}\n`,
  };
}

/**
 * The observation `close` distills — the same durability the decision gets, for
 * the question nobody is going to answer. Without it, `distill` on a closed
 * ticket throws away the only copy of the question, and a reader who later asks
 * "did we ever consider X?" finds a `reason` with nothing to attach it to.
 *
 * The first line is the REASON, because that is the fact `recall` prints; the
 * disposition is spelled out beneath it, naming the invalidating ref when there
 * is one. Tagged `closed` plus the disposition, so a recall can ask for either.
 */
function closureObservation(
  ticket: TicketFrontmatter,
  destination: string,
  question: string,
  reason: string,
  disposition: CloseDisposition,
  eventId: string,
  now: string,
  id: string,
): { frontmatter: ObservationFrontmatter; body: string } {
  const ruling =
    disposition.kind === "out-of-scope" ? "out of scope" : `invalidated by ${disposition.by}`;
  const lines = [
    reason,
    "",
    `Closed ${ticket.type} ticket ${ticket.id} as ${ruling}, charting: ${destination}`,
    ...observationBlock("Question", question),
  ];
  return {
    frontmatter: {
      id,
      name: `closed-${ticket.id}`,
      created: now,
      tags: ["closed", disposition.kind],
      sources: [eventId],
    },
    body: `${lines.join("\n")}\n`,
  };
}

/** The one-line text `resolve` and `close` each require, hardened once. */
function requireOneLineText(value: unknown, flag: string, hint: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new UsageError(hint);
  return requireSingleLine(value.trim(), flag);
}

/** The single `<ref>` positional every lifecycle verb takes. */
function onlyPositional(positionals: string[], verb: string): string {
  if (positionals.length !== 1) {
    throw new UsageError(`roadmap ticket ${verb} takes exactly one <ref> (a ticket id)`);
  }
  return positionals[0]!;
}

/**
 * The optional `--rationale` prose: multi-line by design, since reasoning runs
 * to paragraphs. Only the OUTER whitespace goes — everything between the first
 * and last non-blank characters is stored exactly as written, so the blank line
 * an author put between two paragraphs is still there when it is read back.
 *
 * A flag passed with nothing in it is refused rather than dropped: an agent
 * that meant to explain itself and shipped a blank should hear about it, and
 * omitting the flag is the way to say there is nothing to add.
 */
function optionalRationale(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new UsageError(
      "--rationale was passed with nothing in it — omit the flag, or give the reasoning behind the " +
        "decision (it becomes the observation's body, where prose is welcome: paragraphs are kept as written)",
    );
  }
  return value.trim();
}

/**
 * The `--source` event ids a resolution cites BESIDE its own: the notes an
 * agent journaled while answering the question (`work-map.md` step 3). Without
 * them the research is reachable only through the ticket body, which `distill`
 * empties — the decision would survive with nothing under it.
 *
 * Deduped in argv order, the shape `nahel observe` gives the same field: citing
 * one note twice is one provenance link, not two.
 *
 * Only the SHAPE is judged here. Existence is checked against the journal
 * before the write (see ticketResolve), because `sources` is the observation
 * layer's field and that layer VERIFIES provenance rather than recording refs
 * that may arrive later: `nahel observe` refuses an unknown source outright,
 * and `validate`'s refs.observation-sources is an error, not a warning. A
 * resolution must not write an observation `observe` would have refused.
 */
function parseSourceRefs(values: string[] | undefined): string[] {
  const sources = [...new Set(values ?? [])];
  for (const source of sources) {
    if (!ID_PATTERN.test(source)) {
      throw new UsageError(
        `--source ${JSON.stringify(source)} is not an id — it names the journal event a research ` +
          "note was recorded as (`nahel log note --data summary=…` prints the id it wrote)",
      );
    }
  }
  return sources;
}

/** `resolve <ref> --decision <one-liner> [--rationale <prose>] [--source <event-id>]...`. */
function parseResolveArgs(args: string[]): {
  ref: string;
  decision: string;
  rationale: string | undefined;
  sources: string[];
} {
  const { values, positionals } = parseArgs({
    args,
    options: {
      decision: { type: "string" },
      rationale: { type: "string" },
      source: { type: "string", multiple: true },
    },
    allowPositionals: true,
  });
  return {
    ref: onlyPositional(positionals, "resolve"),
    decision: requireOneLineText(
      values.decision,
      "--decision",
      "a resolution IS its decision — pass a non-empty --decision <one-liner> (it is journaled, distilled into an observation, and indexed on the map from this ticket)",
    ),
    rationale: optionalRationale(values.rationale),
    sources: parseSourceRefs(values.source),
  };
}

/**
 * How a close disposes of the question — the two cases F7's close row names,
 * and the reason they cannot share one spelling:
 *
 * - `out-of-scope`: ruled BEYOND the destination. Earns a line under the map's
 *   Out of scope, the section that keeps the map from growing without bound;
 *   entries there never graduate.
 * - `invalidated`: another decision answered the question out of existence. It
 *   was never beyond the destination, so an Out-of-scope line would be false —
 *   the invalidating ref goes on the ticket, and the map renders it beside
 *   Decisions so far instead.
 *
 * Both readings are derived from the ticket the close wrote; neither is stored
 * on the map, which is why the two dispositions differ in what they RECORD on
 * the ticket rather than in which records they touch.
 */
type CloseDisposition = { kind: "out-of-scope" } | { kind: "invalidated"; by: string };

/** `close <ref> --reason <why> (--out-of-scope | --invalidated-by <ref>)`. */
function parseCloseArgs(args: string[]): {
  ref: string;
  reason: string;
  disposition: CloseDisposition;
} {
  const { values, positionals } = parseArgs({
    args,
    options: {
      reason: { type: "string" },
      "out-of-scope": { type: "boolean" },
      "invalidated-by": { type: "string" },
    },
    allowPositionals: true,
  });
  const ref = onlyPositional(positionals, "close");
  const outOfScope = values["out-of-scope"] === true;
  const invalidatedBy = values["invalidated-by"];
  if (outOfScope && invalidatedBy !== undefined) {
    throw new UsageError(
      "--out-of-scope and --invalidated-by are mutually exclusive — a question is either beyond the " +
        "destination or answered out of existence by another decision, never both",
    );
  }
  if (!outOfScope && invalidatedBy === undefined) {
    throw new UsageError(
      "a close states WHICH disposition it is: --out-of-scope (ruled beyond the destination — it earns a " +
        "line under the map's Out of scope) or --invalidated-by <ticket-or-event-id> (another decision " +
        "answered the question out of existence — it was never beyond the destination, so it renders " +
        "beside Decisions so far instead)",
    );
  }
  const reason = requireOneLineText(
    values.reason,
    "--reason",
    "a close states why the question was ruled away — pass a non-empty --reason <why> (it is the ticket's epitaph under either disposition)",
  );
  if (invalidatedBy !== undefined && !ID_PATTERN.test(invalidatedBy)) {
    throw new UsageError(
      `--invalidated-by ${JSON.stringify(invalidatedBy)} is not an id — it names the resolved ticket, or the ` +
        "journal event, whose decision answered this question out of existence",
    );
  }
  return {
    ref,
    reason,
    disposition:
      invalidatedBy === undefined
        ? { kind: "out-of-scope" }
        : { kind: "invalidated", by: invalidatedBy },
  };
}

/**
 * `resolve`: the decision, the ticket and the observation under ONE write-ahead
 * event (F7). The event id is minted first because the observation's `sources`
 * must cite the very event carrying it — and any `--source` ids beside it, so
 * the research the decision rests on outlives the ticket body.
 *
 * The MAP is not written. Its Decisions so far index is composed at read time
 * from its tickets, so a resolution touches only the two records it owns — and
 * two sessions resolving two tickets on one map never contend for the record
 * they share. The map is still READ, for the destination the observation names.
 */
async function ticketResolve(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const { ref, decision, rationale, sources } = parseResolveArgs(args);
  const ctx = await commandContext(cwd, env, actorOverride);
  const current = await requireTicket(ctx.layout, ref);
  requireState(current.frontmatter, ["open", "claimed"], "resolve");
  requireHumanActor(ctx, current.frontmatter, "resolve");
  const map = await readMap(ctx.layout, current.frontmatter.map);
  // Cited provenance is verified before anything is written, exactly as `nahel
  // observe` verifies it (missingEventIds is the one walk both share): an
  // observation citing an event this store never recorded is a `validate`
  // ERROR, so writing one would make every such resolution a finding.
  const absent = await missingEventIds(ctx.layout, sources);
  if (absent.length > 0) {
    throw new UsageError(
      `--source event(s) not found in the journal: ${absent.join(", ")} — a source names an event ` +
        "this store already recorded (`nahel log note --data summary=…` prints the id it wrote); " +
        "observation provenance must cite real journal events",
    );
  }

  const eventId = generateId(ctx.env);
  const now = ctx.env.now();
  // The claim goes with the state: nothing stays assigned once it is decided.
  const { claimant: _released, ...rest } = current.frontmatter;
  const resolved: TicketFrontmatter = {
    ...rest,
    state: "resolved",
    decision,
    resolution: eventId,
    updated: now,
  };
  const observation = decisionObservation(
    current.frontmatter,
    map.frontmatter.destination,
    current.body.trim(),
    decision,
    rationale,
    // The resolution first — the act this observation is distilled FROM — then
    // the research it rests on, in the order the agent cited it.
    [...new Set([eventId, ...sources])],
    now,
    generateId(ctx.env),
  );
  await mutate(ctx, {
    target: "sequence",
    eventType: CORE_EVENT_TYPES.ticketResolved,
    eventId,
    writes: [
      { target: "ticket", frontmatter: resolved, body: current.body },
      { target: "observation", frontmatter: observation.frontmatter, body: observation.body },
    ],
  });
  await closeStoreContext(ctx);
  return 0;
}

/**
 * `close`: rule the question away, saying WHICH way (see CloseDisposition).
 * A closed question never becomes a decision under either disposition, so
 * nothing is indexed in Decisions so far — but it IS distilled into an
 * observation, the same two-record sequence `resolve` is: `distill` empties a
 * closed ticket's body too, and without the observation the question itself
 * would be the one thing the store forgot.
 *
 * Like `resolve`, this writes NO map record under either disposition: an
 * out-of-scope line is derived from the ticket that earned it, so a close
 * touches only its own two records. The event id is minted first for both
 * reasons the layer has one — the observation cites the event carrying it, and
 * the ticket records it (`closure`), the key the derived section orders by,
 * which `updated` cannot be since `distill` moves it long afterwards.
 */
async function ticketClose(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const { ref, reason, disposition } = parseCloseArgs(args);
  const ctx = await commandContext(cwd, env, actorOverride);
  const current = await requireTicket(ctx.layout, ref);
  requireState(current.frontmatter, ["open", "claimed"], "close");
  requireHumanActor(ctx, current.frontmatter, "close");
  const map = await readMap(ctx.layout, current.frontmatter.map);

  const eventId = generateId(ctx.env);
  const now = ctx.env.now();
  const { claimant: _released, ...rest } = current.frontmatter;
  const closed: TicketFrontmatter = {
    ...rest,
    state: "closed",
    reason,
    ...(disposition.kind === "invalidated" ? { invalidated_by: disposition.by } : {}),
    closure: eventId,
    updated: now,
  };
  const observation = closureObservation(
    current.frontmatter,
    map.frontmatter.destination,
    current.body.trim(),
    reason,
    disposition,
    eventId,
    now,
    generateId(ctx.env),
  );
  await mutate(ctx, {
    target: "sequence",
    eventType: CORE_EVENT_TYPES.ticketClosed,
    eventId,
    writes: [
      { target: "ticket", frontmatter: closed, body: current.body },
      { target: "observation", frontmatter: observation.frontmatter, body: observation.body },
    ],
  });
  await closeStoreContext(ctx);
  return 0;
}

/**
 * `distill`: empty a decided ticket's body THROUGH the CLI (F7). Body deletion
 * is a state mutation like any other — journaled, replayable, attributable —
 * so a body emptied by a raw file edit is a `validate` finding, not a distill.
 *
 * Only the body goes: the decision, the reason and the resolution ref all stay
 * on the record, and the decision's full text lives on in the journal event and
 * in the observation the resolution distilled. An already-empty body is refused
 * rather than journaled again, which is what makes re-running it after a crash
 * repair a no-op instead of a second act.
 */
async function ticketDistill(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const ref = onlyRef(args, "distill");
  const ctx = await commandContext(cwd, env, actorOverride);
  const current = await requireTicket(ctx.layout, ref);
  requireState(current.frontmatter, ["resolved", "closed"], "distill");
  if (current.body === "") {
    throw new UsageError(
      `ticket ${current.frontmatter.id} is already distilled — its body is empty and nothing was changed ` +
        "(the decision reads back from `nahel recall` and `nahel progress`)",
    );
  }
  await mutate(ctx, {
    target: "ticket",
    eventType: CORE_EVENT_TYPES.ticketDistilled,
    frontmatter: { ...current.frontmatter, updated: ctx.env.now() },
    body: "",
  });
  await closeStoreContext(ctx);
  return 0;
}

/** The single-ref argument shape the four lifecycle verbs share. */
function onlyRef(args: string[], verb: string): string {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  if (positionals.length !== 1) {
    throw new UsageError(`roadmap ticket ${verb} takes exactly one <ref> (a ticket id)`);
  }
  return positionals[0]!;
}

/** Dispatch `nahel roadmap ticket <sub>`; the parent verb owns the error surface. */
export async function runTicketSubcommand(
  argv: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const [sub, ...args] = argv;
  if (sub === "new") return ticketNew(args, env, cwd, actorOverride);
  if (sub === "update") return ticketUpdate(args, env, cwd, actorOverride);
  if (sub === "show") return ticketShow(args, cwd);
  if (sub === "claim") return ticketClaim(args, env, cwd, actorOverride);
  if (sub === "release") return ticketRelease(args, env, cwd, actorOverride);
  if (sub === "resolve") return ticketResolve(args, env, cwd, actorOverride);
  if (sub === "close") return ticketClose(args, env, cwd, actorOverride);
  if (sub === "distill") return ticketDistill(args, env, cwd, actorOverride);
  throw new UsageError(
    sub === undefined
      ? "missing subcommand — expected `roadmap ticket new`, `update`, `show`, `claim`, `release`, `resolve`, `close`, or `distill`"
      : `unknown subcommand ${JSON.stringify(sub)} — expected new, update, show, claim, release, resolve, close, or distill`,
  );
}

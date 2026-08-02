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
import {
  closeStoreContext,
  mutate,
  type SequenceWrite,
  type StoreContext,
} from "../store/mutate";
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
                           [--blocked-by <ticket-id>]...
    Create an open ticket on a map and print its generated id.
      --map: the map it hangs off (a map id, or its node's slug or id)
      --type: ${DECISION_TICKET_TYPES.join(" | ")}
      --question: the question itself, stored as the record body
      --blocked-by: a sibling ticket this one waits on (repeatable, ADVISORY)

  nahel roadmap ticket update <ref> [--type <t>] [--question <text>]
                              [--blocked-by <ticket-id>]... [--clear-blockers]
    Re-state the question, the type, or the blocking edges (the second pass of
    charting). Repeatable --blocked-by replaces the whole list.

  nahel roadmap ticket show <ref>
    Print one ticket: its state, claimant, blockers, decision, and question.

  nahel roadmap ticket claim <ref>
    Take the ticket: records the claiming actor so other sessions skip it.
    Advisory only — nothing is frozen, and a claimed ticket refuses only a
    second claim, naming the holder.

  nahel roadmap ticket release <ref>
    Hand it back to the frontier. Permitted to any actor, always.

  nahel roadmap ticket resolve <ref> --decision <one-liner>
    Record the decision: journals it, indexes it on the map, and distills an
    observation citing the resolution event — so \`nahel recall\` finds it.

  nahel roadmap ticket close <ref> --reason <why> (--out-of-scope | --invalidated-by <ref>)
    Rule the question away, stating WHICH disposition it is. Under either one
    it never becomes a decision.
      --out-of-scope: ruled beyond the destination — adds the reason as one
        line in the map's Out of scope section, which never graduates.
      --invalidated-by <ticket-or-event-id>: another decision answered the
        question out of existence — records that ref on the ticket, and the map
        shows it beside Decisions so far. It was never beyond the destination,
        so no line is added to the section above.

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
    },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    throw new UsageError("roadmap ticket update takes exactly one <ref> (a ticket id)");
  }
  if (values["blocked-by"] !== undefined && values["clear-blockers"] === true) {
    throw new UsageError(
      "--blocked-by and --clear-blockers are mutually exclusive — pass one or the other",
    );
  }
  const setFlags = ["type", "question", "blocked-by"] as const;
  if (
    !setFlags.some((flag) => values[flag] !== undefined) &&
    values["clear-blockers"] !== true
  ) {
    throw new UsageError(
      "nothing to update — pass at least one of --type, --question, --blocked-by, --clear-blockers",
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
 * The observation `resolve` distills (F7). Its BODY carries the decision on
 * the first line — what `nahel recall` prints as the fact — then the question
 * and the map's destination, because `distill` is about to throw the ticket's
 * own copy of the question away and the decision must stay readable from
 * `recall` and `progress` alone.
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
  eventId: string,
  now: string,
  id: string,
): { frontmatter: ObservationFrontmatter; body: string } {
  const lines = [
    decision,
    "",
    `Decided by resolving ${ticket.type} ticket ${ticket.id}, charting: ${destination}`,
  ];
  if (question !== "") lines.push(`Question: ${question}`);
  return {
    frontmatter: {
      id,
      name: `decision-${ticket.id}`,
      created: now,
      tags: ["decision", ticket.type],
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

/** `resolve <ref> --decision <one-liner>`. */
function parseResolveArgs(args: string[]): { ref: string; decision: string } {
  const { values, positionals } = parseArgs({
    args,
    options: { decision: { type: "string" } },
    allowPositionals: true,
  });
  return {
    ref: onlyPositional(positionals, "resolve"),
    decision: requireOneLineText(
      values.decision,
      "--decision",
      "a resolution IS its decision — pass a non-empty --decision <one-liner> (it is journaled, indexed on the map, and distilled into an observation)",
    ),
  };
}

/**
 * How a close disposes of the question — the two cases F7's close row names,
 * and the reason they cannot share one spelling:
 *
 * - `out-of-scope`: ruled BEYOND the destination. Gains a line in the map's Out
 *   of scope, which is the section that keeps the map from growing without
 *   bound; entries there never graduate.
 * - `invalidated`: another decision answered the question out of existence. It
 *   was never beyond the destination, so an Out-of-scope line would be false —
 *   the invalidating ref goes on the TICKET, and the map renders it beside
 *   Decisions so far, derived from the tickets rather than stored a second time.
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
      "a close states WHICH disposition it is: --out-of-scope (ruled beyond the destination — it gains a " +
        "line in the map's Out of scope) or --invalidated-by <ticket-or-event-id> (another decision " +
        "answered the question out of existence — it was never beyond the destination, so no Out-of-scope " +
        "line is written)",
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
 * `resolve`: the decision, the ticket, the observation and the map's index
 * line, under ONE write-ahead event (F7). The event id is minted first because
 * the observation's `sources` must cite the very event carrying it.
 */
async function ticketResolve(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const { ref, decision } = parseResolveArgs(args);
  const ctx = await commandContext(cwd, env, actorOverride);
  const current = await requireTicket(ctx.layout, ref);
  requireState(current.frontmatter, ["open", "claimed"], "resolve");
  const map = await readMap(ctx.layout, current.frontmatter.map);

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
    eventId,
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
      {
        target: "map",
        frontmatter: {
          ...map.frontmatter,
          decisions: [...map.frontmatter.decisions, { ticket: resolved.id, decision }],
          updated: now,
        },
        body: map.body,
      },
    ],
  });
  await closeStoreContext(ctx);
  return 0;
}

/**
 * `close`: rule the question away, saying WHICH way (see CloseDisposition).
 * The ticket and — for an out-of-scope ruling — the map's Out of scope line
 * ride one event, the same shape `resolve` does. A closed question never
 * becomes a decision under either disposition, so nothing is indexed in
 * Decisions so far and nothing is distilled.
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
  const map = await readMap(ctx.layout, current.frontmatter.map);

  const now = ctx.env.now();
  const { claimant: _released, ...rest } = current.frontmatter;
  const closed: TicketFrontmatter = {
    ...rest,
    state: "closed",
    reason,
    ...(disposition.kind === "invalidated" ? { invalidated_by: disposition.by } : {}),
    updated: now,
  };
  // An invalidated close touches only the ticket: the map already carries the
  // decision that killed the question, and renders the death beside it.
  const writes: SequenceWrite[] = [{ target: "ticket", frontmatter: closed, body: current.body }];
  if (disposition.kind === "out-of-scope") {
    writes.push({
      target: "map",
      frontmatter: {
        ...map.frontmatter,
        out_of_scope: [...map.frontmatter.out_of_scope, { reason, ticket: rest.id }],
        updated: now,
      },
      body: map.body,
    });
  }
  await mutate(ctx, {
    target: "sequence",
    eventType: CORE_EVENT_TYPES.ticketClosed,
    eventId: generateId(ctx.env),
    writes,
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

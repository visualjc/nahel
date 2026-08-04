import { dirname, relative } from "node:path";
import { parseArgs } from "node:util";
import type { Env } from "../schema/env";
import {
  CORE_EVENT_TYPES,
  MIGRATION_ATTRIBUTION_PAYLOAD_KEY,
  MIGRATION_INCLUDED_PAYLOAD_KEY,
  MIGRATION_NODES_PAYLOAD_KEY,
  MIGRATION_SELECTED_EVENT_TYPE,
  MIGRATION_SELECTION_PAYLOAD_KEY,
  MIGRATION_SUPERSEDED_REASON_KEY,
} from "../schema/events";
import { generateId, ID_PATTERN } from "../schema/id";
import type { JournalEvent, RoadmapNodeFrontmatter } from "../schema/records";
import { readJournal } from "../store/journal";
import {
  failedRoadmapNodePath,
  readMaps,
  readRoadmapNodes,
  roadmapNodePath,
  type StoreLayout,
} from "../store/layout";
import {
  closeStoreContext,
  mutate,
  pendingRoadmapNodes,
  type SequenceWrite,
} from "../store/mutate";
import { commandContext, UsageError } from "./item";

/**
 * `nahel roadmap migration supersede` (PR #26 follow-up C3): a migration
 * attempt declared failed, and its nodes retired.
 *
 * The gap it closes is specific. A migration is once per store, unrepeatable,
 * and journal-first — and until now the only way to undo a bad one was
 * `git revert`, on a store whose entire claim is that it records what happened.
 * The journal would then show an attempt with no account of why it went away.
 *
 * Three rules shape the act. **The journal is untouched**: the selection and
 * every node creation stay exactly where they are, and this appends the
 * retirement beside them — a correction, never a deletion. **The records move,
 * they do not vanish**: each attributed node record goes under
 * `nahel/roadmap/failed/<selection-event-id>/`, where no list, view or check
 * reads it (listRecordIds scans one level for `*.md`) and a human still can.
 * And **it refuses to strand later work**: if any node or map outside the
 * attempt points at one of these records, the act names the blocker and writes
 * nothing, because retiring a record something else references would leave the
 * store holding a link to a node that no longer renders.
 *
 * It is a write-ahead SEQUENCE, the same machinery archival rides (F10): one
 * event carrying every document step, so a kill anywhere leaves the journal
 * ahead of the filesystem — the single crash shape `validate --repair` rolls
 * forward, one idempotent move at a time.
 *
 * **What a supersession retires is AUTHORITY, and only sometimes records.**
 * That distinction was learned from a blocker: the workflow journals the set
 * FIRST and creates the product node BEFORE any feature node, and neither of
 * those carries an attribution — the product node covers no work item. So the
 * two ordinary crash shapes of a migration in progress (killed after the set;
 * killed after the product node) leave an attempt with nothing attributed, and
 * a verb that refused those left the store unable to migrate at all: the
 * stranded attempt stayed active forever, and no fresh selection could follow
 * it. Retiring an attempt that created nothing is a real act with a real
 * consequence — the store gets its next migration back — so it is allowed, and
 * gated on ACKNOWLEDGEMENT rather than on refusal: `--nothing-to-move` says the
 * operator knows no record will move. Without it the refusal stands, because
 * the same state is reached by a finished pre-attribution migration, and
 * "supersede" read as "undo" would retire a good one's authority by reflex.
 *
 * **The store must be CONVERGED before anything is retired.** A retirement is
 * computed from the journal (which nodes the attempt is attributed) and the
 * disk (which records exist, and what still links to them) at once, so while a
 * roadmap-node write is still pending those two answers describe different
 * stores — and a node in neither answer is invisible to this verb by design.
 * That is a real hole, not a hypothetical: a product node whose creation event
 * journaled and whose record write died is unattributed AND absent, so a
 * retirement sails past it, the retry charts a replacement product, and a later
 * `validate --repair` materializes the first one on top. Two live product
 * nodes, and nothing fails, because more than one product node is schema-legal.
 *
 * The answer is a PRECONDITION rather than a sweep for ghosts: refuse while
 * `pendingRoadmapNodes` finds anything, and say to repair first. After repair
 * the materialized record is visible to the operator and to step 4's
 * create-or-reuse, so the semantics that already exist compose correctly and
 * this verb needs no machinery for records nobody has written yet.
 *
 * The precondition is about divergence that PRE-DATES the supersession. The
 * supersession's OWN crash windows are a separate thing, covered by its own
 * write-ahead sequence and unchanged by any of this.
 */

export const MIGRATION_USAGE = `  nahel roadmap migration supersede <selection-event-id> --reason <why>
                                    [--nothing-to-move]
    Retire a failed migration attempt: journal the supersession naming the
    attempt and the reason, and move every node record attributed to it under
    nahel/roadmap/failed/<selection-event-id>/, where nothing renders it.
    The journal keeps the attempt and its nodes' creation events exactly as
    they were. Refused when the id names no ${MIGRATION_SELECTED_EVENT_TYPE}
    event, when that attempt was already superseded, or when a later node or
    map still points at one of the records it would retire.
      --nothing-to-move: acknowledge that the attempt has NO attributed node,
        so only its authority is retired and no record moves — the shape an
        attempt killed before its first feature node leaves. Required for that
        case, because the same state is what a finished migration made before
        attribution existed looks like.
    After it, the store has no active migration and exactly one fresh
    selection may follow.`;

/** The stamp a retired record carries: which act moved it here, and why. */
function supersedeStamp(selection: string, reason: string, eventId: string): string {
  return [
    "> **Superseded — the migration that created this node was retired.**",
    ">",
    `> - Migration: selection event ${selection}`,
    `> - Retired by: event ${eventId}`,
    `> - Reason: ${reason}`,
    ">",
    "> This record is parked, not deleted: no roadmap view reads it, and the",
    "> journal still carries the attempt that created it. A fresh migration",
    "> charts its own nodes; this one is never moved back.",
  ].join("\n");
}

/** Everything the act needs from the journal, in one pass. */
interface Attempt {
  selection: JournalEvent;
  /** Ids of the nodes whose creation events name this selection. */
  attributed: string[];
}

/**
 * Resolve the attempt named on the command line, refusing every state that is
 * not an ACTIVE attempt. Each refusal names the fact it is refusing on, because
 * the recovery differs: a wrong id is retyped, and an already-superseded
 * attempt needs `validate --repair` at most. Whether the attempt has records to
 * move is not a refusal here — it decides which acknowledgement the caller owes.
 */
async function resolveAttempt(layout: StoreLayout, id: string): Promise<Attempt> {
  if (!ID_PATTERN.test(id)) {
    throw new UsageError(
      `${JSON.stringify(id)} is not an event id — pass the id of the ` +
        `${MIGRATION_SELECTED_EVENT_TYPE} event the failed attempt journaled`,
    );
  }
  let selection: JournalEvent | undefined;
  let retiredBy: JournalEvent | undefined;
  const attributed: string[] = [];
  for await (const event of readJournal(layout)) {
    if (event.id === id) selection = event;
    if (
      event.type === CORE_EVENT_TYPES.migrationSuperseded &&
      event.payload[MIGRATION_SELECTION_PAYLOAD_KEY] === id
    ) {
      retiredBy = event;
    }
    if (
      event.type === CORE_EVENT_TYPES.roadmapNodeCreated &&
      event.payload[MIGRATION_ATTRIBUTION_PAYLOAD_KEY] === id
    ) {
      const record = event.payload["record"];
      const nodeId =
        record !== null && typeof record === "object"
          ? (record as { id?: unknown }).id
          : undefined;
      if (typeof nodeId === "string") attributed.push(nodeId);
    }
  }
  if (selection === undefined) {
    throw new UsageError(
      `${id} names no event in this store's journal — pass the id of the ` +
        `${MIGRATION_SELECTED_EVENT_TYPE} event the failed attempt journaled`,
    );
  }
  if (selection.type !== MIGRATION_SELECTED_EVENT_TYPE) {
    throw new UsageError(
      `${id} names a ${selection.type} event, not a ${MIGRATION_SELECTED_EVENT_TYPE} — ` +
        "supersession retires a migration ATTEMPT, which is the selected set it journaled first",
    );
  }
  if (retiredBy !== undefined) {
    throw new UsageError(
      `migration ${id} was already superseded by event ${retiredBy.id} — an attempt is retired ` +
        "once, and a second retirement would claim a second act that never happened (if its records " +
        "are still in place, `nahel validate --repair` completes the move)",
    );
  }
  return { selection, attributed: [...attributed].sort() };
}

/**
 * The included ids one selection declared, read leniently — this is an advisory
 * listing, not the audit. `validate`'s `roadmap.migration-audit` is where a
 * malformed set is judged; refusing to print a hint because the payload is odd
 * would withhold help exactly when the operator needs it most.
 */
function includedIds(selection: JournalEvent): Set<string> {
  const raw = selection.payload[MIGRATION_INCLUDED_PAYLOAD_KEY];
  return new Set(
    (Array.isArray(raw) ? raw : []).filter((id): id is string => typeof id === "string"),
  );
}

/**
 * Every reference from OUTSIDE the attempt into it — the reason the act is
 * refused rather than completed. A link to a record no view reads is a link
 * that goes nowhere, and nothing downstream could tell that state apart from
 * corruption; the honest answer is to name what points where and leave the
 * store exactly as it was.
 */
function blockers(
  nodes: readonly { frontmatter: RoadmapNodeFrontmatter }[],
  maps: readonly { frontmatter: { id: string; node: string } }[],
  retiring: ReadonlySet<string>,
): string[] {
  const found: string[] = [];
  for (const { frontmatter } of nodes) {
    if (retiring.has(frontmatter.id)) continue;
    for (const [field, target] of [
      ["parent", frontmatter.parent],
      ["predecessor", frontmatter.predecessor],
      ...(frontmatter.features ?? []).map((id) => ["feature", id] as const),
    ] as const) {
      if (target !== undefined && retiring.has(target)) {
        found.push(`node ${frontmatter.name} (${frontmatter.id}) — ${field}=${target}`);
      }
    }
  }
  for (const { frontmatter } of maps) {
    if (retiring.has(frontmatter.node)) {
      found.push(`map ${frontmatter.id} — node=${frontmatter.node}`);
    }
  }
  return found.sort();
}

async function supersede(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { reason: { type: "string" }, "nothing-to-move": { type: "boolean" } },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    throw new UsageError(
      "roadmap migration supersede takes exactly one <selection-event-id> — the attempt to retire",
    );
  }
  const reason = values.reason;
  if (reason === undefined || reason.trim() === "") {
    throw new UsageError(
      "a retirement says why — pass a non-empty --reason. A migration nobody can account for " +
        "undoing is worse than the attempt it undoes",
    );
  }
  const acknowledged = values["nothing-to-move"] === true;

  const ctx = await commandContext(cwd, env, actorOverride);
  const attempt = await resolveAttempt(ctx.layout, positionals[0]!);
  // CONVERGENCE FIRST, on both paths — see the note above the module. Checked
  // before the acknowledgement, because which acknowledgement is owed is itself
  // a reading of state this store has not finished writing.
  const pending = await pendingRoadmapNodes(ctx.layout);
  if (pending.length > 0) {
    throw new UsageError(
      `this store carries journal-ahead roadmap state: ${pending.length} roadmap node record(s) ` +
        "are behind the events that record them — " +
        pending
          .map(({ id, eventId, eventType }) => `${id} (${eventType} ${eventId})`)
          .join("; ") +
        ". Retiring an attempt now would scope the retirement to a store that does not exist yet, " +
        "and repair would materialize those records afterwards, over whatever a retry had charted " +
        "in the meantime. Run `nahel validate --repair`, then run this command again — the " +
        "materialized records are then visible to you and to the retry's create-or-reuse step alike",
    );
  }
  // The acknowledgement and the store have to agree, both ways. An attempt with
  // no attributed record is retired only when the caller SAID so, because the
  // same state is what a finished pre-attribution migration looks like and
  // "supersede" read as "undo" would retire a good one's authority by reflex.
  // And the flag on an attempt that does have records is a caller describing a
  // store they are not looking at, so it is refused rather than ignored.
  if (attempt.attributed.length === 0 && !acknowledged) {
    throw new UsageError(
      `migration ${attempt.selection.id} has no attributed node — no ` +
        `\`${CORE_EVENT_TYPES.roadmapNodeCreated}\` event carries ` +
        `\`${MIGRATION_ATTRIBUTION_PAYLOAD_KEY}=${attempt.selection.id}\`, so there is no record to ` +
        "move. Two different stores look like this, and they want opposite things:\n" +
        "  - an attempt INTERRUPTED before its first feature node (the set is journaled, maybe a " +
        "product node exists, nothing else). Retiring its authority is what lets a fresh selection " +
        "follow, so re-run with `--nothing-to-move`;\n" +
        "  - a FINISHED migration made before attribution existed, whose nodes are real and correct. " +
        "It needs no repair, and retiring it would take the authority off a migration that succeeded.",
    );
  }
  if (attempt.attributed.length > 0 && acknowledged) {
    throw new UsageError(
      `--nothing-to-move says this attempt created no node, but ${attempt.attributed.length} node ` +
        `record(s) are attributed to migration ${attempt.selection.id} (${attempt.attributed.join(", ")}) — ` +
        "drop the flag and they are retired with it",
    );
  }
  const retiring = new Set(attempt.attributed);
  const nodes = await readRoadmapNodes(ctx.layout);
  const stranded = blockers(nodes, await readMaps(ctx.layout), retiring);
  if (stranded.length > 0) {
    throw new UsageError(
      `migration ${attempt.selection.id} cannot be superseded: ${stranded.length} record(s) outside ` +
        `the attempt point at nodes it would retire — ${stranded.join("; ")}. Retiring them would ` +
        "leave those links pointing at records nothing renders, so re-point or remove them first",
    );
  }

  const eventId = generateId(ctx.env);
  const header = supersedeStamp(attempt.selection.id, reason, eventId);
  // One document move per attributed record, in id order so the sequence a
  // crash is measured against is the same on every machine. Records the store
  // no longer holds are skipped rather than moved: nothing is there to move,
  // and `validate` owns the absence itself.
  const present = new Set(nodes.map(({ frontmatter }) => frontmatter.id));
  const writes: SequenceWrite[] = attempt.attributed
    .filter((id) => present.has(id))
    .map((id) => ({
      target: "document",
      edit: {
        op: "move",
        from: relative(ctx.layout.root, roadmapNodePath(ctx.layout, id)),
        to: relative(
          ctx.layout.root,
          failedRoadmapNodePath(ctx.layout, attempt.selection.id, id),
        ),
        header,
      },
    }));

  await mutate(ctx, {
    target: "sequence",
    eventType: CORE_EVENT_TYPES.migrationSuperseded,
    eventId,
    writes,
    extraPayload: {
      [MIGRATION_SELECTION_PAYLOAD_KEY]: attempt.selection.id,
      [MIGRATION_SUPERSEDED_REASON_KEY]: reason,
      // Every attributed node, including any whose record was already gone:
      // the payload is what replay and validate read to know a record is
      // retired ON PURPOSE, and an id left out of it would be resurrected.
      [MIGRATION_NODES_PAYLOAD_KEY]: attempt.attributed,
    },
  });
  await closeStoreContext(ctx);
  const first = attempt.attributed[0];
  const parked =
    first === undefined
      ? undefined
      : dirname(
          relative(ctx.layout.root, failedRoadmapNodePath(ctx.layout, attempt.selection.id, first)),
        );
  console.log(
    `✅ superseded migration ${attempt.selection.id} — authority retired, ` +
      `${writes.length} node record(s) moved${parked === undefined ? "" : ` to ${parked}/`} ` +
      "(the journal keeps the attempt; a fresh selection may follow)",
  );
  // The leftovers an authority-only retirement cannot reason about: live nodes
  // covering an id the retired set named. They are not the attempt's by
  // attribution — the verb has no standing to move them — but they are plainly
  // about the same work, and a retry that silently charts a second node for the
  // same epic is the collision this whole review is about. Advisory, and named.
  if (writes.length === 0) {
    const included = includedIds(attempt.selection);
    const leftovers = nodes.filter(
      ({ frontmatter }) => frontmatter.epic !== undefined && included.has(frontmatter.epic),
    );
    if (leftovers.length > 0) {
      console.log(
        `⚠️  ${leftovers.length} live node(s) still cover an id the retired set named — not this ` +
          "attempt's by attribution, so nothing was moved, but look before you re-migrate:",
      );
      for (const { frontmatter } of leftovers) {
        console.log(`  ${frontmatter.name} (${frontmatter.id}) — epic=${frontmatter.epic}`);
      }
    }
  }
  return 0;
}

/** Dispatch `nahel roadmap migration <verb>`. One verb today, named explicitly. */
export async function runMigrationSubcommand(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const [verb, ...rest] = args;
  if (verb === "supersede") return supersede(rest, env, cwd, actorOverride);
  throw new UsageError(
    verb === undefined
      ? "missing subcommand — expected `roadmap migration supersede <selection-event-id> --reason <why>`"
      : `unknown subcommand ${JSON.stringify(verb)} — expected supersede`,
  );
}

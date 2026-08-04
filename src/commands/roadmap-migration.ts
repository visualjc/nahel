import { dirname, relative } from "node:path";
import { parseArgs } from "node:util";
import type { Env } from "../schema/env";
import {
  CORE_EVENT_TYPES,
  MIGRATION_ATTRIBUTION_PAYLOAD_KEY,
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
import { closeStoreContext, mutate, type SequenceWrite } from "../store/mutate";
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
 */

export const MIGRATION_USAGE = `  nahel roadmap migration supersede <selection-event-id> --reason <why>
    Retire a failed migration attempt: journal the supersession naming the
    attempt and the reason, and move every node record attributed to it under
    nahel/roadmap/failed/<selection-event-id>/, where nothing renders it.
    The journal keeps the attempt and its nodes' creation events exactly as
    they were. Refused when the id names no ${MIGRATION_SELECTED_EVENT_TYPE}
    event, when that attempt was already superseded, when it has no attributed
    node to move, or when a later node or map still points at one of them.
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
 * not "an active attempt with records to move". Each refusal names the fact it
 * is refusing on, because the recovery differs: a wrong id is retyped, an
 * already-superseded attempt needs `validate --repair` at most, and a
 * pre-attribution attempt cannot be retired by this verb at all.
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
  if (attributed.length === 0) {
    throw new UsageError(
      `migration ${id} has no attributed node — no \`${CORE_EVENT_TYPES.roadmapNodeCreated}\` event ` +
        `carries \`${MIGRATION_ATTRIBUTION_PAYLOAD_KEY}=${id}\`, so this verb has nothing to retire. ` +
        "Either the attempt created no node yet, or it predates attribution: a supersession that " +
        "moved no record while declaring the attempt undone would be exactly the false history the " +
        "journal exists to prevent",
    );
  }
  return { selection, attributed: [...attributed].sort() };
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
    options: { reason: { type: "string" } },
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

  const ctx = await commandContext(cwd, env, actorOverride);
  const attempt = await resolveAttempt(ctx.layout, positionals[0]!);
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
  const parked = dirname(
    relative(
      ctx.layout.root,
      failedRoadmapNodePath(ctx.layout, attempt.selection.id, attempt.attributed[0]!),
    ),
  );
  console.log(
    `✅ superseded migration ${attempt.selection.id} — ${writes.length} node record(s) moved to ` +
      `${parked}/ (the journal keeps the attempt; a fresh selection may follow)`,
  );
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

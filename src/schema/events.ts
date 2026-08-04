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
  itemStartedBlocked: "item.started-with-open-blocker",
  runStarted: "run.started",
  runUpdated: "run.updated",
  runEnded: "run.ended",
  runPaused: "run.paused",
  itemClaimed: "item.claimed",
  itemHandback: "item.handback",
  observationCreated: "observation.created",
  roadmapNodeCreated: "roadmap.node-created",
  roadmapNodeUpdated: "roadmap.node-updated",
  mapCreated: "roadmap.map-created",
  mapUpdated: "roadmap.map-updated",
  ticketCreated: "roadmap.ticket-created",
  ticketUpdated: "roadmap.ticket-updated",
  ticketClaimed: "roadmap.ticket-claimed",
  ticketReleased: "roadmap.ticket-released",
  ticketResolved: "roadmap.ticket-resolved",
  ticketClosed: "roadmap.ticket-closed",
  ticketDistilled: "roadmap.ticket-distilled",
  prdArchived: "roadmap.prd-archived",
  migrationSuperseded: "roadmap.migration-superseded",
  note: "note",
} as const;

export type CoreEventType = (typeof CORE_EVENT_TYPES)[keyof typeof CORE_EVENT_TYPES];

/**
 * The config-replacement event (`nahel config set`, PRD F4). Deliberately
 * NOT a core mutation type — it replaces a `nahel/config` section, not a
 * record mutate() replays — but named here because more than one layer keys
 * on it: `config set` writes it, and the merge-authority provenance check
 * (PRD F3.4) reads it to prove WHO flipped `merge: on-approve`. Payload:
 * `{section, value}`.
 */
export const CONFIG_UPDATED_EVENT_TYPE = "config.updated";

/**
 * `itemStartedBlocked` (Phase 4 F8, the anti-waterfall rule): a work item
 * deliberately STARTED while one of its `depends_on` targets was still live.
 * Blocking is advisory everywhere — no command refuses work because a blocker
 * is open — so the start succeeds and the event names every open blocker in its
 * `blockers` payload (with `from`, the status the item left), which makes the
 * choice visible rather than prevented.
 *
 * It is a CORE MUTATION type rather than an open extension: for this one
 * transition it REPLACES `item.updated` as the write-ahead event the choke point
 * journals before the record write, carrying its extras alongside the usual
 * replay fields — the `item.claimed` baseline precedent, where what a verb wants
 * to say rides the mutation event instead of getting an append of its own.
 *
 * Advisory means "permit the start", never "the provenance may disappear". As a
 * second append after the mutation it would be a note a kill could drop, and
 * what that leaves is undetectable: a blocked start recorded as an ordinary one,
 * whose `item.updated` already matches disk, so `validate --repair` has nothing
 * to roll forward. As the mutation event itself it inherits the ONE crash shape
 * the store already heals — the journal ahead of the record — annotation
 * included. Every reader that learns mutation types by NAME has to know it:
 * MUTATION_EVENT_TYPES below (replay, divergence) and views/standup.ts's
 * item-record set (movement).
 *
 * Being a mutation type also makes it self-recorded, so `nahel log` refuses it:
 * a type an agent could hand-append is a type an agent could write without
 * starting anything — or start without writing.
 */

/**
 * The mutation subset of the core types: exactly the events the store's
 * mutate() choke point write-ahead journals (item and run record changes).
 * Replay and validation key mutation detection on membership HERE — payload
 * shape (target/record/body) is a validity check WITHIN these types, never
 * the trigger — so a mutation-shaped payload under `note` or any open
 * extension type is inert data, not a replayable mutation. `nahel log`
 * refuses these types outright: mutations self-record through mutate().
 */
export const MUTATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  CORE_EVENT_TYPES.itemCreated,
  CORE_EVENT_TYPES.itemUpdated,
  CORE_EVENT_TYPES.itemStartedBlocked,
  CORE_EVENT_TYPES.itemClaimed,
  CORE_EVENT_TYPES.itemHandback,
  CORE_EVENT_TYPES.runStarted,
  CORE_EVENT_TYPES.runUpdated,
  CORE_EVENT_TYPES.runEnded,
  CORE_EVENT_TYPES.runPaused,
  CORE_EVENT_TYPES.observationCreated,
  CORE_EVENT_TYPES.roadmapNodeCreated,
  CORE_EVENT_TYPES.roadmapNodeUpdated,
  CORE_EVENT_TYPES.mapCreated,
  CORE_EVENT_TYPES.mapUpdated,
  CORE_EVENT_TYPES.ticketCreated,
  CORE_EVENT_TYPES.ticketUpdated,
  CORE_EVENT_TYPES.ticketClaimed,
  CORE_EVENT_TYPES.ticketReleased,
  CORE_EVENT_TYPES.ticketResolved,
  CORE_EVENT_TYPES.ticketClosed,
  CORE_EVENT_TYPES.ticketDistilled,
  CORE_EVENT_TYPES.prdArchived,
  CORE_EVENT_TYPES.migrationSuperseded,
]);

/**
 * `roadmap.prd-archived` (Phase 4 F10): the ONE write-ahead event a PRD
 * archival rides. It is a sequence mutation like `resolve` and `close`, but a
 * longer one — the feature node's link, the authoring plan item's `prd`, the
 * epic's, every further record sharing the path, AND the two DOCUMENT steps
 * (the PRD's move-and-stamp, the product design doc's line) that reach outside
 * the store's records. Carrying the documents in the same event is what makes
 * the file work write-ahead rather than a side effect: a kill anywhere leaves
 * the journal ahead of the filesystem, which `validate --repair` rolls forward.
 */

/**
 * The wayfinder mutation types (F7), each named by the verb that writes it —
 * the PRD's transition table, one row per entry. Three of them are MULTI-RECORD
 * sequences: `resolve` writes the ticket, the decision observation and the
 * map's index line under one event, and `close` writes the ticket and the map's
 * out-of-scope line, so an interruption anywhere in the sequence leaves the
 * journal ahead of the records — the one crash shape replay already heals.
 */
export const WAYFINDER_EVENT_TYPES: ReadonlyMap<string, string> = new Map([
  [CORE_EVENT_TYPES.mapCreated, "`nahel roadmap map new`"],
  [CORE_EVENT_TYPES.mapUpdated, "`nahel roadmap map update`"],
  [CORE_EVENT_TYPES.ticketCreated, "`nahel roadmap ticket new`"],
  [CORE_EVENT_TYPES.ticketUpdated, "`nahel roadmap ticket update`"],
  [CORE_EVENT_TYPES.ticketClaimed, "`nahel roadmap ticket claim`"],
  [CORE_EVENT_TYPES.ticketReleased, "`nahel roadmap ticket release`"],
  [CORE_EVENT_TYPES.ticketResolved, "`nahel roadmap ticket resolve`"],
  [CORE_EVENT_TYPES.ticketClosed, "`nahel roadmap ticket close`"],
  [CORE_EVENT_TYPES.ticketDistilled, "`nahel roadmap ticket distill`"],
]);

/**
 * `nahel roadmap ack` (Phase 4 F5): the human saying "seen" about the roadmap.
 * Deliberately NOT a core mutation type — it changes no record, which is the
 * whole point of the verb — but reserved all the same, because the
 * awaiting-your-eyes surface reads it by TYPE to decide whether agent-authored
 * roadmap acts have been looked at, exactly as merge authority reads
 * `config.updated` to decide who authorized auto-merge. Payload: `{}`.
 */
export const ROADMAP_ACKED_EVENT_TYPE = "roadmap.acked";

/** The dispatch bracket: intent (carrying the composed invocation) and outcome. */
export const DISPATCH_STARTED_EVENT_TYPE = "dispatch.started";
export const DISPATCH_ENDED_EVENT_TYPE = "dispatch.ended";

/** One-per-invocation summary of what the import did (the config.updated precedent). */
export const IMPORT_COMPLETED_EVENT_TYPE = "import.completed";
/** A per-anomaly note: unmappable status, github-mapping mismatch, dropped dependency, unreferenced PRD. */
export const IMPORT_NOTE_EVENT_TYPE = "import.note";
/** A PRD relocated into docs/prds/, its stripped status preserved in this event (ADR-0013 as amended). */
export const IMPORT_PRD_RELOCATED_EVENT_TYPE = "import.prd-relocated";
/** The open-extension event type recording a distill act. */
export const DISTILLED_EVENT_TYPE = "journal.distilled";

/**
 * The three OPEN-EXTENSION types the roadmap's event-sourced columns read
 * (Phase 4 F2). All three are recorded by workflows through `nahel log`, never
 * self-recorded by a command, so none belongs in SELF_RECORDED_EVENT_TYPES —
 * a logged event can therefore never masquerade as a record mutation.
 *
 * `qa.sweep-completed` is the whole-sweep summary, written exactly once per
 * sweep (Phase 3 F6, qa-lane.md). The per-case types (`qa.result`,
 * `qa.finding`, `qa.probe`) are a different SCOPE and are deliberately never
 * read as a sweep — promoting a per-case event would report one case as if it
 * were the whole run. The constant lives HERE rather than beside one reader
 * because two views now key on it: `brief`'s QA line and the roadmap's QA
 * column.
 *
 * `deploy.completed` and `release.announced` are F9's lifecycle types, carrying
 * a feature past its own development; F2 owns the derivation that reads them.
 */
export const QA_SWEEP_EVENT_TYPE = "qa.sweep-completed";
export const DEPLOY_COMPLETED_EVENT_TYPE = "deploy.completed";
export const RELEASE_ANNOUNCED_EVENT_TYPE = "release.announced";

/**
 * `roadmap.column-retracted` (PR #26 follow-up A1): the withdrawal of ONE of
 * the three lifecycle facts above — a sweep summarised from the wrong run, a
 * deploy logged against the wrong epic, a release announced early.
 *
 * An open-extension type like the facts it corrects, so it is logged through
 * `nahel log` and never self-recorded. It is a correction, not a deletion: the
 * journal stays append-only and the retracted line stays exactly where it was.
 * What changes is the DERIVATION — the named event leaves column-winner
 * computation, and the winner is recomputed from the survivors, so retracting
 * the latest sweep promotes the one before it rather than emptying the column.
 *
 * Payload `{event, reason}`. The `event` id is the whole causal edge: NOT the
 * retraction's timestamp (a retraction logged before the fact it names still
 * removes it — the two can arrive in either order across a merge), and not its
 * `item` ref (coverage is the retracted FACT's business). `reason` is prose for
 * the human reading the correction back, and `validate` warns when it is blank
 * — a withdrawal nobody can account for is worse than the fact it withdraws.
 *
 * Only the three types above may be named. A retraction of an item mutation,
 * of another retraction, or of an id no event carries is structurally invalid:
 * `validate` names it and the derivation ignores it. Retraction is IDEMPOTENT
 * (an id is in the retracted set or it is not), and there is no un-retraction:
 * a mis-retraction is corrected by RE-LOGGING the original fact, which is a new
 * event with a new id that no retraction names.
 */
export const ROADMAP_COLUMN_RETRACTED_EVENT_TYPE = "roadmap.column-retracted";

/** The retraction payload keys: the fact it withdraws, and why. */
export const RETRACTION_EVENT_PAYLOAD_KEY = "event";
export const RETRACTION_REASON_PAYLOAD_KEY = "reason";

/**
 * `roadmap.migration-selected` (Phase 4 F6): the complete selected set a
 * roadmap migration journals as its FIRST act — `included`, every work-item id
 * that gets a feature node, and `excluded`, every near-miss as `{id, reason}`.
 *
 * An OPEN-EXTENSION type: the selection is a judgment, and the CLI never judges
 * (HC1), so the migrating agent records it through `nahel log` exactly as
 * `nahel/workflows/migrate-roadmap.md` instructs. Named here because two
 * readers now key on it — the audit below, and the supersession that retires an
 * attempt — and a set spelled two ways is a set no reviewer can read back.
 */
export const MIGRATION_SELECTED_EVENT_TYPE = "roadmap.migration-selected";
/** Its payload keys: the ids that get nodes, and the near-misses with reasons. */
export const MIGRATION_INCLUDED_PAYLOAD_KEY = "included";
export const MIGRATION_EXCLUDED_PAYLOAD_KEY = "excluded";
/** The key inside one `excluded` entry that carries why it was ruled out. */
export const MIGRATION_EXCLUSION_REASON_KEY = "reason";

/**
 * Migration ATTRIBUTION (PR #26 follow-up C2): the payload key a
 * `roadmap.node-created` event carries when the node was created BY a
 * migration, naming the selection event it was created for
 * (`nahel roadmap node new ... --migration <selection-event-id>`).
 *
 * It rides the creation event rather than the node record because it is a fact
 * about the ACT, not about the intent: the node states what the product is
 * meant to do, and it would still state exactly that had it been charted by
 * hand. Attribution is also what keeps the audit honest without a heuristic —
 * ordinary charting after a migration carries nothing, so later nodes are
 * invisible to the audit by construction rather than by a time window.
 */
export const MIGRATION_ATTRIBUTION_PAYLOAD_KEY = "migration";

/**
 * `CORE_EVENT_TYPES.migrationSuperseded` (PR #26 follow-up C3): a migration
 * attempt declared failed, and its nodes retired — the recovery that used to
 * require `git revert` on a store whose whole claim is that it records what
 * happened.
 *
 * SELF-RECORDED and a MUTATION type, because it is one: the act moves every
 * attributed node record under `nahel/roadmap/failed/<selection-event-id>/` in
 * a write-ahead sequence, so a kill anywhere leaves the journal ahead of the
 * filesystem — the one crash shape `validate --repair` rolls forward. A
 * loggable supersession would be a supersession an agent could claim without
 * moving anything.
 *
 * Payload `{selection, reason, nodes}`: the attempt it retires, why (prose for
 * the human reading it back), and the node ids it moved. The journal keeps the
 * failed attempt exactly where it was — a supersession is a correction, never a
 * deletion — and after one there is NO active selection, so exactly one fresh
 * selection may follow.
 */
/** Its payload keys: the retired attempt, why it was retired, and what moved. */
export const MIGRATION_SELECTION_PAYLOAD_KEY = "selection";
export const MIGRATION_SUPERSEDED_REASON_KEY = "reason";
export const MIGRATION_NODES_PAYLOAD_KEY = "nodes";

/**
 * The node ids one event RETIRED — the `nodes` a `roadmap.migration-superseded`
 * event moved out of the roadmap, and [] for every other event.
 *
 * Read by both halves of the write-ahead recovery machinery, which is why it
 * lives here rather than beside either one: a retired record is missing ON
 * PURPOSE, so `validate` must not report it as a record behind its creation
 * event and `validate --repair` must not write it back. Getting that wrong in
 * one of the two would make repair and the report disagree about the same
 * store, and a repair that resurrects what an act deliberately retired is worse
 * than no repair at all.
 *
 * Ids are never reused, so retirement is permanent and needs no ordering rule.
 */
export function supersededNodeIds(event: {
  type: string;
  payload: Record<string, unknown>;
}): string[] {
  if (event.type !== CORE_EVENT_TYPES.migrationSuperseded) return [];
  const nodes = event.payload[MIGRATION_NODES_PAYLOAD_KEY];
  return Array.isArray(nodes) ? nodes.filter((id): id is string => typeof id === "string") : [];
}

/**
 * The one payload key of each lifecycle type that a VIEW renders (F9's shapes,
 * F2's render table): a deploy's `environment` and a release's `version`. Named
 * here, beside the types, because the renderer and the glossary that teaches
 * the vocabulary must not drift: a key renamed in code with the docs left
 * behind teaches workflow authors to record a fact no column will ever show.
 *
 * A deploy's `ref` and `shipped` are recorded and read by people, so no
 * constant claims otherwise.
 */
export const DEPLOY_ENVIRONMENT_PAYLOAD_KEY = "environment";
export const RELEASE_VERSION_PAYLOAD_KEY = "version";

/**
 * The rest of a release's documented shape. Machinery reads these two — no view
 * renders them, but the stage word and `nahel roadmap archive` both require
 * them (see RELEASE_REQUIRED_PAYLOAD_KEYS), so they are named rather than left
 * as prose a workflow author could spell any way they liked.
 */
export const RELEASE_CHANNEL_PAYLOAD_KEY = "channel";
export const RELEASE_ANNOUNCEMENT_PAYLOAD_KEY = "announcement";

/**
 * What a WELL-FORMED lifecycle fact carries, in the order a refusal or a
 * finding lists the ones it lacks. Each must be present and NONBLANK: a
 * recorded empty string tells a reader exactly as much as an omitted key.
 *
 * ONE list per type, because more than one judgment rests on it. A release's
 * three keys decide the `released` STAGE WORD *and* whether `nahel roadmap
 * archive` will stamp a delta closed on that release — deliberately the same
 * predicate, since a view promising `released` where the verb refuses is a view
 * that lies about what the store has earned. A deploy's `environment` decides
 * the `deployed` word the same way. (`ref` and `shipped` stay prose for people:
 * nothing derives from them, so nothing demands them.)
 *
 * What this does NOT touch is the render table (F2/F9): the COLUMNS stay
 * permissive and print what the store holds — `released ? <ts>`, `deployed ?
 * <ts>` — because a column shows the fact and the stage says what it earned.
 */
export const RELEASE_REQUIRED_PAYLOAD_KEYS: readonly string[] = [
  RELEASE_VERSION_PAYLOAD_KEY,
  RELEASE_CHANNEL_PAYLOAD_KEY,
  RELEASE_ANNOUNCEMENT_PAYLOAD_KEY,
];

/** The deploy's counterpart: where it went. */
export const DEPLOY_REQUIRED_PAYLOAD_KEYS: readonly string[] = [
  DEPLOY_ENVIRONMENT_PAYLOAD_KEY,
];

/**
 * The `roadmap.prd-archived` payload key naming the release the archival rests
 * on (A3). The stamped header already carries the archival event's id as its
 * journal pointer; this is the other end of the same thread, so a reader
 * landing on the archival act can reach the release that justified it without
 * re-deriving a coverage walk over the whole journal.
 */
export const ARCHIVAL_RELEASE_PAYLOAD_KEY = "release";

/**
 * The prototype lane's acts (Phase 2 F5). Two of them are read back by
 * machinery, not just by humans, which is why they are reserved types rather
 * than free-form notes:
 *
 * - `prototype.variants-created` carries each variant's BASE commit, and the
 *   never-merge check joins on it to tell a freshly created branch (sitting at
 *   its base, trivially reachable from the default branch) apart from one whose
 *   code was actually merged. A forgeable base is a forgeable acquittal.
 * - `prototype.merge-refused` and `prototype.promotion-refused` are the audit
 *   trail of the refusals F5.2/F5.4 demand: a refusal nobody can read back is
 *   prose, not mechanism.
 */
export const PROTOTYPE_VARIANTS_CREATED_EVENT_TYPE = "prototype.variants-created";
/** A merge-bound status flip refused because the item is a prototype (F5.2). */
export const PROTOTYPE_MERGE_REFUSED_EVENT_TYPE = "prototype.merge-refused";
/** A winning variant's mini-PRD handed to the plan lane (F5.3). */
export const PROTOTYPE_PROMOTED_EVENT_TYPE = "prototype.promoted";
/** A promotion refused by the tier ratchet (F5.4). */
export const PROTOTYPE_PROMOTION_REFUSED_EVENT_TYPE = "prototype.promotion-refused";
/** A variant's workspace disposed of, winner or loser (F5.3). */
export const PROTOTYPE_DISPOSED_EVENT_TYPE = "prototype.disposed";

/**
 * Every event type a nahel COMMAND records for itself: the record mutations
 * mutate() journals, the config replacement `config set` journals, and the
 * dispatch bracket `dispatch` journals. `nahel log` refuses all of them, and
 * the reservation is a security boundary, not tidiness: readers trust these
 * types by TYPE alone — the merge-authority provenance check (PRD F3.4) reads
 * `config.updated` to prove WHO authorized auto-merge — so a type an agent
 * could hand-append through `log` is a type an agent could forge. Same
 * discipline as the reserved mutation payload keys (store/mutate.ts).
 */
export const SELF_RECORDED_EVENT_TYPES: ReadonlyMap<string, string> = new Map([
  ...[...MUTATION_EVENT_TYPES].map(
    (type) => [type, "`nahel item`/`nahel run`"] as [string, string],
  ),
  // Later entries win: the roadmap mutations are journaled by their own verb,
  // not by `nahel item`/`nahel run` like the rest of the mutation set.
  [CORE_EVENT_TYPES.roadmapNodeCreated, "`nahel roadmap node`"],
  [CORE_EVENT_TYPES.roadmapNodeUpdated, "`nahel roadmap node`"],
  ...WAYFINDER_EVENT_TYPES,
  [CORE_EVENT_TYPES.prdArchived, "`nahel roadmap archive`"],
  [CORE_EVENT_TYPES.migrationSuperseded, "`nahel roadmap migration supersede`"],
  [ROADMAP_ACKED_EVENT_TYPE, "`nahel roadmap ack`"],
  [CONFIG_UPDATED_EVENT_TYPE, "`nahel config set`"],
  [DISPATCH_STARTED_EVENT_TYPE, "`nahel dispatch`"],
  [DISPATCH_ENDED_EVENT_TYPE, "`nahel dispatch`"],
  [IMPORT_COMPLETED_EVENT_TYPE, "`nahel import`"],
  [IMPORT_NOTE_EVENT_TYPE, "`nahel import`"],
  [IMPORT_PRD_RELOCATED_EVENT_TYPE, "`nahel import`"],
  [DISTILLED_EVENT_TYPE, "`nahel distill`"],
  [PROTOTYPE_VARIANTS_CREATED_EVENT_TYPE, "`nahel prototype`"],
  [PROTOTYPE_PROMOTED_EVENT_TYPE, "`nahel prototype`"],
  [PROTOTYPE_PROMOTION_REFUSED_EVENT_TYPE, "`nahel prototype`"],
  [PROTOTYPE_DISPOSED_EVENT_TYPE, "`nahel prototype`"],
  [PROTOTYPE_MERGE_REFUSED_EVENT_TYPE, "`nahel item`"],
  // Named precisely: it is a mutation type, so the spread above already
  // reserves it — but `nahel run` never writes it, and the refusal names the
  // verb the reader should reach for instead.
  [CORE_EVENT_TYPES.itemStartedBlocked, "`nahel item`"],
]);

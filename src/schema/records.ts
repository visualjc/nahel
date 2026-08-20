import { z } from "zod";
import {
  ACTOR_KINDS,
  DECISION_TICKET_STATES,
  DECISION_TICKET_TYPES,
  FOUNDING_MODES,
  GOVERNANCE_MODES,
  INCEPTION_TIERS,
  LANES,
  MERGE_AUTHORITIES,
  PRODUCT_GOVERNANCE_MODES,
  ROADMAP_HORIZONS,
  ROADMAP_NODE_KINDS,
  RUN_STATUSES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TYPES,
} from "./enums";
import { ID_ALPHABET, ID_LENGTH, ID_PATTERN } from "./id";
import { TIMESTAMP_PATTERN } from "./time";

/**
 * Zod schemas + inferred types for every schema-v1 record (PRD F1).
 * This layer only validates shapes — all I/O lives in the store layer.
 * Objects are strict: unknown keys are rejected so field typos surface as
 * validation errors instead of silently-ignored state.
 */

/**
 * The stored id field — exported so every schema that REFERENCES a record by
 * id states the rule the same way (the result-doc contract's `run`/`item` keys,
 * PRD F4). One definition, one message: an id check can never drift between
 * the records nahel writes and the documents workers write back.
 */
export const idField = z
  .string()
  .regex(
    ID_PATTERN,
    `must be an ${ID_LENGTH}-char lowercase base32 id (alphabet: ${ID_ALPHABET})`,
  );

/**
 * The stored timestamp field. A SHAPE check only, and deliberately so: it is a
 * parse gate over state that already exists on disk, and tightening it to the
 * calendar would turn a store carrying one impossible date into a store that
 * cannot be read AT ALL — including by the `validate` run that would tell you
 * about it. `epochSeconds` refuses impossible instants where they are USED, and
 * `validate`'s `journal.timestamp` check reports them; the seam is stated in
 * both places rather than hidden in either.
 */
const timestampField = z
  .string()
  .regex(
    TIMESTAMP_PATTERN,
    "must be an ISO-8601 UTC timestamp with second precision: YYYY-MM-DDTHH:MM:SSZ",
  );

const slugField = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "must be a slug: lowercase letters/digits separated by single hyphens (e.g. schema-layer)",
  );

const nonEmptyString = (what: string) => z.string().min(1, `${what} must be a non-empty string`);

/** Who performed an event or mutation — required on every journal event. */
export const actorSchema = z.strictObject({
  kind: z.enum(ACTOR_KINDS),
  id: nonEmptyString("actor id"),
  session: nonEmptyString("actor session").optional(),
});
export type Actor = z.infer<typeof actorSchema>;

/** A mirror reference: where this item is projected in an external tracker. */
export const externalRefSchema = z.strictObject({
  provider: nonEmptyString("external ref provider"),
  id: nonEmptyString("external ref id"),
});
export type ExternalRef = z.infer<typeof externalRefSchema>;

/**
 * A repo-relative knowledge-document path, hardened at the schema level like
 * every path this repo commits: absolute paths (POSIX, drive-letter, UNC) and
 * `..` traversal segments are rejected outright, so a record can never point
 * outside the repo (hard constraint 2). The path is a REFERENCE only —
 * existence on disk is a `nahel validate` warning, never a schema concern
 * (ADR-0012: the document may arrive by later merge).
 */
const repoRelativeDocPathField = (what: string) =>
  z
    .string()
    .min(1, `${what} path must be a non-empty string`)
    .refine(
      (path) => !path.startsWith("/") && !path.startsWith("\\") && !/^[A-Za-z]:[/\\]/.test(path),
      `${what} path must be repo-relative — absolute paths are rejected (hard constraint 2: nothing outside the repo)`,
    )
    .refine(
      (path) => !path.split(/[/\\]/).includes(".."),
      `${what} path must not contain ".." segments — no traversal outside the repo (hard constraint 2)`,
    );

/**
 * The `prd` field: the item's PRD document (ADR-0013 — the plan item that
 * authors a PRD records it as its deliverable; feature items reference it
 * the same way).
 */
const prdPathField = repoRelativeDocPathField("prd");

/**
 * Where a PRD goes once its feature is released (Phase 4 F10): the delta it
 * stated is closed, so the document moves under `docs/prds/archived/` and is
 * never reopened or edited again. A path CONVENTION rather than a schema rule —
 * both the archival verb and `validate` read it, and a single spelling is what
 * keeps the verb that moves a PRD and the checks that judge where it sits from
 * disagreeing about which deltas are closed.
 */
export const ARCHIVED_PRD_DIR = "docs/prds/archived/";

/** True when a `prd` path names a closed delta (see ARCHIVED_PRD_DIR). */
export function isArchivedPrdPath(path: string): boolean {
  return path.startsWith(ARCHIVED_PRD_DIR);
}

/** Where the live PRD at `path` is archived to — its basename under that dir. */
export function archivedPrdPath(path: string): string {
  return `${ARCHIVED_PRD_DIR}${path.split(/[/\\]/).pop() ?? path}`;
}

/**
 * One DOCUMENT step of a write-ahead sequence (Phase 4 F10): the file work an
 * act does OUTSIDE the store's records. Archival has two — the PRD's
 * move-and-stamp, and the line the product design doc gains — and both ride the
 * same journal event the record writes ride, which is what makes a process
 * killed mid-sequence recoverable: the journal ends up ahead of the filesystem
 * exactly as it ends up ahead of a record, and repair rolls it forward.
 *
 * Both ops are stated so that applying them TWICE is applying them once: `move`
 * is complete when the destination exists and the source does not, and `append`
 * writes only when `marker` is absent from the document. That idempotence is
 * what lets repair converge from any interruption point without having to know
 * how far the original act got.
 *
 * `append` keys on a MARKER rather than on the line itself: a product design doc
 * is permanent and gets rewritten by people (F10), so "has this act landed" must
 * survive the sentence being reworded. The marker must therefore be
 * EVENT-SCOPED — text only this act could have written, such as its own event
 * id. A marker naming something the document might plausibly already contain (a
 * path, a slug) is worse than no marker at all: it suppresses the line the act
 * owes, and then reports the act as converged.
 *
 * The same rule is why a `move` is judged by its own `header` (which names the
 * event) and not by the destination merely existing: a document at the target
 * path may be another delta's, and unlinking the source into it destroys a live
 * PRD.
 */
export const documentEditSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("move"),
    from: repoRelativeDocPathField("document from"),
    to: repoRelativeDocPathField("document to"),
    /** The stamped header prepended to the moved document, below any frontmatter. */
    header: nonEmptyString("document header"),
  }),
  z.strictObject({
    op: z.literal("append"),
    path: repoRelativeDocPathField("document path"),
    /** The text whose presence means this append already landed. */
    marker: nonEmptyString("document marker"),
    line: nonEmptyString("document line"),
  }),
]);
export type DocumentEdit = z.infer<typeof documentEditSchema>;

/**
 * The `investigation` field (PRD F5.1): a bug item's durable diagnosis
 * document — symptoms, repro status, hypotheses tested, root cause. By the
 * bug-lane workflow convention it lives at `docs/investigations/<item-id>.md`;
 * the schema validates only the path shape, never the location.
 */
const investigationPathField = repoRelativeDocPathField("investigation");

/** Work item frontmatter — the unit of intent (markdown body carries the prose). */
export const workItemFrontmatterSchema = z.strictObject({
  id: idField,
  name: slugField,
  type: z.enum(WORK_ITEM_TYPES),
  status: z.enum(WORK_ITEM_STATUSES),
  lane: z.enum(LANES),
  parent: idField.optional(),
  depends_on: z.array(idField),
  external_refs: z.array(externalRefSchema),
  prd: prdPathField.optional(),
  investigation: investigationPathField.optional(),
  claimed_by: nonEmptyString("claimed_by actor id").optional(),
  created: timestampField,
  updated: timestampField,
});
export type WorkItemFrontmatter = z.infer<typeof workItemFrontmatterSchema>;

/**
 * Roadmap node frontmatter (Phase 4 F1) — the layer ABOVE work items: one
 * record type covering all three kinds, tree-shaped by `parent`, with the
 * node's intent prose in the markdown body (the observation precedent — the
 * intent IS the body, so a product's paragraph and a feature's one-liner need
 * no separate field).
 *
 * There is deliberately **no status field**, and strict objects are what make
 * that mechanical: every status a node renders is DERIVED from work items and
 * journal events (F2), so there is simply no key to hand-set.
 *
 * Reference direction is one-way and canonical: the node points at the work
 * item (`epic`), and no work-item record ever points back. Every ref field is
 * a plain id — a dangling one is a `validate` finding, never a refused
 * mutation, because the target may arrive by a later merge (ADR-0012).
 *
 * Per-kind fields are all optional on the one record — INCLUDING the two link
 * lists: the per-kind structural rules are SOFT (F1), so WHICH kind carries
 * which field, and how many links an initiative needs, are `validate`
 * judgments. A required list would make an omitted key a schema ERROR before
 * the soft rules could speak. Readers normalize an absent list to empty; a
 * PRESENT list is still validated entry by entry.
 */
export const roadmapNodeFrontmatterSchema = z.strictObject({
  id: idField,
  name: slugField,
  kind: z.enum(ROADMAP_NODE_KINDS),
  horizon: z.enum(ROADMAP_HORIZONS),
  /** The node's parent in the roadmap tree (a roadmap node id, not an item). */
  parent: idField.optional(),
  /** Product: the permanent product design doc (never archived — F10). */
  design_doc: repoRelativeDocPathField("design_doc").optional(),
  /** Product: ADR cross-references, kept in RECORDED order (a sequence, not a set). */
  adrs: z.array(repoRelativeDocPathField("adrs")).optional(),
  /** Feature: the PRD this node's delta is stated in (ADR-0013). */
  prd: prdPathField.optional(),
  /** Feature: the epic WORK ITEM this node covers — the one-way node→item ref. */
  epic: idField.optional(),
  /** Feature: the released node this one continues (lineage across a closed delta, F10). */
  predecessor: idField.optional(),
  /** Initiative: the feature nodes this node links sideways into. */
  features: z.array(idField).optional(),
  created: timestampField,
  updated: timestampField,
});
export type RoadmapNodeFrontmatter = z.infer<typeof roadmapNodeFrontmatterSchema>;

/**
 * Map frontmatter (Phase 4 F7) — the wayfinder chart attached to ONE roadmap
 * node: where this effort is going, what has been decided, what is still foggy,
 * and what was ruled out. The fifth section, **Notes**, is the markdown body
 * (the node/observation precedent: the prose IS the body).
 *
 * A map stores only the sections it OWNS. **Decisions so far** is not one of
 * them, and neither is the part of **Out of scope** a ticket earned: both are
 * composed at read time from the map's tickets, which already carry the decision
 * and the ruling (see views/roadmap.ts renderMap). Storing a second copy made
 * every resolve and every out-of-scope close rewrite the one record that every
 * ticket on the map shares — a hot spot two concurrent sessions contend for, to
 * hold facts that were already written down. The split this leaves is:
 *
 * - `out_of_scope` — the lines an agent CHARTED, before any ticket existed.
 *   Ruling something beyond the destination needs no ticket; a decision does.
 * - the ticket-earned lines, and every decision — derived, never stored.
 *
 * The two stored list sections are REQUIRED keys, unlike a node's per-kind
 * links: a node's links are optional because WHICH kind carries which is a soft
 * `validate` judgment, while the CLI writes both of these on every map
 * mutation. An absent key here therefore means a hand-edited record, which is a
 * finding rather than a shape to tolerate.
 *
 * There is deliberately no status, count, or progress field: a map's state is
 * read from its tickets, and F8's frontier is the only view that ranks them.
 */
export const mapFrontmatterSchema = z.strictObject({
  id: idField,
  /** The roadmap node this map charts — one map per node (F7). */
  node: idField,
  /** Where this effort is going; a map without one charts nothing. */
  destination: nonEmptyString("destination"),
  /** Not yet specified: in-scope questions not sharp enough to ticket yet. */
  fog: z.array(nonEmptyString("fog entry")),
  /**
   * Out of scope, the CHARTED lines only: ruled beyond the destination before
   * any ticket existed, and never graduating. The lines a `ticket close`
   * earned are derived from those tickets and render alongside these.
   */
  out_of_scope: z.array(nonEmptyString("out-of-scope entry")),
  created: timestampField,
  updated: timestampField,
});
export type MapFrontmatter = z.infer<typeof mapFrontmatterSchema>;

/**
 * Decision-ticket frontmatter (Phase 4 F7) — one open question hanging off a
 * map, with the question itself as the markdown body. The body is what
 * `distill` empties once the decision is recorded elsewhere; every other field
 * survives, so a distilled ticket still reads as a resolved question.
 *
 * `state`, `claimant` and `blockers` are the three facts F8's frontier
 * predicate joins on — a takeable ticket is `open`, unclaimed, and blocked by
 * nothing still live. Blocking is ADVISORY: the list is a rendering input, and
 * no command anywhere refuses work because an entry is unresolved.
 *
 * `claimant` is an actor id, present exactly while the state is `claimed`; the
 * terminal states carry none, because nothing is assigned once it is decided.
 */
export const ticketFrontmatterSchema = z.strictObject({
  id: idField,
  /** The map this ticket hangs off — the ticket→map direction, one way. */
  map: idField,
  type: z.enum(DECISION_TICKET_TYPES),
  state: z.enum(DECISION_TICKET_STATES),
  /** Who holds the advisory claim; present exactly while state is `claimed`. */
  claimant: nonEmptyString("claimant actor id").optional(),
  /**
   * Sibling tickets this one waits on — tickets on the SAME map, since a
   * blocker gates work on one destination (a cross-map edge is a `validate`
   * warning). Advisory throughout: nothing anywhere refuses work over one (F8).
   */
  blockers: z.array(idField),
  /**
   * The question is the human's to answer (DD2). ABSENT means false, so every
   * ticket written before the flag existed reads as open to any actor. The rule
   * is the CLI's: under an `agent` actor `resolve`, `close` and clearing the
   * flag are all refused — the third because clear-then-resolve is otherwise
   * the same hole with one extra step. SETTING it is refused to nobody,
   * because restricting a ticket is always safe.
   */
  human_only: z.boolean().optional(),
  /** The one-liner `resolve` recorded — the map's Decisions index derives from it. */
  decision: nonEmptyString("decision").optional(),
  /** Why `close` ruled the question away — required by both dispositions. */
  reason: nonEmptyString("reason").optional(),
  /**
   * The decision that killed this question, when `close` recorded the
   * INVALIDATED disposition (F7's close row): the resolved ticket — or the
   * journal event — whose decision answered it out of existence. Its presence
   * is what tells the two closes apart: an out-of-scope close carries none and
   * earns a line under the map's Out of scope instead, while an invalidated
   * question was never beyond the destination, so filing it there would be
   * false. Both readings are derived from the tickets (F2: derive, never
   * hand-set) — the map stores neither.
   */
  invalidated_by: idField.optional(),
  /** The resolution event id — what the decision's observation cites as its source. */
  resolution: idField.optional(),
  /**
   * The close event id, `resolution`'s counterpart for the other terminal act:
   * what the closed question's observation cites as its source, and the key the
   * map's derived Out-of-scope lines order by. Recorded on the record because
   * `updated` cannot answer WHEN the question was ruled away — `distill` moves
   * it long afterwards, and an order read off it would re-shuffle every time a
   * body was emptied.
   */
  closure: idField.optional(),
  created: timestampField,
  updated: timestampField,
});
export type TicketFrontmatter = z.infer<typeof ticketFrontmatterSchema>;

/** Run — one execution of a work item through its lane; hot state lives here. */
export const runSchema = z.strictObject({
  id: idField,
  item: idField,
  actor: actorSchema,
  lane: z.enum(LANES),
  phase: nonEmptyString("phase"),
  status: z.enum(RUN_STATUSES),
  started: timestampField,
  ended: timestampField.optional(),
});
export type Run = z.infer<typeof runSchema>;

/**
 * Journal event — one entry in the append-only record of what happened.
 * `type` is any non-empty string (core set in events.ts, open to extension);
 * `seq` is the per-segment monotonic sequence that makes merged reads a total
 * order (ts → seq → id, PRD F1).
 */
export const journalEventSchema = z.strictObject({
  id: idField,
  ts: timestampField,
  seq: z.number().int("seq must be an integer").nonnegative("seq must be >= 0"),
  type: nonEmptyString("event type"),
  actor: actorSchema,
  run: idField.optional(),
  item: idField.optional(),
  payload: z.record(z.string(), z.unknown()),
});
export type JournalEvent = z.infer<typeof journalEventSchema>;

/**
 * Observation frontmatter — one durable curated fact; sources are journal
 * event ids. `name` is the recall-searchable slug `nahel observe <slug>`
 * writes; optional because Phase-0 records predate it. `item` optionally
 * names the work item the fact is ABOUT (F5 — e.g. a repro waiver cites its
 * bug), written by `nahel observe --item`.
 */
export const observationFrontmatterSchema = z.strictObject({
  id: idField,
  name: slugField.optional(),
  created: timestampField,
  tags: z.array(nonEmptyString("tag")),
  sources: z.array(idField),
  item: idField.optional(),
});
export type ObservationFrontmatter = z.infer<typeof observationFrontmatterSchema>;

const segmentFilenameField = z
  .string()
  .regex(
    // The optional numeric suffix (`.2`, `.3`, …) is a collision-archived
    // segment: rotation never overwrites an existing archive file, so a
    // second segment for the same run lands under the first free numbered
    // name (bug 7nzsz577) — and it must be distillable like any other.
    /^(run|session)-[0-9a-z]{8}(\.(?:[2-9]|[1-9][0-9]+))?\.jsonl$/,
    "must be a journal segment filename: (run|session)-<8-char id>[.N].jsonl",
  );

/**
 * `nahel/journal/distilled/` (PRD F6): the archived segment filenames whose
 * events have been fully distilled into observations, each recorded as one
 * EMPTY marker file named after the segment. Union semantics — a marker's
 * existence means distilled, and disjoint distills touch disjoint files, so
 * concurrent adds of different segments merge as a plain directory union
 * (ADR-0012 merge-safe state). Maintained only by `nahel distill`; never
 * marks active segments. The schema validates the marker NAMES.
 */
export const distilledSchema = z.array(segmentFilenameField);
export type Distilled = z.infer<typeof distilledSchema>;

/**
 * Run contract — `config.contract` (PRD F2, ADR-0014): how the app launches,
 * seeds, tests, and reports health, plus the ports it binds and the NAMES of
 * the env vars it needs. Secret VALUES never live here — the contract is
 * committed, publishable state; `nahel doctor` verifies the named vars are set
 * on this machine without ever reading their values. Strict: a typo'd key is a
 * validation error, not silent state.
 */
export const contractSchema = z.strictObject({
  launch: nonEmptyString("contract.launch command"),
  seed: nonEmptyString("contract.seed command"),
  test: nonEmptyString("contract.test command"),
  healthcheck: nonEmptyString("contract.healthcheck command").optional(),
  healthcheck_timeout_seconds: z
    .number()
    .int("contract.healthcheck_timeout_seconds must be an integer")
    .positive("contract.healthcheck_timeout_seconds must be >= 1")
    .optional(),
  ports: z
    .array(z.number().int("contract.ports entries must be integers").positive("contract.ports entries must be >= 1"))
    .optional(),
  env: z.array(nonEmptyString("contract.env entry (an env var name)")).optional(),
});
export type Contract = z.infer<typeof contractSchema>;

const commitShaField = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "must be a 40-char lowercase hex commit SHA");

/**
 * One pinned skill source in `skills.yaml` (PRD F7, ADR-0009): a git `repo`
 * (owner/name shorthand, a git URL, or a local path), the `ref` (branch/tag)
 * to pin, and the `use` list of skill names to place. `kind` is implicitly
 * markdown in v1 — there is deliberately NO kind field. Skill names are slugs
 * because restore turns each into a path component under .claude/skills/.
 */
export const skillsManifestEntrySchema = z.strictObject({
  repo: nonEmptyString("skills repo"),
  ref: nonEmptyString("skills ref"),
  use: z.array(slugField).min(1, "use must list at least one skill name"),
});
export type SkillsManifestEntry = z.infer<typeof skillsManifestEntrySchema>;

/** `skills.yaml` — the manifest of pinned skill sources (PRD F7). */
export const skillsManifestSchema = z.strictObject({
  skills: z.array(skillsManifestEntrySchema),
});
export type SkillsManifest = z.infer<typeof skillsManifestSchema>;

/**
 * One resolved entry in `skills.lock` (PRD F7): the source `repo` and its
 * declared `ref`, the exact commit `sha` that ref resolved to at lock time,
 * and the `skills` names that were placed. Comparing lock.ref to the
 * manifest's ref is what makes drift detectable without a network round-trip.
 */
export const skillsLockEntrySchema = z.strictObject({
  repo: nonEmptyString("skills lock repo"),
  ref: nonEmptyString("skills lock ref"),
  sha: commitShaField,
  skills: z.array(slugField),
});
export type SkillsLockEntry = z.infer<typeof skillsLockEntrySchema>;

/** `skills.lock` — the pinned resolution of every manifest source (PRD F7). */
export const skillsLockSchema = z.strictObject({
  entries: z.array(skillsLockEntrySchema),
});
export type SkillsLock = z.infer<typeof skillsLockSchema>;

/**
 * One responsibility's routing (PRD F3, ADR-0015): the agent CLI and/or model
 * to prefer. At least one of the two must be set — an empty entry routes
 * nothing and is a config mistake.
 */
export const routingEntrySchema = z
  .strictObject({
    agent: nonEmptyString("routing agent").optional(),
    model: nonEmptyString("routing model").optional(),
  })
  .refine((entry) => entry.agent !== undefined || entry.model !== undefined, {
    message: "routing entry must set at least one of agent or model",
  });
export type RoutingEntry = z.infer<typeof routingEntrySchema>;

/**
 * Responsibility routing — `config.routing` (PRD F3, ADR-0015): a fixed enum
 * of responsibilities mapped to `{agent, model}` preferences, plus two keys
 * that are NOT responsibilities — `default` (what an unrouted responsibility
 * falls back to) and `review2`.
 *
 * `review2` is F3.1's "second review slot" design call: the review loop needs
 * two reviewer VENDORS and one `review` key can only name one, so the second
 * slot is a config key rather than a fourth enum member — ADR-0015's
 * vocabulary discipline holds and `nahel dispatch review2` stays refused. The
 * slot is filled through the `review` responsibility instead: its driver
 * reviews it in-session when the driver IS that vendor, and dispatches it with
 * `nahel dispatch review --slot 2` otherwise, so any capable vendor can drive
 * the loop. Naming it in committed
 * state is what lets `nahel validate` catch a same-vendor pairing before a run
 * discovers it; optional, so every map written before it existed stays valid
 * (the slot-2 chain then falls through to implementation, then default).
 *
 * Strict: unknown responsibilities are rejected so the vocabulary stays a
 * deliberate schema change, never an accidental typo. Advisory in Phase 1
 * (surfaced by `nahel brief`); enforced by Phase 2 dispatch.
 */
export const routingSchema = z.strictObject({
  architecture: routingEntrySchema.optional(),
  implementation: routingEntrySchema.optional(),
  review: routingEntrySchema.optional(),
  review2: routingEntrySchema.optional(),
  default: routingEntrySchema.optional(),
});
export type Routing = z.infer<typeof routingSchema>;

/**
 * One agent CLI's invocation knowledge (PRD F1.3, ADR-0016 addendum): the
 * `binary` to spawn, the `args` that precede the prompt (headless flags, a
 * subcommand), and the `model_flag` the CLI takes its model on. Dispatch
 * always delivers the prompt as the TRAILING argument — true of every agent
 * CLI shipped — so there is deliberately no prompt-delivery field. A config
 * entry REPLACES the shipped default for that kind wholesale, matching
 * `config set`'s replace-the-section semantics.
 */
export const dispatchAgentSchema = z.strictObject({
  binary: nonEmptyString("dispatch binary"),
  args: z.array(nonEmptyString("dispatch args entry")),
  model_flag: nonEmptyString("dispatch model_flag").optional(),
});
export type DispatchAgent = z.infer<typeof dispatchAgentSchema>;

/**
 * Dispatch invocation config — `config.dispatch` (PRD F1.3): per-agent-CLI
 * overrides of the shipped invocation defaults, keyed by agent kind. Strict
 * over the fixed kind enum: an unknown agent kind is a schema error here (so
 * `nahel validate` and `nahel dispatch` both refuse it) rather than a silent
 * entry nothing ever reads. Omitting the section entirely is the normal
 * case — the defaults cover every known kind.
 */
export const dispatchSchema = z.strictObject({
  claude: dispatchAgentSchema.optional(),
  codex: dispatchAgentSchema.optional(),
  "cursor-agent": dispatchAgentSchema.optional(),
});
export type Dispatch = z.infer<typeof dispatchSchema>;

/**
 * Compaction thresholds — `config.compaction` (PRD F6.2, ADR-0004): when
 * `nahel validate` warns that un-distilled ARCHIVED journal events (events in
 * archived segments with no marker in nahel/journal/distilled/) are overdue
 * for the compact workflow. `max_events` bounds their count, `max_age_days` the age of the
 * oldest one; defaults apply per-field when absent (checks.ts).
 */
export const compactionSchema = z.strictObject({
  max_events: z
    .number()
    .int("compaction.max_events must be an integer")
    .positive("compaction.max_events must be >= 1")
    .optional(),
  max_age_days: z
    .number()
    .int("compaction.max_age_days must be an integer")
    .positive("compaction.max_age_days must be >= 1")
    .optional(),
});
export type Compaction = z.infer<typeof compactionSchema>;

/**
 * Inception record — `config.inception` (PRD F4.1): the tier the project
 * founded at. Written by the inception workflow via `nahel config set`;
 * Phase 2+ autonomy gates and the tier ratchet read it. `full` is recordable
 * now even though the full-tier workflow is deferred.
 *
 * `constitution_signed_by` is the human-signature field the autonomy gate
 * reads (Phase 2 F7.2): "human-signed" has to be verifiable mechanically, so
 * it is recorded state — who signed — rather than a judgment about what the
 * constitution document says. Presence alone is not authority: the gate also
 * requires the `config.updated` act that wrote it to be human-attributed,
 * exactly as merge authority requires of `on-approve` (F3.4). Optional
 * because an unsigned project is a legal state — it simply cannot run AFK.
 */
export const inceptionSchema = z.strictObject({
  tier: z.enum(INCEPTION_TIERS),
  constitution_signed_by: nonEmptyString("inception.constitution_signed_by").optional(),
});
export type Inception = z.infer<typeof inceptionSchema>;

/**
 * Founding record — `config.founding` (Phase 2 F9.4): which interaction mode
 * the founding was started in, and — under `hands-off` — the human's founding
 * `paragraph`, stored VERBATIM.
 *
 * The paragraph is not a description of the constitution; under a hands-off
 * founding it IS the constitution's only human-signed content (F9.5), so this
 * field is reproduced into the constitution document word for word and
 * compared against later. Nothing normalizes it: no trim, no reflow, no case
 * folding — only blank is refused, because a blank paragraph founds nothing.
 *
 * Provenance lives where merge authority's does (governance/authority.ts): the
 * `config.updated` act that wrote THIS section carries the actor, and only a
 * human-attributed act is a signature. That is why the section is separate
 * from `inception` — `config set` replaces a section wholesale, so the tier
 * record (which an agent writes when it finishes founding) would otherwise
 * overwrite the human's act with its own.
 */
export const foundingSchema = z
  .strictObject({
    mode: z.enum(FOUNDING_MODES),
    paragraph: z
      .string()
      .refine(
        (paragraph) => paragraph.trim().length > 0,
        "founding.paragraph must not be blank — the paragraph is the founding's only human-signed content",
      )
      .optional(),
  })
  .refine((founding) => founding.mode !== "hands-off" || founding.paragraph !== undefined, {
    message:
      "founding.paragraph is required when founding.mode is hands-off — the paragraph IS the signed content",
    path: ["paragraph"],
  });
export type Founding = z.infer<typeof foundingSchema>;

/**
 * Governance — `config.governance` (PRD F4, roadmap §7): who owns
 * legislation per area — product (priorities, PRD approvals) and
 * architecture (ADRs, architecture evolution). Both areas are declared
 * together: a half-declared governance posture is ambiguity, not state.
 * Recorded in Phase 1; delegated-consensus enforcement is a later phase.
 *
 * The two fields carry DIFFERENT enums (Phase 4 F5): only `product` takes
 * `agent` (agent-as-PO), and `architecture` stays `human | delegated`. Each
 * field validates against its own set, so `architecture: agent` is refused by
 * the field's own `z.enum` — naming the field and its legal values — and a
 * `product: agent` beside it rescues nothing.
 */
export const governanceSchema = z.strictObject({
  product: z.enum(PRODUCT_GOVERNANCE_MODES),
  architecture: z.enum(GOVERNANCE_MODES),
});
export type Governance = z.infer<typeof governanceSchema>;

/**
 * Merge authority — `config.merge` (PRD F3.4): who may merge a reviewed PR.
 * The PRD's shorthand `merge: on-approve` is spelled as a SECTION with one
 * `authority` key, matching `inception: {tier}` — every config section is an
 * object because `config set` replaces sections with a `--data` object, so a
 * bare scalar would be unsettable through the CLI (hard constraint 3: agents
 * never hand-edit state). Absent means `merge: human`, the default
 * everywhere; resolution and the human-provenance rule live in
 * src/governance/authority.ts.
 */
export const mergeSchema = z.strictObject({
  authority: z.enum(MERGE_AUTHORITIES),
});
export type Merge = z.infer<typeof mergeSchema>;

/**
 * Config — `nahel/config`: where the knowledge layer lives (paths relative to
 * the repo root) and the actor entry this checkout mutates as (PRD F9).
 * The optional `validate` block tunes the maintenance-warning thresholds
 * (PRD F8, ADR-0004); the optional `compaction` (PRD F6.2), `contract`
 * (ADR-0014), `routing` (ADR-0015) and `dispatch` (Phase 2 F1.3) sections are
 * additive too, so existing configs stay valid — as are `inception` and
 * `governance` (PRD F4), written by the inception workflow through
 * `nahel config set`, `merge` (Phase 2 F3.4), and `founding` (Phase 2 F9.4),
 * written by `nahel init --hands-off` or the same `config set` door.
 */
export const configSchema = z.strictObject({
  knowledge: z.strictObject({
    product: nonEmptyString("knowledge.product path"),
    context: nonEmptyString("knowledge.context path"),
    adr: nonEmptyString("knowledge.adr path"),
  }),
  actor: actorSchema,
  validate: z
    .strictObject({
      /** Warn when this many closed segments sit unarchived (rotation debt). */
      rotation_overdue_segments: z
        .number()
        .int("rotation_overdue_segments must be an integer")
        .positive("rotation_overdue_segments must be >= 1")
        .optional(),
    })
    .optional(),
  compaction: compactionSchema.optional(),
  contract: contractSchema.optional(),
  routing: routingSchema.optional(),
  dispatch: dispatchSchema.optional(),
  inception: inceptionSchema.optional(),
  founding: foundingSchema.optional(),
  governance: governanceSchema.optional(),
  merge: mergeSchema.optional(),
});
export type Config = z.infer<typeof configSchema>;

import { z } from "zod";
import {
  ACTOR_KINDS,
  GOVERNANCE_MODES,
  INCEPTION_TIERS,
  LANES,
  RUN_STATUSES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TYPES,
} from "./enums";
import { ID_ALPHABET, ID_LENGTH, ID_PATTERN } from "./id";

/**
 * Zod schemas + inferred types for every schema-v1 record (PRD F1).
 * This layer only validates shapes — all I/O lives in the store layer.
 * Objects are strict: unknown keys are rejected so field typos surface as
 * validation errors instead of silently-ignored state.
 */

const idField = z
  .string()
  .regex(
    ID_PATTERN,
    `must be an ${ID_LENGTH}-char lowercase base32 id (alphabet: ${ID_ALPHABET})`,
  );

const timestampField = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
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
 * writes; optional because Phase-0 records predate it.
 */
export const observationFrontmatterSchema = z.strictObject({
  id: idField,
  name: slugField.optional(),
  created: timestampField,
  tags: z.array(nonEmptyString("tag")),
  sources: z.array(idField),
});
export type ObservationFrontmatter = z.infer<typeof observationFrontmatterSchema>;

const segmentFilenameField = z
  .string()
  .regex(
    /^(run|session)-[0-9a-z]{8}\.jsonl$/,
    "must be a journal segment filename: (run|session)-<8-char id>.jsonl",
  );

/**
 * `nahel/journal/distilled.json` (PRD F6): the archived segment filenames
 * whose events have been fully distilled into observations. A plain sorted
 * list with union semantics — membership means distilled, concurrent adds of
 * different segments merge trivially (ADR-0012 merge-safe state). Maintained
 * only by `nahel distill`; never lists active segments.
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
 * of responsibilities mapped to `{agent, model}` preferences, plus a default.
 * Strict: unknown responsibilities are rejected so the vocabulary stays a
 * deliberate schema change, never an accidental typo. Advisory in Phase 1
 * (surfaced by `nahel brief`); enforced by Phase 2 dispatch.
 */
export const routingSchema = z.strictObject({
  architecture: routingEntrySchema.optional(),
  implementation: routingEntrySchema.optional(),
  review: routingEntrySchema.optional(),
  default: routingEntrySchema.optional(),
});
export type Routing = z.infer<typeof routingSchema>;

/**
 * Compaction thresholds — `config.compaction` (PRD F6.2, ADR-0004): when
 * `nahel validate` warns that un-distilled ARCHIVED journal events (events in
 * archived segments not listed in distilled.json) are overdue for the compact
 * workflow. `max_events` bounds their count, `max_age_days` the age of the
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
 */
export const inceptionSchema = z.strictObject({
  tier: z.enum(INCEPTION_TIERS),
});
export type Inception = z.infer<typeof inceptionSchema>;

/**
 * Governance — `config.governance` (PRD F4, roadmap §7): who owns
 * legislation per area — product (priorities, PRD approvals) and
 * architecture (ADRs, architecture evolution). Both areas are declared
 * together: a half-declared governance posture is ambiguity, not state.
 * Recorded in Phase 1; delegated-consensus enforcement is a later phase.
 */
export const governanceSchema = z.strictObject({
  product: z.enum(GOVERNANCE_MODES),
  architecture: z.enum(GOVERNANCE_MODES),
});
export type Governance = z.infer<typeof governanceSchema>;

/**
 * Config — `nahel/config`: where the knowledge layer lives (paths relative to
 * the repo root) and the actor entry this checkout mutates as (PRD F9).
 * The optional `validate` block tunes the maintenance-warning thresholds
 * (PRD F8, ADR-0004); the optional `compaction` (PRD F6.2), `contract`
 * (ADR-0014) and `routing` (ADR-0015) sections are additive too, so existing
 * configs stay valid — as are `inception` and `governance` (PRD F4), written
 * by the inception workflow through `nahel config set`.
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
  inception: inceptionSchema.optional(),
  governance: governanceSchema.optional(),
});
export type Config = z.infer<typeof configSchema>;

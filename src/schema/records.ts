import { z } from "zod";
import { ACTOR_KINDS, LANES, RUN_STATUSES, WORK_ITEM_STATUSES, WORK_ITEM_TYPES } from "./enums";
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

/** Observation frontmatter — one durable curated fact; sources are journal event ids. */
export const observationFrontmatterSchema = z.strictObject({
  id: idField,
  created: timestampField,
  tags: z.array(nonEmptyString("tag")),
  sources: z.array(idField),
});
export type ObservationFrontmatter = z.infer<typeof observationFrontmatterSchema>;

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
 * Config — `nahel/config`: where the knowledge layer lives (paths relative to
 * the repo root) and the actor entry this checkout mutates as (PRD F9).
 * The optional `validate` block tunes the maintenance-warning thresholds
 * (PRD F8, ADR-0004); the optional `contract` (ADR-0014) and `routing`
 * (ADR-0015) sections are additive too, so existing configs stay valid.
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
      /** Warn when the journal holds this many events (compaction debt). */
      compaction_overdue_events: z
        .number()
        .int("compaction_overdue_events must be an integer")
        .positive("compaction_overdue_events must be >= 1")
        .optional(),
    })
    .optional(),
  contract: contractSchema.optional(),
  routing: routingSchema.optional(),
});
export type Config = z.infer<typeof configSchema>;

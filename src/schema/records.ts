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
 * Config — `nahel/config`: where the knowledge layer lives (paths relative to
 * the repo root) and the actor entry this checkout mutates as (PRD F9).
 */
export const configSchema = z.strictObject({
  knowledge: z.strictObject({
    product: nonEmptyString("knowledge.product path"),
    context: nonEmptyString("knowledge.context path"),
    adr: nonEmptyString("knowledge.adr path"),
  }),
  actor: actorSchema,
});
export type Config = z.infer<typeof configSchema>;

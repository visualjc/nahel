import YAML from "yaml";
import type { z } from "zod";
import {
  configSchema,
  distilledSchema,
  observationFrontmatterSchema,
  runSchema,
  skillsLockSchema,
  skillsManifestSchema,
  workItemFrontmatterSchema,
  type Config,
  type JournalEvent,
  type ObservationFrontmatter,
  type Run,
  type SkillsLock,
  type SkillsManifest,
  type WorkItemFrontmatter,
} from "../schema/records";
import { MUTATION_EVENT_TYPES } from "../schema/events";
import type { HotState } from "../store/hotstate";
import {
  compareEvents,
  latestCandidates,
  SESSION_CLOSED_EVENT_TYPE,
  type SegmentScan,
} from "../store/journal";

/**
 * `nahel validate`'s check library (PRD F8): pure functions over the raw
 * store scan collected by index.ts — no filesystem, no clock, no randomness.
 * Every check reports findings instead of throwing, so one corruption never
 * hides another. `brief` (#8) consumes the same findings for its warnings
 * section, which is why the shape below is the stable contract.
 */

/** One validation finding. Errors fail `nahel validate`; warnings do not. */
export interface Finding {
  severity: "error" | "warning";
  /** Stable machine id of the check, e.g. `schema.item`, `journal.divergence`. */
  check: string;
  /** File the finding points at, when there is one. */
  path?: string;
  /** What is wrong, with ids and fields named. */
  message: string;
  /** How to fix it, when a concrete action exists. */
  fix?: string;
}

/** A raw markdown-with-frontmatter record read (item or observation). */
export interface RawFrontmatterRecord {
  /** Id implied by the filename. */
  id: string;
  path: string;
  /** Unvalidated frontmatter mapping, when the file split cleanly. */
  frontmatter?: Record<string, unknown>;
  body?: string;
  /** Read/split failure, when it did not. */
  error?: string;
}

/** A raw run-directory read: record text plus the run's hot state. */
export interface RawRunRecord {
  /** Id implied by the directory name. */
  id: string;
  path: string;
  /** Unvalidated run.json text, when readable. */
  text?: string;
  /** Read failure, when it was not. */
  error?: string;
  hotStatePath: string;
  /** Parsed hot state, null when state.json is absent, undefined when unreadable. */
  hotState?: HotState | null;
  hotStateError?: string;
}

/** Everything validate checks, collected in one store read pass. */
export interface ValidationInput {
  configPath: string;
  /** Unvalidated config text, when readable. */
  configText?: string;
  configError?: string;
  items: RawFrontmatterRecord[];
  runs: RawRunRecord[];
  observations: RawFrontmatterRecord[];
  segments: SegmentScan[];
  /** `skills.yaml` — undefined text means absent (a repo may use no skills). */
  skillsManifestPath: string;
  skillsManifestText?: string;
  skillsManifestError?: string;
  /** `skills.lock` — undefined text means absent. */
  skillsLockPath: string;
  skillsLockText?: string;
  skillsLockError?: string;
  /** `nahel/journal/distilled.json` — undefined text means absent (nothing distilled). */
  distilledPath: string;
  distilledText?: string;
  distilledError?: string;
  /**
   * The collector's clock reading (env.now() format), injected as DATA so the
   * checks stay pure. Optional: without it the compaction AGE threshold is
   * skipped (the count threshold needs no clock).
   */
  now?: string;
}

/** Default rotation-debt threshold: closed segments awaiting archive. */
export const DEFAULT_ROTATION_OVERDUE_SEGMENTS = 5;
/** Default compaction-debt threshold: un-distilled archived events (PRD F6.2). */
export const DEFAULT_COMPACTION_MAX_EVENTS = 200;
/** Default compaction-debt threshold: age in days of the oldest un-distilled archived event. */
export const DEFAULT_COMPACTION_MAX_AGE_DAYS = 30;

/** The records that parsed cleanly — what the integrity checks run over. */
interface ParsedState {
  input: ValidationInput;
  config: Config | undefined;
  items: Map<string, { record: WorkItemFrontmatter; body: string; path: string }>;
  /** Ids with an item file on disk, valid or not (dangling = no file at all). */
  itemFiles: Set<string>;
  runs: Map<string, { record: Run; path: string }>;
  /** Ids with a run directory on disk, valid or not. */
  runDirs: Set<string>;
  observations: Map<string, { record: ObservationFrontmatter; path: string }>;
  /** Every valid event across all segments, in the ts → seq → id total order. */
  events: JournalEvent[];
  eventIds: Set<string>;
  /** Parsed skills.yaml / skills.lock (undefined when absent or malformed). */
  skillsManifest: SkillsManifest | undefined;
  skillsLock: SkillsLock | undefined;
  /**
   * Distilled archived segment names (PRD F6). Empty when the file is absent;
   * undefined when it is malformed (reported as schema.distilled), which
   * mutes the compaction check rather than double-reporting over bad data.
   */
  distilled: Set<string> | undefined;
}

function zodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const RESTORE_FIX = "fix the named field(s) or restore the file from git";

/** Parse every raw record, reporting schema findings and keeping what parsed. */
function parseState(input: ValidationInput): { state: ParsedState; findings: Finding[] } {
  const findings: Finding[] = [];
  const state: ParsedState = {
    input,
    config: undefined,
    items: new Map(),
    itemFiles: new Set(input.items.map((raw) => raw.id)),
    runs: new Map(),
    runDirs: new Set(input.runs.map((raw) => raw.id)),
    observations: new Map(),
    events: [],
    eventIds: new Set(),
    skillsManifest: undefined,
    skillsLock: undefined,
    distilled: undefined,
  };

  // Config.
  if (input.configError !== undefined) {
    findings.push({
      severity: "error",
      check: "schema.config",
      path: input.configPath,
      message: input.configError,
      fix: "run `nahel init` (or restore nahel/config from git)",
    });
  } else if (input.configText !== undefined) {
    let parsed: unknown;
    let yamlError: string | undefined;
    try {
      parsed = YAML.parse(input.configText);
    } catch (error) {
      yamlError = errorMessage(error);
    }
    if (yamlError !== undefined) {
      findings.push({
        severity: "error",
        check: "schema.config",
        path: input.configPath,
        message: `nahel/config is not parseable YAML: ${yamlError}`,
        fix: RESTORE_FIX,
      });
    } else {
      const result = configSchema.safeParse(parsed);
      if (result.success) {
        state.config = result.data;
      } else {
        findings.push({
          severity: "error",
          check: "schema.config",
          path: input.configPath,
          message: `nahel/config is invalid: ${zodIssues(result.error)}`,
          fix: RESTORE_FIX,
        });
      }
    }
  }

  // Skills manifest (skills.yaml, PRD F7). Absent is fine (undefined text);
  // present-but-malformed is a schema error, so drift can trust what parsed.
  if (input.skillsManifestError !== undefined) {
    findings.push({
      severity: "error",
      check: "schema.skills-manifest",
      path: input.skillsManifestPath,
      message: `skills.yaml is unreadable: ${input.skillsManifestError}`,
      fix: RESTORE_FIX,
    });
  } else if (input.skillsManifestText !== undefined) {
    let parsed: unknown;
    let yamlError: string | undefined;
    try {
      parsed = YAML.parse(input.skillsManifestText);
    } catch (error) {
      yamlError = errorMessage(error);
    }
    if (yamlError !== undefined) {
      findings.push({
        severity: "error",
        check: "schema.skills-manifest",
        path: input.skillsManifestPath,
        message: `skills.yaml is not parseable YAML: ${yamlError}`,
        fix: RESTORE_FIX,
      });
    } else {
      const result = skillsManifestSchema.safeParse(parsed);
      if (result.success) state.skillsManifest = result.data;
      else {
        findings.push({
          severity: "error",
          check: "schema.skills-manifest",
          path: input.skillsManifestPath,
          message: `skills.yaml is invalid: ${zodIssues(result.error)}`,
          fix: RESTORE_FIX,
        });
      }
    }
  }

  // Skills lockfile (skills.lock, PRD F7): JSON, same absent/malformed rules.
  if (input.skillsLockError !== undefined) {
    findings.push({
      severity: "error",
      check: "schema.skills-lock",
      path: input.skillsLockPath,
      message: `skills.lock is unreadable: ${input.skillsLockError}`,
      fix: RESTORE_FIX,
    });
  } else if (input.skillsLockText !== undefined) {
    let parsed: unknown;
    let jsonError: string | undefined;
    try {
      parsed = JSON.parse(input.skillsLockText);
    } catch (error) {
      jsonError = errorMessage(error);
    }
    if (jsonError !== undefined) {
      findings.push({
        severity: "error",
        check: "schema.skills-lock",
        path: input.skillsLockPath,
        message: `skills.lock is not parseable JSON: ${jsonError}`,
        fix: "run `nahel skills lock` to regenerate it (or restore skills.lock from git)",
      });
    } else {
      const result = skillsLockSchema.safeParse(parsed);
      if (result.success) state.skillsLock = result.data;
      else {
        findings.push({
          severity: "error",
          check: "schema.skills-lock",
          path: input.skillsLockPath,
          message: `skills.lock is invalid: ${zodIssues(result.error)}`,
          fix: "run `nahel skills lock` to regenerate it (or restore skills.lock from git)",
        });
      }
    }
  }

  // Distilled segment list (distilled.json, PRD F6): JSON, absent means
  // nothing distilled yet (an empty set); malformed is a schema error and
  // leaves state.distilled undefined so the compaction check stays quiet
  // instead of reporting over data it cannot trust.
  if (input.distilledError !== undefined) {
    findings.push({
      severity: "error",
      check: "schema.distilled",
      path: input.distilledPath,
      message: `distilled.json is unreadable: ${input.distilledError}`,
      fix: RESTORE_FIX,
    });
  } else if (input.distilledText === undefined) {
    state.distilled = new Set();
  } else {
    let parsed: unknown;
    let jsonError: string | undefined;
    try {
      parsed = JSON.parse(input.distilledText);
    } catch (error) {
      jsonError = errorMessage(error);
    }
    if (jsonError !== undefined) {
      findings.push({
        severity: "error",
        check: "schema.distilled",
        path: input.distilledPath,
        message: `distilled.json is not parseable JSON: ${jsonError}`,
        fix: "restore distilled.json from git — `nahel distill` maintains it as a sorted JSON array of archived segment filenames",
      });
    } else {
      const result = distilledSchema.safeParse(parsed);
      if (result.success) state.distilled = new Set(result.data);
      else {
        findings.push({
          severity: "error",
          check: "schema.distilled",
          path: input.distilledPath,
          message: `distilled.json is invalid: ${zodIssues(result.error)}`,
          fix: "restore distilled.json from git — `nahel distill` maintains it as a sorted JSON array of archived segment filenames",
        });
      }
    }
  }

  // Items and observations share the frontmatter-record shape.
  const frontmatterKinds = [
    {
      check: "schema.item",
      what: "work item",
      raws: input.items,
      schema: workItemFrontmatterSchema,
      keep: (raw: RawFrontmatterRecord, record: WorkItemFrontmatter) =>
        state.items.set(record.id, { record, body: raw.body ?? "", path: raw.path }),
    },
    {
      check: "schema.observation",
      what: "observation",
      raws: input.observations,
      schema: observationFrontmatterSchema,
      keep: (raw: RawFrontmatterRecord, record: ObservationFrontmatter) =>
        state.observations.set(record.id, { record, path: raw.path }),
    },
  ] as const;
  for (const kind of frontmatterKinds) {
    for (const raw of kind.raws) {
      if (raw.error !== undefined) {
        findings.push({
          severity: "error",
          check: kind.check,
          path: raw.path,
          message: `${kind.what} ${raw.id}: ${raw.error}`,
          fix: RESTORE_FIX,
        });
        continue;
      }
      const result = kind.schema.safeParse(raw.frontmatter);
      if (!result.success) {
        findings.push({
          severity: "error",
          check: kind.check,
          path: raw.path,
          message: `${kind.what} ${raw.id} has invalid frontmatter: ${zodIssues(result.error)}`,
          fix: RESTORE_FIX,
        });
        continue;
      }
      if (result.data.id !== raw.id) {
        findings.push({
          severity: "error",
          check: kind.check,
          path: raw.path,
          message: `${kind.what} frontmatter id ${result.data.id} does not match filename id ${raw.id}`,
          fix: "rename the file to <id>.md or fix the frontmatter id",
        });
        continue;
      }
      // TypeScript cannot relate kind.schema to kind.keep across the union,
      // but within one kind they always match.
      (kind.keep as (r: RawFrontmatterRecord, rec: unknown) => void)(raw, result.data);
    }
  }

  // Runs (JSON records).
  for (const raw of input.runs) {
    if (raw.error !== undefined) {
      findings.push({
        severity: "error",
        check: "schema.run",
        path: raw.path,
        message: `run ${raw.id}: ${raw.error}`,
        fix: RESTORE_FIX,
      });
    } else if (raw.text !== undefined) {
      let parsed: unknown;
      let jsonError: string | undefined;
      try {
        parsed = JSON.parse(raw.text);
      } catch (error) {
        jsonError = errorMessage(error);
      }
      if (jsonError !== undefined) {
        findings.push({
          severity: "error",
          check: "schema.run",
          path: raw.path,
          message: `run ${raw.id} record is not parseable JSON: ${jsonError}`,
          fix: RESTORE_FIX,
        });
      } else {
        const result = runSchema.safeParse(parsed);
        if (!result.success) {
          findings.push({
            severity: "error",
            check: "schema.run",
            path: raw.path,
            message: `run ${raw.id} record is invalid: ${zodIssues(result.error)}`,
            fix: RESTORE_FIX,
          });
        } else if (result.data.id !== raw.id) {
          findings.push({
            severity: "error",
            check: "schema.run",
            path: raw.path,
            message: `run record id ${result.data.id} does not match directory id ${raw.id}`,
            fix: "rename the run directory to the record id or fix the record",
          });
        } else {
          state.runs.set(result.data.id, { record: result.data, path: raw.path });
        }
      }
    }
    if (raw.hotStateError !== undefined) {
      findings.push({
        severity: "error",
        check: "schema.hotstate",
        path: raw.hotStatePath,
        message: `run ${raw.id} hot state is corrupt: ${raw.hotStateError}`,
        fix: "hot state must be a JSON object — fix state.json or delete it (the workflow's next write recreates it)",
      });
    }
  }

  // Journal events: malformed lines are findings; valid events feed the
  // integrity checks in the merged total order.
  for (const segment of input.segments) {
    for (const malformed of segment.malformed) {
      findings.push({
        severity: "error",
        check: "schema.event",
        path: segment.path,
        message: `segment ${segment.name} line ${malformed.line}: ${malformed.reason}`,
        fix: "journal segments are append-only JSONL — restore the segment from git",
      });
    }
    for (const event of segment.events) {
      state.events.push(event);
      state.eventIds.add(event.id);
    }
  }
  state.events.sort(compareEvents);

  return { state, findings };
}

/** Referential integrity: every ref names a record that exists (PRD F8). */
function checkRefs(state: ParsedState): Finding[] {
  const findings: Finding[] = [];
  for (const { record, path } of state.items.values()) {
    if (record.parent !== undefined && !state.itemFiles.has(record.parent)) {
      findings.push({
        severity: "error",
        check: "refs.parent",
        path,
        message: `item ${record.id} has parent ${record.parent}, which does not exist`,
        fix: "create the parent item or fix/remove the parent field",
      });
    }
    for (const dependency of record.depends_on) {
      if (!state.itemFiles.has(dependency)) {
        findings.push({
          severity: "error",
          check: "refs.depends-on",
          path,
          message: `item ${record.id} depends on ${dependency}, which does not exist`,
          fix: "create the dependency or remove it from depends_on",
        });
      }
    }
  }
  for (const { record, path } of state.runs.values()) {
    if (!state.itemFiles.has(record.item)) {
      findings.push({
        severity: "error",
        check: "refs.run-item",
        path,
        message: `run ${record.id} references item ${record.item}, which does not exist`,
        fix: "if the item's record write crashed, `nahel validate --repair` materializes it from the journal",
      });
    }
  }
  for (const event of state.events) {
    if (event.run !== undefined && !state.runDirs.has(event.run)) {
      findings.push({
        severity: "error",
        check: "refs.event-run",
        message: `event ${event.id} (${event.type}) references run ${event.run}, which does not exist`,
        fix: "if the run's record write crashed, `nahel validate --repair` materializes it from the journal",
      });
    }
    if (event.item !== undefined && !state.itemFiles.has(event.item)) {
      findings.push({
        severity: "error",
        check: "refs.event-item",
        message: `event ${event.id} (${event.type}) references item ${event.item}, which does not exist`,
        fix: "if the item's record write crashed, `nahel validate --repair` materializes it from the journal",
      });
    }
  }
  for (const { record, path } of state.observations.values()) {
    for (const source of record.sources) {
      if (!state.eventIds.has(source)) {
        findings.push({
          severity: "error",
          check: "refs.observation-sources",
          path,
          message: `observation ${record.id} cites source event ${source}, which is not in the journal`,
          fix: "fix the source event id — observation provenance must point at real journal events",
        });
      }
    }
  }
  return findings;
}

/** Circular parent / depends_on detection; each cycle reported once. */
function checkCycles(state: ParsedState): Finding[] {
  const findings: Finding[] = [];

  // Parent cycles: walk each item's parent chain; a chain returning to its
  // start is a cycle. Report it once, keyed by its smallest member.
  const reported = new Set<string>();
  for (const [id, { record }] of state.items) {
    const chain = [id];
    const seen = new Set(chain);
    let current = record.parent;
    while (current !== undefined) {
      if (current === id) {
        const key = [...chain].sort()[0]!;
        if (!reported.has(key)) {
          reported.add(key);
          findings.push({
            severity: "error",
            check: "cycle.parent",
            message: `parent chain forms a cycle: ${[...chain, id].join(" → ")}`,
            fix: "break the cycle by fixing the parent field of one item in it",
          });
        }
        break;
      }
      if (seen.has(current)) break;
      seen.add(current);
      chain.push(current);
      current = state.items.get(current)?.record.parent;
    }
  }

  // depends_on cycles: three-color DFS; a back edge closes a cycle.
  const color = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const reportedDeps = new Set<string>();
  const visit = (id: string): void => {
    color.set(id, "visiting");
    stack.push(id);
    for (const dependency of state.items.get(id)?.record.depends_on ?? []) {
      const mark = color.get(dependency);
      if (mark === "visiting") {
        const cycle = stack.slice(stack.indexOf(dependency));
        const key = [...cycle].sort().join(",");
        if (!reportedDeps.has(key)) {
          reportedDeps.add(key);
          findings.push({
            severity: "error",
            check: "cycle.depends-on",
            message: `depends_on forms a cycle: ${[...cycle, dependency].join(" → ")}`,
            fix: "break the cycle by removing one depends_on edge in it",
          });
        }
      } else if (mark === undefined && state.items.has(dependency)) {
        visit(dependency);
      }
    }
    stack.pop();
    color.set(id, "done");
  };
  for (const id of state.items.keys()) {
    if (!color.has(id)) visit(id);
  }

  return findings;
}

/** A mutation event's parsed payload, or why it cannot be replayed. */
type Mutation =
  | { target: "item"; record: WorkItemFrontmatter; body: string }
  | { target: "run"; record: Run }
  | { target: "item" | "run"; invalid: string };

/**
 * Parse a mutation event's payload record, when the event is a mutation.
 * Mutations are identified by event TYPE (the choke point's core mutation
 * types), never by payload shape — a mutation-shaped payload under `note` or
 * any open extension type (a forged `nahel log`, a rogue writer) is inert
 * data. Within a mutation type, payload shape is a validity check: a core
 * mutation event that cannot be replayed is reported, not ignored.
 */
function mutationRecord(event: JournalEvent): Mutation | undefined {
  if (!MUTATION_EVENT_TYPES.has(event.type)) return undefined;
  const payload = event.payload;
  if (payload["target"] === "item") {
    const result = workItemFrontmatterSchema.safeParse(payload["record"]);
    if (!result.success) return { target: "item", invalid: zodIssues(result.error) };
    const body = payload["body"];
    if (typeof body !== "string") {
      return { target: "item", invalid: "payload body is not a string" };
    }
    return { target: "item", record: result.data, body };
  }
  if (payload["target"] === "run") {
    const result = runSchema.safeParse(payload["record"]);
    if (!result.success) return { target: "run", invalid: zodIssues(result.error) };
    return { target: "run", record: result.data };
  }
  // A core mutation type whose payload lacks the target/record replay fields:
  // the choke point always writes them, so this event cannot be replayed.
  return {
    target: event.type.startsWith("item.") ? "item" : "run",
    invalid: "payload carries no target/record mutation fields",
  };
}

/**
 * Claim checks over the journaled history in total order (PRD F8/F9):
 * replaying every mutation event's record, an agent mutation on an item
 * covered by a claim AT THAT EVENT'S TIME is a violation (the choke point
 * refuses these locally, so one in the journal means a merge raced a claim —
 * F1's stated consequence), and a claim landing while a different actor's
 * claim is live (no handback between) is a post-merge claim conflict.
 */
function checkClaims(state: ParsedState): Finding[] {
  const findings: Finding[] = [];
  const claimedBy = new Map<string, string>();
  const parentOf = new Map<string, string | undefined>();

  // Mirrors mutate()'s findClaimOnChain: one chain walk with a seen-set
  // shared across chains — a node a previous walk passed through without
  // returning is proven claim-free upward.
  const claimOnChain = (
    startId: string | undefined,
    seen: Set<string>,
  ): { id: string; claimant: string } | undefined => {
    let current = startId;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const claimant = claimedBy.get(current);
      if (claimant !== undefined) return { id: current, claimant };
      current = parentOf.get(current);
    }
    return undefined;
  };

  // Parity with mutate()'s findCoveringClaim (PR #12 review HIGH 4): BOTH
  // parent chains are checked — the one the item had at event time and the
  // one the mutation is bringing in (`incomingParent`) — so a journaled
  // agent reparent INTO a claimed subtree cannot evade claims.violation.
  const coveringClaim = (
    itemId: string,
    incomingParent: string | undefined,
  ): { id: string; claimant: string } | undefined => {
    const seen = new Set<string>();
    return claimOnChain(itemId, seen) ?? claimOnChain(incomingParent, seen);
  };

  for (const event of state.events) {
    const mutation = mutationRecord(event);
    if (mutation === undefined || "invalid" in mutation) continue;

    const targetItem = mutation.target === "item" ? mutation.record.id : mutation.record.item;
    if (event.actor.kind === "agent") {
      const incomingParent =
        mutation.target === "item" ? mutation.record.parent : undefined;
      const claim = coveringClaim(targetItem, incomingParent);
      if (claim !== undefined) {
        const via = claim.id === targetItem ? "" : ` via claimed ancestor ${claim.id}`;
        findings.push({
          severity: "error",
          check: "claims.violation",
          message:
            `event ${event.id} (${event.type}) is an agent mutation by ${event.actor.id} ` +
            `on item ${targetItem}, which was claimed by ${claim.claimant}${via} at event time`,
          fix: "review the merged history with the claimant — the claim was held when this mutation was journaled (PRD F9)",
        });
      }
    }

    if (mutation.target === "item") {
      const record = mutation.record;
      const existing = claimedBy.get(record.id);
      if (
        record.claimed_by !== undefined &&
        existing !== undefined &&
        existing !== record.claimed_by
      ) {
        findings.push({
          severity: "error",
          check: "claims.conflict",
          message:
            `item ${record.id} has conflicting claims: claimed by ${existing}, ` +
            `then by ${record.claimed_by} (event ${event.id}) with no handback between`,
          fix: "decide the claimant: the loser hands back, then re-claim (nahel handback / nahel claim)",
        });
      }
      if (record.claimed_by === undefined) claimedBy.delete(record.id);
      else claimedBy.set(record.id, record.claimed_by);
      parentOf.set(record.id, record.parent);
    }
  }
  return findings;
}

/**
 * Claim/pause coherence over CURRENT state (PRD F9, PR #12 review HIGH 3):
 * `nahel claim` journals claimed_by and then pauses covered runs in a second
 * loop — a crash between the two leaves a claimed subtree with ACTIVE runs,
 * and replay cannot heal run status (the pause was never journaled). An
 * active run whose item is covered by a claim (its own claim or a claimed
 * ancestor, walking the on-disk parent chain) is therefore an error.
 */
function checkClaimedActiveRuns(state: ParsedState): Finding[] {
  const findings: Finding[] = [];

  const coveringClaim = (
    itemId: string,
  ): { id: string; claimant: string } | undefined => {
    const seen = new Set<string>();
    let current: string | undefined = itemId;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const item = state.items.get(current);
      if (item === undefined) return undefined;
      if (item.record.claimed_by !== undefined) {
        return { id: current, claimant: item.record.claimed_by };
      }
      current = item.record.parent;
    }
    return undefined;
  };

  for (const { record, path } of state.runs.values()) {
    if (record.status !== "active") continue;
    const claim = coveringClaim(record.item);
    if (claim === undefined) continue;
    const via = claim.id === record.item ? "" : ` via claimed ancestor ${claim.id}`;
    findings.push({
      severity: "error",
      check: "claims.active-run",
      path,
      message:
        `run ${record.id} is active on item ${record.item}, which is covered by ` +
        `${claim.claimant}'s claim${via} — claim pauses covered runs, so an active one ` +
        `means the claim was interrupted before its pause step`,
      fix: `pause the run (nahel pause ${record.id}) or hand back and re-run the claim (nahel handback ${claim.id})`,
    });
  }
  return findings;
}

/** Journal well-formedness: monotonic seq per segment, globally unique ids. */
function checkJournal(state: ParsedState): Finding[] {
  const findings: Finding[] = [];
  for (const segment of state.input.segments) {
    let previous: JournalEvent | undefined;
    for (const event of segment.events) {
      if (previous !== undefined && event.seq <= previous.seq) {
        findings.push({
          severity: "error",
          check: "journal.seq",
          path: segment.path,
          message:
            `segment ${segment.name}: event ${event.id} has seq ${event.seq} ` +
            `after event ${previous.id} with seq ${previous.seq} — per-segment seq must increase`,
          fix: "the segment was edited or corrupted — restore it from git (segments are append-only)",
        });
      }
      previous = event;
    }
  }

  const owners = new Map<string, string[]>();
  for (const segment of state.input.segments) {
    for (const event of segment.events) {
      const list = owners.get(event.id);
      if (list === undefined) owners.set(event.id, [segment.name]);
      else list.push(segment.name);
    }
  }
  for (const [id, segments] of owners) {
    if (segments.length > 1) {
      findings.push({
        severity: "error",
        check: "journal.duplicate-id",
        message: `event id ${id} appears ${segments.length} times, in: ${segments.join(", ")}`,
        fix: "event ids must be globally unique — a segment was duplicated; remove the copy",
      });
    }
  }
  return findings;
}

/**
 * Journal-ahead divergence (PRD F1's write-ahead crash window): a record
 * behind — or missing, or differing from — its latest mutation event.
 * `validate --repair` replays these via the store's replayPending().
 * Mutation events whose payload cannot be replayed are reported instead.
 *
 * "Latest" mirrors replayPending's segment-aware rule: within a segment seq
 * is causal (only the segment's LAST mutation event per record counts);
 * across segments, same-second finalists are genuinely order-ambiguous
 * (per-invocation session segments, second-precision timestamps — see the
 * store's latestCandidates), so a record matching ANY max-ts finalist is in
 * sync. Anything less would flag a false divergence — and repair would
 * REGRESS the record — whenever two CLI invocations mutate one record within
 * the same wall-clock second.
 */
function checkDivergence(state: ParsedState): Finding[] {
  const findings: Finding[] = [];

  for (const event of state.events) {
    const mutation = mutationRecord(event);
    if (mutation !== undefined && "invalid" in mutation) {
      findings.push({
        severity: "error",
        check: "journal.payload",
        message:
          `mutation event ${event.id} (${event.type}) carries an unreplayable ` +
          `${mutation.target} payload — ${mutation.invalid} — repair cannot use it`,
        fix: "the event payload was corrupted — restore the segment from git",
      });
    }
  }

  type ItemFinalist = { event: JournalEvent; record: WorkItemFrontmatter; body: string };
  type RunFinalist = { event: JournalEvent; record: Run };
  const itemFinalists = new Map<string, ItemFinalist[]>();
  const runFinalists = new Map<string, RunFinalist[]>();
  for (const segment of state.input.segments) {
    // Per segment, event order is causal order: later overwrites earlier.
    const segmentItems = new Map<string, ItemFinalist>();
    const segmentRuns = new Map<string, RunFinalist>();
    for (const event of segment.events) {
      const mutation = mutationRecord(event);
      if (mutation === undefined || "invalid" in mutation) continue;
      if (mutation.target === "item") {
        segmentItems.set(mutation.record.id, {
          event,
          record: mutation.record,
          body: mutation.body,
        });
      } else {
        segmentRuns.set(mutation.record.id, { event, record: mutation.record });
      }
    }
    for (const [id, finalist] of segmentItems) {
      itemFinalists.set(id, [...(itemFinalists.get(id) ?? []), finalist]);
    }
    for (const [id, finalist] of segmentRuns) {
      runFinalists.set(id, [...(runFinalists.get(id) ?? []), finalist]);
    }
  }

  const repairFix =
    "run `nahel validate --repair` — it replays the journaled mutation and only materializes what the journal already records";
  for (const [id, finalists] of itemFinalists) {
    const disk = state.items.get(id);
    const candidates = latestCandidates(finalists);
    const inSync =
      disk !== undefined &&
      candidates.some(
        (candidate) =>
          JSON.stringify(disk.record) === JSON.stringify(candidate.record) &&
          disk.body === candidate.body,
      );
    if (!inSync) {
      const pending = candidates[candidates.length - 1]!;
      findings.push({
        severity: "error",
        check: "journal.divergence",
        ...(disk === undefined ? {} : { path: disk.path }),
        message:
          `item ${id} record is ${disk === undefined ? "missing" : "behind"} its latest ` +
          `mutation event ${pending.event.id} (${pending.event.type}) — the journal is ahead`,
        fix: repairFix,
      });
    }
  }
  for (const [id, finalists] of runFinalists) {
    const disk = state.runs.get(id);
    const candidates = latestCandidates(finalists);
    const inSync =
      disk !== undefined &&
      candidates.some(
        (candidate) => JSON.stringify(disk.record) === JSON.stringify(candidate.record),
      );
    if (!inSync) {
      const pending = candidates[candidates.length - 1]!;
      findings.push({
        severity: "error",
        check: "journal.divergence",
        ...(disk === undefined ? {} : { path: disk.path }),
        message:
          `run ${id} record is ${disk === undefined ? "missing" : "behind"} its latest ` +
          `mutation event ${pending.event.id} (${pending.event.type}) — the journal is ahead`,
        fix: repairFix,
      });
    }
  }
  return findings;
}

/**
 * Hot-state staleness (warnings): hot state is NOT replay-healed (the journal
 * does not record it), so a crash between the record write and the hot-state
 * write leaves state.json missing or contradicting the run record. Detectable
 * only when the workflow-owned shape carries the conventional phase/status
 * mirror keys — checked when present, never required.
 */
function checkHotState(state: ParsedState): Finding[] {
  const findings: Finding[] = [];
  for (const raw of state.input.runs) {
    const run = state.runs.get(raw.id);
    if (run === undefined || raw.hotStateError !== undefined) continue;
    if (raw.hotState === null) {
      findings.push({
        severity: "warning",
        check: "hotstate.stale",
        path: raw.hotStatePath,
        message: `run ${raw.id} has no hot state (state.json missing) — likely a crash between the record write and the hot-state write`,
        fix: "the workflow's next hot-state write heals this; hot state is not journal-replayable",
      });
      continue;
    }
    if (raw.hotState === undefined) continue;
    const mismatches: string[] = [];
    if ("phase" in raw.hotState && raw.hotState["phase"] !== run.record.phase) {
      mismatches.push(
        `phase ${JSON.stringify(raw.hotState["phase"])} vs record ${JSON.stringify(run.record.phase)}`,
      );
    }
    if ("status" in raw.hotState && raw.hotState["status"] !== run.record.status) {
      mismatches.push(
        `status ${JSON.stringify(raw.hotState["status"])} vs record ${JSON.stringify(run.record.status)}`,
      );
    }
    if (mismatches.length > 0) {
      findings.push({
        severity: "warning",
        check: "hotstate.stale",
        path: raw.hotStatePath,
        message: `run ${raw.id} hot state contradicts its record: ${mismatches.join("; ")}`,
        fix: "the workflow's next hot-state write heals this; hot state is not journal-replayable",
      });
    }
  }
  return findings;
}

const TIMESTAMP_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/**
 * Seconds since the Unix epoch for a schema-format UTC timestamp, computed
 * with plain calendar arithmetic (days-from-civil) — the validate layer is
 * pure and touches no ambient clock or date machinery. Undefined when the
 * string is not in the schema's timestamp format.
 */
function epochSeconds(timestamp: string): number | undefined {
  const parts = TIMESTAMP_PARTS.exec(timestamp);
  if (parts === null) return undefined;
  const [, year, month, day, hour, minute, second] = parts.map(Number) as number[];
  const shiftedYear = month! <= 2 ? year! - 1 : year!;
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month! + (month! > 2 ? -3 : 9)) + 2) / 5) + day! - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  const epochDays = era * 146097 + dayOfEra - 719468;
  return epochDays * 86400 + hour! * 3600 + minute! * 60 + second!;
}

const COMPACT_FIX =
  "run the compact workflow (nahel/workflows/compact.md): distill facts with `nahel observe`, then mark the covered segments with `nahel distill <segment>...`";

/**
 * Maintenance-debt warnings (ADR-0004: validate flags overdue semantic
 * maintenance). Rotation debt is closed-but-unarchived segments (threshold
 * from config's `validate` block); compaction debt is UN-DISTILLED ARCHIVED
 * events — events in archived segments not listed in distilled.json — over
 * the `compaction` section's count/age thresholds (PRD F6.2). The age leg
 * needs the injected clock reading and is skipped without one.
 */
function checkMaintenance(state: ParsedState): Finding[] {
  const findings: Finding[] = [];
  const rotationThreshold =
    state.config?.validate?.rotation_overdue_segments ?? DEFAULT_ROTATION_OVERDUE_SEGMENTS;

  // Provably-closed active segments (rotate.ts's rule, evaluated purely):
  // a run segment whose run has ended, or a session segment whose final
  // event is the session.closed marker.
  let closed = 0;
  for (const segment of state.input.segments) {
    if (segment.archived || segment.malformed.length > 0) continue;
    const runMatch = /^run-(.+)\.jsonl$/.exec(segment.name);
    if (runMatch !== null) {
      if (state.runs.get(runMatch[1]!)?.record.status === "ended") closed += 1;
      continue;
    }
    const last = segment.events[segment.events.length - 1];
    if (/^session-.+\.jsonl$/.test(segment.name) && last?.type === SESSION_CLOSED_EVENT_TYPE) {
      closed += 1;
    }
  }
  if (closed >= rotationThreshold) {
    findings.push({
      severity: "warning",
      check: "rotation.overdue",
      message: `${closed} closed journal segment(s) await archiving (threshold ${rotationThreshold}) — rotation is overdue`,
      fix: "rotate the journal: closed segments are safe to archive, active segments are never touched",
    });
  }

  // Compaction debt (PRD F6.2). A malformed distilled.json already produced
  // schema.distilled and leaves state.distilled undefined — skip rather than
  // warn over data we cannot trust.
  if (state.distilled === undefined) return findings;
  const maxEvents = state.config?.compaction?.max_events ?? DEFAULT_COMPACTION_MAX_EVENTS;
  const maxAgeDays =
    state.config?.compaction?.max_age_days ?? DEFAULT_COMPACTION_MAX_AGE_DAYS;

  const undistilled = state.input.segments.filter(
    (segment) => segment.archived && !state.distilled!.has(segment.name),
  );
  let undistilledEvents = 0;
  let oldest: string | undefined;
  for (const segment of undistilled) {
    undistilledEvents += segment.events.length;
    for (const event of segment.events) {
      if (oldest === undefined || event.ts < oldest) oldest = event.ts;
    }
  }

  if (undistilledEvents >= maxEvents) {
    findings.push({
      severity: "warning",
      check: "compaction.overdue",
      message:
        `journal archive holds ${undistilledEvents} un-distilled event(s) across ` +
        `${undistilled.length} segment(s) (threshold ${maxEvents}) — compaction is overdue`,
      fix: COMPACT_FIX,
    });
  }

  const nowSeconds = state.input.now === undefined ? undefined : epochSeconds(state.input.now);
  const oldestSeconds = oldest === undefined ? undefined : epochSeconds(oldest);
  if (nowSeconds !== undefined && oldestSeconds !== undefined) {
    const ageDays = (nowSeconds - oldestSeconds) / 86400;
    if (ageDays > maxAgeDays) {
      findings.push({
        severity: "warning",
        check: "compaction.overdue",
        message:
          `the oldest un-distilled archived event (${oldest}) is ${Math.floor(ageDays)} day(s) ` +
          `old (threshold ${maxAgeDays}) — compaction is overdue`,
        fix: COMPACT_FIX,
      });
    }
  }
  return findings;
}

/**
 * Skills lockfile drift (PRD F7, ADR-0009): manifest and lock disagree.
 * Deterministic — compares the two committed files only, NEVER the network.
 * Three warnings, keyed by the source `repo`:
 *   - a manifest source with no lock entry (needs `nahel skills lock`);
 *   - a lock entry no longer in the manifest (an orphaned pin);
 *   - a manifest source whose ref changed since it was locked (stale pin).
 * A malformed manifest/lock produced a schema error already and leaves the
 * parsed value undefined, so drift is skipped rather than reported twice.
 */
function checkSkillsDrift(state: ParsedState): Finding[] {
  const manifest = state.skillsManifest;
  const lock = state.skillsLock;
  if (manifest === undefined && lock === undefined) return [];

  const findings: Finding[] = [];
  const lockByRepo = new Map((lock?.entries ?? []).map((entry) => [entry.repo, entry]));
  const manifestRepos = new Set((manifest?.skills ?? []).map((source) => source.repo));

  for (const source of manifest?.skills ?? []) {
    const locked = lockByRepo.get(source.repo);
    if (locked === undefined) {
      findings.push({
        severity: "warning",
        check: "skills.unlocked",
        path: state.input.skillsManifestPath,
        message: `skills.yaml lists ${source.repo} but skills.lock has no entry for it — the source is unpinned`,
        fix: "run `nahel skills lock` to resolve and pin it",
      });
    } else if (locked.ref !== source.ref) {
      findings.push({
        severity: "warning",
        check: "skills.stale",
        path: state.input.skillsManifestPath,
        message: `${source.repo} is pinned at ref ${locked.ref} (sha ${locked.sha}) but skills.yaml now asks for ref ${source.ref}`,
        fix: "run `nahel skills lock` to re-resolve the changed ref",
      });
    }
  }

  for (const entry of lock?.entries ?? []) {
    if (!manifestRepos.has(entry.repo)) {
      findings.push({
        severity: "warning",
        check: "skills.orphaned",
        path: state.input.skillsLockPath,
        message: `skills.lock pins ${entry.repo} but skills.yaml no longer lists it`,
        fix: "remove it from skills.lock (or restore the manifest source), then run `nahel skills lock`",
      });
    }
  }

  return findings;
}

/** Deterministic report order: errors first, then check, path, message. */
function compareFindings(a: Finding, b: Finding): number {
  if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
  if (a.check !== b.check) return a.check < b.check ? -1 : 1;
  const pathA = a.path ?? "";
  const pathB = b.path ?? "";
  if (pathA !== pathB) return pathA < pathB ? -1 : 1;
  return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
}

/**
 * Run every check over one collected store scan. Pure: identical inputs
 * produce identical findings in a deterministic order (errors before
 * warnings). This is the library interface `brief` (#8) consumes.
 */
export function validate(input: ValidationInput): Finding[] {
  const { state, findings } = parseState(input);
  findings.push(
    ...checkRefs(state),
    ...checkCycles(state),
    ...checkClaims(state),
    ...checkClaimedActiveRuns(state),
    ...checkJournal(state),
    ...checkDivergence(state),
    ...checkHotState(state),
    ...checkMaintenance(state),
    ...checkSkillsDrift(state),
  );
  return findings.sort(compareFindings);
}

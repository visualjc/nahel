import YAML from "yaml";
import type { z } from "zod";
import {
  configSchema,
  observationFrontmatterSchema,
  runSchema,
  workItemFrontmatterSchema,
  type Config,
  type JournalEvent,
  type ObservationFrontmatter,
  type Run,
  type WorkItemFrontmatter,
} from "../schema/records";
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
}

/** Default rotation-debt threshold: closed segments awaiting archive. */
export const DEFAULT_ROTATION_OVERDUE_SEGMENTS = 5;
/** Default compaction-debt threshold: total journal events (ADR-0004). */
export const DEFAULT_COMPACTION_OVERDUE_EVENTS = 1000;

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

/** Parse a mutation event's payload record, when the event is a mutation. */
function mutationRecord(event: JournalEvent): Mutation | undefined {
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
  return undefined;
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

  const coveringClaim = (
    itemId: string,
  ): { id: string; claimant: string } | undefined => {
    const seen = new Set<string>();
    let current: string | undefined = itemId;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const claimant = claimedBy.get(current);
      if (claimant !== undefined) return { id: current, claimant };
      current = parentOf.get(current);
    }
    return undefined;
  };

  for (const event of state.events) {
    const mutation = mutationRecord(event);
    if (mutation === undefined || "invalid" in mutation) continue;

    const targetItem = mutation.target === "item" ? mutation.record.id : mutation.record.item;
    if (event.actor.kind === "agent") {
      const claim = coveringClaim(targetItem);
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

/**
 * Maintenance-debt warnings (ADR-0004: validate flags overdue semantic
 * maintenance). Thresholds come from config's optional `validate` block,
 * with sane defaults.
 */
function checkMaintenance(state: ParsedState): Finding[] {
  const findings: Finding[] = [];
  const rotationThreshold =
    state.config?.validate?.rotation_overdue_segments ?? DEFAULT_ROTATION_OVERDUE_SEGMENTS;
  const compactionThreshold =
    state.config?.validate?.compaction_overdue_events ?? DEFAULT_COMPACTION_OVERDUE_EVENTS;

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

  const totalEvents = state.input.segments.reduce(
    (sum, segment) => sum + segment.events.length,
    0,
  );
  if (totalEvents >= compactionThreshold) {
    findings.push({
      severity: "warning",
      check: "compaction.overdue",
      message: `journal holds ${totalEvents} events (threshold ${compactionThreshold}) — compaction is overdue`,
      fix: "distill durable observations from the journal (semantic maintenance is workflow work, ADR-0004)",
    });
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
    ...checkJournal(state),
    ...checkDivergence(state),
    ...checkHotState(state),
    ...checkMaintenance(state),
  );
  return findings.sort(compareFindings);
}

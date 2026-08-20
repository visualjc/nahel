import YAML from "yaml";
import type { z } from "zod";
import { resolveReviewSlots } from "../dispatch/invocation";
import { CANONICAL_WORKFLOWS } from "../install/canonical-workflows";
import {
  constitutionSignatureStatus,
  mergeAuthorityStatus,
  resolveGovernance,
  type FoundingDisagreement,
  type FoundingSignatureStatus,
  type InceptionSignatureStatus,
  type MergeAuthorityStatus,
} from "../governance/authority";
import {
  configSchema,
  distilledSchema,
  isArchivedPrdPath,
  mapFrontmatterSchema,
  observationFrontmatterSchema,
  roadmapNodeFrontmatterSchema,
  runSchema,
  skillsLockSchema,
  skillsManifestSchema,
  ticketFrontmatterSchema,
  workItemFrontmatterSchema,
  type Config,
  type JournalEvent,
  type MapFrontmatter,
  type ObservationFrontmatter,
  type RoadmapNodeFrontmatter,
  type Run,
  type SkillsLock,
  type SkillsManifest,
  type TicketFrontmatter,
  type WorkItemFrontmatter,
} from "../schema/records";
import {
  CORE_EVENT_TYPES,
  DEPLOY_COMPLETED_EVENT_TYPE,
  MIGRATION_ATTRIBUTION_PAYLOAD_KEY,
  MIGRATION_EXCLUDED_PAYLOAD_KEY,
  MIGRATION_EXCLUSION_REASON_KEY,
  MIGRATION_INCLUDED_PAYLOAD_KEY,
  MIGRATION_SELECTED_EVENT_TYPE,
  MIGRATION_SELECTION_PAYLOAD_KEY,
  MUTATION_EVENT_TYPES,
  NOTE_TICKET_PAYLOAD_KEY,
  PROTOTYPE_VARIANTS_CREATED_EVENT_TYPE,
  RELEASE_ANNOUNCED_EVENT_TYPE,
  ROADMAP_COLUMN_RETRACTED_EVENT_TYPE,
  SELF_RECORDED_EVENT_TYPES,
  supersededNodeIds,
} from "../schema/events";
import { ID_PATTERN } from "../schema/id";
import { epochSeconds } from "../schema/time";
import { parseFrontmatter } from "../store/frontmatter";
import type { HotState } from "../store/hotstate";
import type { PrototypeRefScan } from "../store/prototype";
import {
  RESULT_DOC_FILENAME,
  RESULT_DOC_STATUSES,
  resultDocFrontmatterSchema,
} from "../store/result";
import {
  compareEvents,
  latestCandidates,
  SESSION_CLOSED_EVENT_TYPE,
  type SegmentScan,
} from "../store/journal";
import { eventDocuments } from "../store/mutate";
import {
  archivalRelease,
  featureDevStatus,
  featureStatus,
  retractedEventId,
  retractionReason,
  ROADMAP_COLUMN_FACT_TYPES,
} from "../views/roadmap";

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
  /** Where this run's worker result document belongs (PRD F4). */
  resultDocPath: string;
  /**
   * The result document's raw text, when the worker left one. Undefined means
   * ABSENT (or unreadable, which is the same non-document), and absence is
   * never a finding — see checkResultDocs.
   */
  resultDocText?: string;
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
  /** Roadmap node records from `nahel/roadmap/` (Phase 4 F1). */
  roadmapNodes: RawFrontmatterRecord[];
  /** Map records from `nahel/maps/` and ticket records from `nahel/tickets/` (F7). */
  maps: RawFrontmatterRecord[];
  tickets: RawFrontmatterRecord[];
  segments: SegmentScan[];
  /** `skills.yaml` — undefined text means absent (a repo may use no skills). */
  skillsManifestPath: string;
  skillsManifestText?: string;
  skillsManifestError?: string;
  /** `skills.lock` — undefined text means absent. */
  skillsLockPath: string;
  skillsLockText?: string;
  skillsLockError?: string;
  /**
   * The store's copy of each CANONICAL workflow doc, keyed by the embedded
   * name: where the doc belongs, and its text — `null` when the file is not
   * there (or is not a readable file). Only the canonical names are read, so
   * an ADDITIONAL workflow doc cannot appear here and cannot be flagged.
   * Optional: without it the workflows checks are skipped, exactly like
   * `prdPresence`.
   */
  workflowDocs?: Record<string, { path: string; text: string | null }>;
  /**
   * `nahel/journal/distilled/` — one empty marker file per distilled archived
   * segment. `distilledMarkers` is the raw filename listing ([] covers the
   * absent-dir case: nothing distilled yet); `distilledError` a readdir
   * failure.
   */
  distilledDir: string;
  distilledMarkers?: string[];
  distilledError?: string;
  /**
   * The collector's clock reading (env.now() format), injected as DATA so the
   * checks stay pure. Optional: without it the compaction AGE threshold is
   * skipped (the count threshold needs no clock).
   */
  now?: string;
  /**
   * Existence on disk of every schema-valid `prd` path any item references,
   * keyed by the path as written (repo-relative) — collected by index.ts so
   * the checks stay pure (F1, ADR-0013). Optional: without it the
   * item.prd-missing warning is skipped (same pattern as `now`).
   */
  prdPresence?: Record<string, boolean>;
  /**
   * Existence on disk of every schema-valid `investigation` path any item
   * references (F5), collected exactly like prdPresence. Optional: without it
   * the item.investigation-missing warning is skipped.
   */
  investigationPresence?: Record<string, boolean>;
  /**
   * Existence on disk of every schema-valid ADR path any roadmap node
   * cross-references (F1), collected exactly like prdPresence. Optional:
   * without it the roadmap.adr-missing warning is skipped.
   */
  adrPresence?: Record<string, boolean>;
  /**
   * Existence and content of every path a journaled DOCUMENT step names (F10):
   * `documentPresence` for all of them, `documentText` for the `append` targets
   * whose completion is judged by content rather than by existence. Optional,
   * and absent entirely in a store no archival ever touched — without them the
   * document half of the divergence report is skipped, like `prdPresence`.
   */
  documentPresence?: Record<string, boolean>;
  documentText?: Record<string, string>;
  /**
   * The repo's prototype refs — local branches with their tips, the resolved
   * default branch, and the remote-tracking prototype refs (Phase 2 F5.2),
   * collected by index.ts so the never-merge checks stay pure. Optional, and an
   * `error` inside it means the same thing as absence: nahel could not look, so
   * it reports nothing rather than guessing.
   */
  prototypeRefs?: PrototypeRefScan;
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
  observations: Map<string, { record: ObservationFrontmatter; body: string; path: string }>;
  /** Roadmap nodes that parsed cleanly, by id (Phase 4 F1). */
  roadmapNodes: Map<string, { record: RoadmapNodeFrontmatter; body: string; path: string }>;
  /** Ids with a node file on disk, valid or not (dangling = no file at all). */
  roadmapNodeFiles: Set<string>;
  /** Maps and tickets that parsed cleanly, by id (Phase 4 F7). */
  maps: Map<string, { record: MapFrontmatter; body: string; path: string }>;
  tickets: Map<string, { record: TicketFrontmatter; body: string; path: string }>;
  /** Ids with a map/ticket file on disk, valid or not (dangling = no file). */
  mapFiles: Set<string>;
  ticketFiles: Set<string>;
  /** Every valid event across all segments, in the ts → seq → id total order. */
  events: JournalEvent[];
  eventIds: Set<string>;
  /** Parsed skills.yaml / skills.lock (undefined when absent or malformed). */
  skillsManifest: SkillsManifest | undefined;
  skillsLock: SkillsLock | undefined;
  /**
   * Distilled archived segment names (PRD F6): the well-formed marker
   * filenames in `nahel/journal/distilled/`. Empty when the dir is absent;
   * undefined only when the dir itself is unreadable (reported as
   * schema.distilled), which mutes the compaction check rather than
   * reporting over state it could not see. A stray non-segment filename is
   * its own schema.distilled finding but does not poison the other markers —
   * each marker is an independent file.
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
    roadmapNodes: new Map(),
    roadmapNodeFiles: new Set(input.roadmapNodes.map((raw) => raw.id)),
    maps: new Map(),
    tickets: new Map(),
    mapFiles: new Set(input.maps.map((raw) => raw.id)),
    ticketFiles: new Set(input.tickets.map((raw) => raw.id)),
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

  // Distilled markers (nahel/journal/distilled/, PRD F6): one empty file per
  // distilled archived segment, the name being the datum; an absent dir means
  // nothing distilled yet (an empty listing). Markers are independent files,
  // so a stray non-segment filename is reported per name while the
  // well-formed markers still count; only an unreadable dir mutes the
  // compaction check (nothing could be seen at all).
  if (input.distilledError !== undefined) {
    findings.push({
      severity: "error",
      check: "schema.distilled",
      path: input.distilledDir,
      message: `distilled marker directory is unreadable: ${input.distilledError}`,
      fix: RESTORE_FIX,
    });
  } else {
    const markers = new Set<string>();
    for (const name of input.distilledMarkers ?? []) {
      const result = distilledSchema.element.safeParse(name);
      if (result.success) {
        markers.add(result.data);
      } else {
        findings.push({
          severity: "error",
          check: "schema.distilled",
          path: input.distilledDir,
          message: `distilled marker ${JSON.stringify(name)} is not an archived segment filename: ${zodIssues(result.error)}`,
          fix: "remove the stray file — `nahel distill` keeps one empty marker file per distilled segment, named exactly after it",
        });
      }
    }
    state.distilled = markers;
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
        state.observations.set(record.id, { record, body: raw.body ?? "", path: raw.path }),
    },
    {
      check: "schema.roadmap-node",
      what: "roadmap node",
      raws: input.roadmapNodes,
      schema: roadmapNodeFrontmatterSchema,
      keep: (raw: RawFrontmatterRecord, record: RoadmapNodeFrontmatter) =>
        state.roadmapNodes.set(record.id, { record, body: raw.body ?? "", path: raw.path }),
    },
    {
      check: "schema.map",
      what: "map",
      raws: input.maps,
      schema: mapFrontmatterSchema,
      keep: (raw: RawFrontmatterRecord, record: MapFrontmatter) =>
        state.maps.set(record.id, { record, body: raw.body ?? "", path: raw.path }),
    },
    {
      check: "schema.ticket",
      what: "decision ticket",
      raws: input.tickets,
      schema: ticketFrontmatterSchema,
      keep: (raw: RawFrontmatterRecord, record: TicketFrontmatter) =>
        state.tickets.set(record.id, { record, body: raw.body ?? "", path: raw.path }),
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
    // An observation's `item` names the work it is a fact ABOUT. Items are
    // never deleted (`dropped` is a status, not a removal), so a ref with no
    // record behind it is a lost write or a hand deletion — an error, like
    // every other record-to-record ref here, not the WARNING knowledge
    // documents get (those legitimately arrive by a later merge).
    if (record.item !== undefined && !state.itemFiles.has(record.item)) {
      findings.push({
        severity: "error",
        check: "refs.observation-item",
        path,
        message: `observation ${record.id} is about item ${record.item}, which does not exist`,
        fix: "if the item's record write crashed, `nahel validate --repair` materializes it from the journal; otherwise fix or remove the observation's item field",
      });
    }
  }
  return findings;
}

/**
 * Roadmap node references (Phase 4 F1). Severity follows the record's own
 * semantics, not one blanket rule:
 *
 * - `parent` is a record-to-record ref the store owns, and nodes are never
 *   deleted, so a missing one is a lost write or a hand deletion — an ERROR,
 *   exactly like an item's parent.
 * - `predecessor` and the initiative's sideways `features` links are WARNINGS
 *   naming both ends, as F1 states: the link is recorded first and the target
 *   may arrive by a later merge, and a link to a non-`feature` node is an odd
 *   shape rather than corruption. Nothing here was ever refused at write time.
 * - duplicate slugs are an ERROR: `nahel roadmap node` refuses them at
 *   creation, but node files are disjoint, so a merge can land two cleanly and
 *   this is the only place the collision can surface.
 */
function checkRoadmapRefs(state: ParsedState): Finding[] {
  const findings: Finding[] = [];
  const byName = new Map<string, string[]>();
  for (const { record, path } of state.roadmapNodes.values()) {
    byName.set(record.name, [...(byName.get(record.name) ?? []), record.id]);
    if (record.parent !== undefined && !state.roadmapNodeFiles.has(record.parent)) {
      findings.push({
        severity: "error",
        check: "refs.roadmap-parent",
        path,
        message: `roadmap node ${record.id} (${record.name}) has parent ${record.parent}, which does not exist`,
        fix: "create the parent node or `nahel roadmap node update <ref> --clear-parent`",
      });
    }
    if (record.predecessor !== undefined && !state.roadmapNodeFiles.has(record.predecessor)) {
      findings.push({
        severity: "warning",
        check: "roadmap.predecessor-missing",
        path,
        message: `roadmap node ${record.id} (${record.name}) names predecessor ${record.predecessor}, which does not exist`,
        fix: "the predecessor node may arrive by a later merge — otherwise fix it with `nahel roadmap node update <ref> --predecessor <ref>` or `--clear-predecessor`",
      });
    }
    // An absent link list is an empty one: the schema keeps both lists
    // optional so kind and cardinality are judged HERE, not at parse time.
    for (const linked of record.features ?? []) {
      const target = state.roadmapNodes.get(linked);
      if (!state.roadmapNodeFiles.has(linked)) {
        findings.push({
          severity: "warning",
          check: "roadmap.initiative-link",
          path,
          message: `roadmap node ${record.id} (${record.name}) links feature ${linked}, which does not exist`,
          fix: "the linked node may arrive by a later merge — otherwise re-link with `nahel roadmap node update <ref> --feature <ref>`",
        });
      } else if (target !== undefined && target.record.kind !== "feature") {
        findings.push({
          severity: "warning",
          check: "roadmap.initiative-link",
          path,
          message:
            `roadmap node ${record.id} (${record.name}) links ${linked} (${target.record.name}) sideways, ` +
            `but that node's kind is ${target.record.kind}, not feature`,
          fix: "initiative links point at feature nodes — re-link with `nahel roadmap node update <ref> --feature <ref>`",
        });
      }
    }
  }
  for (const [name, ids] of [...byName.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (ids.length > 1) {
      findings.push({
        severity: "error",
        check: "roadmap.duplicate-name",
        message: `roadmap slug ${JSON.stringify(name)} is held by ${ids.sort().join(" and ")} — slugs are unique per store`,
        fix: "rename all but one with `nahel roadmap node update <id> --name <slug>` — every view addresses nodes by name",
      });
    }
  }
  return findings;
}

/**
 * The derivation rows that are also findings (Phase 4 F2, extended by the PR
 * #26 review). The rules are not restated here — featureDevStatus and
 * featureStatus ARE the rules, and this check reports what they already derive,
 * so a warning can never fire on a store whose status renders clean (or stay
 * silent on one that does not).
 *
 * All are WARNINGS: the derivation still produces a status either way, and
 * none of the shapes was refused at write time. `epic-missing` is reported only
 * when NO item file exists for the id — an epic whose record is on disk but
 * unparseable is already a `schema.item` error, and calling it missing as well
 * would report one corruption twice, in a way that reads as two separate
 * defects.
 *
 * THREE of them are not about the epic at all — the malformed-lifecycle family,
 * one per row of the precedence table. Every row advances on a well-formed
 * winner only, so a fact that cannot carry its row holds the feature back
 * SILENTLY, while the workflow that logged it believes it recorded a pass or a
 * ship:
 *
 * - `sweep-failed-count` (A2) — `failed` missing, non-numeric or negative. A
 *   count greater than zero is a sweep that found failures, recorded correctly,
 *   and warns about nothing.
 * - `release-incomplete` / `deploy-incomplete` (final gate) — the winning
 *   release or deploy carrying no nonblank value for a required key.
 *
 * All three report UNCONDITIONALLY, from the derivation, over every node.
 * `release-incomplete` used to live in the PRD lifecycle check, which skips a
 * node with no `prd` — so most nodes got silence about a thin release, and a
 * thin deploy was never checked anywhere. Each names the EVENT and the keys it
 * lacks, because re-logging that act is the fix; a retracted fact decides no
 * column, so the derivation hands back nothing and none of them fires.
 */
function checkRoadmapDerivation(state: ParsedState): Finding[] {
  const findings: Finding[] = [];
  const items = [...state.items.values()].map((entry) => entry.record);
  for (const { record, path } of state.roadmapNodes.values()) {
    const status = featureStatus(record, items, state.events);
    if (status.unreadableSweep !== undefined) {
      findings.push({
        severity: "warning",
        check: "roadmap.sweep-failed-count",
        path,
        message:
          `roadmap node ${record.id} (${record.name}) is covered by sweep ${status.unreadableSweep}, whose ` +
          "`failed` count is not a usable number (absent, non-numeric, or negative) — the stage did not " +
          `advance to tested and reads ${status.stage}`,
        fix: "re-log the sweep with its real count (`nahel log qa.sweep-completed --item <id> --data failed=<n>`) and retract the unreadable one with `nahel log roadmap.column-retracted`",
      });
    }
    // The sweep warning's two siblings, one per row above it. Same shape, same
    // severity, same reason: the row silently declined to advance, and the
    // workflow that logged the act believes it recorded a ship.
    for (const [gaps, type, check] of [
      [status.incompleteRelease, RELEASE_ANNOUNCED_EVENT_TYPE, "roadmap.release-incomplete"],
      [status.incompleteDeploy, DEPLOY_COMPLETED_EVENT_TYPE, "roadmap.deploy-incomplete"],
    ] as const) {
      if (gaps === undefined) continue;
      findings.push({
        severity: "warning",
        check,
        path,
        message:
          `roadmap node ${record.id} (${record.name}) is covered by ${type} event ${gaps.event}, which ` +
          `records no ${gaps.missing.join(", ")} — the stage did not advance on it and reads ${status.stage}`,
        fix: `re-log the act in full (\`nahel log ${type} --item ${record.epic ?? "<epic>"} ${gaps.missing.map((key) => `--data ${key}=<${key}>`).join(" ")}\`), and retract the thin one with \`nahel log ${ROADMAP_COLUMN_RETRACTED_EVENT_TYPE}\` if it was wrong`,
      });
    }
    const epic = record.epic;
    if (epic === undefined) continue;
    const { anomaly } = featureDevStatus(record, items);
    if (anomaly === "epic-missing" && !state.itemFiles.has(epic)) {
      findings.push({
        severity: "warning",
        check: "roadmap.epic-missing",
        path,
        message: `roadmap node ${record.id} (${record.name}) covers epic ${epic}, which is not an item record — its dev status reads unknown`,
        fix: "the item may arrive by a later merge — otherwise point the node at the right epic with `nahel roadmap node update <ref> --epic <item-id>` or `--clear-epic`",
      });
    }
    if (anomaly === "all-dropped") {
      findings.push({
        severity: "warning",
        check: "roadmap.epic-all-dropped",
        path,
        message: `roadmap node ${record.id} (${record.name}) covers epic ${epic}, whose every work item was dropped — its dev status reads planned over no live work`,
        fix: "drop the node's intent too, or plan new work under the epic with `nahel item new` — this is advisory, nothing was refused",
      });
    }
    // The same fact one level up: an epic with no work UNDER it is the work,
    // so a dropped one is a feature whose only work item was abandoned.
    if (anomaly === "epic-dropped") {
      findings.push({
        severity: "warning",
        check: "roadmap.epic-dropped",
        path,
        message: `roadmap node ${record.id} (${record.name}) covers epic ${epic}, which has no work under it and was itself dropped — its dev status reads planned over no live work`,
        fix: "drop the node's intent too, or plan new work under the epic with `nahel item new` — this is advisory, nothing was refused",
      });
    }
  }
  return findings;
}

/**
 * Lifecycle-fact retractions (PR #26 follow-up A1). A retraction is an ordinary
 * logged event, so nothing about it can be refused at write time — which is
 * precisely why it is read back here. Three shapes are reported, all WARNINGS:
 * the derivation IGNORES an invalid retraction, so the store still renders; it
 * just renders as though the retraction had not been written, and a correction
 * that silently did nothing is the worst way for one to fail.
 *
 * - `roadmap.retraction-malformed` — the payload names no event id readably, or
 *   carries no reason. A withdrawal nobody can account for is worse than the
 *   fact it withdraws, and one naming nothing is never read as naming
 *   everything.
 * - `roadmap.retraction-target-missing` — the id names no event in this store.
 *   Like every dangling ref in the layer it may resolve by a later merge
 *   (ADR-0012), so it is advisory and the fix says so.
 * - `roadmap.retraction-target-kind` — the target exists and is not one of the
 *   three lifecycle facts (an item mutation, another retraction, anything at
 *   all). There is no un-retraction: the fix is the doctrine, RE-LOG the
 *   original fact, which is a new event with a new id that nothing retracts.
 *
 * The target id is read through the derivation's own reader, so the check
 * reports exactly the event the columns acted on.
 */
function checkRoadmapRetractions(state: ParsedState): Finding[] {
  const findings: Finding[] = [];
  const byId = new Map(state.events.map((event) => [event.id, event]));
  for (const event of state.events) {
    if (event.type !== ROADMAP_COLUMN_RETRACTED_EVENT_TYPE) continue;
    const target = retractedEventId(event);
    if (target === undefined || retractionReason(event) === undefined) {
      findings.push({
        severity: "warning",
        check: "roadmap.retraction-malformed",
        message:
          `retraction ${event.id} carries no ${target === undefined ? "`event` id" : "`reason`"} — ` +
          "a retraction withdraws ONE named lifecycle fact and says why, and this one withdraws nothing",
        fix: `re-log it in full: \`nahel log ${ROADMAP_COLUMN_RETRACTED_EVENT_TYPE} --data event=<event-id> --data reason="<why>"\``,
      });
      // Nothing further to say. It never reached whatever it named — the
      // derivation goes through withdrawnEventId, which requires both halves —
      // so a second finding about that target would read as a second defect and
      // imply the retraction otherwise worked.
      continue;
    }
    const found = byId.get(target);
    if (found === undefined) {
      findings.push({
        severity: "warning",
        check: "roadmap.retraction-target-missing",
        message: `retraction ${event.id} names event ${target}, which this store's journal does not carry — it withdraws nothing`,
        fix: "the event may arrive by a later merge — otherwise re-log the retraction naming the right event id",
      });
      continue;
    }
    if (!ROADMAP_COLUMN_FACT_TYPES.has(found.type)) {
      findings.push({
        severity: "warning",
        check: "roadmap.retraction-target-kind",
        message:
          `retraction ${event.id} names event ${found.id}, whose type is ${found.type} — only a ` +
          `${[...ROADMAP_COLUMN_FACT_TYPES].join(", ")} can be retracted, so it withdraws nothing`,
        fix: "a mis-retraction is corrected by re-logging the original fact, never by retracting the retraction — there is no un-retraction",
      });
    }
  }
  return findings;
}

/** The check id every migration-audit finding carries. */
const MIGRATION_AUDIT_CHECK = "roadmap.migration-audit";

/** The fix a defect in an already-journaled selection earns: the journal is append-only. */
const SUPERSEDE_FIX =
  "the journal is append-only, so the attempt is retired rather than edited: " +
  "`nahel roadmap migration supersede <selection-event-id> --reason <why>`, then re-run the migration";

/** The selected set one `roadmap.migration-selected` payload declares. */
interface SelectedSet {
  /** Every id that gets a node, de-duplicated (a set is a set). */
  included: Set<string>;
  /** Every near-miss id ruled out. */
  excluded: Set<string>;
  /** Findings about the payload's own shape — clause (a). */
  findings: Finding[];
  /** False when the payload carries no usable `included` list: coverage cannot run. */
  usable: boolean;
}

/** How the two lists are spelled in the command a fix points at. */
const SELECTION_LOG_FIX =
  `re-log the complete set: \`nahel log ${MIGRATION_SELECTED_EVENT_TYPE} ` +
  `--data ${MIGRATION_INCLUDED_PAYLOAD_KEY}='["<item-id>"]' ` +
  `--data ${MIGRATION_EXCLUDED_PAYLOAD_KEY}='[{"id":"<item-id>","${MIGRATION_EXCLUSION_REASON_KEY}":"<why>"}]'\` ` +
  "(the journal is append-only, so a set already acted on is retired with `nahel roadmap migration supersede`)";

/** One clause-(a) finding, in the words every one of them shares. */
function selectionFinding(event: JournalEvent, message: string, fix = SUPERSEDE_FIX): Finding {
  return {
    severity: "error",
    check: MIGRATION_AUDIT_CHECK,
    message: `migration selection ${event.id} ${message}`,
    fix,
  };
}

/** How a payload value reads in a finding — quoted, and never a sprawling object. */
function payloadValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/**
 * Clause (a): read the selected set out of one selection payload, reporting
 * everything that makes it unreadable as a call. The rules are the ones a
 * reviewer would apply — every entry names a work item, a set is a set (no id
 * twice, on either list), a call does not contradict itself (no id both
 * included and excluded), and a near-miss without a reason is exactly the
 * silent omission the workflow's near-miss rule exists to prevent.
 *
 * It is read STRICTLY, and nothing malformed is salvaged. The set arrives
 * through `nahel log --data`, which JSON-parses whatever it is handed: this is
 * the one input the audit joins on that no schema validates on the way in, so
 * a reader that skipped what it could not parse would turn a broken call into
 * a silently smaller one — and then audit the store against a coverage story
 * nobody made. An absent `excluded` is a finding for the same reason an empty
 * one is not: "no near-misses" is a statement, and silence is not.
 *
 * An id on BOTH lists is reported once and then treated as included: the
 * contradiction is the defect, and reporting the same id again as "a node
 * covers an excluded id" would bill one mistake twice.
 */
function selectedSet(event: JournalEvent): SelectedSet {
  const findings: Finding[] = [];
  const included = new Set<string>();
  const excluded = new Set<string>();
  const raw = event.payload[MIGRATION_INCLUDED_PAYLOAD_KEY];
  if (!Array.isArray(raw)) {
    findings.push(
      selectionFinding(
        event,
        `carries no \`${MIGRATION_INCLUDED_PAYLOAD_KEY}\` list of work-item ids — the set it ` +
          "declared cannot be read, so nothing can be audited against it",
        SELECTION_LOG_FIX,
      ),
    );
    return { included, excluded, findings, usable: false };
  }
  for (const entry of raw) {
    if (typeof entry !== "string" || !ID_PATTERN.test(entry)) {
      findings.push(
        selectionFinding(
          event,
          `lists ${payloadValue(entry)} under \`${MIGRATION_INCLUDED_PAYLOAD_KEY}\`, which is not a ` +
            "work-item id — the set names the items that get nodes, so an entry nothing can be " +
            "looked up by is a call no reviewer can check",
          SELECTION_LOG_FIX,
        ),
      );
      continue;
    }
    if (included.has(entry)) {
      findings.push(
        selectionFinding(
          event,
          `lists ${entry} more than once — the selected set is a set, and a duplicate reads as ` +
            "two nodes owed for one item",
        ),
      );
      continue;
    }
    included.add(entry);
  }

  const rawExcluded = event.payload[MIGRATION_EXCLUDED_PAYLOAD_KEY];
  if (!Array.isArray(rawExcluded)) {
    findings.push(
      selectionFinding(
        event,
        `carries no \`${MIGRATION_EXCLUDED_PAYLOAD_KEY}\` list of near-misses — a migration that ` +
          "ruled nothing out says so with an empty list, and silence is not the same statement " +
          "(an unreadable list is worse: it reads as no near-misses at all)",
        SELECTION_LOG_FIX,
      ),
    );
    return { included, excluded, findings, usable: false };
  }
  for (const entry of rawExcluded) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      findings.push(
        selectionFinding(
          event,
          `excludes ${payloadValue(entry)}, which is not an ` +
            `\`{id, ${MIGRATION_EXCLUSION_REASON_KEY}}\` entry — a near-miss is an id AND the ` +
            "one-line reason a reviewer argues with",
          SELECTION_LOG_FIX,
        ),
      );
      continue;
    }
    const near = entry as Record<string, unknown>;
    const id = near["id"];
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      findings.push(
        selectionFinding(
          event,
          `excludes ${payloadValue(id)}, which is not a work-item id — a near-miss nothing can be ` +
            "looked up by cannot be checked against the store",
          SELECTION_LOG_FIX,
        ),
      );
      continue;
    }
    const reason = near[MIGRATION_EXCLUSION_REASON_KEY];
    if (typeof reason !== "string" || reason.trim() === "") {
      findings.push(
        selectionFinding(
          event,
          `excludes ${id} with no \`${MIGRATION_EXCLUSION_REASON_KEY}\` — a near-miss a reviewer ` +
            "cannot argue with is the silent omission the reason exists to prevent",
        ),
      );
      continue;
    }
    if (included.has(id)) {
      findings.push(
        selectionFinding(
          event,
          `lists ${id} as both included and excluded — the call contradicts itself, and nothing ` +
            "downstream can say whether that item was meant to get a node",
        ),
      );
      continue;
    }
    if (excluded.has(id)) {
      findings.push(
        selectionFinding(
          event,
          `excludes ${id} more than once — the near-miss list is a set too, and two reasons for ` +
            "one exclusion are two accounts of a call made once",
        ),
      );
      continue;
    }
    excluded.add(id);
  }
  // A set with ANY defect is not a call the coverage half can be run against:
  // auditing the store against a partially-read set would report gaps and
  // inventions that are artefacts of the reading, not of the migration. The
  // payload finding is the whole answer until the set is re-made.
  return { included, excluded, findings, usable: findings.length === 0 };
}

/**
 * The migration audit (PR #26 follow-up C2): the join between the selected set
 * a migration journaled FIRST and the nodes it then created. Nothing else in
 * the store makes that comparison — a reviewer had to hold two lists side by
 * side — which is exactly the audit a once-per-store, unrepeatable act needs.
 *
 * It runs only where a `roadmap.migration-selected` event exists: a store that
 * never migrated has nothing to audit and earns no finding. Within such a
 * store, four rules:
 *
 * - (a) the selection payload must be readable as a call — see selectedSet;
 * - (b) for the ACTIVE attempt, every included id has exactly ONE attributed
 *   feature node whose `epic` matches, no attributed node covers an excluded
 *   or unlisted id, and every attributed node's creation event is STRICTLY
 *   later than the selection (a same-second tie breaks on random event id, so
 *   it proves nothing — the workflow fails a migration on exactly this);
 * - (c) UNATTRIBUTED nodes are ignored entirely. Ordinary charting after a
 *   migration is not the migration's business, and attribution rather than a
 *   time window is what tells the two apart;
 * - (d) two active selections are one error and the coverage half SUSPENDS:
 *   with two attempts live, which one owes a node for a given id is precisely
 *   what nobody can say, and reporting both attempts' gaps would invent an
 *   answer.
 *
 * Violations are errors, because the audit exists to make a migration
 * trustworthy and a warning nobody has to clear is not a guarantee.
 *
 * **The legacy rule** (the compatibility clause, deliberate): an active
 * selection with ZERO attributed nodes gets clauses (a) and (d) and one
 * ADVISORY WARNING — never errors. Two real states produce it and neither is a
 * broken migration: an attempt that PREDATES attribution (this repo's own live
 * migration, whose nodes were created before `--migration` existed), and an
 * attempt whose nodes have not been created yet (the workflow journals the set
 * FIRST, so the gap between step 3 and step 5 is the normal shape of a
 * migration in progress). Read literally, "ignore unattributed nodes" would
 * report every included id of a correct, finished legacy migration as
 * uncovered and turn it permanently red — and re-migrating to satisfy a
 * checker would write exactly the false history C1 rules out.
 */
function checkMigrationAudit(state: ParsedState): Finding[] {
  const selections = state.events.filter((event) => event.type === MIGRATION_SELECTED_EVENT_TYPE);
  if (selections.length === 0) return [];
  /** Each retired attempt, and the supersession that retired it. */
  const retired = new Map<string, JournalEvent>();
  /** The node ids those supersessions moved — their absence is already journaled. */
  const moved = new Set<string>();
  for (const event of state.events) {
    if (event.type !== CORE_EVENT_TYPES.migrationSuperseded) continue;
    const target = event.payload[MIGRATION_SELECTION_PAYLOAD_KEY];
    if (typeof target === "string") retired.set(target, event);
    for (const id of supersededNodeIds(event)) moved.add(id);
  }
  // A live node attributed to a RETIRED attempt, reported before anything else
  // and independent of how many selections are active — it is a different fact
  // from coverage, and the one the rest of this check would never catch: the
  // audit only ever looks at the active attempt, so such a node belongs to no
  // attempt anyone audits. `nahel roadmap node new` refuses to write one, but a
  // refusal at the write seam says nothing about a store another worktree
  // merged into: it can chart against a selection this branch superseded.
  //
  // Nodes the supersession itself NAMED are excluded: their move is journaled,
  // so a live one is the write-ahead crash window, which repair rolls forward
  // and `journal.divergence` already reports.
  const findings: Finding[] = [];
  for (const event of state.events) {
    if (event.type !== CORE_EVENT_TYPES.roadmapNodeCreated) continue;
    const attribution = event.payload[MIGRATION_ATTRIBUTION_PAYLOAD_KEY];
    if (typeof attribution !== "string") continue;
    const supersession = retired.get(attribution);
    if (supersession === undefined) continue;
    const mutation = mutationRecords(event)[0];
    if (mutation === undefined || "invalid" in mutation) continue;
    const nodeId = mutation.record.id;
    if (moved.has(nodeId) || !state.roadmapNodes.has(nodeId)) continue;
    findings.push({
      severity: "error",
      check: MIGRATION_AUDIT_CHECK,
      path: state.roadmapNodes.get(nodeId)!.path,
      message:
        `node ${nodeId} is attributed to migration ${attribution}, which event ${supersession.id} ` +
        "retired — the node is live and its attempt is not, so no coverage audit will ever look at " +
        "it (a retired attempt owes nothing, and the audit reads the active one)",
      fix:
        `re-create it against the live attempt (\`nahel roadmap node new feature <name> ... --migration <selection-event-id>\`) ` +
        "or, if it is ordinary charting rather than migration work, without --migration at all",
    });
  }

  const active = selections.filter((event) => !retired.has(event.id));
  if (active.length > 1) {
    findings.push({
      severity: "error",
      check: MIGRATION_AUDIT_CHECK,
      message:
        `this store carries ${active.length} active migration selections ` +
        `(${active.map((event) => event.id).join(", ")}) — a store migrates ONCE, and with two ` +
        "attempts live nothing can say which one owes a node for which item, so the coverage " +
        "audit is suspended until exactly one is active",
      fix: "retire the attempt that failed: `nahel roadmap migration supersede <selection-event-id> --reason <why>`",
    });
    return findings;
  }
  // Every attempt superseded: the migration was retired, and the journal holds
  // both the attempt and its retirement. There is no active call to audit, and
  // reporting one would invent an authority the store does not carry.
  if (active.length === 0) return findings;

  const selection = active[0]!;
  const set = selectedSet(selection);
  findings.push(...set.findings);
  if (!set.usable) return findings;

  const attributed = state.events.filter(
    (event) =>
      event.type === CORE_EVENT_TYPES.roadmapNodeCreated &&
      event.payload[MIGRATION_ATTRIBUTION_PAYLOAD_KEY] === selection.id,
  );
  if (attributed.length === 0) {
    findings.push({
      severity: "warning",
      check: MIGRATION_AUDIT_CHECK,
      message:
        `migration selection ${selection.id} has no attributed node — no ` +
        `\`${CORE_EVENT_TYPES.roadmapNodeCreated}\` event carries ` +
        `\`${MIGRATION_ATTRIBUTION_PAYLOAD_KEY}=${selection.id}\`, so its coverage cannot be ` +
        "audited. Either its nodes have not been created yet, or the attempt predates attribution " +
        "(a legacy migration — history, not a defect)",
      fix: `nodes created from here on carry it: \`nahel roadmap node new feature <name> ... --migration ${selection.id}\`. A finished legacy migration needs no repair and is never re-run to satisfy a checker.`,
    });
    return findings;
  }

  const selectionAt = epochSeconds(selection.ts);
  /** Attributed nodes as the store holds them NOW, keyed by the epic each covers. */
  const covering = new Map<string, string[]>();
  for (const event of attributed) {
    const mutation = mutationRecords(event)[0];
    if (mutation === undefined || "invalid" in mutation) continue;
    const nodeId = mutation.record.id;
    // The node as the store holds it NOW, not as it was created: one re-pointed
    // at another epic afterwards covers what it points at today, and one whose
    // record is gone covers nothing (journal.divergence owns the absence).
    const node = state.roadmapNodes.get(nodeId)?.record;
    if (node === undefined) continue;
    const at = epochSeconds(event.ts);
    if (at !== undefined && selectionAt !== undefined && at <= selectionAt) {
      findings.push({
        severity: "error",
        check: MIGRATION_AUDIT_CHECK,
        message:
          `node ${nodeId} was created in the same second as (or before) migration selection ` +
          `${selection.id} — ${event.ts} against ${selection.ts} — so the selection cannot be shown ` +
          "to have preceded it: a same-second tie breaks on random event id and renders in the right order about half the time",
        fix: "the ordering IS the audit trail and a tie cannot be repaired by a note — retire the attempt and re-run it, waiting past the selection's second (`nahel roadmap migration supersede <selection-event-id> --reason <why>`)",
      });
    }
    if (node.kind !== "feature") {
      findings.push({
        severity: "error",
        check: MIGRATION_AUDIT_CHECK,
        message:
          `node ${nodeId} is attributed to migration ${selection.id} and is a ${node.kind} node — ` +
          "migration attributes the FEATURE nodes it creates for the selected ids, and the product " +
          "node it also creates covers no item and carries no attribution",
        fix: SUPERSEDE_FIX,
      });
      continue;
    }
    if (node.epic === undefined) {
      findings.push({
        severity: "error",
        check: MIGRATION_AUDIT_CHECK,
        message:
          `node ${nodeId} is attributed to migration ${selection.id} and names no \`epic\` — it ` +
          "covers no item, so it accounts for nothing in the selected set",
        fix: `point it at the item it covers: \`nahel roadmap node update ${nodeId} --epic <item-id>\``,
      });
      continue;
    }
    covering.set(node.epic, [...(covering.get(node.epic) ?? []), nodeId]);
  }

  for (const [epic, nodes] of [...covering].sort()) {
    if (set.included.has(epic)) continue;
    findings.push({
      severity: "error",
      check: MIGRATION_AUDIT_CHECK,
      message:
        `node ${nodes.join(", ")} is attributed to migration ${selection.id} and covers ${epic}, ` +
        (set.excluded.has(epic)
          ? "which that selection excluded as a near-miss — the migration acted against its own call"
          : "which that selection never listed — the migration invented coverage its call does not account for"),
      fix: "retire the attempt and re-run it, or — if the node is ordinary charting rather than migration work — re-create it without --migration",
    });
  }
  for (const id of [...set.included].sort()) {
    const nodes = covering.get(id) ?? [];
    if (nodes.length === 1) continue;
    findings.push({
      severity: "error",
      check: MIGRATION_AUDIT_CHECK,
      message:
        nodes.length === 0
          ? `migration selection ${selection.id} included ${id}, and no node attributed to it ` +
            "covers that item — the set declared coverage the migration did not deliver"
          : `migration selection ${selection.id} included ${id}, and ${nodes.length} attributed ` +
            `nodes cover it (${nodes.join(", ")}) — one selected item earns one node`,
      fix:
        nodes.length === 0
          ? `chart the missing node: \`nahel roadmap node new feature <name> --horizon <h> --intent <text> --epic ${id} --migration ${selection.id}\``
          : SUPERSEDE_FIX,
    });
  }
  return findings;
}

/**
 * ADR cross-reference existence (F1): a product node's ADR path should name a
 * file on disk, but a missing one is a WARNING naming the node and the path —
 * never an error and never a refused mutation, exactly like an item's PRD
 * (the document may arrive by a later merge, ADR-0012). Skipped entirely when
 * the collector supplied no presence data.
 */
function checkRoadmapAdrRefs(state: ParsedState): Finding[] {
  const findings: Finding[] = [];
  const presence = state.input.adrPresence;
  if (presence === undefined) return findings;
  for (const { record, path } of state.roadmapNodes.values()) {
    for (const adr of record.adrs ?? []) {
      if (presence[adr] === false) {
        findings.push({
          severity: "warning",
          check: "roadmap.adr-missing",
          path,
          message: `roadmap node ${record.id} (${record.name}) references ADR ${adr}, which does not exist on disk`,
          fix: "write the ADR or fix the node's reference with `nahel roadmap node update <ref> --adr <path>` — an ADR may arrive by a later merge",
        });
      }
    }
  }
  return findings;
}

/**
 * The PRD lifecycle (Phase 4 F10): a feature's PRD is LIVE until the feature is
 * released and ARCHIVED after, and both halves coming apart is worth saying.
 * All three are warnings — nothing here was refused at write time, and none of
 * them makes the store unreadable:
 *
 * - `prd-missing`: the node's document is not on disk. The node-side twin of
 *   `item.prd-missing`, and the shape a half-finished archival leaves behind
 *   (the file moved, the reference did not) — so it names the path that points
 *   at neither location.
 * - `prd-unarchived`: the feature reached `released`, so its delta is closed,
 *   but the document is still sitting in the live directory.
 * - `closed-delta`: the reverse and the more serious of the two — a node that
 *   is NOT released pointing INTO the archive, which is someone continuing
 *   work against a delta that was closed. The fix is the doctrine: a new node
 *   with a new PRD, naming this one as its predecessor.
 *
 * "Released" here is archivalRelease's predicate, never a field: it IS what
 * `nahel roadmap archive` gates on, so `prd-unarchived` fires on exactly the
 * nodes that verb ACCEPTS — this check tells a human to run it, and a warning
 * naming a command that then refuses is a warning nobody can act on. Since the
 * final gate that predicate is also the `released` stage word, so the two
 * findings below and the rendered roadmap cannot disagree either.
 *
 * A node whose release is too THIN to carry an archival is not reported here.
 * That is a fact about the release, not about the PRD, and
 * checkRoadmapDerivation names it whether or not the node carries a `prd` at
 * all — which is where most nodes live.
 */
function checkPrdLifecycle(state: ParsedState): Finding[] {
  const findings: Finding[] = [];
  const presence = state.input.prdPresence;
  const items = [...state.items.values()].map((entry) => entry.record);
  for (const { record, path } of state.roadmapNodes.values()) {
    const prd = record.prd;
    if (prd === undefined) continue;
    if (presence?.[prd] === false) {
      findings.push({
        severity: "warning",
        check: "roadmap.prd-missing",
        path,
        message: `roadmap node ${record.id} (${record.name}) references PRD ${prd}, which does not exist on disk`,
        fix: "the PRD may arrive by a later merge — otherwise fix the reference with `nahel roadmap node update <ref> --prd <path>`, or, if an archival was interrupted, `nahel validate --repair` completes it",
      });
    }
    // Archival qualification and the `released` stage word are ONE predicate
    // since the final gate, so this reads either way round; asking
    // archivalRelease is asking the verb's own gate, which is the honest one.
    // A thin release is NOT reported here — it is not about the PRD, and
    // checkRoadmapDerivation names it whether or not the node carries one.
    const release = archivalRelease(record, items, state.events);
    const released = release !== undefined && release.missing.length === 0;
    if (released && !isArchivedPrdPath(prd)) {
      findings.push({
        severity: "warning",
        check: "roadmap.prd-unarchived",
        path,
        message:
          `roadmap node ${record.id} (${record.name}) is released, but its PRD ${prd} is still live — ` +
          "a released delta is closed, and its PRD belongs in the archive",
        fix: `close it with \`nahel roadmap archive ${record.name}\` — the PRD moves with every reference to it, and the product design doc is updated in the same act`,
      });
    }
    if (!released && isArchivedPrdPath(prd)) {
      findings.push({
        severity: "warning",
        check: "roadmap.closed-delta",
        path,
        message:
          `roadmap node ${record.id} (${record.name}) is not released, but its PRD ${prd} is archived — ` +
          "this is work continuing against a delta that was already closed",
        fix: `an archived PRD is never reopened or edited: open a new feature node with a new PRD instead, naming this one as its predecessor (\`nahel roadmap node new feature <name> ... --predecessor ${record.name}\`)`,
      });
    }
  }
  return findings;
}

/**
 * Structural shape (F1): the per-kind rules are SOFT — the authoring agent
 * infers placement, the CLI refuses nothing but a duplicate slug — so every
 * odd shape is a WARNING with the node named. Reported here:
 *
 * - a node that is its own parent or its own predecessor (a self-loop is a
 *   well-formed id link, so the write is recorded and reported, not refused);
 * - a feature parented to a feature (usually a work item, not a roadmap node);
 * - a non-product node with no product ancestor (intent hanging off nothing);
 * - an initiative linking fewer than two features — the cardinality judgment,
 *   which lives here rather than in the schema so an initiative can be created
 *   and wired up in two acts.
 *
 * The ancestor walk carries a seen-set, so a self-loop or a longer parent cycle
 * terminates and its members simply read as having no product ancestor — which
 * is exactly what they have.
 */
function checkRoadmapShape(state: ParsedState): Finding[] {
  const findings: Finding[] = [];
  for (const { record, path } of state.roadmapNodes.values()) {
    const parent = record.parent === undefined ? undefined : state.roadmapNodes.get(record.parent);
    const selfParented = record.parent === record.id;
    if (selfParented) {
      findings.push({
        severity: "warning",
        check: "roadmap.shape",
        path,
        message: `roadmap node ${record.id} (${record.name}) is its own parent — the tree closes on itself here`,
        fix: "re-parent it with `nahel roadmap node update <ref> --parent <ref>` or `--clear-parent` — this is advisory, nothing was refused",
      });
    }
    if (record.predecessor === record.id) {
      findings.push({
        severity: "warning",
        check: "roadmap.shape",
        path,
        message: `roadmap node ${record.id} (${record.name}) is its own predecessor — lineage cannot start at itself`,
        fix: "point it at the released node it continues with `nahel roadmap node update <ref> --predecessor <ref>`, or `--clear-predecessor` — this is advisory, nothing was refused",
      });
    }
    if (record.kind === "initiative" && (record.features ?? []).length < 2) {
      findings.push({
        severity: "warning",
        check: "roadmap.shape",
        path,
        message:
          `roadmap node ${record.id} (${record.name}) is an initiative linking ` +
          `${(record.features ?? []).length} feature(s) sideways — an initiative links several`,
        fix: "link the features it spans with `nahel roadmap node update <ref> --feature <ref> --feature <ref>` — this is advisory, nothing was refused",
      });
    }
    if (!selfParented && record.kind === "feature" && parent?.record.kind === "feature") {
      findings.push({
        severity: "warning",
        check: "roadmap.shape",
        path,
        message:
          `roadmap node ${record.id} (${record.name}) is a feature parented to feature ` +
          `${parent.record.id} (${parent.record.name}) — a feature's children are usually work items, not nodes`,
        fix: "re-parent it under a product node, or make it a work item under the parent feature's epic — this is advisory, nothing was refused",
      });
    }
    if (record.kind === "product") continue;
    const seen = new Set<string>([record.id]);
    let current = parent;
    let productAncestor = false;
    while (current !== undefined && !seen.has(current.record.id)) {
      seen.add(current.record.id);
      if (current.record.kind === "product") {
        productAncestor = true;
        break;
      }
      current =
        current.record.parent === undefined
          ? undefined
          : state.roadmapNodes.get(current.record.parent);
    }
    if (!productAncestor) {
      findings.push({
        severity: "warning",
        check: "roadmap.shape",
        path,
        message: `roadmap node ${record.id} (${record.name}) has no product ancestor — its intent hangs off nothing`,
        fix: "parent it (directly or through its tree) under a product node with `nahel roadmap node update <ref> --parent <ref>` — this is advisory, nothing was refused",
      });
    }
  }
  return findings;
}

/**
 * Map and decision-ticket integrity (Phase 4 F7). The severity split follows
 * the rest of the roadmap layer exactly: a ref the STORE owns — the node a map
 * charts, the map a ticket hangs off — is an error, because nothing addresses
 * a chart without it; everything the PRD calls advisory (blocking edges, the
 * claimant/state pairing) is a warning that never fails validate.
 *
 * The one error that is not a ref is the HAND-EMPTIED BODY. `distill` exists so
 * that throwing a question away is a journaled, replayable, attributable act
 * (HC3); an empty body with no distill event behind it means someone did it
 * with an editor, which is exactly the thing the verb replaces.
 */
function checkWayfinder(state: ParsedState): Finding[] {
  const findings: Finding[] = [];

  // Which node each map charts — a second map on one node makes `map show
  // <node-slug>` ambiguous, the same way a duplicate slug does for nodes.
  const mapsByNode = new Map<string, string[]>();
  for (const { record, path } of state.maps.values()) {
    mapsByNode.set(record.node, [...(mapsByNode.get(record.node) ?? []), record.id]);
    if (!state.roadmapNodeFiles.has(record.node)) {
      findings.push({
        severity: "error",
        check: "refs.map-node",
        path,
        message: `map ${record.id} charts roadmap node ${record.node}, which does not exist`,
        fix: "create the node, or re-chart the map on the right one — a map with no node is a chart of nothing",
      });
    }
  }
  for (const [node, ids] of [...mapsByNode.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (ids.length > 1) {
      findings.push({
        severity: "error",
        check: "roadmap.duplicate-map",
        message:
          `roadmap node ${node} is charted by ${ids.sort().join(" and ")} — one map per node ` +
          "(a second one makes `nahel roadmap map show <node>` ambiguous)",
        fix: "merge the two charts into one and delete the loser's record — this is what a merge of two charting sessions produces",
      });
    }
  }

  // Every ticket whose body was emptied THROUGH the CLI, by its distill event.
  const distilled = new Set<string>();
  for (const event of state.events) {
    if (event.type !== CORE_EVENT_TYPES.ticketDistilled) continue;
    for (const mutation of mutationRecords(event)) {
      if (!("invalid" in mutation) && mutation.target === "ticket") {
        distilled.add(mutation.record.id);
      }
    }
  }

  for (const { record, body, path } of state.tickets.values()) {
    if (!state.mapFiles.has(record.map)) {
      findings.push({
        severity: "error",
        check: "refs.ticket-map",
        path,
        message: `decision ticket ${record.id} hangs off map ${record.map}, which does not exist`,
        fix: "chart the map, or re-point the ticket at the right one — a ticket with no map answers no destination",
      });
    }
    for (const blocker of record.blockers) {
      if (blocker === record.id) {
        findings.push({
          severity: "warning",
          check: "roadmap.ticket-shape",
          path,
          message: `decision ticket ${record.id} is its own blocker — it can never come off the frontier`,
          fix: `re-wire it with \`nahel roadmap ticket update ${record.id} --blocked-by <ticket-id>\` or \`--clear-blockers\` — this is advisory, nothing was refused`,
        });
      } else if (!state.ticketFiles.has(blocker)) {
        findings.push({
          severity: "warning",
          check: "roadmap.ticket-blocker-missing",
          path,
          message: `decision ticket ${record.id} is blocked by ${blocker}, which does not exist`,
          fix: "the blocking ticket may arrive by a later merge — otherwise re-wire it with `nahel roadmap ticket update <ref> --blocked-by <ticket-id>` or `--clear-blockers`",
        });
      } else {
        // Blocking edges run between SIBLINGS — tickets charting the same
        // destination. A cross-map edge holds this map's question until another
        // map's question resolves (F8's frontier eligibility joins on exactly
        // this list), gating work on a destination it does not share. Reported,
        // never refused: blocking is advisory everywhere.
        const target = state.tickets.get(blocker);
        if (target !== undefined && target.record.map !== record.map) {
          findings.push({
            severity: "warning",
            check: "roadmap.ticket-blocker-cross-map",
            path,
            message:
              `decision ticket ${record.id} (map ${record.map}) is blocked by ${blocker}, which hangs off ` +
              `map ${target.record.map} — blocking edges run between tickets on the same map`,
            fix: "re-wire it onto a sibling with `nahel roadmap ticket update <ref> --blocked-by <ticket-id>` or `--clear-blockers`, or chart the shared question on this map — this is advisory, nothing was refused",
          });
        }
      }
    }
    // `close --invalidated-by` records the decision that killed the question.
    // A ref resolving to neither a ticket nor a journal event records nothing —
    // reported like every other dangling ref in the layer, never refused (the
    // target may arrive by a later merge, ADR-0012).
    if (
      record.invalidated_by !== undefined &&
      !state.ticketFiles.has(record.invalidated_by) &&
      !state.eventIds.has(record.invalidated_by)
    ) {
      findings.push({
        severity: "warning",
        check: "roadmap.ticket-invalidator-missing",
        path,
        message:
          `decision ticket ${record.id} was closed as invalidated by ${record.invalidated_by}, ` +
          "which is neither a ticket nor a journal event — nothing records what killed the question",
        fix: "the invalidating record may arrive by a later merge — otherwise re-close it against the real decision (`nahel roadmap ticket close <ref> --invalidated-by <ticket-or-event-id> --reason <why>`)",
      });
    }
    // The claimant and the state are one fact spelled twice: `claimed` means
    // someone holds it, and no other state holds anything.
    if (record.state === "claimed" && record.claimant === undefined) {
      findings.push({
        severity: "warning",
        check: "roadmap.ticket-shape",
        path,
        message: `decision ticket ${record.id} is claimed but records no claimant — nothing says who is working it`,
        fix: `release it with \`nahel roadmap ticket release ${record.id}\` and claim it again — the claim is advisory, so releasing is always permitted`,
      });
    }
    if (record.state !== "claimed" && record.claimant !== undefined) {
      findings.push({
        severity: "warning",
        check: "roadmap.ticket-shape",
        path,
        message:
          `decision ticket ${record.id} is ${record.state} but still records claimant ` +
          `${record.claimant} — nothing stays assigned once it is decided`,
        fix: "the CLI drops the claimant on every terminal transition; this record was written another way",
      });
    }
    if (body === "" && !distilled.has(record.id)) {
      findings.push({
        severity: "error",
        check: "roadmap.ticket-body",
        path,
        message:
          `decision ticket ${record.id} has an empty body and no \`${CORE_EVENT_TYPES.ticketDistilled}\` event — ` +
          "a ticket body is emptied through the CLI, never by editing the file (hard constraint 3)",
        fix: `restore the body (\`nahel validate --repair\` replays the journaled record), then empty it with \`nahel roadmap ticket distill ${record.id}\``,
      });
    }
  }
  return findings;
}

/** The `kind:id` spelling every actor-naming message in the layer uses. */
function actorRef(actor: JournalEvent["actor"]): string {
  return `${actor.kind}:${actor.id}`;
}

/**
 * The events one resolution CITES beside its own (planning-partner DD6). The
 * resolve sequence writes the ticket and its decision observation under one
 * event, and the observation's `sources` is `[the resolution event, ...whatever
 * --source named]` — so the cited research is derivable from the event itself,
 * with no dependence on the observation record surviving on disk or on the
 * `decision-<ticket>` name being reconstructable.
 */
function citedSources(mutations: readonly Mutation[], eventId: string): string[] {
  const sources: string[] = [];
  for (const mutation of mutations) {
    if ("invalid" in mutation || mutation.target !== "observation") continue;
    for (const source of mutation.record.sources) {
      if (source !== eventId) sources.push(source);
    }
  }
  return sources;
}

/**
 * The human notes that could RATIFY a self-resolved grilling ticket, grouped
 * by the ticket each one names and left in the store's total order.
 *
 * DD6's door — the resolution CITES a human-attributed source — shuts the
 * moment the resolution lands: the journal is append-only, and a resolved
 * ticket's sources are written once, inside the resolve sequence. So a store
 * where the human ruled out loud and the agent relayed the ruling under its
 * own actor can never buy its way out of the warning, however honest it was.
 * Ratification is the SECOND door: a human, afterwards, journaling a note that
 * names the ticket — putting on the record that the decision was theirs.
 *
 * A note qualifies on THREE facts about the act, none of them about the
 * ticket record:
 *
 *   - HUMAN-attributed. An agent vouching for its own answer vouches for
 *     nothing — the same reason DD6 refuses an agent's own research note.
 *   - a LOGGED type, i.e. not self-recorded. `nahel log` refuses the reserved
 *     types precisely so readers can trust them by TYPE, so a `ticket` key on
 *     one is coincidence at best; this is the exact boundary the plan-since
 *     linkage draws, and for the same reason.
 *   - naming ONE ticket, by NOTE_TICKET_PAYLOAD_KEY. Two tickets is two notes.
 *
 * The fourth fact — STRICTLY LATER than the resolution — belongs to the caller,
 * which holds the resolution event; a note is kept here regardless of when it
 * landed, because whether it ratifies depends on which resolution is asking.
 */
function ratifyingNotes(events: readonly JournalEvent[]): Map<string, JournalEvent[]> {
  const notes = new Map<string, JournalEvent[]>();
  for (const event of events) {
    if (event.actor.kind !== "human" || SELF_RECORDED_EVENT_TYPES.has(event.type)) continue;
    const ticket = event.payload[NOTE_TICKET_PAYLOAD_KEY];
    if (typeof ticket !== "string") continue;
    const existing = notes.get(ticket);
    if (existing === undefined) notes.set(ticket, [event]);
    else existing.push(event);
  }
  return notes;
}

/**
 * Who was allowed to ANSWER a decision ticket (planning-partner F4/DD2, DD6).
 *
 * Both rules this checks live outside the store: `human_only` is enforced on
 * the COMMAND PATH only (roadmap-ticket.ts's requireHumanActor refuses
 * resolve, close and `update --clear-human-only` under an `agent:*` actor),
 * and "the partner never answers its own interview questions" is stated in
 * `plan.md` and enforced by nothing at all. The store is the durable artefact,
 * so validate reads the JOURNAL — the only place recording WHO acted — and
 * reports what the command path would have refused, or what the workflow
 * forbids.
 *
 * Attribution is read from the EVENT, not from any record field: the actor is
 * a fact about the act, and the ticket record keeps none. Acts are identified
 * by event TYPE, the same rule mutationRecords() states — a mutation-shaped
 * payload under another type is inert data, never a resolution.
 *
 * The severity split is the difference between the two rules:
 *
 * - human-only violations are ERRORS. The CLI refuses those acts outright, so
 *   a store exhibiting one was mutated outside the CLI or through a bug — there
 *   is no legitimate reading of it.
 * - an agent-resolved grilling ticket is a WARNING. The CLI permits it,
 *   `delegated`/`agent` governance permits it outright, and a DD6 delegation
 *   makes it legitimate even under `human`. The warning exists so a human
 *   browsing validate output SEES that an interview question was answered by an
 *   agent — hard constraint 6: reported, never silent, and never refused.
 *
 * That warning has TWO doors out, because one of them can only be walked
 * through in advance. DD6's door is the resolution citing a human-attributed
 * source, and it shuts the instant the resolution lands — the journal is
 * append-only, so a resolution journaled without a source can never gain one.
 * Post-hoc RATIFICATION is the other: a human note, journaled LATER, naming
 * the ticket (see ratifyingNotes). Without it the check has no reading for the
 * ordinary case where the human ruled in conversation and the agent relayed
 * the ruling under its own actor — which is what its first live run flagged,
 * sixteen times over, on nahel's own planning-partner map.
 */
function checkTicketAuthority(state: ParsedState): Finding[] {
  const findings: Finding[] = [];
  // Product governance decides only the GRILLING rule; the human-only rule is
  // absolute (DD6: "F4's agent-actor refusal stands regardless"). An unreadable
  // config mutes the grilling half rather than guessing a posture, exactly as
  // checkMergeAuthority declines to judge a store it cannot read.
  const productMode =
    state.config === undefined
      ? undefined
      : resolveGovernance(state.config.governance).product.mode;
  const humanEvents = new Set(
    state.events.filter((event) => event.actor.kind === "human").map((event) => event.id),
  );
  const ratifications = ratifyingNotes(state.events);

  // The flag as last RECORDED, ticket by ticket, walking the store's total
  // order. A ticket mutation event carries the whole end-state record and no
  // diff, so "the flag was cleared" is derivable only by comparing against the
  // previously journaled state — which is what makes this a journal walk rather
  // than a record check.
  const flagged = new Map<string, boolean>();

  for (const event of state.events) {
    const mutations = mutationRecords(event);
    const human = event.actor.kind === "human";
    for (const mutation of mutations) {
      if ("invalid" in mutation || mutation.target !== "ticket") continue;
      const record = mutation.record;
      const wasFlagged = flagged.get(record.id) === true;
      const isFlagged = record.human_only === true;
      flagged.set(record.id, isFlagged);

      if (wasFlagged && !isFlagged && !human) {
        findings.push({
          severity: "error",
          check: "roadmap.ticket-human-only-cleared",
          message:
            `decision ticket ${record.id} had its human-only flag cleared by ` +
            `${actorRef(event.actor)} (event ${event.id}, ${event.type}) — only a human may ` +
            "loosen a human-only ticket, and the CLI refuses `ticket update --clear-human-only` " +
            "under an agent actor (clear-then-resolve is the same hole with one extra step)",
          fix:
            `restore the flag with \`nahel roadmap ticket update ${record.id} --human-only\` and review ` +
            "everything done to the ticket after that event — this record was not written through the CLI",
        });
        continue;
      }

      const terminal =
        event.type === CORE_EVENT_TYPES.ticketResolved ||
        event.type === CORE_EVENT_TYPES.ticketClosed;

      if (isFlagged && terminal && !human) {
        findings.push({
          severity: "error",
          check: "roadmap.ticket-human-only-bypassed",
          message:
            `decision ticket ${record.id} is human-only, and its ${event.type} (event ${event.id}) ` +
            `was made by ${actorRef(event.actor)} — the CLI refuses that act under an agent actor, ` +
            "so this store was mutated outside the CLI or through a bug",
          fix:
            "take the answer back to the human whose question it was — re-open the decision with them, " +
            "and find the writer that skipped the refusal (hard constraint 3: agents mutate through the CLI)",
        });
        continue;
      }

      // The grilling rule (DD6). Only RESOLVE: a close rules the question away
      // rather than answering it, and ruling scope is not the interview. Only
      // under `human` product governance, and only when the resolution cites no
      // human-attributed source — a resolution citing the human's delegation
      // note IS the delegated path, not a rogue one — and only when no human
      // has RATIFIED it since. A ratifying note must be strictly later than
      // this resolution in the store's total order: a note written before the
      // decision cannot vouch for a decision not yet made, and an earlier note
      // the resolution meant to lean on is DD6's door, reached by citing it.
      if (
        event.type === CORE_EVENT_TYPES.ticketResolved &&
        !human &&
        !isFlagged &&
        record.type === "grilling" &&
        productMode === "human" &&
        !citedSources(mutations, event.id).some((source) => humanEvents.has(source)) &&
        !(ratifications.get(record.id) ?? []).some((note) => compareEvents(note, event) > 0)
      ) {
        findings.push({
          severity: "warning",
          check: "roadmap.ticket-grilling-self-resolved",
          message:
            `decision ticket ${record.id} is a grilling question resolved by ` +
            `${actorRef(event.actor)} (event ${event.id}) under governance.product: human, ` +
            "citing no human-attributed source — the partner answered its own interview question",
          fix:
            `record the delegation the way DD6 does — the human journals a note naming the ticket ` +
            `(\`nahel log note --data ticket=${record.id} --data summary=…\`) and the resolution cites it ` +
            "with `--source <event-id>`. Already resolved? the journal is append-only, so no source " +
            "can be added now — instead a human may ratify it post-hoc, and the same note journaled " +
            `AFTER the resolution clears this: \`nahel log note --data ticket=${record.id} ` +
            `--data summary="ratified: <why>"\`, under a human actor. Nothing was refused: under ` +
            "delegated/agent product governance the partner holds this authority outright",
        });
      }
    }
  }
  return findings;
}

/**
 * Knowledge-document reference existence: an item's document path (`prd`,
 * `investigation`) should name a file on disk, but a missing one is a
 * WARNING, never an error — knowledge documents can legitimately arrive by a
 * later merge (ADR-0012 merge-safe state). Skipped entirely when the
 * collector supplied no presence data for that field.
 */
function checkDocRefs(
  state: ParsedState,
  presence: Record<string, boolean> | undefined,
  field: "prd" | "investigation",
  check: string,
  what: string,
  fix: string,
): Finding[] {
  const findings: Finding[] = [];
  if (presence === undefined) return findings;
  for (const { record, path } of state.items.values()) {
    const doc = record[field];
    if (doc === undefined || presence[doc] !== false) continue;
    findings.push({
      severity: "warning",
      check,
      path,
      message: `item ${record.id} references ${what} ${doc}, which does not exist on disk`,
      fix,
    });
  }
  return findings;
}

/** PRD reference existence (F1, ADR-0013). */
function checkPrdRefs(state: ParsedState): Finding[] {
  return checkDocRefs(
    state,
    state.input.prdPresence,
    "prd",
    "item.prd-missing",
    "PRD",
    "author the document (prd-new workflow) or fix the item's prd path — a PRD may arrive by a later merge",
  );
}

/** Investigation reference existence (F5). */
function checkInvestigationRefs(state: ParsedState): Finding[] {
  return checkDocRefs(
    state,
    state.input.investigationPresence,
    "investigation",
    "item.investigation-missing",
    "investigation",
    "author the document (bug-lane workflow) or fix the item's investigation path — it may arrive by a later merge",
  );
}

/**
 * PRD-approval consistency (ADR-0013 + its 2026-07-21 amendment): a PRD file
 * carries no status — its approval lifecycle lives on the authoring `plan`
 * item, where done = approved, and `prd-parse` gates epic creation on that.
 * But `item update --status backlog --reopen` can revoke a plan item's done
 * AFTER feature items referencing the same PRD are already in flight, and
 * nothing else detects that drift. So: an ACTIVE non-plan item referencing a
 * `prd` whose authoring plan item(s) exist but none is done is a WARNING
 * (approval missing or revoked). A ccpm-imported epic carries a `prd` but has
 * NO plan item authoring it — no plan item shares the path, so imports stay
 * quiet. Finished work (the referencing item itself done or dropped) pointing
 * at a since-revoked PRD is history, not drift, so it is exempt; every active
 * status (backlog, in-progress, blocked, in-review) warns. A warning, never an
 * error — this never fails `nahel validate`.
 */
function checkPrdApproval(state: ParsedState): Finding[] {
  const findings: Finding[] = [];

  // PRD path → the authoring plan items' ids and whether any of them is done.
  const plansByPrd = new Map<string, { ids: string[]; anyDone: boolean }>();
  for (const { record } of state.items.values()) {
    if (record.type !== "plan" || record.prd === undefined) continue;
    const entry = plansByPrd.get(record.prd) ?? { ids: [], anyDone: false };
    entry.ids.push(record.id);
    entry.anyDone = entry.anyDone || record.status === "done";
    plansByPrd.set(record.prd, entry);
  }

  for (const { record, path } of state.items.values()) {
    if (record.type === "plan" || record.prd === undefined) continue;
    if (record.status === "done" || record.status === "dropped") continue;
    const plans = plansByPrd.get(record.prd);
    if (plans === undefined || plans.anyDone) continue;
    // Sort so the id listing (and thus the message) is deterministic.
    const ids = [...plans.ids].sort().join(", ");
    findings.push({
      severity: "warning",
      check: "item.prd-unapproved",
      path,
      message:
        `item ${record.id} references ${record.prd} whose authoring plan item ${ids} ` +
        `is not done (approval missing or revoked)`,
      fix: "flip the authoring plan item to done once the PRD is approved (the prd-parse gate), or pause the feature work until then",
    });
  }
  return findings;
}

/**
 * Parent/child status rollup: `done` on a parent claims the work beneath it
 * is finished, and nothing else notices when a child disagrees — the state a
 * parent closed by itself leaves behind, or a merge that reopened a child
 * under an already-closed parent.
 *
 * Settled means done OR dropped, the finished/live split checkPrdApproval
 * uses: a deliberately cut child is a decision, not pending work.
 *
 * A WARNING, never an error: both records are individually valid and either
 * one may be the correct one — which side to move is a human's call.
 */
function checkChildrenRollup(state: ParsedState): Finding[] {
  const findings: Finding[] = [];

  // Unfinished children per parent id. state.items is keyed in the collector's
  // sorted-id order, so each listing is deterministic without re-sorting.
  const unfinished = new Map<string, string[]>();
  for (const { record } of state.items.values()) {
    if (record.parent === undefined) continue;
    if (record.status === "done" || record.status === "dropped") continue;
    const listing = unfinished.get(record.parent) ?? [];
    listing.push(`${record.id} (${record.status})`);
    unfinished.set(record.parent, listing);
  }

  for (const { record, path } of state.items.values()) {
    if (record.status !== "done") continue;
    const open = unfinished.get(record.id);
    if (open === undefined) continue;
    findings.push({
      severity: "warning",
      check: "item.children-unfinished",
      path,
      message:
        `item ${record.id} is done but ${open.length} child item(s) are not ` +
        `done or dropped: ${open.join(", ")}`,
      fix: `finish or drop the child items, or reopen the parent (\`nahel item update ${record.id} --status in-progress\`)`,
    });
  }
  return findings;
}

/**
 * Merge-authority provenance (PRD F3.4): `merge: on-approve` is legitimate
 * under hard constraint 6 / ADR-0011 (as amended 2026-07-25) only as the
 * HUMAN's standing authorization — the committed config flip IS the
 * authorization — so the flip's provenance must be human, provable from the
 * journal. A flag an agent set (or one no journaled config mutation accounts
 * for: a hand edit, a lost flip) authorizes nothing: the review loop treats
 * the project as `merge: human` and this warns that the flag is inert.
 *
 * A third way to fail: two or more config mutations setting the section in the
 * SAME second that disagree. Same-second acts from different sessions carry no
 * ordering (F3.4 / authority.ts), so provenance is undecidable and fails safe.
 *
 * A WARNING, never an error: an unauthorized flag degrades to the safe
 * default, it does not corrupt state — but it is never silent (hard
 * constraint 6: quality invariants are never SILENTLY skipped).
 */
function mergeAuthorityCause(status: MergeAuthorityStatus): string {
  if (status.defect === "agent-set") {
    return (
      `the config mutation that set it (event ${status.setBy!.event}) was made by ` +
      `${status.setBy!.actor.kind}:${status.setBy!.actor.id} — an agent cannot grant ` +
      `the human's standing merge authorization`
    );
  }
  if (status.defect === "ambiguous") {
    const tied = (status.tied ?? [])
      .map((tie) => `${tie.event} by ${tie.actor.kind}:${tie.actor.id}`)
      .join(", ");
    return (
      `${(status.tied ?? []).length} config mutations set it in the same second (${tied}) ` +
      `and they disagree — same-second acts from different sessions carry no ordering, ` +
      `so which one governs is undecidable`
    );
  }
  return "no journaled config mutation sets it, so the flip's human provenance cannot be proven";
}

/**
 * Ambiguity needs one extra word in every provenance fix: the repairing act
 * must be LATER, not merely newer in the file — same-second acts carry no
 * ordering, so a fresh act sharing the tied second decides nothing either.
 */
function resignTiming(defect: string | undefined): string {
  return defect === "ambiguous"
    ? " — run it at least one second after the tied acts, so its timestamp is strictly the latest"
    : "";
}

function checkMergeAuthority(state: ParsedState): Finding[] {
  if (state.config === undefined) return [];
  const status = mergeAuthorityStatus(state.config.merge, state.events);
  if (status.defect === undefined) return [];

  const timing = resignTiming(status.defect);
  return [
    {
      severity: "warning",
      check: "merge.unauthorized",
      path: state.input.configPath,
      message:
        `nahel/config sets merge: on-approve, but ${mergeAuthorityCause(status)} — ` +
        `the flag is inert and merge authority stays human (PRs wait for a person)`,
      fix:
        "a HUMAN must re-run `nahel config set merge --data authority=on-approve` " +
        `(as a human actor — NAHEL_ACTOR unset, or human:<id>)${timing}; that journaled act ` +
        "IS the standing authorization. Otherwise drop the section and stay on merge: human",
    },
  ];
}

/**
 * Founding signature provenance (PRD F9.5, nahel/workflows/inception.md): the
 * merge.unauthorized analogue for the founding act. Under a hands-off founding
 * the paragraph IS the constitution's only human-signed content, and
 * inception.md states the rule twice — "the human-attributed `config.updated`
 * act that wrote the `founding` section IS the paragraph's signature. An
 * agent-run founding act signs nothing." Nothing surfaced a bad founding
 * mechanically: the workflow and the autonomy gate both state the rule, and
 * both rely on a reader checking the journal by hand.
 *
 * Only a founding carrying a PARAGRAPH is judged — a `guided` founding records
 * which door the project came through and nothing more, so an agent may write
 * it (inception.md: "only its act's actor is load-bearing" about the hands-off
 * paragraph).
 *
 * A WARNING, never an error: an unsigned founding is a gate refusal, not
 * corrupt state — the paragraph stays exactly as recorded, it just authorizes
 * nothing. But it is never silent (hard constraint 6).
 */
/** How each tie axis reads in the warning, in the order they are reported. */
const TIE_DISAGREEMENTS: Record<FoundingDisagreement, string> = {
  actor: "under different actor kinds",
  mode: "recording different founding modes",
  paragraph: "recording different paragraphs",
};

function foundingSignatureCause(status: FoundingSignatureStatus, declaredMode: string): string {
  if (status.defect === "agent-recorded") {
    return (
      `the config mutation that recorded it (event ${status.recordedBy!.event}) was made by ` +
      `${status.recordedBy!.actor.kind}:${status.recordedBy!.actor.id} — an agent-run founding ` +
      `act signs nothing`
    );
  }
  if (status.defect === "mode-mismatch") {
    // No signature is claimed either way here, so this wording holds for both
    // actor kinds: what the act attests is a DOOR, and config declares another
    // one. Named first because the mode decides what the paragraph even means.
    return (
      `the latest founding act (event ${status.recordedBy!.event}, by ` +
      `${status.recordedBy!.actor.kind}:${status.recordedBy!.actor.id}) recorded mode ` +
      `${JSON.stringify(status.recordedMode)}, not the ${JSON.stringify(declaredMode)} ` +
      "nahel/config declares — the door moved after the act, and an act attests only the mode " +
      "it recorded"
    );
  }
  if (status.defect === "paragraph-mismatch") {
    // Only a HUMAN act ever signed anything, so only there can the text have
    // moved out from under a signature. Saying that of an agent act would
    // assert a signature F9.5 never granted it.
    const consequence =
      status.recordedBy!.actor.kind === "human"
        ? "the text moved after it was signed, and an act signs only the bytes it recorded"
        : "and an agent-run founding act signs nothing anyway, so this paragraph was never signed";
    return (
      `the latest founding act (event ${status.recordedBy!.event}, by ` +
      `${status.recordedBy!.actor.kind}:${status.recordedBy!.actor.id}) records different ` +
      `paragraph bytes than nahel/config holds — ${consequence}`
    );
  }
  if (status.defect === "ambiguous") {
    const tied = (status.tied ?? [])
      .map((tie) => `${tie.event} by ${tie.actor.kind}:${tie.actor.id}`)
      .join(", ");
    // The tie's OWN disagreements — same-second acts may differ on who acted,
    // on the door they recorded, on the paragraph, or on any combination, and
    // naming an axis that does not apply would misdescribe the journal.
    const how = (status.disagreement ?? []).map((axis) => TIE_DISAGREEMENTS[axis]).join(" AND ");
    return (
      `${(status.tied ?? []).length} config mutations recorded it in the same second (${tied}) ` +
      `${how} — same-second acts from different sessions carry no ordering, ` +
      `so which one signed is undecidable`
    );
  }
  return "no journaled config mutation records it, so the paragraph's human provenance cannot be proven";
}

/**
 * Inception signature provenance (PRD F7.2, nahel/workflows/afk-run.md gate
 * 1a): the same rule for every project that did NOT found hands-off — guided
 * foundings and the projects founded before the field existed. With no
 * paragraph to sign, the gate reads `inception.constitution_signed_by` and the
 * act that recorded it: "an agent-attributed signature is not a signature".
 * Two states were entirely unsurfaced until now — a section that never
 * recorded a signer, and a signer an agent transcribed on a human's behalf —
 * and both refuse the run at the gate, hours after the human left.
 *
 * A WARNING, never an error, exactly as founding.unsigned: an unsigned
 * constitution is a gate refusal, not corrupt state — interactive work is
 * ungated and stays legal. Validate simply moves the refusal from the moment
 * the human walks away to the moment they can still act on it.
 */
function inceptionSignatureCause(status: InceptionSignatureStatus): string {
  if (status.defect === "absent") {
    return "nahel/config records no `inception` section, so nothing records who signed the constitution";
  }
  if (status.defect === "unsigned") {
    return (
      "nahel/config records an inception tier but no `constitution_signed_by`, " +
      "so nothing records who signed the constitution"
    );
  }
  if (status.defect === "agent-recorded") {
    return (
      "the config mutation that recorded nahel/config's `constitution_signed_by` " +
      `(event ${status.recordedBy!.event}) was made by ` +
      `${status.recordedBy!.actor.kind}:${status.recordedBy!.actor.id} — an agent transcribing ` +
      "a human's name is not that human's signature"
    );
  }
  if (status.defect === "signer-mismatch") {
    // Only a HUMAN act ever signed anything, so only there can the field have
    // moved out from under a signature. Saying that of an agent act would
    // assert a signature F7.2 never granted it (foundingSignatureCause's rule,
    // same reason).
    const consequence =
      status.recordedBy!.actor.kind === "human"
        ? "the signer moved after it was recorded, and an act signs only what it recorded"
        : "and an agent-transcribed signature is no signature anyway, so this signer never signed";
    return (
      `the latest act on nahel/config's \`inception\` section (event ${status.recordedBy!.event}, ` +
      `by ${status.recordedBy!.actor.kind}:${status.recordedBy!.actor.id}) recorded a different ` +
      `\`constitution_signed_by\` than nahel/config holds — ${consequence}`
    );
  }
  if (status.defect === "ambiguous") {
    const tied = (status.tied ?? [])
      .map((tie) => `${tie.event} by ${tie.actor.kind}:${tie.actor.id}`)
      .join(", ");
    return (
      `${(status.tied ?? []).length} config mutations wrote nahel/config's \`inception\` section ` +
      `in the same second (${tied}) and they disagree — same-second acts from different sessions ` +
      "carry no ordering, so which one signed is undecidable"
    );
  }
  return (
    "no journaled config mutation records nahel/config's `constitution_signed_by`, " +
    "so the signature's human provenance cannot be proven"
  );
}

/**
 * WHO repairs an unsigned inception record — the answer differs by founding
 * mode, and getting it wrong breaks the mode's promise. Under a hands-off
 * founding the human is gone BY DESIGN (F9.5's zero-return door): the
 * signature is the founding act, and the tier record beside it is bookkeeping
 * an agent completes, citing that act. Demanding the human's return there
 * would make validate ask for the one thing the mode exists to avoid. Every
 * other project signs with THIS act, so only the human can make it.
 *
 * `foundedHandsOff` is the JOURNAL's answer, never config's own `mode` field:
 * a hand-edited door must not talk an agent into signing on a human's behalf.
 *
 * Both fields in the one command either way: `config set` replaces the whole
 * section, so a signer-only re-run would drop the tier (and a tier-only one
 * the signature). The tier is named when config records one, so the command
 * is a paste rather than a lookup.
 */
function inceptionSignatureFix(
  state: ParsedState,
  status: InceptionSignatureStatus,
  founding: FoundingSignatureStatus | undefined,
  foundedHandsOff: boolean,
): string {
  const tier = state.config?.inception?.tier ?? "<seed|standard|full>";
  const set = (signer: string): string =>
    `\`nahel config set inception --data tier=${tier} --data 'constitution_signed_by=${signer}'\``;

  if (foundedHandsOff) {
    // A journal-proved hands-off door always has ONE governing founding act —
    // that is what proved it (authority.ts) — so the citation is always there.
    return (
      `an AGENT may record this — run ${set("<the human who founded>")}: under a hands-off ` +
      `founding the signature is the founding act (event ${founding!.recordedBy!.event}), not ` +
      "this act, so the tier record is bookkeeping that must never wait for the human to come " +
      "back (nahel/workflows/inception.md)"
    );
  }
  return (
    `a HUMAN must run ${set("<their id>")} themselves (as a human actor — NAHEL_ACTOR unset, or ` +
    `human:<id>)${resignTiming(status.defect)}; \`config set\` replaces the whole section, so ` +
    "both fields must be given in that one act, and the act itself IS the signature " +
    "(nahel/workflows/inception.md)"
  );
}

/**
 * The constitution's signature, both halves from one verdict (authority.ts):
 * `founding.unsigned` for the hands-off paragraph, `inception.unsigned` for
 * the tier record every project needs. They fail independently — a hands-off
 * project can have a signed paragraph and no tier record — and each names its
 * own repair, so each is its own finding.
 */
function checkConstitutionSignature(state: ParsedState): Finding[] {
  if (state.config === undefined) return [];
  const { founding, inception, foundedHandsOff } = constitutionSignatureStatus(
    state.config,
    state.events,
  );
  const findings: Finding[] = [];

  if (founding !== undefined && !founding.signed) {
    // The mode config DECLARES: the act re-recording it must restore the door
    // this project actually came through, and under a mode-mismatch the two
    // are precisely what disagree.
    const declaredMode = state.config.founding!.mode;
    findings.push({
      severity: "warning",
      check: "founding.unsigned",
      path: state.input.configPath,
      message:
        "nahel/config records a founding paragraph, but " +
        `${foundingSignatureCause(founding, declaredMode)} — the constitution is unsigned and ` +
        "the autonomy gate refuses to treat it as founded",
      // The JSON --data form, never `--data paragraph=…`: the key=value
      // dialect trims the whole entry (parseDataEntries), so the value loses
      // its trailing whitespace and the human would re-sign bytes that differ
      // from the ones on disk (nahel/workflows/inception.md). JSON passes the
      // text through untouched — and verbatim is the whole promise (F9.5).
      fix:
        "a HUMAN must re-run `nahel config set founding " +
        `--data '{"mode": "${declaredMode}", "paragraph": "<the paragraph, verbatim>"}'\` ` +
        `(as a human actor — NAHEL_ACTOR unset, or human:<id>)${resignTiming(founding.defect)}; ` +
        "that journaled act IS the paragraph's signature (nahel/workflows/inception.md)",
    });
  }

  // An `inception` section a store never had is worth reporting only once the
  // store has something the gate would refuse: work on disk, or a founding
  // that recorded which door the project came through. A freshly scaffolded
  // store has nothing to run AFK yet, and warning there would make `nahel
  // init` greet every new project with a defect. Raw presence, so a
  // malformed item still counts — work is work.
  const hasWork =
    state.itemFiles.size > 0 || state.runDirs.size > 0 || state.config.founding !== undefined;
  if (!inception.signed && (inception.defect !== "absent" || hasWork)) {
    findings.push({
      severity: "warning",
      check: "inception.unsigned",
      path: state.input.configPath,
      message:
        `${inceptionSignatureCause(inception)} — the constitution is unsigned and the autonomy ` +
        "gate refuses to start an AFK run",
      fix: inceptionSignatureFix(state, inception, founding, foundedHandsOff),
    });
  }

  return findings;
}

/**
 * Cross-vendor review slots (PRD F3.1): the review loop demands two reviewer
 * VENDORS, and `nahel/workflows/review-loop.md` step 1 refuses to count two
 * same-vendor reviews as two — a refusal that lands mid-loop, after the work
 * is done. Resolving both slots from committed config (routing.review2 made
 * slot 2 nameable) moves that discovery to setup time, where the fix is one
 * `config set` instead of a parked item.
 *
 * A WARNING, never an error: a single-vendor map is an honest state for a
 * project that never runs the loop, and the loop itself still refuses. Silent
 * it is not (hard constraint 6).
 */
function checkReviewSlots(state: ParsedState): Finding[] {
  const routing = state.config?.routing;
  if (routing === undefined) return [];
  const slots = resolveReviewSlots(routing);
  if (slots === undefined || slots.slot1.agent !== slots.slot2.agent) return [];
  return [
    {
      severity: "warning",
      check: "routing.review-same-vendor",
      path: state.input.configPath,
      message:
        `both review slots resolve to the same vendor agent ${JSON.stringify(slots.slot1.agent)} ` +
        `(slot 1 via ${slots.slot1.via}, slot 2 via ${slots.slot2.via}) — ` +
        `two same-vendor reviews are not two reviewers, so the review loop refuses to sign off`,
      fix:
        "name a second vendor: `nahel config set routing` with a `review2` entry (or a `review` " +
        "entry) whose agent differs from the other slot's — see nahel/workflows/setup-routing.md",
    },
  ];
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
type MutationTarget =
  | "item"
  | "run"
  | "observation"
  | "roadmap-node"
  | "map"
  | "ticket";

type Mutation =
  | { target: "item"; record: WorkItemFrontmatter; body: string }
  | { target: "run"; record: Run }
  | { target: "observation"; record: ObservationFrontmatter; body: string }
  | { target: "roadmap-node"; record: RoadmapNodeFrontmatter; body: string }
  | { target: "map"; record: MapFrontmatter; body: string }
  | { target: "ticket"; record: TicketFrontmatter; body: string }
  | { target: MutationTarget; invalid: string };

/** Each mutation target's schema, and whether its payload carries a body. */
const MUTATION_SCHEMAS: Record<
  MutationTarget,
  { schema: z.ZodType<{ id: string }>; hasBody: boolean }
> = {
  item: { schema: workItemFrontmatterSchema, hasBody: true },
  run: { schema: runSchema, hasBody: false },
  observation: { schema: observationFrontmatterSchema, hasBody: true },
  "roadmap-node": { schema: roadmapNodeFrontmatterSchema, hasBody: true },
  map: { schema: mapFrontmatterSchema, hasBody: true },
  ticket: { schema: ticketFrontmatterSchema, hasBody: true },
};

/** Parse one `{target, record, body}` triple out of a mutation payload. */
function mutationEntry(entry: Record<string, unknown>, target: MutationTarget): Mutation {
  const kind = MUTATION_SCHEMAS[target];
  const result = kind.schema.safeParse(entry["record"]);
  if (!result.success) return { target, invalid: zodIssues(result.error) };
  const body = entry["body"];
  if (kind.hasBody && typeof body !== "string") {
    return { target, invalid: "payload body is not a string" };
  }
  // The cast is the same one parseState's kind table makes: TypeScript cannot
  // relate the table's schema to the union member across a lookup, but within
  // one target they always match.
  return { target, record: result.data, body: typeof body === "string" ? body : "" } as Mutation;
}

/**
 * The mutation records one event carries, when the event is a mutation — one
 * entry for a single-record mutation, one per record for a SEQUENCE (F7's
 * `resolve` and `close` write several records under a single write-ahead
 * event), and [] when the event is not a mutation at all.
 *
 * Mutations are identified by event TYPE (the choke point's core mutation
 * types), never by payload shape — a mutation-shaped payload under `note` or
 * any open extension type (a forged `nahel log`, a rogue writer) is inert
 * data. Within a mutation type, payload shape is a validity check: a core
 * mutation event that cannot be replayed is reported, not ignored.
 */
function mutationRecords(event: JournalEvent): Mutation[] {
  if (!MUTATION_EVENT_TYPES.has(event.type)) return [];
  const payload = event.payload;
  if (payload["target"] === "sequence") {
    const records = payload["records"];
    if (!Array.isArray(records)) {
      return [{ target: sequenceTarget(event), invalid: "sequence payload carries no records list" }];
    }
    const mutations: Mutation[] = [];
    for (const entry of records) {
      if (entry === null || typeof entry !== "object") {
        mutations.push({ target: sequenceTarget(event), invalid: "sequence record is not an object" });
        continue;
      }
      const record = entry as Record<string, unknown>;
      const target = record["target"];
      // A DOCUMENT step is a step of the sequence but not a record (F10): it
      // has no id and no schema to compare against disk, and checkArchival
      // reports it against the filesystem instead.
      if (target === "document") continue;
      if (typeof target !== "string" || !(target in MUTATION_SCHEMAS)) {
        mutations.push({
          target: sequenceTarget(event),
          invalid: `sequence record names no known target (${JSON.stringify(target)})`,
        });
        continue;
      }
      mutations.push(mutationEntry(record, target as MutationTarget));
    }
    return mutations;
  }
  const target = payload["target"];
  if (typeof target === "string" && target in MUTATION_SCHEMAS) {
    return [mutationEntry(payload, target as MutationTarget)];
  }
  // A core mutation type whose payload lacks the target/record replay fields:
  // the choke point always writes them, so this event cannot be replayed.
  return [
    {
      target: sequenceTarget(event),
      invalid: "payload carries no target/record mutation fields",
    },
  ];
}

/** The record kind an unreplayable event's TYPE implies, for the report. */
function sequenceTarget(event: JournalEvent): MutationTarget {
  if (event.type.startsWith("item.")) return "item";
  if (event.type.startsWith("observation.")) return "observation";
  if (event.type.startsWith("roadmap.map-")) return "map";
  if (event.type.startsWith("roadmap.ticket-")) return "ticket";
  if (event.type.startsWith("roadmap.")) return "roadmap-node";
  return "run";
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
    for (const mutation of mutationRecords(event)) {
      if ("invalid" in mutation) continue;
      // Observations, roadmap nodes, maps and tickets touch no item — no claim
      // can cover them (mutate() parity: a claim freezes work, never the intent
      // above it, and a ticket's own claim is advisory assignment).
      if (mutation.target !== "item" && mutation.target !== "run") continue;

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

/**
 * Journal well-formedness: real timestamps, monotonic seq per segment, globally
 * unique ids.
 *
 * The TIMESTAMP leg is the seam between the record schema and timestamp
 * arithmetic (`schema/time.ts`). `ts` is validated as a SHAPE, and that gate
 * has to stay loose — tightening it to the calendar would make a store carrying
 * one impossible date unreadable, including by the `validate` run that would
 * tell you about it — so `2026-02-30T00:00:00Z` parses cleanly and reaches
 * every reader that orders or ages the journal. Arithmetic REFUSES it, which
 * would otherwise retire the compaction-age threshold for a reason nobody could
 * see. So it is reported here, once, as the corruption it is.
 */
function checkJournal(state: ParsedState): Finding[] {
  const findings: Finding[] = [];
  for (const segment of state.input.segments) {
    for (const event of segment.events) {
      if (epochSeconds(event.ts) !== undefined) continue;
      findings.push({
        severity: "error",
        check: "journal.timestamp",
        path: segment.path,
        message:
          `event ${event.id} is dated ${event.ts}, which is not a real instant — ` +
          "every time-ordered read of the journal (ordering, windows, ages) rests on it",
        fix: "the segment was edited or written by a non-nahel tool — restore it from git (segments are append-only)",
      });
    }
  }
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
    for (const mutation of mutationRecords(event)) {
      if (!("invalid" in mutation)) continue;
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

  // Keyed by target and id, and mirroring the store's replayPending exactly: a
  // SEQUENCE event (F7) contributes one finalist per record it carries, so an
  // interruption between any two of its writes is reported record by record.
  type Finalist = { event: JournalEvent; record: { id: string }; body: string };
  const finalists = new Map<string, Finalist[]>();
  for (const segment of state.input.segments) {
    // Per segment, event order is causal order: later overwrites earlier.
    const latest = new Map<string, Finalist>();
    for (const event of segment.events) {
      for (const mutation of mutationRecords(event)) {
        if ("invalid" in mutation) continue;
        const body = mutation.target === "run" ? "" : mutation.body;
        latest.set(`${mutation.target}:${mutation.record.id}`, {
          event,
          record: mutation.record,
          body,
        });
      }
    }
    for (const [key, finalist] of latest) {
      finalists.set(key, [...(finalists.get(key) ?? []), finalist]);
    }
  }

  /** The on-disk record and its file, per target — what divergence compares to. */
  const onDisk: Record<
    MutationTarget,
    Map<string, { record: { id: string }; body?: string; path: string }>
  > = {
    item: state.items,
    run: state.runs,
    observation: state.observations,
    "roadmap-node": state.roadmapNodes,
    map: state.maps,
    ticket: state.tickets,
  };
  /** What each target is called in the report. */
  const noun: Record<MutationTarget, string> = {
    item: "item",
    run: "run",
    observation: "observation",
    "roadmap-node": "roadmap node",
    map: "map",
    ticket: "decision ticket",
  };

  // Records the journal says were RETIRED (C3), dropped for the same reason
  // replayPending drops them: a superseded migration's node left the roadmap by
  // a journaled act, so its absence is deliberate rather than the crash window.
  // What is reported here and what repair materializes have to agree, or
  // `--repair` would resurrect exactly what this check called gone.
  for (const event of state.events) {
    for (const id of supersededNodeIds(event)) finalists.delete(`roadmap-node:${id}`);
  }

  const repairFix =
    "run `nahel validate --repair` — it replays the journaled mutation and only materializes what the journal already records";
  for (const [key, list] of finalists) {
    const target = key.slice(0, key.indexOf(":")) as MutationTarget;
    const id = key.slice(target.length + 1);
    const disk = onDisk[target].get(id);
    const candidates = latestCandidates(list);
    const inSync =
      disk !== undefined &&
      candidates.some(
        (candidate) =>
          JSON.stringify(disk.record) === JSON.stringify(candidate.record) &&
          (disk.body ?? "") === candidate.body,
      );
    if (!inSync) {
      const pending = candidates[candidates.length - 1]!;
      findings.push({
        severity: "error",
        check: "journal.divergence",
        ...(disk === undefined ? {} : { path: disk.path }),
        message:
          `${noun[target]} ${id} record is ${disk === undefined ? "missing" : "behind"} its latest ` +
          `mutation event ${pending.event.id} (${pending.event.type}) — the journal is ahead`,
        fix: repairFix,
      });
    }
  }
  return findings;
}

/**
 * The DOCUMENT half of divergence (Phase 4 F10). A journaled document step is
 * the same promise a journaled record write is — the journal states what the
 * filesystem should hold — so an act killed before the file work landed is
 * reported in the same words and healed by the same flag.
 *
 * The shapes a `move` can be caught in are named separately, because they are
 * different facts about where the document is:
 *
 * - the destination holds a document this event did NOT stamp: a reused PRD
 *   basename pointing two deltas at one archive slot. Repair refuses to unlink
 *   the live source into it, and this names why;
 * - neither location holds it: repair cannot invent a document, so this is the
 *   one archival state `--repair` will not fix, and it says so;
 * - the destination is empty and the source still holds it: the move never
 *   started, the journal is ahead;
 * - BOTH hold it: the copy landed and the source was never unlinked — the one
 *   partial state the move's own ordering can leave, and the next repair pass
 *   removes the source.
 *
 * An `append` is judged by its MARKER, not by the line: a design doc is
 * permanent and gets reworded, and the act has landed as long as the pointer it
 * carried — event-scoped, so nothing else can have written it — is still in the
 * document.
 */
function checkArchival(state: ParsedState): Finding[] {
  const findings: Finding[] = [];
  const presence = state.input.documentPresence;
  const repairFix =
    "run `nahel validate --repair` — it applies the journaled document step and only makes real what the journal already records";
  for (const event of state.events) {
    const { edits, invalid } = eventDocuments(event);
    for (const reason of invalid) {
      findings.push({
        severity: "error",
        check: "journal.payload",
        message:
          `mutation event ${event.id} (${event.type}) carries an unusable document step — ${reason} — ` +
          "repair cannot use it",
        fix: "the event payload was corrupted — restore the segment from git",
      });
    }
    if (presence === undefined) continue;
    for (const edit of edits) {
      if (edit.op === "move") {
        const to = presence[edit.to] === true;
        const from = presence[edit.from] === true;
        // A file AT the destination is not this move having happened: the
        // stamp names the archival event, so only the stamp proves it.
        if (to && !(state.input.documentText?.[edit.to] ?? "").includes(edit.header)) {
          findings.push({
            severity: "error",
            check: "roadmap.document-collision",
            path: edit.to,
            message:
              `event ${event.id} moved ${edit.from} to ${edit.to}, but the document at ${edit.to} carries a ` +
              "different act's stamp — repair will not unlink a live document into an archive it did not write",
            // The recovery is repair, NOT the verb: by the time this fires the
            // event is journaled and the record refs already point at the
            // archived path, so re-running `nahel roadmap archive` only earns
            // the already-archived refusal. Freeing the destination is the one
            // thing missing — repair has been holding the move all along.
            fix: "move the document already at that path aside (the archive holds one file per delta, and an archived PRD is never overwritten), then run `nahel validate --repair` — it completes the journaled move",
          });
          continue;
        }
        if (!to && !from) {
          findings.push({
            severity: "error",
            check: "roadmap.document-lost",
            message:
              `event ${event.id} moved ${edit.from} to ${edit.to}, and the document is at neither ` +
              "location — nothing this store moves is ever deleted, so this is a hand deletion",
            fix: "restore the document from git — `nahel validate --repair` cannot invent one",
          });
        } else if (!to) {
          findings.push({
            severity: "error",
            check: "journal.divergence",
            path: edit.to,
            message: `document ${edit.to} is missing its journaled move from ${edit.from} (event ${event.id}) — the journal is ahead`,
            fix: repairFix,
          });
        } else if (from) {
          findings.push({
            severity: "error",
            check: "journal.divergence",
            path: edit.from,
            message: `document ${edit.from} was journaled as moved to ${edit.to} (event ${event.id}) but still exists at both — the journal is ahead`,
            fix: repairFix,
          });
        }
        continue;
      }
      if (presence[edit.path] !== true) {
        // An ERROR, like every other journal-ahead-of-disk state: the act was
        // recorded, the document it names is not there, and repair cannot
        // converge until it is. A warning would let a store where an act is
        // permanently half-done exit 0.
        findings.push({
          severity: "error",
          check: "roadmap.design-doc-missing",
          path: edit.path,
          message: `event ${event.id} recorded a line for ${edit.path}, which does not exist on disk — the product design doc is permanent, never archived and never deleted, so the journal is ahead of nothing`,
          fix: "restore the document from git and run `nahel validate --repair` (it appends the recorded line), or point the product node at the right one with `nahel roadmap node update <ref> --design-doc <path>`",
        });
        continue;
      }
      if (!(state.input.documentText?.[edit.path] ?? "").includes(edit.marker)) {
        findings.push({
          severity: "error",
          check: "journal.divergence",
          path: edit.path,
          message: `document ${edit.path} does not carry what event ${event.id} recorded (${edit.marker}) — the journal is ahead`,
          fix: repairFix,
        });
      }
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

/** The result contract as one line, for the findings that judge the whole shape. */
const RESULT_DOC_SHAPE_FIX =
  `a result document is YAML frontmatter between \`---\` lines — \`run\`, \`item\`, ` +
  `\`status\` (${RESULT_DOC_STATUSES.join(" | ")}), \`summary\` — followed by free markdown`;

/** What each contract field must hold, for the per-issue findings. */
const RESULT_DOC_FIELD_FIX: Record<string, string> = {
  run: "`run` must be the id of the run directory the document sits in",
  item: "`item` must be the id of the work item the run is executing",
  status: `\`status\` must be one of ${RESULT_DOC_STATUSES.join(" | ")}`,
  summary: "`summary` must be ONE non-empty line — the detail belongs in the body",
};

/**
 * Worker result documents (PRD F4): every `nahel/runs/<id>/result.md` that
 * EXISTS is judged against the result contract — the frontmatter split, the
 * schema, and the two cross-references it carries.
 *
 * Everything here is a WARNING, without exception. A result doc is authored by
 * a dispatched agent nahel does not control, in a process nobody was watching;
 * it is a report about the store, never store state nahel wrote. Failing
 * `nahel validate` on a worker's typo would let an outside process break the
 * repo's integrity gate, so these findings advise and never fail.
 *
 * A run dir WITHOUT result.md produces nothing at all (F4 non-goal: worker
 * enforcement — dispatch records whether the file appeared, F5). The scope is
 * result.md alone: a malformed run record or a rogue run-dir name is already
 * another check's finding and is not re-reported here.
 */
function checkResultDocs(state: ParsedState): Finding[] {
  const findings: Finding[] = [];
  for (const raw of state.input.runs) {
    if (raw.resultDocText === undefined) continue;
    const path = raw.resultDocPath;

    let frontmatter: Record<string, unknown>;
    try {
      frontmatter = parseFrontmatter(raw.resultDocText).frontmatter;
    } catch (error) {
      findings.push({
        severity: "warning",
        check: "run.result-doc",
        path,
        message: `run ${raw.id}: ${RESULT_DOC_FILENAME} is not a frontmatter document — ${errorMessage(error)}`,
        fix: RESULT_DOC_SHAPE_FIX,
      });
      continue;
    }

    // One finding PER ISSUE, not the collapsed `zodIssues` line the store's own
    // records get (F4 acceptance: each missing required key and a bad status
    // enum are DISTINCT findings) — the author is an agent that reads findings
    // one at a time and fixes what each one names.
    const parsed = resultDocFrontmatterSchema.safeParse(frontmatter);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path.length === 0 ? "(root)" : issue.path.join(".");
        findings.push({
          severity: "warning",
          check: "run.result-doc",
          path,
          message: `run ${raw.id}: ${RESULT_DOC_FILENAME} frontmatter is invalid — ${field}: ${issue.message}`,
          fix: RESULT_DOC_FIELD_FIX[field] ?? RESULT_DOC_SHAPE_FIX,
        });
      }
      continue;
    }

    if (parsed.data.run !== raw.id) {
      findings.push({
        severity: "warning",
        check: "run.result-doc",
        path,
        message: `run ${raw.id}: ${RESULT_DOC_FILENAME} reports run ${parsed.data.run}, which is not the run directory it sits in`,
        fix: RESULT_DOC_FIELD_FIX["run"]!,
      });
    }
    if (!state.itemFiles.has(parsed.data.item)) {
      findings.push({
        severity: "warning",
        check: "run.result-doc",
        path,
        message: `run ${raw.id}: ${RESULT_DOC_FILENAME} names item ${parsed.data.item}, which does not exist`,
        fix: `${RESULT_DOC_FIELD_FIX["item"]!} — take it from the run's task document`,
      });
    }
  }
  return findings;
}

const COMPACT_FIX =
  "run the compact workflow (nahel/workflows/compact.md): distill facts with `nahel observe`, then mark the covered segments with `nahel distill <segment>...`";

/**
 * Maintenance-debt warnings (ADR-0004: validate flags overdue semantic
 * maintenance). Rotation debt is closed-but-unarchived segments (threshold
 * from config's `validate` block); compaction debt is UN-DISTILLED ARCHIVED
 * events — events in archived segments with no marker in
 * nahel/journal/distilled/ — over
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

  // Compaction debt (PRD F6.2). An unreadable marker dir already produced
  // schema.distilled and leaves state.distilled undefined — skip rather than
  // warn over state we could not see.
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

  // Either reading may be unreadable rather than absent — an impossible date in
  // an archived segment, which `journal.timestamp` above reports by name. The
  // age leg then measures nothing rather than measuring a fiction; the reader
  // is already being told exactly which event to repair.
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

/**
 * Canonical workflow drift (chore 7fq7yvne, following bug mcm4ak0e): the
 * workflow docs in the store's `nahel/workflows/` against the copies EMBEDDED
 * in the running binary. Deterministic — a byte comparison against a build-time
 * constant, no network and no clock.
 *
 * Two warnings, never errors, because both states are legitimate mid-upgrade:
 *   - `workflows.drift`: the doc is there and differs. Two things produce that
 *     and nahel cannot tell them apart, so the message names both — the binary
 *     was upgraded and the store's copy is stale, or the doc was hand-edited.
 *     `nahel init` is write-if-missing, so the refresh is to move the edited
 *     copy aside (or delete it) and re-run init.
 *   - `workflows.missing`: the doc is not there at all. A store scaffolded
 *     before v0.4.1 never received any of them and warns once per doc, which
 *     is the honest count — and one `nahel init` writes every one of them back
 *     without touching anything that already exists.
 *
 * EXTRA docs alongside the canonical set are never flagged: additional
 * workflows are the sanctioned place for a repo's own judgment, and this check
 * only ever looks up the canonical names.
 */
function checkWorkflowDrift(state: ParsedState): Finding[] {
  const docs = state.input.workflowDocs;
  if (docs === undefined) return [];

  // The whole canonical set absent is ONE condition — a store scaffolded
  // before the docs shipped — not eighteen. Collapsing it protects the
  // brief's byte budget (18 warnings truncated the constitution section),
  // and the fix is a single command either way. Partial absence stays
  // per-file below, where naming exactly what is gone earns its lines.
  // Guarded on the FULL embedded set, not just what the collector handed
  // over: a partial input map whose entries all read null must fall through
  // to per-file findings rather than claim "all N absent".
  const collected = CANONICAL_WORKFLOWS.filter((workflow) => docs[workflow.name] !== undefined);
  if (
    collected.length === CANONICAL_WORKFLOWS.length &&
    collected.every((workflow) => docs[workflow.name]?.text === null)
  ) {
    return [
      {
        severity: "warning",
        check: "workflows.missing",
        message:
          `all ${collected.length} canonical workflow docs are absent from this store — ` +
          `it was scaffolded before the docs shipped with the binary`,
        fix: "run `nahel init`: it only writes what is absent, so one run restores the whole canonical set and overwrites nothing",
      },
    ];
  }

  const findings: Finding[] = [];
  for (const workflow of CANONICAL_WORKFLOWS) {
    const doc = docs[workflow.name];
    if (doc === undefined) continue;
    const file = `${workflow.name}.md`;
    if (doc.text === null) {
      findings.push({
        severity: "warning",
        check: "workflows.missing",
        path: doc.path,
        message:
          `${file} is a canonical workflow doc but this store does not have it — ` +
          `a store scaffolded before the docs shipped is missing all of them`,
        fix: "run `nahel init`: it only writes what is absent, so one run restores every missing canonical doc and overwrites nothing",
      });
    } else if (doc.text !== workflow.body) {
      findings.push({
        severity: "warning",
        check: "workflows.drift",
        path: doc.path,
        message:
          `${file} differs from this binary's embedded copy — either the binary was ` +
          `upgraded past the store's stale copy, or the doc was hand-edited (the canonical ` +
          `docs are canonical; local judgment belongs in ADDITIONAL workflow docs beside them)`,
        fix: `\`nahel init\` never overwrites an existing doc, so refresh it by moving ${file} aside (or deleting it) and running \`nahel init\``,
      });
    }
  }
  return findings;
}

/**
 * Read the journaled creation bases: branch → the commit it branched FROM
 * (`prototype.variants-created`, Phase 2 F5.1). Later records win, which is
 * the right answer for a branch name that was disposed of and re-created.
 * Payloads are read defensively — events are data, and a malformed one must
 * mute its own branch, never poison the check.
 */
function prototypeBases(state: ParsedState): Map<string, string> {
  const bases = new Map<string, string>();
  for (const event of state.events) {
    if (event.type !== PROTOTYPE_VARIANTS_CREATED_EVENT_TYPE) continue;
    const variants = event.payload["variants"];
    if (!Array.isArray(variants)) continue;
    for (const entry of variants) {
      if (typeof entry !== "object" || entry === null) continue;
      const { branch, base } = entry as Record<string, unknown>;
      if (typeof branch === "string" && typeof base === "string") bases.set(branch, base);
    }
  }
  return bases;
}

/**
 * Never-merge, enforced mechanically (PRD F5.2). Prototype code never merges,
 * and a prototype ref must never reach a PR or the default branch — so this
 * check reports three things and guesses at none of them:
 *
 * - `prototype.merged` (error), from EITHER of two independent signals:
 *   - *ancestry* — the branch's tip has moved past the base it was created at
 *     AND the default branch now contains that tip. Both halves are required:
 *     a branch still sitting at its base is reachable from the default branch
 *     by construction, and flagging that would fire on every `nahel prototype
 *     start` a second after it ran.
 *   - *patch-id equivalence* — `git cherry` reports commits of this branch
 *     whose patch already exists in the default branch. A cherry-pick or a
 *     rebase-style copy lands prototype code as a NEW commit, so ancestry sees
 *     an innocent branch while the code is merged in every sense that matters;
 *     the lane's rule 2 forbids a cherry-pick by name, and this is its teeth.
 *     Needs no creation base, so it judges unrecorded branches too.
 *
 *   Honest residual: a SQUASH merge (or a copy that was edited on the way in)
 *   changes the patch, so neither signal sees it, and detecting it offline
 *   would mean content-diffing every default-branch commit against every
 *   prototype commit — a cost out of proportion to a check that runs on every
 *   `nahel validate`. The mechanical teeth are ancestry + patch equivalence;
 *   the rest is the never-push/never-PR rule in
 *   `nahel/workflows/prototype-lane.md`, which is stated there rather than
 *   pretended at here.
 * - `prototype.pushed` (error): a remote-tracking prototype ref exists. Pushing
 *   is the precondition for opening a PR, and it is the furthest an offline,
 *   deterministic check can see — nahel never asks a remote anything, so "a PR
 *   exists" is judged by its local footprint, not by an API call.
 * - `prototype.unrecorded` (warning): a prototype-named branch nahel has no
 *   creation record for. Without the base, "sitting at its creation point" and
 *   "merged into the default branch" are the same git observation, so the
 *   honest report is that the branch cannot be judged — not a verdict.
 * - `prototype.scan-failed` (error): the scan ABORTED inside a real repo, so
 *   none of the above ran. ERROR, not warning, on the exit contract: warnings
 *   exit 0, and an unverified constitutional invariant reported as exit 0 is
 *   indistinguishable from a verified-clean repo — the invisible failure
 *   PRODUCT.md HC6 / ADR-0011 forbid. It sits with validate's other
 *   could-not-READ findings (a record that will not parse, an unreplayable
 *   payload), all errors; the warnings are cases where the data WAS read and
 *   only the verdict is unreachable (`prototype.unrecorded`, same-second
 *   ambiguity). No repo at all stays silent: nothing exists to be judged.
 */
function checkPrototypeRefs(state: ParsedState): Finding[] {
  const scan = state.input.prototypeRefs;
  if (scan === undefined) return [];
  if (scan.scanFailed === true) {
    return [
      {
        severity: "error",
        check: "prototype.scan-failed",
        message:
          `the prototype ref scan could not complete: ${scan.error ?? "no reason reported"} — ` +
          "never-merge enforcement (F5.2) did not run, so prototype code that reached the " +
          "default branch would go unreported",
        fix:
          "fix the git failure above and re-run `nahel validate` — never-merge is a hard " +
          "constraint, so an unread repo is reported, never assumed clean",
      },
    ];
  }
  if (scan.error !== undefined) return [];

  const findings: Finding[] = [];
  const bases = prototypeBases(state);

  for (const branch of scan.branches) {
    // Patch-id equivalence first: it needs no creation base, so it judges
    // hand-made branches the ancestry half can only call unjudgeable.
    const copies = branch.copiedToDefault;
    if (scan.defaultBranch !== undefined && copies.length > 0) {
      findings.push({
        severity: "error",
        check: "prototype.merged",
        message:
          `prototype branch ${branch.branch} has ${copies.length} commit(s) whose patch is already ` +
          `in ${scan.defaultBranch} (${copies.join(", ")}) — copied across by cherry-pick or rebase, ` +
          "and prototype code never merges (nahel/workflows/prototype-lane.md)",
        fix:
          `revert those commits out of ${scan.defaultBranch}; promote the variant's mini-PRD ` +
          "with `nahel prototype promote <variant-item-id>` and rebuild the work in the feature lane",
      });
    }

    const base = bases.get(branch.branch);
    if (base === undefined) {
      findings.push({
        severity: "warning",
        check: "prototype.unrecorded",
        message:
          `prototype branch ${branch.branch} has no journaled creation record, so nahel cannot ` +
          "tell whether its code reached the default branch — an unrecorded prototype ref is unjudgeable, not innocent",
        fix: "spawn prototype variants with `nahel prototype start <item-id> --variants <n>`, which records each branch's base",
      });
      continue;
    }
    if (scan.defaultBranch === undefined) continue;
    if (branch.tip !== base && branch.ancestorOfDefault) {
      findings.push({
        severity: "error",
        check: "prototype.merged",
        message:
          `prototype branch ${branch.branch} has commits past its base ${base} and ${scan.defaultBranch} ` +
          "now contains them — prototype code never merges (nahel/workflows/prototype-lane.md)",
        fix:
          `revert the prototype commits out of ${scan.defaultBranch}; promote the variant's mini-PRD ` +
          "with `nahel prototype promote <variant-item-id>` and rebuild the work in the feature lane",
      });
    } else if (
      branch.mergeBaseWithDefault !== undefined &&
      branch.mergeBaseWithDefault !== base
    ) {
      // Merge-base drift: the third signal, for the merge-then-advance shape.
      // Merge T1 into the default branch and keep committing — the tip is not
      // contained (ancestry silent) and the merged commit is genuinely
      // reachable from the default branch (`git cherry` silent), but the
      // divergence point has moved off the recorded base. The drift cannot
      // say WHICH direction history crossed (default merged into the variant
      // moves it identically) — both directions are forbidden by the lane, so
      // the verdict is the same either way. Guarded behind the ancestry
      // signal (else-if) so a fully merged tip reports once, not twice.
      findings.push({
        severity: "error",
        check: "prototype.merged",
        message:
          `prototype branch ${branch.branch} has a merge-base with ${scan.defaultBranch} at ` +
          `${branch.mergeBaseWithDefault}, past its recorded base ${base} — history crossed the ` +
          "never-merge fence (a prototype commit reached the default branch, or the default " +
          "branch was merged into the variant; both are forbidden — nahel/workflows/prototype-lane.md)",
        fix:
          `if prototype commits reached ${scan.defaultBranch}, revert them out; if ${scan.defaultBranch} ` +
          "was merged into the variant, dispose it (`nahel prototype dispose`) and re-start — a stale " +
          "variant is re-started, never refreshed",
      });
    }
  }

  for (const ref of scan.remoteRefs) {
    findings.push({
      severity: "error",
      check: "prototype.pushed",
      message:
        `prototype ref ${ref} is pushed to a remote — that is the precondition for a PR, and prototype ` +
        "code never merges (nahel/workflows/prototype-lane.md)",
      fix: "delete the remote branch; prototype workspaces stay local and are disposed of with `nahel prototype dispose <variant-item-id>`",
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
    ...checkRoadmapRefs(state),
    ...checkRoadmapDerivation(state),
    ...checkRoadmapRetractions(state),
    ...checkMigrationAudit(state),
    ...checkRoadmapAdrRefs(state),
    ...checkPrdLifecycle(state),
    ...checkRoadmapShape(state),
    ...checkWayfinder(state),
    ...checkTicketAuthority(state),
    ...checkPrdRefs(state),
    ...checkInvestigationRefs(state),
    ...checkPrdApproval(state),
    ...checkChildrenRollup(state),
    ...checkMergeAuthority(state),
    ...checkConstitutionSignature(state),
    ...checkReviewSlots(state),
    ...checkCycles(state),
    ...checkClaims(state),
    ...checkClaimedActiveRuns(state),
    ...checkJournal(state),
    ...checkDivergence(state),
    ...checkArchival(state),
    ...checkHotState(state),
    ...checkResultDocs(state),
    ...checkMaintenance(state),
    ...checkSkillsDrift(state),
    ...checkWorkflowDrift(state),
    ...checkPrototypeRefs(state),
  );
  return findings.sort(compareFindings);
}

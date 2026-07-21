import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { WorkItemStatus, WorkItemType } from "../schema/enums";
import type { Env } from "../schema/env";
import { CORE_EVENT_TYPES } from "../schema/events";
import { generateId } from "../schema/id";
import type { ExternalRef, WorkItemFrontmatter } from "../schema/records";
import {
  prdRelocationDest,
  readCcpmSource,
  readSourceDoc,
  relocatePrd,
  type CcpmEpic,
  type CcpmSource,
  type CcpmUnitFile,
} from "../store/ccpm";
import { appendEvent } from "../store/journal";
import { listItems, readItem } from "../store/layout";
import { closeStoreContext, mutate, type StoreContext } from "../store/mutate";
import { commandContext, execute, UsageError, type Command } from "./item";

/**
 * `nahel import --from-ccpm` (PRD F8): migrate a live ccpm project — epics,
 * tasks, and PRDs — into the current nahel store. Every created item is an
 * ordinary mutation through the store's mutate() choke point (write-ahead
 * journaled for free, PRD F8.3); PRDs relocate into `docs/prds/` with their
 * status stripped and lifted onto the owning item (ADR-0013). The SOURCE repo
 * is read-only — nothing under it is ever written. Re-running is idempotent:
 * an item already present (matched by github ref, else parent+slug) is skipped
 * with a journaled count, so a partial earlier run completes without
 * duplication (PRD F8.3).
 *
 * The command splits cleanly: the pure mapping layer below (statuses, types,
 * slugs, github refs) is unit-tested without I/O; all filesystem reads of the
 * source tree live in the store's ccpm module (the same fs-is-store-only
 * discipline skills.ts follows); item writes flow through mutate().
 */

// ---------------------------------------------------------------------------
// Pure mapping layer (no I/O) — the deterministic ccpm → nahel field contract.
// ---------------------------------------------------------------------------

/** Turn a ccpm prose title (or already-slug name) into a schema-valid slug. */
export function slugifyCcpmName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** ccpm status spellings onto the universal work-item lifecycle enum. */
const CCPM_STATUS_MAP: Record<string, WorkItemStatus> = {
  backlog: "backlog",
  open: "backlog",
  draft: "backlog",
  proposed: "backlog",
  "in-progress": "in-progress",
  in_progress: "in-progress",
  "in progress": "in-progress",
  started: "in-progress",
  blocked: "blocked",
  completed: "done",
  closed: "done",
  done: "done",
  complete: "done",
};

/**
 * Map a ccpm status onto the universal enum. An unmappable non-empty status
 * falls to `backlog` and returns `original` so the caller journals a note
 * naming it (PRD open question 2: enumerate, never guess silently). A missing
 * status is the natural `backlog` default with nothing to name.
 */
export function mapCcpmStatus(raw: string | undefined): {
  status: WorkItemStatus;
  original?: string;
} {
  if (raw === undefined) return { status: "backlog" };
  const normalized = raw.trim().toLowerCase();
  if (normalized === "") return { status: "backlog" };
  const mapped = CCPM_STATUS_MAP[normalized];
  if (mapped !== undefined) return { status: mapped };
  return { status: "backlog", original: raw };
}

/**
 * Map a ccpm unit to a work-item type. `bug` comes ONLY from an explicit
 * `type: bug` frontmatter field — never inferred from a name (a task titled
 * "fix the bug" is still a feature). Everything else is `feature`.
 */
export function mapCcpmType(frontmatter: Record<string, unknown>): WorkItemType {
  const type = frontmatter["type"];
  if (typeof type === "string" && type.trim().toLowerCase() === "bug") return "bug";
  return "feature";
}

/** The github issue number from an `.../issues/<n>` URL, else undefined. */
export function extractGithubIssueId(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const match = url.match(/\/issues\/(\d+)\b/);
  return match?.[1];
}

/** Parse github-mapping.md into issue-number → issue-URL (the Epic + task lines). */
export function parseGithubMapping(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.match(/#(\d+)\b.*?(https?:\/\/\S+)/);
    if (match) map.set(match[1]!, match[2]!);
  }
  return map;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Preserve a ccpm timestamp into the new record when it is already a valid
 * schema-v1 UTC timestamp; otherwise stamp the current time (the record must
 * carry a valid one, and a malformed source date is not worth failing the
 * whole migration over).
 */
export function preserveTimestamp(raw: unknown, env: Env): string {
  return typeof raw === "string" && TIMESTAMP.test(raw) ? raw : env.now();
}

// ---------------------------------------------------------------------------
// Journal event types this command emits (all open-extension, so the store's
// replay machinery ignores them — they carry no mutation payload).
// ---------------------------------------------------------------------------

/** One-per-invocation summary of what the import did (the config.updated precedent). */
export const IMPORT_COMPLETED_EVENT_TYPE = "import.completed";
/** A per-anomaly note: unmappable status, github-mapping mismatch, dropped dependency, unreferenced PRD. */
export const IMPORT_NOTE_EVENT_TYPE = "import.note";
/** A PRD relocated into docs/prds/, recording the status stripped and lifted onto the owning item. */
export const IMPORT_PRD_RELOCATED_EVENT_TYPE = "import.prd-relocated";

// ---------------------------------------------------------------------------
// Orchestration (I/O through the store layer + the mutate() choke point).
// ---------------------------------------------------------------------------

interface ImportCounts {
  items_created: number;
  items_skipped: number;
  prds_relocated: number;
  notes: number;
}

interface ExistingItem {
  id: string;
  frontmatter: WorkItemFrontmatter;
}

const USAGE = `usage:
  nahel import --from-ccpm [--source <repo-root>]
    Migrate a ccpm project (epics, tasks, PRDs) into this nahel store. Every
    created item is an ordinary journaled mutation; PRDs relocate into
    docs/prds/ with their status stripped and lifted onto the owning item
    (ADR-0013). The source repo is read-only. Re-running is idempotent:
    already-imported items (matched by github ref, else parent+slug) are
    skipped, so a partial earlier run completes without duplication.
      --source: the ccpm repo root to read (default: this repo)`;

/** Snapshot every work item already in the store, for idempotency matching. */
async function loadExistingItems(ctx: StoreContext): Promise<ExistingItem[]> {
  const ids = await listItems(ctx.layout);
  const items: ExistingItem[] = [];
  for (const id of ids) {
    const { frontmatter } = await readItem(ctx.layout, id);
    items.push({ id, frontmatter });
  }
  return items;
}

/**
 * Find an already-imported item matching this unit's identity (PRD F8.3):
 * the github external_ref id when present is authoritative; otherwise the
 * (parent, slug-name) pair. A github id with no on-disk match is genuinely new
 * — it does NOT fall through to a slug match.
 */
function findExisting(
  existing: readonly ExistingItem[],
  githubId: string | undefined,
  parent: string | undefined,
  slug: string,
): ExistingItem | undefined {
  if (githubId !== undefined) {
    return existing.find((item) =>
      item.frontmatter.external_refs.some(
        (ref) => ref.provider === "github" && ref.id === githubId,
      ),
    );
  }
  return existing.find(
    (item) => item.frontmatter.name === slug && (item.frontmatter.parent ?? undefined) === parent,
  );
}

function githubRefs(githubId: string | undefined): ExternalRef[] {
  return githubId === undefined ? [] : [{ provider: "github", id: githubId }];
}

async function emitNote(
  ctx: StoreContext,
  env: Env,
  counts: ImportCounts,
  payload: Record<string, unknown>,
  item?: string,
): Promise<void> {
  await appendEvent(ctx.layout, env, {
    type: IMPORT_NOTE_EVENT_TYPE,
    actor: ctx.actor,
    session: ctx.session,
    ...(item === undefined ? {} : { item }),
    payload,
  });
  counts.notes += 1;
}

/** Cross-check a unit's frontmatter github ref against github-mapping.md; frontmatter wins. */
async function crossCheckMapping(
  ctx: StoreContext,
  env: Env,
  counts: ImportCounts,
  mapping: Map<string, string> | null,
  githubId: string | undefined,
  githubUrl: unknown,
  itemId: string,
  unit: string,
): Promise<void> {
  if (mapping === null || githubId === undefined) return;
  const mapped = mapping.get(githubId);
  if (mapped !== undefined && mapped !== githubUrl) {
    await emitNote(
      ctx,
      env,
      counts,
      {
        kind: "github-mapping-mismatch",
        unit,
        github_issue: githubId,
        frontmatter_url: typeof githubUrl === "string" ? githubUrl : null,
        mapping_url: mapped,
        resolution: "frontmatter wins",
      },
      itemId,
    );
  }
}

/** A PRD an epic references, read and ready to relocate (no writes done yet). */
interface ResolvedEpicPrd {
  /** The source-repo-relative candidate path that resolved. */
  candidate: string;
  fileBasename: string;
  /** The deterministic docs/prds/ destination (the epic item's `prd` field). */
  dest: string;
  /** The PRD frontmatter with `status` removed (relocated status-stripped). */
  strippedFrontmatter: Record<string, unknown>;
  body: string;
  /** The PRD's raw `status`, stripped from the copy but recorded on relocation. */
  prdStatus: string | undefined;
}

/**
 * Resolve the PRD an epic references (ADR-0013) WITHOUT writing anything: find
 * the first candidate that reads (its `prd:` path, else `.claude/prds/<name>.md`),
 * strip its status, and compute the deterministic docs/prds/ destination. Free
 * of journal/item side effects, so importEpic can create the epic item —
 * carrying this `dest` as its `prd` field — BEFORE any item-referencing
 * relocation event is emitted (PRD F8.3, Finding 1: no journal event may
 * reference an item not yet on disk; a crash in that window would dangle the
 * ref forever). The destination is deterministic, so a crash after item
 * creation but before relocation heals on re-run.
 */
async function resolveEpicPrd(
  sourceRoot: string,
  epic: CcpmEpic,
): Promise<ResolvedEpicPrd | undefined> {
  const candidates: string[] = [];
  const declared = epic.frontmatter["prd"];
  if (typeof declared === "string" && declared !== "") candidates.push(declared);
  candidates.push(`.claude/prds/${epic.name}.md`);

  for (const candidate of candidates) {
    let doc: CcpmUnitFile | null;
    try {
      doc = await readSourceDoc(sourceRoot, candidate);
    } catch {
      continue; // an unsafe path is skipped; the next candidate may resolve
    }
    if (doc === null) continue;

    const rawStatus = doc.frontmatter["status"];
    const stripped = { ...doc.frontmatter };
    delete stripped["status"];
    const fileBasename = basename(candidate);
    return {
      candidate,
      fileBasename,
      dest: prdRelocationDest(fileBasename),
      strippedFrontmatter: stripped,
      body: doc.body,
      prdStatus: typeof rawStatus === "string" ? rawStatus : undefined,
    };
  }
  return undefined;
}

/**
 * Materialize a resolved PRD into docs/prds/ and journal the relocation against
 * the owning item — which by now exists on disk (importEpic creates it first,
 * Finding 1). Idempotent via relocatePrd: a re-run that changes nothing writes
 * nothing and emits no event.
 *
 * The epic's status wins on the item (execution beats authoring), but a genuine
 * CONFLICT must not pass silently (Finding 2): when the PRD's stripped status
 * maps — via the same mapCcpmStatus table — to a DIFFERENT universal status
 * than the owning item's, journal a prd-status-conflict note naming both
 * originals and both mapped values. Tied to a real relocation (`wrote`) so it
 * stays idempotent and heals with the relocation itself.
 */
async function relocateResolvedPrd(
  ctx: StoreContext,
  env: Env,
  resolved: ResolvedEpicPrd,
  counts: ImportCounts,
  relocatedBasenames: Set<string>,
  owningItem: string,
  owningStatus: WorkItemStatus,
): Promise<void> {
  relocatedBasenames.add(resolved.fileBasename);
  const { dest, wrote } = await relocatePrd(
    ctx.layout.root,
    resolved.fileBasename,
    resolved.strippedFrontmatter,
    resolved.body,
  );
  if (!wrote) return;
  counts.prds_relocated += 1;
  await appendEvent(ctx.layout, env, {
    type: IMPORT_PRD_RELOCATED_EVENT_TYPE,
    actor: ctx.actor,
    session: ctx.session,
    item: owningItem,
    payload: {
      source: resolved.candidate,
      dest,
      status_stripped: resolved.prdStatus ?? null,
      owning_item: owningItem,
    },
  });

  if (resolved.prdStatus !== undefined) {
    const prdMapped = mapCcpmStatus(resolved.prdStatus).status;
    if (prdMapped !== owningStatus) {
      await emitNote(
        ctx,
        env,
        counts,
        {
          kind: "prd-status-conflict",
          prd_status: resolved.prdStatus,
          prd_mapped: prdMapped,
          item_status: owningStatus,
          resolution: "epic status wins (execution over authoring)",
        },
        owningItem,
      );
    }
  }
}

/** Import one epic and its tasks; mutate() write-ahead-journals each creation. */
async function importEpic(
  ctx: StoreContext,
  env: Env,
  sourceRoot: string,
  epic: CcpmEpic,
  existing: ExistingItem[],
  counts: ImportCounts,
  relocatedBasenames: Set<string>,
): Promise<void> {
  const mapping = epic.mappingText === null ? null : parseGithubMapping(epic.mappingText);

  // Resolve the epic's identity (github ref, else its own slug at the root).
  const epicGithubId = extractGithubIssueId(epic.frontmatter["github"]);
  const epicSlug = slugifyCcpmName(epic.name) || `epic-${generateId(env)}`;
  const epicMatch = findExisting(existing, epicGithubId, undefined, epicSlug);
  const epicId = epicMatch?.id ?? generateId(env);

  // Resolve every task's identity BEFORE creating any, so depends_on (which can
  // point forward) always resolves to a real id, existing or freshly minted.
  const stemToId = new Map<string, string>();
  interface TaskPlan {
    task: CcpmEpic["tasks"][number];
    id: string;
    existing: boolean;
    githubId: string | undefined;
    name: string;
  }
  const taskPlans: TaskPlan[] = [];
  for (const task of epic.tasks) {
    const githubId = extractGithubIssueId(task.frontmatter["github"]);
    const rawName = task.frontmatter["name"];
    const name = typeof rawName === "string" && rawName !== "" ? rawName : task.stem;
    const slug = slugifyCcpmName(name) || `task-${task.stem}`;
    const match = findExisting(existing, githubId, epicId, slug);
    const id = match?.id ?? generateId(env);
    stemToId.set(task.stem, id);
    taskPlans.push({ task, id, existing: match !== undefined, githubId, name });
  }

  // Resolve the PRD read-only (no journal writes): its docs/prds/ destination
  // is deterministic, so the item can carry it as its `prd` field BEFORE the
  // item exists — the actual relocation (which references the item) happens
  // only after item creation below (PRD F8.3, Finding 1).
  const resolvedPrd = await resolveEpicPrd(sourceRoot, epic);
  const prd = resolvedPrd?.dest;

  // The epic's mapped status — used to create a new item and, either way, to
  // detect a PRD/epic status conflict on relocation (Finding 2). An existing
  // item's on-disk status is authoritative for that comparison.
  const epicMapped = mapCcpmStatus(
    typeof epic.frontmatter["status"] === "string"
      ? (epic.frontmatter["status"] as string)
      : undefined,
  );
  const owningStatus: WorkItemStatus = epicMatch?.frontmatter.status ?? epicMapped.status;

  // Create the epic item (feature, lane full) unless it already exists.
  if (epicMatch === undefined) {
    const { status, original } = epicMapped;
    const created = preserveTimestamp(epic.frontmatter["created"], env);
    const frontmatter: WorkItemFrontmatter = {
      id: epicId,
      name: epicSlug,
      type: "feature",
      status,
      lane: "full",
      depends_on: [],
      external_refs: githubRefs(epicGithubId),
      ...(prd === undefined ? {} : { prd }),
      created,
      updated: preserveTimestamp(epic.frontmatter["updated"], env),
    };
    await mutate(ctx, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemCreated,
      frontmatter,
      body: epic.body,
    });
    counts.items_created += 1;
    existing.push({ id: epicId, frontmatter });
    if (original !== undefined) {
      await emitNote(
        ctx,
        env,
        counts,
        { kind: "unmappable-status", unit: "epic", original, mapped: status },
        epicId,
      );
    }
    await crossCheckMapping(
      ctx,
      env,
      counts,
      mapping,
      epicGithubId,
      epic.frontmatter["github"],
      epicId,
      "epic",
    );
  } else {
    counts.items_skipped += 1;
  }

  // The epic item now exists on disk (freshly created or pre-existing), so the
  // relocation event may safely reference it. Runs whether or not the epic was
  // new, so a partial prior run (item created, PRD not yet relocated) heals.
  if (resolvedPrd !== undefined) {
    await relocateResolvedPrd(
      ctx,
      env,
      resolvedPrd,
      counts,
      relocatedBasenames,
      epicId,
      owningStatus,
    );
  }

  // Create the tasks (feature/bug, lane direct, parented to the epic).
  for (const plan of taskPlans) {
    if (plan.existing) {
      counts.items_skipped += 1;
      continue;
    }
    const { task, id } = plan;
    const { status, original } = mapCcpmStatus(
      typeof task.frontmatter["status"] === "string"
        ? (task.frontmatter["status"] as string)
        : undefined,
    );

    // Resolve depends_on: ccpm lists sibling task numbers (github issue
    // numbers / filename stems). Each resolves to that sibling's new id; a
    // number with no sibling task is dropped with a note.
    const rawDeps = Array.isArray(task.frontmatter["depends_on"])
      ? (task.frontmatter["depends_on"] as unknown[])
      : [];
    const dependsOn: string[] = [];
    for (const dep of rawDeps) {
      const key = String(dep);
      const resolved = stemToId.get(key);
      if (resolved !== undefined) {
        dependsOn.push(resolved);
      } else {
        await emitNote(
          ctx,
          env,
          counts,
          { kind: "unresolvable-depends-on", dropped: key },
          id,
        );
      }
    }

    const created = preserveTimestamp(task.frontmatter["created"], env);
    const frontmatter: WorkItemFrontmatter = {
      id,
      name: slugifyCcpmName(plan.name) || `task-${task.stem}`,
      type: mapCcpmType(task.frontmatter),
      status,
      lane: "direct",
      parent: epicId,
      depends_on: dependsOn,
      external_refs: githubRefs(plan.githubId),
      created,
      updated: preserveTimestamp(task.frontmatter["updated"], env),
    };
    await mutate(ctx, {
      target: "item",
      eventType: CORE_EVENT_TYPES.itemCreated,
      frontmatter,
      body: task.body,
    });
    counts.items_created += 1;
    existing.push({ id, frontmatter });
    if (original !== undefined) {
      await emitNote(
        ctx,
        env,
        counts,
        { kind: "unmappable-status", unit: "task", stem: task.stem, original, mapped: status },
        id,
      );
    }
    // Task github refs cross-check against the mapping, and against the
    // filename stem (ccpm names task files by issue number).
    await crossCheckMapping(
      ctx,
      env,
      counts,
      mapping,
      plan.githubId,
      task.frontmatter["github"],
      id,
      `task ${task.stem}`,
    );
    if (plan.githubId !== undefined && plan.githubId !== task.stem) {
      await emitNote(
        ctx,
        env,
        counts,
        {
          kind: "github-stem-mismatch",
          stem: task.stem,
          github_issue: plan.githubId,
          resolution: "frontmatter github issue wins for external_refs",
        },
        id,
      );
    }
  }
}

/** Relocate PRDs no epic referenced (they still belong in docs/prds/, PRD F8.2). */
async function relocateUnreferencedPrds(
  ctx: StoreContext,
  env: Env,
  source: CcpmSource,
  counts: ImportCounts,
  relocatedBasenames: Set<string>,
): Promise<void> {
  for (const prd of source.prds) {
    const fileBasename = basename(prd.sourcePath);
    if (relocatedBasenames.has(fileBasename)) continue;
    const stripped = { ...prd.frontmatter };
    const status = stripped["status"];
    delete stripped["status"];
    const { dest, wrote } = await relocatePrd(ctx.layout.root, fileBasename, stripped, prd.body);
    relocatedBasenames.add(fileBasename);
    if (wrote) {
      counts.prds_relocated += 1;
      await appendEvent(ctx.layout, env, {
        type: IMPORT_PRD_RELOCATED_EVENT_TYPE,
        actor: ctx.actor,
        session: ctx.session,
        payload: {
          source: prd.sourcePath,
          dest,
          status_stripped: typeof status === "string" ? status : null,
          owning_item: null,
        },
      });
      await emitNote(ctx, env, counts, {
        kind: "prd-unreferenced",
        source: prd.sourcePath,
        dest,
      });
    }
  }
}

async function runImport(
  argv: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "from-ccpm": { type: "boolean" },
      source: { type: "string" },
    },
    allowPositionals: true,
  });
  if (values["from-ccpm"] !== true) {
    throw new UsageError(
      "import requires --from-ccpm — ccpm is the only supported source format",
    );
  }
  const sourceRoot = resolve(cwd, values.source ?? ".");

  const ctx = await commandContext(cwd, env, actorOverride);
  const source = await readCcpmSource(sourceRoot);
  const existing = await loadExistingItems(ctx);
  const counts: ImportCounts = {
    items_created: 0,
    items_skipped: 0,
    prds_relocated: 0,
    notes: 0,
  };
  const relocatedBasenames = new Set<string>();

  for (const epic of source.epics) {
    await importEpic(ctx, env, sourceRoot, epic, existing, counts, relocatedBasenames);
  }
  await relocateUnreferencedPrds(ctx, env, source, counts, relocatedBasenames);

  await appendEvent(ctx.layout, env, {
    type: IMPORT_COMPLETED_EVENT_TYPE,
    actor: ctx.actor,
    session: ctx.session,
    payload: { ...counts },
  });
  await closeStoreContext(ctx);

  console.log(
    `✅ import complete — ${counts.items_created} item(s) created, ` +
      `${counts.items_skipped} skipped, ${counts.prds_relocated} PRD(s) relocated, ` +
      `${counts.notes} note(s)`,
  );
  return 0;
}

export const importCommand: Command = {
  name: "import",
  description: "migrate a ccpm project into this nahel store (import --from-ccpm)",
  run: (argv, env, cwd, actorOverride) =>
    execute("run `nahel import --help` for usage", async () => {
      if (argv.includes("--help") || argv.includes("-h")) {
        console.log(USAGE);
        return 0;
      }
      return runImport(argv, env, cwd, actorOverride);
    }),
};

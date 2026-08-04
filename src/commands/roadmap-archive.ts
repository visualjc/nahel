import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Env } from "../schema/env";
import {
  ARCHIVAL_RELEASE_PAYLOAD_KEY,
  ARCHIVAL_RELEASE_PAYLOAD_KEYS,
  CORE_EVENT_TYPES,
  RELEASE_ANNOUNCED_EVENT_TYPE,
} from "../schema/events";
import { generateId } from "../schema/id";
import {
  archivedPrdPath,
  isArchivedPrdPath,
  type RoadmapNodeFrontmatter,
  type WorkItemFrontmatter,
} from "../schema/records";
import {
  readItem,
  readRoadmapNode,
  readRoadmapNodes,
  readTextFile,
  resolveRoadmapNode,
  type StoreLayout,
} from "../store/layout";
import { closeStoreContext, mutate, type SequenceWrite } from "../store/mutate";
import { archivalRelease, featureStatus } from "../views/roadmap";
import { loadSnapshot } from "../views/snapshot";
import { commandContext, UsageError } from "./item";
import { columnEvents } from "./roadmap-ref";

/**
 * `nahel roadmap archive` (Phase 4 F10): a released feature's delta is CLOSED,
 * so its PRD stops being a live document. The verb moves it under
 * `docs/prds/archived/` with a stamped header, moves every stored reference to
 * the old path with it, and appends the release to the product design doc —
 * all in ONE act, through the write-ahead choke point.
 *
 * Two rules shape it. **Released is the precondition**, read from F9's derived
 * stage rather than from any field: a feature still being built has a live PRD,
 * and archiving it would close a delta that is still open. **The act is
 * total**: a dangling `prd` path after archival is a bug, not a warning, so the
 * catch-all sweep updates EVERY record holding the old path, not just the three
 * the PRD names by role.
 *
 * Re-running it is refused rather than repeated — the node's link already points
 * into the archive, which is the same total-transition discipline the decision
 * ticket verbs follow, and what makes archival idempotent after a crash repair.
 */

export const ARCHIVE_USAGE = `  nahel roadmap archive <ref>
    Close a released feature's delta: move its PRD to docs/prds/archived/ with
    a stamped header (released date, epic link, the archival event's id, and
    the line that the code and tests are the truth now), move every stored
    reference to the old path in the same act, and append the release to the
    product design doc — which is permanent and never archived.
    Refused unless the feature's stage is \`released\` AND the release that
    earned it records a nonblank ${ARCHIVAL_RELEASE_PAYLOAD_KEYS.join(", ")};
    refused again once the delta is closed. Further work is a NEW node with a
    new PRD, which may name this one as its \`--predecessor\`.`;

/** The stamp's first line — how an already-archived document is recognized. */
const STAMP_OPENER = "> **Archived — the delta this PRD stated is closed.**";

/**
 * The four elements F10 requires of the stamped header, in one block: the
 * released date, the epic and node it covered, the JOURNAL POINTER (the id of
 * the archival event carrying this very move), and the line naming what is
 * authoritative from here on. The pointer is why the event id is minted before
 * the mutation: the document cites the event that moves it.
 */
function archiveStamp(node: RoadmapNodeFrontmatter, release: string, eventId: string): string {
  return [
    STAMP_OPENER,
    ">",
    // The release column VERBATIM (`released <version> <ts>`), because the
    // render table's strings are the contract every surface prints.
    `> - Release: ${release}`,
    `> - Epic: ${node.epic ?? "(none recorded)"} — roadmap node ${node.name} (${node.id})`,
    `> - Journal: archived by event ${eventId}`,
    ">",
    "> The code and tests are the truth now — this PRD is never reopened and",
    "> never edited. Further work on this feature is a new node with a new PRD,",
    "> which may name this one as its predecessor.",
  ].join("\n");
}

/**
 * The sentinel that says THIS archival's line is in a document. Event-scoped,
 * never the archived path: a path is prose anyone may already have written down
 * — a link, an earlier paragraph, a note about the delta that was about to
 * close — and keying on one would let an unrelated mention suppress the line the
 * act owes and then report the act as converged. The event id names one act and
 * nothing else, and it is the same journal pointer the archived PRD's header
 * carries, so a human rewording the sentence keeps convergence as long as the
 * pointer survives — which is exactly what the pointer is for.
 */
function archivalSentinel(eventId: string): string {
  return `archival event ${eventId}`;
}

/** The line the product design doc gains: what shipped, and where its delta is filed. */
function designNote(node: RoadmapNodeFrontmatter, archived: string, eventId: string): string {
  return (
    `- **${node.name}** shipped — its delta is closed and the PRD that stated it ` +
    `is archived at \`${archived}\` (${archivalSentinel(eventId)}).`
  );
}

/**
 * The product design doc this feature's release updates: the nearest PRODUCT
 * ancestor's `design_doc`. Walked rather than assumed, because the field lives
 * on the product node and a feature can sit several levels below it; a
 * seen-set keeps a parent cycle from looping. A tree with no product ancestor,
 * or a product carrying no design doc, simply has nothing to update — that is a
 * shape `validate` already reports, and refusing archival over it would leave
 * the delta open for a reason that has nothing to do with the delta.
 */
function productDesignDoc(
  nodes: ReadonlyMap<string, RoadmapNodeFrontmatter>,
  start: RoadmapNodeFrontmatter,
): string | undefined {
  const seen = new Set<string>();
  let current: RoadmapNodeFrontmatter | undefined = start;
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.kind === "product" && current.design_doc !== undefined) return current.design_doc;
    current = current.parent === undefined ? undefined : nodes.get(current.parent);
  }
  return undefined;
}

/**
 * Every record holding the old path, in the order F10 enumerates the writes:
 * the feature node's link, then the authoring plan item(s) (ADR-0013), then the
 * epic the PRD was parsed into, then — as the catch-all — everything else that
 * shares the path, items before nodes and ids sorted within each. The order is
 * fixed rather than derived so the sequence a crash is measured against is the
 * same on every machine.
 */
function referenceWrites(
  node: RoadmapNodeFrontmatter,
  items: readonly { frontmatter: WorkItemFrontmatter; body: string }[],
  nodes: readonly { frontmatter: RoadmapNodeFrontmatter; body: string }[],
  archived: string,
  now: string,
): SequenceWrite[] {
  const rank = (item: WorkItemFrontmatter): number => {
    if (item.type === "plan") return 0;
    return item.id === node.epic ? 1 : 2;
  };
  const ordered = [...items].sort(
    (a, b) =>
      rank(a.frontmatter) - rank(b.frontmatter) ||
      (a.frontmatter.id < b.frontmatter.id ? -1 : 1),
  );
  const writes: SequenceWrite[] = ordered.map(({ frontmatter, body }) => ({
    target: "item",
    frontmatter: { ...frontmatter, prd: archived, updated: now },
    body,
  }));
  for (const { frontmatter, body } of nodes) {
    // The feature node itself is written first, by the caller — it is the one
    // reference the act is ABOUT, not one the catch-all sweep found.
    if (frontmatter.id === node.id) continue;
    writes.push({
      target: "roadmap-node",
      frontmatter: { ...frontmatter, prd: archived, updated: now },
      body,
    });
  }
  return writes;
}

/** Refuse a ref that names no node, the same way the zoom does. */
async function requireNode(layout: StoreLayout, ref: string) {
  const record = await resolveRoadmapNode(layout, ref);
  if (record === null) {
    throw new UsageError(
      `roadmap node ${JSON.stringify(ref)} does not name a roadmap node — pass a node slug or id ` +
        "(`nahel roadmap` lists them)",
    );
  }
  return record;
}

/**
 * The whole act (F10's six writes, in order): the archival event carrying every
 * one of them, then the PRD's move-and-stamp, the feature node's link, the
 * authoring plan item, the epic, each further record sharing the path, and
 * finally the product design doc's line. One event, so an interruption anywhere
 * leaves the journal ahead of the store and the filesystem alike — the one
 * shape `validate --repair` rolls forward.
 */
export async function runArchiveSubcommand(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  if (positionals.length !== 1) {
    throw new UsageError(
      "roadmap archive takes exactly one <ref> (the released feature node's slug or id)",
    );
  }
  const ctx = await commandContext(cwd, env, actorOverride);
  const record = await requireNode(ctx.layout, positionals[0]!);
  const node = record.frontmatter;
  const prd = node.prd;
  if (prd === undefined) {
    throw new UsageError(
      `roadmap node ${node.id} (${node.name}) has no \`prd\` to archive — archival closes the delta a PRD ` +
        "stated, so there is nothing to move (record one with `nahel roadmap node update <ref> --prd <path>`)",
    );
  }
  if (isArchivedPrdPath(prd)) {
    throw new UsageError(
      `roadmap node ${node.id} (${node.name}) is already archived at ${prd} — an archived PRD is never ` +
        "reopened and never edited; further work on this feature is a new node with a new PRD " +
        `(\`nahel roadmap node new feature <name> ... --predecessor ${node.name}\`)`,
    );
  }

  // The precondition is DERIVED (F9), never a field: released means an
  // unretracted `release.announced` covers the epic, and nothing else says so.
  const { items } = await loadSnapshot(ctx.layout);
  const events = await columnEvents(ctx.layout);
  const status = featureStatus(node, items, events);
  const release = archivalRelease(node, items, events);
  if (release === undefined) {
    throw new UsageError(
      `roadmap node ${node.id} (${node.name}) stands at stage ${status.stage}, and a PRD is archived only ` +
        "once its feature is released — its delta is still open. Record the release with " +
        `\`nahel log ${RELEASE_ANNOUNCED_EVENT_TYPE} --item <epic> ${ARCHIVAL_RELEASE_PAYLOAD_KEYS.map(
          (key) => `--data ${key}=<${key}>`,
        ).join(" ")}\` first.`,
    );
  }
  // Stage released is not archival-qualified (A3). The view stays permissive —
  // it shows what the store holds — but this act stamps the document closed
  // forever on a header that CITES the release, so the release has to be one a
  // reader can follow back. The refusal names the event, because the fix is to
  // re-log that release and nothing in the store points at it otherwise.
  if (release.missing.length > 0) {
    throw new UsageError(
      `roadmap node ${node.id} (${node.name}) reads stage released on ${RELEASE_ANNOUNCED_EVENT_TYPE} ` +
        `event ${release.event.id}, but that release records no ${release.missing.join(", ")} — an ` +
        "archived PRD is stamped closed forever and its header cites the release, so the release has to be " +
        "one a reader can follow back. Re-log it in full " +
        `(\`nahel log ${RELEASE_ANNOUNCED_EVENT_TYPE} --item ${node.epic ?? "<epic>"} ${ARCHIVAL_RELEASE_PAYLOAD_KEYS.map(
          (key) => `--data ${key}=<${key}>`,
        ).join(" ")}\`), then run this command again.`,
    );
  }

  const archived = archivedPrdPath(prd);
  if ((await readTextFile(join(ctx.layout.root, prd))) === null) {
    throw new UsageError(
      `the PRD at ${prd} does not exist, so there is nothing to move — if a previous archival was ` +
        `interrupted, \`nahel validate --repair\` completes it (the document may already be at ${archived})`,
    );
  }
  // A PRD basename is not unique across time: a successor reusing the name its
  // predecessor shipped under points at an archive slot another delta already
  // filled. Refused outright rather than resolved here — every automatic answer
  // (overwrite, suffix, merge) either buries a closed record or invents a
  // filename nobody chose, and no PRD is ever deleted.
  if ((await readTextFile(join(ctx.layout.root, archived))) !== null) {
    throw new UsageError(
      `${archived} already exists, so archiving ${prd} there would bury a closed delta — rename one of the ` +
        "two documents first (the archive holds one file per delta, and an archived PRD is never " +
        "overwritten), then run this command again",
    );
  }

  const eventId = generateId(ctx.env);
  const now = ctx.env.now();
  const nodes = await readRoadmapNodes(ctx.layout);
  const byId = new Map(nodes.map(({ frontmatter }) => [frontmatter.id, frontmatter]));
  // Every record holding the old path, re-read for its BODY: the snapshot and
  // the node listing carry frontmatter, and a record write carries both.
  const itemRecords = await Promise.all(
    items.filter((item) => item.prd === prd).map((item) => readItem(ctx.layout, item.id)),
  );
  const nodeRecords = await Promise.all(
    nodes
      .filter(({ frontmatter }) => frontmatter.prd === prd)
      .map(({ frontmatter }) => readRoadmapNode(ctx.layout, frontmatter.id)),
  );

  const writes: SequenceWrite[] = [
    // 1. the PRD itself, stamped with the event that is moving it
    {
      target: "document",
      edit: {
        op: "move",
        from: prd,
        to: archived,
        header: archiveStamp(node, status.release, eventId),
      },
    },
    // 2. the feature node's own link
    {
      target: "roadmap-node",
      frontmatter: { ...node, prd: archived, updated: now },
      body: record.body,
    },
    // 3-5. the plan item, the epic, and every other record sharing the path
    ...referenceWrites(node, itemRecords, nodeRecords, archived, now),
  ];
  // 6. the product design doc: permanent, updated in place, never archived
  const designDoc = productDesignDoc(byId, node);
  if (designDoc !== undefined) {
    writes.push({
      target: "document",
      edit: {
        op: "append",
        path: designDoc,
        marker: archivalSentinel(eventId),
        line: designNote(node, archived, eventId),
      },
    });
  }

  await mutate(ctx, {
    target: "sequence",
    eventType: CORE_EVENT_TYPES.prdArchived,
    eventId,
    writes,
    // The other end of the stamped header's journal pointer: the header names
    // this event, and this event names the release that justified it, so a
    // reader can walk between them without re-deriving a coverage walk.
    extraPayload: { [ARCHIVAL_RELEASE_PAYLOAD_KEY]: release.event.id },
  });
  await closeStoreContext(ctx);
  const moved = writes.filter((write) => write.target !== "document").length;
  console.log(
    `✅ archived ${prd} → ${archived} (${moved} reference(s) moved` +
      `${designDoc === undefined ? "" : `, ${designDoc} updated`})`,
  );
  return 0;
}

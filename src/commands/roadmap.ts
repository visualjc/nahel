import { parseArgs } from "node:util";
import { ROADMAP_HORIZONS, ROADMAP_NODE_KINDS } from "../schema/enums";
import type { Env } from "../schema/env";
import { CORE_EVENT_TYPES, ROADMAP_ACKED_EVENT_TYPE } from "../schema/events";
import { generateId, ID_PATTERN } from "../schema/id";
import {
  roadmapNodeFrontmatterSchema,
  type JournalEvent,
  type RoadmapNodeFrontmatter,
} from "../schema/records";
import { appendEvent, readJournal } from "../store/journal";
import {
  itemExists,
  openStore,
  readMaps,
  readRoadmapNodes,
  readTickets,
  resolveRoadmapNode,
  type StoreLayout,
} from "../store/layout";
import { closeStoreContext, mutate } from "../store/mutate";
import {
  isRoadmapColumnEvent,
  ROADMAP_SUBCOMMANDS,
  renderRoadmapNode,
  renderRoadmapOverview,
  renderRoadmapZoom,
  roadmapNodeLinks,
} from "../views/roadmap";
import { loadSnapshot } from "../views/snapshot";
import { commandContext, execute, requireValid, UsageError, type Command } from "./item";
import { MAP_USAGE, runMapSubcommand } from "./roadmap-map";
import { nearMissNames, resolveNodeRef } from "./roadmap-ref";
import { runTicketSubcommand, TICKET_USAGE } from "./roadmap-ticket";

/**
 * `nahel roadmap node` (Phase 4 F1): the roadmap node write and read-back
 * surface — the layer above work items. Thin over the store, exactly like
 * `nahel item`: parse argv → call the store, with every mutation flowing
 * through mutate() (actor resolution, write-ahead journaling) and no
 * filesystem or journal access of its own.
 *
 * Two rules shape what this verb refuses. **Slugs are unique per store**, so a
 * duplicate name is refused at creation and at rename — the slug is how every
 * view and command addresses a node. **Everything else structural is soft**: a
 * feature under a feature, a node with no product ancestor, an initiative with
 * one link — all created, and reported by `nahel validate` instead. A link to
 * a node that does not exist YET is recorded when spelled as an id (the target
 * may arrive by a later merge, ADR-0012) and refused when spelled as a slug,
 * which cannot be resolved to anything.
 *
 * The node→item direction is canonical and one-way: `--epic` records the epic
 * on the NODE and no work-item record is ever written here.
 */

const KIND_FIELD = roadmapNodeFrontmatterSchema.shape.kind;
const NAME_FIELD = roadmapNodeFrontmatterSchema.shape.name;
const HORIZON_FIELD = roadmapNodeFrontmatterSchema.shape.horizon;
const DESIGN_DOC_FIELD = roadmapNodeFrontmatterSchema.shape.design_doc;
// The lists are optional on the record (omission is validate's judgment, not
// the schema's), so the ENTRY validator comes from inside the optional.
const ADR_FIELD = roadmapNodeFrontmatterSchema.shape.adrs.unwrap().element;
const PRD_FIELD = roadmapNodeFrontmatterSchema.shape.prd;
const EPIC_FIELD = roadmapNodeFrontmatterSchema.shape.epic;

const USAGE = `usage:
  nahel roadmap
    The product level: every product node with the derived distribution of its
    feature children, those children grouped by horizon with their derived
    columns, and the zoom hint. Reads only — nothing is written.

  nahel roadmap <ref>
    Zoom to one node: its ancestors, its own fields and intent, its derived
    status, its chart, its children, and — for a feature — the work items
    under its epic. <ref> is the node's slug or its id.
    (A node named after a subcommand below is reached by \`roadmap node show\`.)

  nahel roadmap node new <kind> <name> --horizon <h> --intent <text>
                         [--parent <ref>] [--design-doc <path>] [--adr <path>]...
                         [--prd <path>] [--epic <item-id>] [--predecessor <ref>]
                         [--feature <ref>]...
    Create a roadmap node and print its generated id.
      kind: ${ROADMAP_NODE_KINDS.join(" | ")}
      name: a slug, unique per store — every view addresses nodes by it
      --horizon: ${ROADMAP_HORIZONS.join(" | ")}
      --intent: the node's intent prose, stored as the record body
      --parent: the node above it (a node slug or id)
      --design-doc: product — the permanent product design doc
      --adr: product — an ADR cross-reference (repeatable, order preserved)
      --prd: feature — the PRD stating this delta
      --epic: feature — the epic WORK ITEM this node covers (node -> item)
      --predecessor: feature — the released node this one continues
      --feature: initiative — a feature node linked sideways (repeatable)

  nahel roadmap node update <ref> [--name <slug>] [--horizon <h>] [--intent <text>]
                            [--parent <ref>] [--design-doc <path>] [--adr <path>]...
                            [--prd <path>] [--epic <item-id>] [--predecessor <ref>]
                            [--feature <ref>]... [--clear-parent] [--clear-design-doc]
                            [--clear-adrs] [--clear-prd] [--clear-epic]
                            [--clear-predecessor] [--clear-features]
    Update fields; the CLI maintains \`updated\`. Repeatable --adr and --feature
    replace the whole list; each --clear-* flag removes the field / empties the
    list and is mutually exclusive with its setter.

  nahel roadmap node show <ref>
    Print one node — its fields, its lineage both ways, and its intent prose.
    <ref> is the node's slug or its id; both address the same node.

  nahel roadmap ack
    Say "seen": records a human-attributed acknowledgement that clears the
    brief's "roadmap changes since your last touch" line. Mutates no node.
    Run under an AGENT actor it is journaled as itself and clears nothing.

${MAP_USAGE}

${TICKET_USAGE}`;

/** Options shared by `node new` and `node update` (update adds the clears). */
const LINK_OPTIONS = {
  horizon: { type: "string" },
  intent: { type: "string" },
  parent: { type: "string" },
  "design-doc": { type: "string" },
  adr: { type: "string", multiple: true },
  prd: { type: "string" },
  epic: { type: "string" },
  predecessor: { type: "string" },
  feature: { type: "string", multiple: true },
} as const;

/**
 * Every column a node renders is DERIVED (F2), so there is no field to set and
 * no flag that could set one. parseArgs already refuses an unknown option, but
 * "Unknown option '--status'" reads like an omission the next release might
 * fix. These refusals name the rule that owns the column instead, so the answer
 * to "how do I set it" is the act that actually moves it.
 */
const DERIVED_FLAGS: ReadonlyMap<string, string> = new Map([
  [
    "--status",
    "a feature node's dev status is derived from the statuses of the work items under its epic — move the work with `nahel item update`",
  ],
  [
    "--stage",
    "a feature node's stage is derived by precedence from its release, deploy, and QA events and its epic rollup — record the act with `nahel log`",
  ],
  [
    "--qa",
    "a feature node's QA column is derived from the latest `qa.sweep-completed` covering its epic — record the sweep with `nahel log`",
  ],
  [
    "--deploy",
    "a feature node's deploy column is derived from the latest `deploy.completed` covering its epic — record the deploy with `nahel log`",
  ],
  [
    "--release",
    "a feature node's release column is derived from the latest `release.announced` covering its epic — record the release with `nahel log`",
  ],
]);

/** Refuse a derived-status flag by name, before parseArgs calls it merely unknown. */
function refuseDerivedFlags(args: readonly string[]): void {
  for (const arg of args) {
    const flag = arg.split("=")[0]!;
    const rule = DERIVED_FLAGS.get(flag);
    if (rule !== undefined) {
      throw new UsageError(`${flag} is not a flag and never will be: ${rule}`);
    }
  }
}

/** The intent IS the record body, so it must say something. */
function requireIntent(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new UsageError(
      "a roadmap node states its intent — pass a non-empty --intent (a one-liner for a feature, a paragraph for a product)",
    );
  }
  return value.endsWith("\n") ? value : `${value}\n`;
}

/** Refuse a name already held by another node (slugs are unique per store). */
async function requireFreeName(
  layout: StoreLayout,
  name: string,
  selfId?: string,
): Promise<void> {
  const taken = (await readRoadmapNodes(layout)).find(
    (record) => record.frontmatter.name === name && record.frontmatter.id !== selfId,
  );
  if (taken !== undefined) {
    throw new UsageError(
      `roadmap node name ${JSON.stringify(name)} is already used by node ${taken.frontmatter.id} — ` +
        "slugs are unique per store (every view addresses nodes by name)",
    );
  }
}

async function nodeNew(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { ...LINK_OPTIONS },
    allowPositionals: true,
  });
  if (positionals.length !== 2) {
    throw new UsageError(
      `roadmap node new takes exactly <kind> <name> — got ${positionals.length} positional argument(s)`,
    );
  }
  const kind = requireValid(KIND_FIELD, positionals[0], "kind");
  const name = requireValid(NAME_FIELD, positionals[1], "name");
  if (values.horizon === undefined) {
    throw new UsageError(
      `every roadmap node carries a horizon — pass --horizon ${ROADMAP_HORIZONS.join("|")}`,
    );
  }
  const horizon = requireValid(HORIZON_FIELD, values.horizon, "--horizon");
  const body = requireIntent(values.intent);
  // Path hardening happens in the schema (repo-relative, no traversal);
  // existence on disk is deliberately NOT checked — the document may arrive by
  // a later merge, and a missing one is a validate finding (ADR-0012).
  const designDoc =
    values["design-doc"] === undefined
      ? undefined
      : requireValid(DESIGN_DOC_FIELD, values["design-doc"], "--design-doc");
  const adrs = (values.adr ?? []).map((path) => requireValid(ADR_FIELD, path, "--adr"));
  const prd = values.prd === undefined ? undefined : requireValid(PRD_FIELD, values.prd, "--prd");
  const epic =
    values.epic === undefined ? undefined : requireValid(EPIC_FIELD, values.epic, "--epic");

  const ctx = await commandContext(cwd, env, actorOverride);
  await requireFreeName(ctx.layout, name);
  const parent =
    values.parent === undefined
      ? undefined
      : await resolveNodeRef(ctx.layout, values.parent, "--parent");
  const predecessor =
    values.predecessor === undefined
      ? undefined
      : await resolveNodeRef(ctx.layout, values.predecessor, "--predecessor");
  const features: string[] = [];
  for (const ref of values.feature ?? []) {
    features.push(await resolveNodeRef(ctx.layout, ref, "--feature"));
  }

  const created = env.now();
  const frontmatter: RoadmapNodeFrontmatter = {
    id: generateId(env),
    name,
    kind,
    horizon,
    ...(parent === undefined ? {} : { parent }),
    ...(designDoc === undefined ? {} : { design_doc: designDoc }),
    adrs,
    ...(prd === undefined ? {} : { prd }),
    ...(epic === undefined ? {} : { epic }),
    ...(predecessor === undefined ? {} : { predecessor }),
    features,
    created,
    updated: created,
  };
  await mutate(ctx, {
    target: "roadmap-node",
    eventType: CORE_EVENT_TYPES.roadmapNodeCreated,
    frontmatter,
    body,
  });
  await closeStoreContext(ctx);
  console.log(frontmatter.id);
  return 0;
}

async function nodeUpdate(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      ...LINK_OPTIONS,
      name: { type: "string" },
      "clear-parent": { type: "boolean" },
      "clear-design-doc": { type: "boolean" },
      "clear-adrs": { type: "boolean" },
      "clear-prd": { type: "boolean" },
      "clear-epic": { type: "boolean" },
      "clear-predecessor": { type: "boolean" },
      "clear-features": { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    throw new UsageError("roadmap node update takes exactly one <ref> (a node slug or id)");
  }
  const ref = positionals[0]!;
  // A set flag and its clear flag together are ambiguous — refused outright.
  for (const [setFlag, clearFlag] of [
    ["parent", "clear-parent"],
    ["design-doc", "clear-design-doc"],
    ["adr", "clear-adrs"],
    ["prd", "clear-prd"],
    ["epic", "clear-epic"],
    ["predecessor", "clear-predecessor"],
    ["feature", "clear-features"],
  ] as const) {
    if (values[setFlag] !== undefined && values[clearFlag] === true) {
      throw new UsageError(
        `--${setFlag} and --${clearFlag} are mutually exclusive — pass one or the other`,
      );
    }
  }
  const setFlags = [
    "name",
    "horizon",
    "intent",
    "parent",
    "design-doc",
    "adr",
    "prd",
    "epic",
    "predecessor",
    "feature",
  ] as const;
  const clearFlags = [
    "clear-parent",
    "clear-design-doc",
    "clear-adrs",
    "clear-prd",
    "clear-epic",
    "clear-predecessor",
    "clear-features",
  ] as const;
  const hasChange =
    setFlags.some((flag) => values[flag] !== undefined) ||
    clearFlags.some((flag) => values[flag] === true);
  if (!hasChange) {
    throw new UsageError(
      `nothing to update — pass at least one of ${setFlags.map((f) => `--${f}`).join(", ")}, ` +
        clearFlags.map((f) => `--${f}`).join(", "),
    );
  }

  const ctx = await commandContext(cwd, env, actorOverride);
  const current = await resolveRoadmapNode(ctx.layout, ref);
  if (current === null) {
    throw new UsageError(
      `roadmap node ${JSON.stringify(ref)} not found — pass a node slug or id (records live in nahel/roadmap/)`,
    );
  }
  const next: RoadmapNodeFrontmatter = { ...current.frontmatter };
  let body = current.body;

  if (values.name !== undefined) {
    const name = requireValid(NAME_FIELD, values.name, "--name");
    await requireFreeName(ctx.layout, name, next.id);
    next.name = name;
  }
  if (values.horizon !== undefined) {
    next.horizon = requireValid(HORIZON_FIELD, values.horizon, "--horizon");
  }
  if (values.intent !== undefined) {
    body = requireIntent(values.intent);
  }
  if (values.parent !== undefined) {
    // A self-parent is a well-formed id link and an odd SHAPE, so it is
    // recorded and reported by `nahel validate` — a duplicate slug stays the
    // only structural refusal (F1: nothing else is ever refused).
    next.parent = await resolveNodeRef(ctx.layout, values.parent, "--parent");
  }
  if (values["design-doc"] !== undefined) {
    next.design_doc = requireValid(DESIGN_DOC_FIELD, values["design-doc"], "--design-doc");
  }
  if (values.adr !== undefined) {
    next.adrs = values.adr.map((path) => requireValid(ADR_FIELD, path, "--adr"));
  }
  if (values.prd !== undefined) {
    next.prd = requireValid(PRD_FIELD, values.prd, "--prd");
  }
  if (values.epic !== undefined) {
    next.epic = requireValid(EPIC_FIELD, values.epic, "--epic");
  }
  if (values.predecessor !== undefined) {
    // Same rule as --parent: a self-predecessor is recorded and warned about.
    next.predecessor = await resolveNodeRef(ctx.layout, values.predecessor, "--predecessor");
  }
  if (values.feature !== undefined) {
    const features: string[] = [];
    for (const featureRef of values.feature) {
      features.push(await resolveNodeRef(ctx.layout, featureRef, "--feature"));
    }
    next.features = features;
  }
  // Clears build the full post-mutation record — "cleared" is an ABSENT key
  // for the scalars, an empty list for the two lists.
  if (values["clear-parent"] === true) delete next.parent;
  if (values["clear-design-doc"] === true) delete next.design_doc;
  if (values["clear-adrs"] === true) next.adrs = [];
  if (values["clear-prd"] === true) delete next.prd;
  if (values["clear-epic"] === true) delete next.epic;
  if (values["clear-predecessor"] === true) delete next.predecessor;
  if (values["clear-features"] === true) next.features = [];
  next.updated = env.now();

  await mutate(ctx, {
    target: "roadmap-node",
    eventType: CORE_EVENT_TYPES.roadmapNodeUpdated,
    frontmatter: next,
    body,
  });
  await closeStoreContext(ctx);
  return 0;
}

async function nodeShow(args: string[], cwd: string): Promise<number> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  if (positionals.length !== 1) {
    throw new UsageError("roadmap node show takes exactly one <ref> (a node slug or id)");
  }
  const ref = positionals[0]!;
  const layout = await openStore(cwd);
  const record = await resolveRoadmapNode(layout, ref);
  if (record === null) {
    throw new UsageError(
      `roadmap node ${JSON.stringify(ref)} not found — pass a node slug or id (records live in nahel/roadmap/)`,
    );
  }
  // Lineage and initiative membership are facts held by OTHER nodes, so the
  // whole tree is read to answer them.
  const nodes = await readRoadmapNodes(layout);
  console.log(renderRoadmapNode(record, roadmapNodeLinks(nodes, record.frontmatter.id)));
  return 0;
}

/**
 * The journal facts the derived columns read (F2), collected while STREAMING so
 * a long journal never has to fit in memory to render a roadmap: only the three
 * column event types are kept, and the views take it from there.
 */
async function columnEvents(layout: StoreLayout): Promise<JournalEvent[]> {
  const events: JournalEvent[] = [];
  for await (const event of readJournal(layout)) {
    if (isRoadmapColumnEvent(event)) events.push(event);
  }
  return events;
}

/**
 * `nahel roadmap` with no ref (F3): the product level. A pure read — the store
 * is opened, four collections are read, and the renderer turns them into text.
 * Nothing here writes, and an empty store is rendered (how to start), never
 * refused.
 */
async function overview(cwd: string): Promise<number> {
  const layout = await openStore(cwd);
  const nodes = await readRoadmapNodes(layout);
  const { items } = await loadSnapshot(layout);
  console.log(renderRoadmapOverview(nodes, items, await columnEvents(layout)));
  return 0;
}

/**
 * What a ref that named no node earns. Two different facts, so two different
 * answers: a ref that IS a work item is not a miss at all — the roadmap points
 * at items and stops there (F1's one-way direction), so the answer is the verb
 * that reads items. Anything else names the slugs it resembles, and points at
 * the complete list when it resembles none.
 */
async function missedRef(
  layout: StoreLayout,
  nodes: readonly { frontmatter: RoadmapNodeFrontmatter }[],
  ref: string,
): Promise<UsageError> {
  if (ID_PATTERN.test(ref) && (await itemExists(layout, ref))) {
    return new UsageError(
      `${ref} is a work item, not a roadmap node — read it with \`nahel progress --item ${ref}\` ` +
        "(a feature node points AT its epic; the item never points back)",
    );
  }
  const guesses = nearMissNames(
    nodes.map(({ frontmatter }) => frontmatter.name),
    ref,
  );
  return new UsageError(
    `${JSON.stringify(ref)} does not name a roadmap node — ` +
      (guesses.length === 0
        ? "run `nahel roadmap` to list them"
        : `near misses: ${guesses.join(", ")} (\`nahel roadmap\` lists them all)`),
  );
}

/**
 * `nahel roadmap <ref>` (F3): zoom to one node. The whole tree is already in
 * hand for the breadcrumb and the reverse links, so the ref is matched against
 * it rather than read a second time — id first, then slug, exactly the
 * precedence resolveRoadmapNode uses.
 */
async function zoom(ref: string, args: string[], cwd: string): Promise<number> {
  if (args.length > 0) {
    throw new UsageError(
      `roadmap takes one ref (a node slug or id) — got ${JSON.stringify([ref, ...args].join(" "))}`,
    );
  }
  const layout = await openStore(cwd);
  const nodes = await readRoadmapNodes(layout);
  const record =
    nodes.find(({ frontmatter }) => frontmatter.id === ref) ??
    nodes.find(({ frontmatter }) => frontmatter.name === ref);
  if (record === undefined) throw await missedRef(layout, nodes, ref);
  const { items } = await loadSnapshot(layout);
  console.log(
    renderRoadmapZoom(record, {
      nodes,
      items,
      events: await columnEvents(layout),
      maps: await readMaps(layout),
      tickets: await readTickets(layout),
    }),
  );
  return 0;
}

/**
 * `nahel roadmap ack` (F5): record that a human has looked at the roadmap. The
 * act IS the whole verb — it carries no ref, no payload, and touches no record,
 * so there is nothing to parse and nothing to name. Under an AGENT actor it is
 * journaled all the same and clears nothing: provenance is read back from the
 * journal, exactly as merge authority reads the flip that authorizes it, and a
 * silent ✅ would read as a clear the awaiting surface will not honor.
 */
async function ack(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  if (args.length > 0) {
    throw new UsageError(
      `roadmap ack takes no arguments — it acknowledges the roadmap as a whole (got ${JSON.stringify(args[0])})`,
    );
  }
  const ctx = await commandContext(cwd, env, actorOverride);
  await appendEvent(ctx.layout, ctx.env, {
    type: ROADMAP_ACKED_EVENT_TYPE,
    actor: ctx.actor,
    session: ctx.session,
    payload: {},
  });
  await closeStoreContext(ctx);
  console.log(
    ctx.actor.kind === "human"
      ? "✅ roadmap acknowledged"
      : `✅ roadmap acknowledged by ${ctx.actor.kind}:${ctx.actor.id} — recorded, but an agent ack clears nothing (a human's eyes are what the brief is waiting for)`,
  );
  return 0;
}

export const roadmapCommand: Command = {
  name: "roadmap",
  description:
    "read the roadmap and zoom into it, and create or update its nodes — the intent layer above work items (roadmap [ref], roadmap node new | update | show, roadmap ack)",
  run: (argv, env, cwd, actorOverride) =>
    execute("run `nahel roadmap --help` for usage", async () => {
      const [group, ...rest] = argv;
      if (
        group === "--help" ||
        group === "-h" ||
        rest.includes("--help") ||
        rest.includes("-h")
      ) {
        console.log(USAGE);
        return 0;
      }
      // F3: the bare verb IS the view. The verbs below are ROADMAP_SUBCOMMANDS,
      // so a node named `node`, `map`, `ticket` or `ack` is addressed by
      // `nahel roadmap node show <ref>` instead — the verbs win the word.
      if (group === undefined) return overview(cwd);
      if (group === "ack") return ack(rest, env, cwd, actorOverride);
      if (group === "map") return runMapSubcommand(rest, env, cwd, actorOverride);
      if (group === "ticket") return runTicketSubcommand(rest, env, cwd, actorOverride);
      // Anything that is not a reserved verb is a node REF, not an unknown
      // subcommand: `nahel roadmap <slug-or-id>` is the zoom (F3). The set is
      // the views' — a hint must never name a word this line swallows.
      if (!ROADMAP_SUBCOMMANDS.has(group)) return zoom(group, rest, cwd);
      const [sub, ...args] = rest;
      refuseDerivedFlags(args);
      if (sub === "new") return nodeNew(args, env, cwd, actorOverride);
      if (sub === "update") return nodeUpdate(args, env, cwd, actorOverride);
      if (sub === "show") return nodeShow(args, cwd);
      throw new UsageError(
        sub === undefined
          ? "missing subcommand — expected `roadmap node new`, `roadmap node update`, or `roadmap node show`"
          : `unknown subcommand ${JSON.stringify(sub)} — expected new, update, or show`,
      );
    }),
};

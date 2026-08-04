import { parseArgs } from "node:util";
import type { Env } from "../schema/env";
import { CORE_EVENT_TYPES } from "../schema/events";
import { generateId } from "../schema/id";
import { mapFrontmatterSchema, type MapFrontmatter } from "../schema/records";
import {
  openStore,
  readMaps,
  resolveMap,
  resolveRoadmapNode,
  ticketsForMap,
  type StoreLayout,
} from "../store/layout";
import { closeStoreContext, mutate } from "../store/mutate";
import { renderMap } from "../views/roadmap";
import { commandContext, requireValid, UsageError } from "./item";
import { requireSingleLine, resolveNodeRef, ticketTerminalEvents } from "./roadmap-ref";

/**
 * `nahel roadmap map` (Phase 4 F7): the wayfinder map — one chart per roadmap
 * node holding a destination, notes, the decision index, the fog, and what was
 * ruled out. Thin over the store like every other verb: parse argv → call the
 * store, with every mutation flowing through mutate()'s write-ahead choke
 * point and no filesystem or journal access of its own.
 *
 * Two sections are deliberately NOT writable here, because neither is stored:
 * **Decisions so far** and the ticket-earned part of **Out of scope** are
 * derived from the map's tickets at read time — the decision is the ticket's
 * act, and a hand-written index line would be an index of nothing. Out-of-scope
 * lines may still be AUTHORED at charting time (`--out-of-scope`), because
 * ruling something beyond the destination needs no ticket; a decision always
 * does. Those charted lines are the only ones this record stores.
 */

const DESTINATION_FIELD = mapFrontmatterSchema.shape.destination;
const FOG_FIELD = mapFrontmatterSchema.shape.fog.element;
const OUT_OF_SCOPE_FIELD = mapFrontmatterSchema.shape.out_of_scope.element;

export const MAP_USAGE = `  nahel roadmap map new --node <ref> --destination <text> [--notes <text>]
                        [--fog <line>]... [--out-of-scope <line>]...
    Chart a map on a roadmap node and print its generated id. One map per node.
      --node: the node this map charts (a node slug or id)
      --destination: where this effort is going
      --notes: the map's prose, stored as the record body
      --fog: an in-scope question not sharp enough to ticket yet (repeatable)
      --out-of-scope: something ruled beyond the destination (repeatable)

  nahel roadmap map update <ref> [--destination <text>] [--notes <text>]
                          [--fog <line>]... [--clear-fog]
                          [--out-of-scope <line>]... [--clear-out-of-scope]
    Update the authored sections; the CLI maintains \`updated\`. Repeatable
    --fog and --out-of-scope replace the whole section (that is how a fog line
    graduates: re-state what is left); each --clear-* flag empties it.
    <ref> is the map's id, or the slug or id of the node it charts.

  nahel roadmap map show <ref>
    Print the whole chart: every section, the node it charts, and its tickets.`;

/**
 * The two sections no flag writes (F7). parseArgs already refuses an unknown
 * option, but "Unknown option '--decision'" reads like an omission — these
 * refusals name the act that actually moves the section instead.
 */
const DERIVED_MAP_FLAGS: ReadonlyMap<string, string> = new Map([
  [
    "--decision",
    "a map's Decisions so far index is written by resolving a ticket — record the decision with `nahel roadmap ticket resolve <ref> --decision <one-liner>`",
  ],
  [
    "--decisions",
    "a map's Decisions so far index is written by resolving a ticket — record the decision with `nahel roadmap ticket resolve <ref> --decision <one-liner>`",
  ],
]);

/** Refuse a section flag by name, before parseArgs calls it merely unknown. */
function refuseDerivedMapFlags(args: readonly string[]): void {
  for (const arg of args) {
    const rule = DERIVED_MAP_FLAGS.get(arg.split("=")[0]!);
    if (rule !== undefined) {
      throw new UsageError(`${arg.split("=")[0]!} is not a flag: ${rule}`);
    }
  }
}

const SECTION_OPTIONS = {
  destination: { type: "string" },
  notes: { type: "string" },
  fog: { type: "string", multiple: true },
  "out-of-scope": { type: "string", multiple: true },
} as const;

/** Notes are the record body; an absent --notes leaves it empty, never blank-padded. */
function notesBody(value: string | undefined): string {
  if (value === undefined || value.trim() === "") return "";
  return value.endsWith("\n") ? value : `${value}\n`;
}

/** Resolve a map ref (map id, or the node's slug or id) or refuse it by name. */
export async function requireMap(layout: StoreLayout, ref: string) {
  const record = await resolveMap(layout, ref);
  if (record === null) {
    throw new UsageError(
      `no map found for ${JSON.stringify(ref)} — pass a map id, or the slug or id of the node it charts ` +
        "(chart one with `nahel roadmap map new --node <ref> --destination <text>`)",
    );
  }
  return record;
}

async function mapNew(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { ...SECTION_OPTIONS, node: { type: "string" } },
    allowPositionals: true,
  });
  if (positionals.length > 0) {
    throw new UsageError(
      `roadmap map new takes no positional arguments — the node is named by --node (got ${JSON.stringify(positionals[0])})`,
    );
  }
  if (values.node === undefined) {
    throw new UsageError("a map charts one roadmap node — pass --node <slug|id>");
  }
  if (values.destination === undefined) {
    throw new UsageError(
      "a map states where the effort is going — pass --destination <text> (a map that charts nowhere charts nothing)",
    );
  }
  const destination = requireSingleLine(
    requireValid(DESTINATION_FIELD, values.destination, "--destination"),
    "--destination",
  );
  const fog = (values.fog ?? []).map((line) =>
    requireSingleLine(requireValid(FOG_FIELD, line, "--fog"), "--fog"),
  );
  const outOfScope = (values["out-of-scope"] ?? []).map((line) =>
    requireSingleLine(requireValid(OUT_OF_SCOPE_FIELD, line, "--out-of-scope"), "--out-of-scope"),
  );

  const ctx = await commandContext(cwd, env, actorOverride);
  const node = await resolveNodeRef(ctx.layout, values.node, "--node");
  // One map per node: the node's slug is how a map is addressed, so a second
  // one would make `map show <slug>` ambiguous. Same rule, same reason, as the
  // duplicate-slug refusal on nodes — and the only refusal on this verb.
  const existing = (await readMaps(ctx.layout)).find((map) => map.frontmatter.node === node);
  if (existing !== undefined) {
    throw new UsageError(
      `roadmap node ${values.node} is already charted by map ${existing.frontmatter.id} — ` +
        `one map per node; update it with \`nahel roadmap map update ${values.node}\``,
    );
  }

  const created = env.now();
  const frontmatter: MapFrontmatter = {
    id: generateId(env),
    node,
    destination,
    fog,
    out_of_scope: outOfScope,
    created,
    updated: created,
  };
  await mutate(ctx, {
    target: "map",
    eventType: CORE_EVENT_TYPES.mapCreated,
    frontmatter,
    body: notesBody(values.notes),
  });
  await closeStoreContext(ctx);
  console.log(frontmatter.id);
  return 0;
}

async function mapUpdate(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      ...SECTION_OPTIONS,
      "clear-fog": { type: "boolean" },
      "clear-out-of-scope": { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    throw new UsageError(
      "roadmap map update takes exactly one <ref> (a map id, or the node's slug or id)",
    );
  }
  for (const [setFlag, clearFlag] of [
    ["fog", "clear-fog"],
    ["out-of-scope", "clear-out-of-scope"],
  ] as const) {
    if (values[setFlag] !== undefined && values[clearFlag] === true) {
      throw new UsageError(
        `--${setFlag} and --${clearFlag} are mutually exclusive — pass one or the other`,
      );
    }
  }
  const setFlags = ["destination", "notes", "fog", "out-of-scope"] as const;
  const clearFlags = ["clear-fog", "clear-out-of-scope"] as const;
  if (
    !setFlags.some((flag) => values[flag] !== undefined) &&
    !clearFlags.some((flag) => values[flag] === true)
  ) {
    throw new UsageError(
      `nothing to update — pass at least one of ${setFlags.map((f) => `--${f}`).join(", ")}, ` +
        clearFlags.map((f) => `--${f}`).join(", "),
    );
  }

  const ctx = await commandContext(cwd, env, actorOverride);
  const current = await requireMap(ctx.layout, positionals[0]!);
  const next: MapFrontmatter = { ...current.frontmatter };
  let body = current.body;
  if (values.destination !== undefined) {
    next.destination = requireSingleLine(
      requireValid(DESTINATION_FIELD, values.destination, "--destination"),
      "--destination",
    );
  }
  if (values.notes !== undefined) body = notesBody(values.notes);
  if (values.fog !== undefined) {
    next.fog = values.fog.map((line) =>
      requireSingleLine(requireValid(FOG_FIELD, line, "--fog"), "--fog"),
    );
  }
  if (values["out-of-scope"] !== undefined) {
    // Re-authoring replaces the CHARTED lines only, and cannot orphan anything:
    // the lines `ticket close` earned are derived from those tickets and were
    // never in this list to lose.
    next.out_of_scope = values["out-of-scope"].map((line) =>
      requireSingleLine(requireValid(OUT_OF_SCOPE_FIELD, line, "--out-of-scope"), "--out-of-scope"),
    );
  }
  if (values["clear-fog"] === true) next.fog = [];
  if (values["clear-out-of-scope"] === true) next.out_of_scope = [];
  next.updated = env.now();

  await mutate(ctx, {
    target: "map",
    eventType: CORE_EVENT_TYPES.mapUpdated,
    frontmatter: next,
    body,
  });
  await closeStoreContext(ctx);
  return 0;
}

async function mapShow(args: string[], cwd: string): Promise<number> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  if (positionals.length !== 1) {
    throw new UsageError(
      "roadmap map show takes exactly one <ref> (a map id, or the node's slug or id)",
    );
  }
  const layout = await openStore(cwd);
  const record = await requireMap(layout, positionals[0]!);
  // The node's name, the map's tickets, and the acts that resolved or closed
  // them are facts held ELSEWHERE — by other records and by the journal — so
  // all three are read here rather than derived from the map alone.
  const node = await resolveRoadmapNode(layout, record.frontmatter.node);
  console.log(
    renderMap(
      record,
      node,
      await ticketsForMap(layout, record.frontmatter.id),
      await ticketTerminalEvents(layout),
    ),
  );
  return 0;
}

/**
 * Dispatch `nahel roadmap map <sub>`. The parent verb owns the error surface
 * (its execute() wrapper prints and exits), so this throws rather than catching.
 */
export async function runMapSubcommand(
  argv: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const [sub, ...args] = argv;
  refuseDerivedMapFlags(args);
  if (sub === "new") return mapNew(args, env, cwd, actorOverride);
  if (sub === "update") return mapUpdate(args, env, cwd, actorOverride);
  if (sub === "show") return mapShow(args, cwd);
  throw new UsageError(
    sub === undefined
      ? "missing subcommand — expected `roadmap map new`, `roadmap map update`, or `roadmap map show`"
      : `unknown subcommand ${JSON.stringify(sub)} — expected new, update, or show`,
  );
}

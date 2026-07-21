import { parseArgs } from "node:util";
import type { z } from "zod";
import { LANES, WORK_ITEM_STATUSES, WORK_ITEM_TYPES, type WorkItemStatus } from "../schema/enums";
import type { Env } from "../schema/env";
import { CORE_EVENT_TYPES } from "../schema/events";
import { generateId } from "../schema/id";
import {
  workItemFrontmatterSchema,
  type ExternalRef,
  type WorkItemFrontmatter,
} from "../schema/records";
import { itemExists, readItem, type StoreLayout } from "../store/layout";
import {
  closeStoreContext,
  createStoreContext,
  mutate,
  type StoreContext,
} from "../store/mutate";

/**
 * `nahel item` — the work-item write surface (PRD F3). Commands are thin:
 * parse argv → call the store. Every mutation flows through the store's
 * mutate() choke point, which resolves the actor, enforces claims, and
 * write-ahead-journals the full mutation — this layer never touches the
 * filesystem or the journal directly.
 *
 * This module also hosts the command-layer plumbing shared with run.ts
 * (the Command shape, error surface, actor override, referential checks):
 * issue #5 owns exactly these two command files.
 */

/**
 * Registration-ready CLI command; cli.ts wires name → run (issue #4).
 * `actorOverride` is the NAHEL_ACTOR spec *value*: only the cli.ts entry
 * point reads the process environment, and it injects the value here —
 * commands stay pure over their arguments (see store/actor.ts).
 */
export interface Command {
  name: string;
  description: string;
  run(argv: string[], env: Env, cwd: string, actorOverride?: string): Promise<number>;
}

/** A user-input error: printed with the command's usage hint, exit 1. */
export class UsageError extends Error {}

/** Resolve the store context every mutation command starts from. */
export function commandContext(
  cwd: string,
  env: Env,
  actorOverride?: string,
): Promise<StoreContext> {
  return createStoreContext(cwd, env, { actorOverride });
}

function isParseArgsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return (
    typeof code === "string" &&
    (code.startsWith("ERR_PARSE_ARGS") || code === "ERR_INVALID_ARG_TYPE")
  );
}

/**
 * Uniform command error surface: any thrown error prints `error: …` on
 * stderr and exits 1; user-input errors also get the usage hint.
 */
export async function execute(usageHint: string, body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof UsageError || isParseArgsError(error)) {
      console.error(usageHint);
    }
    return 1;
  }
}

/** Write-time referential validation: `id` must be an item on disk. */
export async function requireExistingItem(
  layout: StoreLayout,
  id: string,
  what: string,
): Promise<void> {
  if (!(await itemExists(layout, id))) {
    throw new UsageError(
      `${what} ${id} does not reference an existing item — create it with \`nahel item new\` or check the id`,
    );
  }
}

/** Validate one field against its record schema, with an actionable message. */
export function requireValid<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const reason = result.error.issues[0]?.message ?? result.error.message;
    throw new UsageError(`invalid ${what} ${JSON.stringify(value)} — ${reason}`);
  }
  return result.data;
}

function requireEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  what: string,
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new UsageError(
      `invalid ${what} ${JSON.stringify(value)} — expected one of: ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

function parseExternalRef(value: string): ExternalRef {
  const separator = value.indexOf(":");
  const provider = separator === -1 ? "" : value.slice(0, separator);
  const id = separator === -1 ? "" : value.slice(separator + 1);
  if (provider === "" || id === "") {
    throw new UsageError(
      `invalid --external-ref ${JSON.stringify(value)} — expected <provider>:<id> (e.g. github:123)`,
    );
  }
  return { provider, id };
}

/** Statuses that `--reopen` guards against accidentally resurrecting. */
const CLOSED_STATUSES: readonly WorkItemStatus[] = ["done", "dropped"];

const USAGE = `usage:
  nahel item new <type> <name> <lane> [--parent <id>] [--depends-on <id>]...
                 [--external-ref <provider>:<id>]... [--prd <path>]
                 [--investigation <path>]
    Create a work item (status starts at backlog) and print its generated id.
      type: ${WORK_ITEM_TYPES.join(" | ")}
      lane: ${LANES.join(" | ")}
      --prd: repo-relative path to the item's PRD document (ADR-0013)
      --investigation: repo-relative path to a bug's investigation document (F5)

  nahel item update <id> [--status <status>] [--lane <lane>] [--parent <id>]
                    [--depends-on <id>]... [--external-ref <provider>:<id>]...
                    [--prd <path>] [--investigation <path>] [--reopen]
                    [--clear-parent] [--clear-depends-on] [--clear-external-refs]
                    [--clear-prd] [--clear-investigation]
    Update fields; the CLI maintains \`updated\`. Repeatable --depends-on and
    --external-ref replace the whole list; --clear-parent, --clear-depends-on,
    --clear-external-refs, --clear-prd and --clear-investigation remove the
    field / empty the list (each is mutually exclusive with its set flag).
      status: ${WORK_ITEM_STATUSES.join(" | ")}
      Any status transition is legal except re-opening a done or dropped item,
      which requires --reopen (guard against accidental resurrection);
      done <-> dropped and non-status edits of a closed item need no flag.`;

async function itemNew(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      parent: { type: "string" },
      "depends-on": { type: "string", multiple: true },
      "external-ref": { type: "string", multiple: true },
      prd: { type: "string" },
      investigation: { type: "string" },
    },
    allowPositionals: true,
  });
  if (positionals.length !== 3) {
    throw new UsageError(
      `item new takes exactly <type> <name> <lane> — got ${positionals.length} positional argument(s)`,
    );
  }
  const type = requireEnum(positionals[0]!, WORK_ITEM_TYPES, "type");
  const name = requireValid(workItemFrontmatterSchema.shape.name, positionals[1], "name");
  const lane = requireEnum(positionals[2]!, LANES, "lane");
  const externalRefs = (values["external-ref"] ?? []).map(parseExternalRef);
  // Path hardening happens in the schema (repo-relative, no traversal);
  // existence on disk is deliberately NOT checked — the PRD may arrive by a
  // later merge, and a missing document is a validate WARNING (ADR-0012).
  const prd =
    values.prd === undefined
      ? undefined
      : requireValid(workItemFrontmatterSchema.shape.prd, values.prd, "--prd");
  const investigation =
    values.investigation === undefined
      ? undefined
      : requireValid(
          workItemFrontmatterSchema.shape.investigation,
          values.investigation,
          "--investigation",
        );

  const ctx = await commandContext(cwd, env, actorOverride);
  if (values.parent !== undefined) {
    await requireExistingItem(ctx.layout, values.parent, "--parent");
  }
  for (const dependency of values["depends-on"] ?? []) {
    await requireExistingItem(ctx.layout, dependency, "--depends-on");
  }

  const created = env.now();
  const frontmatter: WorkItemFrontmatter = {
    id: generateId(env),
    name,
    type,
    status: "backlog",
    lane,
    ...(values.parent === undefined ? {} : { parent: values.parent }),
    depends_on: values["depends-on"] ?? [],
    external_refs: externalRefs,
    ...(prd === undefined ? {} : { prd }),
    ...(investigation === undefined ? {} : { investigation }),
    created,
    updated: created,
  };
  await mutate(ctx, {
    target: "item",
    eventType: CORE_EVENT_TYPES.itemCreated,
    frontmatter,
    body: "",
  });
  await closeStoreContext(ctx);
  console.log(frontmatter.id);
  return 0;
}

async function itemUpdate(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      status: { type: "string" },
      lane: { type: "string" },
      parent: { type: "string" },
      "depends-on": { type: "string", multiple: true },
      "external-ref": { type: "string", multiple: true },
      prd: { type: "string" },
      investigation: { type: "string" },
      reopen: { type: "boolean" },
      "clear-parent": { type: "boolean" },
      "clear-depends-on": { type: "boolean" },
      "clear-external-refs": { type: "boolean" },
      "clear-prd": { type: "boolean" },
      "clear-investigation": { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    throw new UsageError("item update takes exactly one <id>");
  }
  const id = positionals[0]!;
  // A set flag and its clear flag together are ambiguous — refused outright.
  for (const [setFlag, clearFlag] of [
    ["parent", "clear-parent"],
    ["depends-on", "clear-depends-on"],
    ["external-ref", "clear-external-refs"],
    ["prd", "clear-prd"],
    ["investigation", "clear-investigation"],
  ] as const) {
    if (values[setFlag] !== undefined && values[clearFlag] === true) {
      throw new UsageError(
        `--${setFlag} and --${clearFlag} are mutually exclusive — pass one or the other`,
      );
    }
  }
  const hasChange =
    values.status !== undefined ||
    values.lane !== undefined ||
    values.parent !== undefined ||
    values["depends-on"] !== undefined ||
    values["external-ref"] !== undefined ||
    values.prd !== undefined ||
    values.investigation !== undefined ||
    values["clear-parent"] === true ||
    values["clear-depends-on"] === true ||
    values["clear-external-refs"] === true ||
    values["clear-prd"] === true ||
    values["clear-investigation"] === true;
  if (!hasChange) {
    throw new UsageError(
      "nothing to update — pass at least one of --status, --lane, --parent, --depends-on, " +
        "--external-ref, --prd, --investigation, --clear-parent, --clear-depends-on, " +
        "--clear-external-refs, --clear-prd, --clear-investigation",
    );
  }

  const ctx = await commandContext(cwd, env, actorOverride);
  if (!(await itemExists(ctx.layout, id))) {
    throw new UsageError(`item ${id} not found — check the id (records live in nahel/items/)`);
  }
  const { frontmatter: current, body } = await readItem(ctx.layout, id);
  const next: WorkItemFrontmatter = { ...current };

  if (values.status !== undefined) {
    const status = requireEnum(values.status, WORK_ITEM_STATUSES, "status");
    const reopening =
      CLOSED_STATUSES.includes(current.status) && !CLOSED_STATUSES.includes(status);
    if (reopening && values.reopen !== true) {
      throw new UsageError(
        `item ${id} is ${current.status} — re-opening requires --reopen (guard against accidental resurrection)`,
      );
    }
    next.status = status;
  }
  if (values.lane !== undefined) {
    next.lane = requireEnum(values.lane, LANES, "lane");
  }
  if (values.parent !== undefined) {
    if (values.parent === id) {
      throw new UsageError(`item ${id} cannot be its own parent`);
    }
    await requireExistingItem(ctx.layout, values.parent, "--parent");
    next.parent = values.parent;
  }
  if (values["depends-on"] !== undefined) {
    for (const dependency of values["depends-on"]) {
      if (dependency === id) {
        throw new UsageError(`item ${id} cannot depend on itself`);
      }
      await requireExistingItem(ctx.layout, dependency, "--depends-on");
    }
    next.depends_on = values["depends-on"];
  }
  if (values["external-ref"] !== undefined) {
    next.external_refs = values["external-ref"].map(parseExternalRef);
  }
  if (values.prd !== undefined) {
    // Schema-hardened path; existence is validate's concern, not write-time's
    // (ADR-0012: the PRD document may arrive by a later merge).
    next.prd = requireValid(workItemFrontmatterSchema.shape.prd, values.prd, "--prd");
  }
  if (values.investigation !== undefined) {
    // Same reference semantics as --prd: schema-hardened path, existence is
    // validate's concern (ADR-0012: the document may arrive by a later merge).
    next.investigation = requireValid(
      workItemFrontmatterSchema.shape.investigation,
      values.investigation,
      "--investigation",
    );
  }
  // Clears build the full post-mutation record — "cleared" is an ABSENT
  // parent key (never parent: undefined/null), an empty list for the others.
  // The store's claim check still reads the CURRENT chain from disk starting
  // at the item itself, so clearing the parent can never slip a covered item
  // out of a claimed subtree.
  if (values["clear-parent"] === true) {
    delete next.parent;
  }
  if (values["clear-depends-on"] === true) {
    next.depends_on = [];
  }
  if (values["clear-external-refs"] === true) {
    next.external_refs = [];
  }
  if (values["clear-prd"] === true) {
    delete next.prd;
  }
  if (values["clear-investigation"] === true) {
    delete next.investigation;
  }
  next.updated = env.now();

  await mutate(ctx, {
    target: "item",
    eventType: CORE_EVENT_TYPES.itemUpdated,
    frontmatter: next,
    body,
  });
  await closeStoreContext(ctx);
  return 0;
}

export const itemCommand: Command = {
  name: "item",
  description: "create and update work items (item new | item update)",
  run: (argv, env, cwd, actorOverride) =>
    execute("run `nahel item --help` for usage", async () => {
      const [sub, ...rest] = argv;
      if (sub === "--help" || sub === "-h" || rest.includes("--help") || rest.includes("-h")) {
        console.log(USAGE);
        return 0;
      }
      if (sub === "new") return itemNew(rest, env, cwd, actorOverride);
      if (sub === "update") return itemUpdate(rest, env, cwd, actorOverride);
      throw new UsageError(
        sub === undefined
          ? "missing subcommand — expected `item new` or `item update`"
          : `unknown subcommand ${JSON.stringify(sub)} — expected new or update`,
      );
    }),
};

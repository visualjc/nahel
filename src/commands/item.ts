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
import { NAHEL_ACTOR_VAR } from "../store/actor";
import { itemExists, readItem, type StoreLayout } from "../store/layout";
import { createStoreContext, mutate, type StoreContext } from "../store/mutate";

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

/** Registration-ready CLI command; cli.ts wires name → run (issue #4). */
export interface Command {
  name: string;
  description: string;
  run(argv: string[], env: Env, cwd: string): Promise<number>;
}

/** A user-input error: printed with the command's usage hint, exit 1. */
export class UsageError extends Error {}

/**
 * Commands are the CLI entry point, so the NAHEL_ACTOR override *value* is
 * read here and passed down — store code never reads the process environment
 * (see store/actor.ts).
 */
export function processActorOverride(): string | undefined {
  return process.env[NAHEL_ACTOR_VAR];
}

/** Resolve the store context every mutation command starts from. */
export function commandContext(cwd: string, env: Env): Promise<StoreContext> {
  return createStoreContext(cwd, env, { actorOverride: processActorOverride() });
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
  nahel item new <type> <name> <lane> [--parent <id>] [--depends-on <id>]... [--external-ref <provider>:<id>]...
    Create a work item (status starts at backlog) and print its generated id.
      type: ${WORK_ITEM_TYPES.join(" | ")}
      lane: ${LANES.join(" | ")}

  nahel item update <id> [--status <status>] [--lane <lane>] [--parent <id>]
                    [--depends-on <id>]... [--external-ref <provider>:<id>]... [--reopen]
    Update fields; the CLI maintains \`updated\`. Repeatable --depends-on and
    --external-ref replace the whole list.
      status: ${WORK_ITEM_STATUSES.join(" | ")}
      Any status transition is legal except re-opening a done or dropped item,
      which requires --reopen (guard against accidental resurrection);
      done <-> dropped and non-status edits of a closed item need no flag.`;

async function itemNew(args: string[], env: Env, cwd: string): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      parent: { type: "string" },
      "depends-on": { type: "string", multiple: true },
      "external-ref": { type: "string", multiple: true },
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

  const ctx = await commandContext(cwd, env);
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
    created,
    updated: created,
  };
  await mutate(ctx, {
    target: "item",
    eventType: CORE_EVENT_TYPES.itemCreated,
    frontmatter,
    body: "",
  });
  console.log(frontmatter.id);
  return 0;
}

async function itemUpdate(args: string[], env: Env, cwd: string): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      status: { type: "string" },
      lane: { type: "string" },
      parent: { type: "string" },
      "depends-on": { type: "string", multiple: true },
      "external-ref": { type: "string", multiple: true },
      reopen: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    throw new UsageError("item update takes exactly one <id>");
  }
  const id = positionals[0]!;
  const hasChange =
    values.status !== undefined ||
    values.lane !== undefined ||
    values.parent !== undefined ||
    values["depends-on"] !== undefined ||
    values["external-ref"] !== undefined;
  if (!hasChange) {
    throw new UsageError(
      "nothing to update — pass at least one of --status, --lane, --parent, --depends-on, --external-ref",
    );
  }

  const ctx = await commandContext(cwd, env);
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
  next.updated = env.now();

  await mutate(ctx, {
    target: "item",
    eventType: CORE_EVENT_TYPES.itemUpdated,
    frontmatter: next,
    body,
  });
  return 0;
}

export const itemCommand: Command = {
  name: "item",
  description: "create and update work items (item new | item update)",
  run: (argv, env, cwd) =>
    execute("run `nahel item --help` for usage", async () => {
      const [sub, ...rest] = argv;
      if (sub === "--help" || sub === "-h" || rest.includes("--help") || rest.includes("-h")) {
        console.log(USAGE);
        return 0;
      }
      if (sub === "new") return itemNew(rest, env, cwd);
      if (sub === "update") return itemUpdate(rest, env, cwd);
      throw new UsageError(
        sub === undefined
          ? "missing subcommand — expected `item new` or `item update`"
          : `unknown subcommand ${JSON.stringify(sub)} — expected new or update`,
      );
    }),
};

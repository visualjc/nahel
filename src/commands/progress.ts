import { parseArgs } from "node:util";
import type { Command, CommandContext } from "../cli";
import { journalEventSchema } from "../schema/records";
import { itemExists, readConfig, storeLayout } from "../store/layout";
import { collectProgress, renderProgress, type ProgressQuery } from "../views/progress";
import { descendantIds, loadSnapshot } from "../views/snapshot";
import { UsageError } from "./item";

/**
 * `nahel progress` (PRD F6): the merged journal timeline, newest LAST.
 * STRICTLY a view — a thin wrapper over the streaming collector and the pure
 * renderer; every output token comes off a journal event. `--item` covers the
 * item's whole subtree (descendants included) plus run-scoped events of the
 * subtree's runs; `--since` cuts by the journal's own timestamp format;
 * `--limit` keeps the newest n while streaming (never a full-journal load).
 */

const USAGE = "usage: nahel progress [--item <id>] [--since <iso>] [--limit <n>]";

interface ProgressFlags {
  item?: string;
  since?: string;
  limit?: number;
}

function parseFlags(argv: string[]): ProgressFlags {
  let values: { item?: string; since?: string; limit?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        item: { type: "string" },
        since: { type: "string" },
        limit: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (positionals.length > 0) {
    throw new UsageError(`unexpected extra arguments: ${positionals.join(" ")}`);
  }

  let limit: number | undefined;
  if (values.limit !== undefined) {
    if (!/^[0-9]+$/.test(values.limit) || Number(values.limit) < 1) {
      throw new UsageError(
        `invalid --limit ${JSON.stringify(values.limit)} — expected a positive integer`,
      );
    }
    limit = Number(values.limit);
  }

  if (values.since !== undefined) {
    // The journal's own ts format is the filter's contract — reuse its schema.
    const parsed = journalEventSchema.shape.ts.safeParse(values.since);
    if (!parsed.success) {
      const reason = parsed.error.issues[0]?.message ?? parsed.error.message;
      throw new UsageError(`invalid --since ${JSON.stringify(values.since)} — ${reason}`);
    }
  }

  return {
    ...(values.item === undefined ? {} : { item: values.item }),
    ...(values.since === undefined ? {} : { since: values.since }),
    ...(limit === undefined ? {} : { limit }),
  };
}

async function runProgress(argv: string[], ctx: CommandContext): Promise<number> {
  try {
    const flags = parseFlags(argv);
    const layout = storeLayout(ctx.cwd);
    // Initialized-repo gate: a missing config errors with the `nahel init`
    // pointer instead of rendering a misleadingly empty timeline.
    await readConfig(layout);

    const query: ProgressQuery = {
      ...(flags.since === undefined ? {} : { since: flags.since }),
      ...(flags.limit === undefined ? {} : { limit: flags.limit }),
    };
    if (flags.item !== undefined) {
      if (!(await itemExists(layout, flags.item))) {
        throw new UsageError(
          `--item ${flags.item} does not reference an existing work item — check the id`,
        );
      }
      const snapshot = await loadSnapshot(layout);
      const itemIds = descendantIds(snapshot.items, flags.item);
      query.itemIds = itemIds;
      query.runIds = new Set(
        snapshot.runs
          .filter((entry) => itemIds.has(entry.run.item))
          .map((entry) => entry.run.id),
      );
    }

    ctx.stdout(renderProgress(await collectProgress(layout, query)));
    return 0;
  } catch (error) {
    ctx.stderr(`❌ ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof UsageError) ctx.stderr(USAGE);
    return 1;
  }
}

export const progressCommand: Command = {
  description:
    "show the journal timeline, newest last (--item covers the subtree; --since, --limit)",
  run: runProgress,
};

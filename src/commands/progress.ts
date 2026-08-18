import { parseArgs } from "node:util";
import type { Command, CommandContext } from "../cli";
import { itemExists, openStore, readConfig } from "../store/layout";
import { collectProgress, renderProgress, type ProgressQuery } from "../views/progress";
import { descendantIds, loadSnapshot } from "../views/snapshot";
import { resolveSince } from "../views/standup";
import { UsageError } from "./item";

/**
 * `nahel progress` (PRD F6): the merged journal timeline, newest LAST.
 * STRICTLY a view — a thin wrapper over the streaming collector and the pure
 * renderer; every output token comes off a journal event. `--item` covers the
 * item's whole subtree (descendants included) plus run-scoped events of the
 * subtree's runs; `--since` cuts by a window in the CLI's one window language
 * (`7d`, `24h` or an ISO timestamp — the same `resolveSince` standup and
 * decisions use, resolved HERE from `ctx.env.now()` so the view never sees a
 * clock); `--limit` keeps the newest n while streaming (never a full-journal
 * load).
 */

const USAGE =
  "usage: nahel progress [--item <id>] [--since <7d|24h|ISO timestamp>] [--limit <n>]";

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

  return {
    ...(values.item === undefined ? {} : { item: values.item }),
    ...(values.since === undefined ? {} : { since: values.since }),
    ...(limit === undefined ? {} : { limit }),
  };
}

async function runProgress(argv: string[], ctx: CommandContext): Promise<number> {
  try {
    const flags = parseFlags(argv);
    // Resolved BEFORE the store is opened, the standup way: a spec that names
    // no instant is refused with the reason it names none, and nothing is read
    // or printed on the way. The view downstream only ever sees the resolved
    // absolute cutoff, so `--since 7d` and its equivalent timestamp select the
    // same events under a fixed Env.
    let since: string | undefined;
    if (flags.since !== undefined) {
      const resolved = resolveSince(flags.since, ctx.env.now());
      if ("error" in resolved) {
        throw new UsageError(`invalid --since ${JSON.stringify(flags.since)} — ${resolved.error}`);
      }
      since = resolved.since;
    }
    const layout = await openStore(ctx.cwd);
    // Initialized-repo gate: a missing config errors with the `nahel init`
    // pointer instead of rendering a misleadingly empty timeline.
    await readConfig(layout);

    const query: ProgressQuery = {
      ...(since === undefined ? {} : { since }),
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
    "show the journal timeline, newest last (--item covers the subtree; --since 7d|24h|ISO, --limit)",
  run: runProgress,
};

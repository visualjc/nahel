import { parseArgs } from "node:util";
import type { Command, CommandContext } from "../cli";
import type { JournalEvent } from "../schema/records";
import { readJournal } from "../store/journal";
import { openStore, readConfig, readRoadmapNodes } from "../store/layout";
import { isStandupEvent, renderStandup, resolveSince } from "../views/standup";
import { loadSnapshot } from "../views/snapshot";
import { UsageError } from "./item";

/**
 * `nahel standup --since <when>` (Phase 4 F4): the curated window over the
 * journal — what moved, what shipped, what parked, what got blocked, grouped by
 * roadmap node and item.
 *
 * STRICTLY a view, and the strictest one in the codebase: it creates zero new
 * state — no records, no events, no config — so `git status` is clean after it
 * runs. A thin I/O wrapper, exactly like `progress`: the store reads happen
 * here and the rendering is the pure function beside them.
 *
 * The window is resolved HERE, from `ctx.env.now()` and nothing else (ADR-0004,
 * hard constraint 1) — the view never sees a clock, only the resolved cutoff.
 */

const USAGE = "usage: nahel standup --since <7d|24h|ISO timestamp>";

function parseFlags(argv: string[]): { since: string } {
  let values: { since?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: { since: { type: "string" } },
      strict: true,
      allowPositionals: true,
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (positionals.length > 0) {
    throw new UsageError(`unexpected extra arguments: ${positionals.join(" ")}`);
  }
  if (values.since === undefined) {
    // No default window is invented: a standup is a report ABOUT a window, and
    // one nobody chose would put a number in the header that nobody meant.
    throw new UsageError("--since is required — give a window (7d, 24h) or an ISO timestamp");
  }
  return { since: values.since };
}

async function runStandup(argv: string[], ctx: CommandContext): Promise<number> {
  try {
    const flags = parseFlags(argv);
    // The window is resolved BEFORE the store is opened: a spec that names no
    // instant is refused with the reason it names none, and nothing is read or
    // printed on the way — never a header carrying an impossible year.
    const resolved = resolveSince(flags.since, ctx.env.now());
    if ("error" in resolved) {
      throw new UsageError(`invalid --since ${JSON.stringify(flags.since)} — ${resolved.error}`);
    }
    const since = resolved.since;
    const layout = await openStore(ctx.cwd);
    // Initialized-repo gate: a missing config errors with the `nahel init`
    // pointer instead of rendering a misleadingly quiet window.
    await readConfig(layout);

    // Only the acts a standup can read are kept while streaming — the
    // isRoadmapColumnEvent precedent, so a journal that outgrows memory still
    // renders. Acts before the window are kept too: they are the baseline a
    // transition inside it is measured against.
    const events: JournalEvent[] = [];
    for await (const event of readJournal(layout)) {
      if (isStandupEvent(event)) events.push(event);
    }
    const snapshot = await loadSnapshot(layout);
    ctx.stdout(
      renderStandup({
        since,
        nodes: await readRoadmapNodes(layout),
        items: snapshot.items,
        runs: snapshot.runs,
        events,
      }),
    );
    return 0;
  } catch (error) {
    ctx.stderr(`❌ ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof UsageError) ctx.stderr(USAGE);
    return 1;
  }
}

export const standupCommand: Command = {
  description:
    "show what moved in a time window, grouped by roadmap node and item (--since 7d|24h|ISO)",
  run: runStandup,
};

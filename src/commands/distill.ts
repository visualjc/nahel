import { parseArgs } from "node:util";
import type { Env } from "../schema/env";
import { appendEvent, listSegments } from "../store/journal";
import { addDistilled, readDistilled } from "../store/layout";
import { closeStoreContext } from "../store/mutate";
import { commandContext, execute, UsageError, type Command } from "./item";

/**
 * `nahel distill` (PRD F6.1): mark ARCHIVED journal segments as fully
 * distilled — union them into nahel/journal/distilled.json and journal the
 * act. Append/mark only, the F6 acceptance bar: no journal event is ever
 * edited or deleted, and re-running over already-distilled segments changes
 * nothing (no new entries, no new events). Only rotated segments qualify:
 * an active segment may still receive events, so "fully distilled" cannot
 * be claimed for it yet.
 */

const USAGE = `usage:
  nahel distill <segment-filename>...
    Mark archived journal segments (nahel/journal/archive/) as distilled.
    Refuses segments that are still active (not yet rotated) or unknown.`;

/** The open-extension event type recording a distill act. */
export const DISTILLED_EVENT_TYPE = "journal.distilled";

async function runDistill(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  if (positionals.length === 0) {
    throw new UsageError("distill takes at least one archived segment filename");
  }
  const names = [...new Set(positionals)].sort();

  const ctx = await commandContext(cwd, env, actorOverride);
  // Validate EVERY name before writing anything — no partial marking.
  const segments = await listSegments(ctx.layout);
  const active = new Set(segments.active);
  const archived = new Set(segments.archived);
  for (const name of names) {
    if (active.has(name)) {
      throw new UsageError(
        `segment ${name} is still active (not yet rotated) — only archived segments can be ` +
          "marked distilled; rotation archives it once its run ends or its session closes",
      );
    }
    if (!archived.has(name)) {
      throw new UsageError(
        `segment ${name} is not in the journal archive (nahel/journal/archive/) — check the name`,
      );
    }
  }

  const already = new Set(await readDistilled(ctx.layout));
  const toAdd = names.filter((name) => !already.has(name));
  if (toAdd.length === 0) {
    console.log(`already distilled: ${names.length} segment(s) — nothing to do`);
    return 0;
  }

  // Write-ahead like every state change: the act lands in the journal first,
  // then the distilled list is updated (a crash between the two is healed by
  // simply re-running distill — the union write is idempotent).
  await appendEvent(ctx.layout, ctx.env, {
    type: DISTILLED_EVENT_TYPE,
    actor: ctx.actor,
    session: ctx.session,
    payload: { segments: toAdd },
  });
  const { added } = await addDistilled(ctx.layout, toAdd);
  await closeStoreContext(ctx);
  console.log(`✅ distilled ${added.length} segment(s): ${added.join(", ")}`);
  return 0;
}

export const distillCommand: Command = {
  name: "distill",
  description:
    "mark archived journal segments as distilled (adds them to nahel/journal/distilled.json, journals the act)",
  run: (argv, env, cwd, actorOverride) =>
    execute("run `nahel distill --help` for usage", async () => {
      if (argv.includes("--help") || argv.includes("-h")) {
        console.log(USAGE);
        return 0;
      }
      return runDistill(argv, env, cwd, actorOverride);
    }),
};

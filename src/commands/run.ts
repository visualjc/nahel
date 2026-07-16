import { parseArgs } from "node:util";
import type { Env } from "../schema/env";
import { CORE_EVENT_TYPES } from "../schema/events";
import { generateId } from "../schema/id";
import { runSchema, type Run } from "../schema/records";
import { writeHotState } from "../store/hotstate";
import { readItem, readRun } from "../store/layout";
import { mutate, type StoreContext } from "../store/mutate";
import {
  commandContext,
  execute,
  requireExistingItem,
  requireValid,
  UsageError,
  type Command,
} from "./item";

/**
 * `nahel run` — the run-lifecycle write surface (PRD F3). Commands are thin:
 * parse argv → call the store. Run record mutations flow through the store's
 * mutate() choke point (actor resolution, claim refusal, write-ahead
 * journaling into the run's own segment); hot state (state.json, ADR-0012:
 * run-scoped) is written through the store's hotstate module after the
 * journaled record write, mirroring the run's current position.
 *
 * `run end` closes the run's journal segment by making it provably closed:
 * the run.ended event is the segment's final line and the record's
 * status=ended is what rotation checks before archiving.
 *
 * The Run record has no dedicated outcome field, so the outcome given to
 * `run end` is recorded as the run's final phase — durably carried by the
 * run.ended event payload — and echoed as `outcome` in hot state.
 */

/** Every run opens in this phase; workflows own the phases that follow. */
const INITIAL_PHASE = "starting";

const USAGE = `usage:
  nahel run start <item>
    Start a run for a work item and print the generated run id. Creates the
    run record and its hot state (state.json); the lane comes from the item
    and the initial phase is "${INITIAL_PHASE}".

  nahel run update <run> --phase <phase>
    Move an open run to a new phase (hot state follows). Phases are
    workflow-owned; an ended run cannot be updated.

  nahel run end <run> <outcome>
    Close the run: status becomes ended, the outcome (e.g. success, failure)
    is recorded as the run's final phase and in hot state, and the run's
    journal segment is closed (rotation may archive it).`;

/** Mirror the run's current position into its run-scoped state.json. */
function hotStateFor(run: Run, updated: string): Record<string, unknown> {
  return { phase: run.phase, status: run.status, updated };
}

async function readOpenRun(ctx: StoreContext, runId: string, closing: boolean): Promise<Run> {
  let run: Run;
  try {
    run = await readRun(ctx.layout, runId);
  } catch (error) {
    throw new UsageError(
      `run ${runId} not found — start one with \`nahel run start <item>\` (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  if (run.status === "ended") {
    throw new UsageError(
      closing
        ? `run ${runId} already ended at ${run.ended} — it cannot be closed twice`
        : `run ${runId} has ended — start a new run with \`nahel run start ${run.item}\``,
    );
  }
  return run;
}

async function runStart(args: string[], env: Env, cwd: string): Promise<number> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  if (positionals.length !== 1) {
    throw new UsageError("run start takes exactly one <item>");
  }
  const itemId = positionals[0]!;
  const ctx = await commandContext(cwd, env);
  await requireExistingItem(ctx.layout, itemId, "item");
  const { frontmatter: item } = await readItem(ctx.layout, itemId);

  const run: Run = {
    id: generateId(env),
    item: item.id,
    actor: ctx.actor,
    lane: item.lane,
    phase: INITIAL_PHASE,
    status: "active",
    started: env.now(),
  };
  await mutate(ctx, { target: "run", eventType: CORE_EVENT_TYPES.runStarted, run });
  await writeHotState(ctx.layout, run.id, hotStateFor(run, run.started));
  console.log(run.id);
  return 0;
}

async function runUpdate(args: string[], env: Env, cwd: string): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { phase: { type: "string" } },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    throw new UsageError("run update takes exactly one <run>");
  }
  const runId = positionals[0]!;
  if (values.phase === undefined) {
    throw new UsageError("run update requires --phase <phase>");
  }
  const phase = requireValid(runSchema.shape.phase, values.phase, "--phase");

  const ctx = await commandContext(cwd, env);
  const run = await readOpenRun(ctx, runId, false);
  const next: Run = { ...run, phase };
  await mutate(ctx, { target: "run", eventType: CORE_EVENT_TYPES.runUpdated, run: next });
  await writeHotState(ctx.layout, runId, hotStateFor(next, env.now()));
  return 0;
}

async function runEnd(args: string[], env: Env, cwd: string): Promise<number> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  if (positionals.length !== 2) {
    throw new UsageError("run end takes exactly <run> <outcome> (e.g. success, failure)");
  }
  const runId = positionals[0]!;
  const outcome = requireValid(runSchema.shape.phase, positionals[1], "outcome");

  const ctx = await commandContext(cwd, env);
  const run = await readOpenRun(ctx, runId, true);
  const ended = env.now();
  const closed: Run = { ...run, phase: outcome, status: "ended", ended };
  await mutate(ctx, { target: "run", eventType: CORE_EVENT_TYPES.runEnded, run: closed });
  await writeHotState(ctx.layout, runId, { ...hotStateFor(closed, ended), outcome });
  return 0;
}

export const runCommand: Command = {
  name: "run",
  description: "drive the run lifecycle (run start | run update --phase | run end)",
  run: (argv, env, cwd) =>
    execute("run `nahel run --help` for usage", async () => {
      const [sub, ...rest] = argv;
      if (sub === "--help" || sub === "-h" || rest.includes("--help") || rest.includes("-h")) {
        console.log(USAGE);
        return 0;
      }
      if (sub === "start") return runStart(rest, env, cwd);
      if (sub === "update") return runUpdate(rest, env, cwd);
      if (sub === "end") return runEnd(rest, env, cwd);
      throw new UsageError(
        sub === undefined
          ? "missing subcommand — expected `run start`, `run update` or `run end`"
          : `unknown subcommand ${JSON.stringify(sub)} — expected start, update or end`,
      );
    }),
};

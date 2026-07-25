import { parseArgs } from "node:util";
import {
  composeInvocation,
  resolveAgent,
  resolveRoute,
  type ComposedInvocation,
  type ResolvedRoute,
} from "../dispatch/invocation";
import {
  ROUTING_RESPONSIBILITIES,
  type RoutingResponsibility,
} from "../schema/enums";
import { DISPATCH_ENDED_EVENT_TYPE, DISPATCH_STARTED_EVENT_TYPE } from "../schema/events";
import type { Env } from "../schema/env";
import type { Run } from "../schema/records";
import { spawnDispatch } from "../store/dispatch";
import { appendEvent } from "../store/journal";
import { readConfig, readItem } from "../store/layout";
import { closeStoreContext, type StoreContext } from "../store/mutate";
import { commandContext, execute, requireExistingItem, UsageError, type Command } from "./item";
import { endRun, startRun } from "./run";

/**
 * `nahel dispatch` (PRD F1, ADR-0016): the deterministic mechanics of
 * launching a routed executor, and nothing else. It resolves the routing map
 * for a responsibility, composes the agent CLI's invocation (binary, model
 * flag, NAHEL_ACTOR, the `nahel brief` orientation preamble), spawns it, and
 * records the run — no planning, no scoring, no retry-on-judgment. The loop
 * and every judgment call live in the afk-run workflow a host agent executes;
 * the CLI never decides, only executes decided dispatches.
 *
 * Determinism holds (hard constraint 1): dispatch makes zero LLM calls and
 * needs zero API keys of its own. The agent CLI it spawns carries its own
 * credentials in the inherited environment, which nahel never reads.
 *
 * Ordering is deliberate. EVERY refusal — routing, agent kind, and the
 * compose-time ones (a model the agent spec has no flag for) — happens before
 * a single byte of state changes, so a misrouted dispatch journals nothing and
 * leaves no ghost run; the run then opens and the invocation is journaled
 * BEFORE the spawn (write-ahead), so a crash mid-run leaves the intent
 * provable; the run is closed with the worker's exit status.
 */

/** Phase a dispatched run opens in; the worker owns the phases that follow. */
const DISPATCH_PHASE = "dispatched";

/** Run outcomes recorded as the run's final phase (the `run end` vocabulary). */
const SUCCESS = "success";
const FAILURE = "failure";

/** Exit status a command runner uses for "binary not found". */
const NOT_FOUND_EXIT = 127;

const USAGE = `usage:
  nahel dispatch <responsibility> --item <id> -- <task args...>
    Spawn the agent CLI the routing map assigns to <responsibility>
    (${ROUTING_RESPONSIBILITIES.join(" | ")}), with the mapped model, the
    worker's own NAHEL_ACTOR identity, and an orientation preamble telling it
    to run \`nahel brief\` before acting. Everything after \`--\` is the task
    prompt, passed through untouched.
    --item is required: every dispatch belongs to a work item, and the
    dispatch opens and closes a run record for it.
    Exit status is 0 when the worker exited 0, 1 otherwise; the composed
    invocation and the outcome are journaled either way.`;

interface DispatchArgs {
  responsibility: RoutingResponsibility;
  item: string;
  task: string;
}

function requireResponsibility(value: string): RoutingResponsibility {
  if ((ROUTING_RESPONSIBILITIES as readonly string[]).includes(value)) {
    return value as RoutingResponsibility;
  }
  const known = ROUTING_RESPONSIBILITIES.join(", ");
  // The two routing keys that are not responsibilities: `default` is what an
  // unrouted responsibility falls back TO, and `review2` names the review
  // loop's second reviewer slot — a slot the loop's driver fills under its own
  // actor, so nothing ever spawns it (PRD F3.1, ADR-0015's enum discipline).
  if (value === "default" || value === "review2") {
    const role =
      value === "default"
        ? "an unrouted responsibility falls back to routing.default"
        : "routing.review2 names the review loop's second reviewer slot, which its driver fills itself";
    throw new UsageError(
      `"${value}" is a routing map KEY, not a dispatchable responsibility — ` +
        `dispatch one of: ${known} (${role})`,
    );
  }
  throw new UsageError(
    `unknown responsibility ${JSON.stringify(value)} — expected one of: ${known}`,
  );
}

/**
 * Split argv at `--`: everything before belongs to nahel, everything after is
 * the worker's task, untouched. Splitting BEFORE parsing is what keeps a
 * task's own flags (`--item`, `--model`, even `--help`) out of nahel's own
 * option handling.
 */
function splitArgv(argv: string[]): { own: string[]; task: string[] } {
  const separator = argv.indexOf("--");
  return separator === -1
    ? { own: argv, task: [] }
    : { own: argv.slice(0, separator), task: argv.slice(separator + 1) };
}

function parseDispatchArgs(argv: string[]): DispatchArgs {
  const { own, task } = splitArgv(argv);
  const { values, positionals } = parseArgs({
    args: own,
    options: { item: { type: "string" } },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    throw new UsageError(
      `dispatch takes exactly one <responsibility> — got ${positionals.length} positional argument(s)`,
    );
  }
  const responsibility = requireResponsibility(positionals[0]!);
  if (task.length === 0) {
    throw new UsageError(
      "dispatch needs a task: everything after `--` is the prompt handed to the worker " +
        "(e.g. `nahel dispatch implementation --item <id> -- implement the parser`)",
    );
  }
  // Every dispatch belongs to a work item: F1.1's acceptance is a correctly
  // attributed RUN record, and a run needs an item. There is no itemless
  // dispatch in the AFK loop, so the itemless form is a usage error rather
  // than a dispatch nothing can be attributed to.
  if (values.item === undefined) {
    throw new UsageError(
      "dispatch needs --item <id>: every dispatch belongs to a work item, and the run " +
        "it opens is how the work is attributed (e.g. `nahel dispatch implementation " +
        "--item <id> -- implement the parser`)",
    );
  }
  return { responsibility, item: values.item, task: task.join(" ") };
}

/** Journal the intent, carrying the invocation exactly as it will be spawned. */
async function journalStart(
  ctx: StoreContext,
  args: DispatchArgs,
  route: ResolvedRoute,
  invocation: ComposedInvocation,
  run: Run,
): Promise<void> {
  await appendEvent(ctx.layout, ctx.env, {
    type: DISPATCH_STARTED_EVENT_TYPE,
    actor: ctx.actor,
    run: run.id,
    item: args.item,
    payload: {
      responsibility: route.responsibility,
      agent: route.agent,
      ...(route.model === undefined ? {} : { model: route.model }),
      via: route.via,
      invocation: {
        binary: invocation.binary,
        args: invocation.args,
        env: invocation.env,
      },
    },
  });
}

async function journalEnd(
  ctx: StoreContext,
  args: DispatchArgs,
  route: ResolvedRoute,
  run: Run,
  outcome: { outcome: string; exit_code?: number; error?: string },
): Promise<void> {
  await appendEvent(ctx.layout, ctx.env, {
    type: DISPATCH_ENDED_EVENT_TYPE,
    actor: ctx.actor,
    run: run.id,
    item: args.item,
    payload: { responsibility: route.responsibility, agent: route.agent, ...outcome },
  });
}

async function runDispatch(
  argv: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const args = parseDispatchArgs(argv);

  // Resolution first: every refusal below happens before a single byte of
  // state changes, so a misrouted dispatch is inert (no run, no events).
  const ctx = await commandContext(cwd, env, actorOverride);
  const config = await readConfig(ctx.layout);
  const route = resolveRoute(config.routing, args.responsibility);
  const spec = resolveAgent(route.agent, config.dispatch);

  // Composition can refuse too (a route naming a model the agent spec has no
  // flag for is schema-valid but unspawnable), and its refusals must land with
  // the rest — BEFORE any state changes. Composition is pure, so probing it
  // with the same inputs minus the item/run fires every compose-time refusal
  // while the store is still untouched; a ghost run with nothing spawned would
  // break the "a misrouted dispatch is inert" contract.
  composeInvocation({
    responsibility: args.responsibility,
    agent: route.agent,
    model: route.model,
    spec,
    task: args.task,
  });

  await requireExistingItem(ctx.layout, args.item, "--item");
  const { frontmatter: item } = await readItem(ctx.layout, args.item);
  // The run belongs to the EXECUTOR, not to the dispatching session: its
  // actor is the routed agent, while the dispatch events stay attributed to
  // whoever dispatched. Claim enforcement runs here (store mutate), so a
  // claimed item refuses the dispatch before anything is spawned.
  const run = await startRun(ctx, item, {
    actor: { kind: "agent", id: route.agent },
    phase: DISPATCH_PHASE,
  });

  const invocation = composeInvocation({
    responsibility: args.responsibility,
    agent: route.agent,
    model: route.model,
    spec,
    task: args.task,
    item: args.item,
    run: run.id,
  });

  // Write-ahead: the invocation is journaled before the child exists, so the
  // record of what was dispatched survives any crash during the run.
  await journalStart(ctx, args, route, invocation, run);

  let result;
  try {
    result = await spawnDispatch({
      binary: invocation.binary,
      args: invocation.args,
      actorSpec: invocation.env.NAHEL_ACTOR,
      cwd,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await journalEnd(ctx, args, route, run, { outcome: FAILURE, error: message });
    await endRun(ctx, run, FAILURE);
    throw error;
  }

  if (result.stdout !== "") console.log(result.stdout.trimEnd());
  if (result.stderr !== "") console.error(result.stderr.trimEnd());

  const outcome = result.exitCode === 0 ? SUCCESS : FAILURE;
  await journalEnd(ctx, args, route, run, { outcome, exit_code: result.exitCode });
  await endRun(ctx, run, outcome);
  await closeStoreContext(ctx);

  const where = ` (run ${run.id})`;
  const model = route.model === undefined ? "" : ` on ${route.model}`;
  if (outcome === SUCCESS) {
    console.log(`✅ dispatched ${args.responsibility} → ${route.agent}${model}${where}`);
    return 0;
  }
  console.error(
    `❌ ${route.agent} exited ${result.exitCode} for ${args.responsibility}${where}` +
      (result.exitCode === NOT_FOUND_EXIT
        ? ` — exit ${NOT_FOUND_EXIT} usually means the agent binary was not found: ` +
          `check config.dispatch.${route.agent}.binary`
        : ""),
  );
  return 1;
}

export const dispatchCommand: Command = {
  name: "dispatch",
  description:
    "spawn the agent CLI routing assigns to a responsibility (composed invocation + run record, journaled)",
  run: (argv, env, cwd, actorOverride) =>
    execute("run `nahel dispatch --help` for usage", async () => {
      // Only nahel's own half of argv can ask for help; a task prompt that
      // happens to contain --help is the worker's business.
      const { own } = splitArgv(argv);
      if (own.includes("--help") || own.includes("-h")) {
        console.log(USAGE);
        return 0;
      }
      return runDispatch(argv, env, cwd, actorOverride);
    }),
};

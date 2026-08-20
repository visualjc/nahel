import { parseArgs } from "node:util";
import {
  composeInvocation,
  resolveAgent,
  resolveReviewSlotRoute,
  resolveRoute,
  REVIEW_SLOTS,
  type ComposedInvocation,
  type ResolvedRoute,
  type ReviewSlot,
} from "../dispatch/invocation";
import {
  ROUTING_RESPONSIBILITIES,
  type RoutingResponsibility,
} from "../schema/enums";
import { DISPATCH_ENDED_EVENT_TYPE, DISPATCH_STARTED_EVENT_TYPE } from "../schema/events";
import type { Env } from "../schema/env";
import type { Config, Run } from "../schema/records";
import { spawnDispatch } from "../store/dispatch";
import { runContractHealthcheck } from "../store/healthcheck";
import { appendEvent } from "../store/journal";
import { readConfig, readItem, readRun } from "../store/layout";
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
 *
 * Closing is conditional, though (PRD F6): the run and item records are re-read
 * AFTER the worker exits, because a human's `nahel pause` or `nahel claim`
 * lands DURING the spawn — the very window an intervention is for. Closing from
 * the pre-spawn run object would overwrite that state with `ended` and erase
 * the intervention. Under one, the worker's outcome is still journaled and the
 * run record is left exactly as the human set it.
 */

/** Phase a dispatched run opens in; the worker owns the phases that follow. */
const DISPATCH_PHASE = "dispatched";

/** Run outcomes recorded as the run's final phase (the `run end` vocabulary). */
const SUCCESS = "success";
const FAILURE = "failure";

/** Exit status a command runner uses for "binary not found". */
const NOT_FOUND_EXIT = 127;

/** Where the per-vendor unattended sandbox recipes live, quoted in the refusal. */
const SANDBOX_DOC = "nahel/workflows/setup-routing.md";

/**
 * What the preflight did, journaled with the dispatch so a later reader can
 * tell a probed run from an unprobed one: the gate passed, a human waved it
 * through with `--no-preflight`, or there was nothing to probe (no contract
 * healthcheck). Three values rather than a bare flag because "passed" and
 * "never ran" are different facts about a run that later failed.
 */
type PreflightVerdict = "passed" | "skipped" | "none";

const USAGE = `usage:
  nahel dispatch <responsibility> [--slot 2] --item <id> -- <task args...>
    Spawn the agent CLI the routing map assigns to <responsibility>
    (${ROUTING_RESPONSIBILITIES.join(" | ")}), with the mapped model, the
    worker's own NAHEL_ACTOR identity, and an orientation preamble telling it
    to run \`nahel brief\` before acting. Everything after \`--\` is the task
    prompt, passed through untouched.
    --item is required: every dispatch belongs to a work item, and the
    dispatch opens and closes a run record for it.
    --slot <${REVIEW_SLOTS.join("|")}> applies to \`review\` only: it names which
    reviewer slot to fill, resolving through that slot's routing chain
    (slot 2: routing.review2, then implementation, then default) so any
    capable vendor can drive the review loop.
    Before spawning, dispatch PREFLIGHTS the environment: it runs the run
    contract's healthcheck (doctor's own probe) in the store root, and
    refuses when it fails — a dispatcher under a too-restrictive agent
    sandbox hands that sandbox to the worker, whose failures then look like
    anything but the cause. See "Unattended sandbox flags" in
    ${SANDBOX_DOC}.
    --no-preflight dispatches without probing; the skip is journaled.
    Exit status is 0 when the worker exited 0, 1 otherwise; the composed
    invocation and the outcome are journaled either way.`;

interface DispatchArgs {
  responsibility: RoutingResponsibility;
  item: string;
  task: string;
  /** Reviewer slot to fill (`review` only); undefined is the plain route. */
  slot?: ReviewSlot;
  /** `--no-preflight`: dispatch without probing the environment first. */
  noPreflight: boolean;
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
        : "routing.review2 names the review loop's second reviewer slot — " +
          "fill it with `nahel dispatch review --slot 2`";
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

/**
 * `--slot` names a REVIEW slot and nothing else: slots are the review loop's
 * two-reviewer structure (PRD F3.1), so a slot on `implementation` is a
 * misunderstanding worth refusing rather than silently ignoring.
 */
function requireSlot(value: string, responsibility: RoutingResponsibility): ReviewSlot {
  if (responsibility !== "review") {
    throw new UsageError(
      `--slot applies to the \`review\` responsibility only — reviewer slots are the review ` +
        `loop's structure, and "${responsibility}" has none. Drop --slot, or dispatch review.`,
    );
  }
  const slot = REVIEW_SLOTS.find((known) => String(known) === value);
  if (slot === undefined) {
    throw new UsageError(
      `unknown review slot ${JSON.stringify(value)} — expected one of: ` +
        `${REVIEW_SLOTS.join(", ")} (slot 1 is the review route, slot 2 the second reviewer)`,
    );
  }
  return slot;
}

function parseDispatchArgs(argv: string[]): DispatchArgs {
  const { own, task } = splitArgv(argv);
  const { values, positionals } = parseArgs({
    args: own,
    options: {
      item: { type: "string" },
      slot: { type: "string" },
      "no-preflight": { type: "boolean" },
    },
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
  const slot = values.slot === undefined ? undefined : requireSlot(values.slot, responsibility);
  return {
    responsibility,
    item: values.item,
    task: task.join(" "),
    noPreflight: values["no-preflight"] === true,
    ...(slot === undefined ? {} : { slot }),
  };
}

/** The preflight found the environment too restrictive to dispatch into. */
class DispatchPreflightError extends Error {}

/**
 * Sandbox preflight (chore f35q1rax): prove the environment can actually run
 * this project's own commands BEFORE a worker is spawned into it.
 *
 * The failure this exists for: a dispatcher running under an agent CLI's
 * sandbox hands that sandbox to everything it spawns — the worker, and every
 * command the worker runs. The field report is codex's sandbox blocking `ps`,
 * which fails nahel's pgid healthcheck; the run then dies of strange
 * downstream errors from a worker nobody suspected was caged.
 *
 * What this can honestly check is the DISPATCHING context, not the vendor
 * CLI's own internal sandbox: running the probe "inside the invocation the
 * worker gets" would mean spawning the agent CLI and paying an LLM call to ask
 * it, which dispatch may never do (hard constraint 1 — zero LLM calls, zero
 * API keys). So the probe runs here, in the store root, under the environment
 * the child inherits: everything the worker's subprocesses face at minimum. A
 * sandbox that blocks `ps` for this process blocks it for the worker too.
 *
 * The probe itself is the run contract's healthcheck — doctor's machinery
 * (store/healthcheck.ts), not a second opinion — so the two commands can never
 * disagree about whether this machine is fit to run the project.
 */
async function preflight(
  config: Config,
  root: string,
  skip: boolean,
): Promise<PreflightVerdict> {
  if (skip) {
    // Advisory doctrine: a deliberate override is permitted, never silent.
    console.error(
      `⚠ preflight skipped (--no-preflight): dispatching without proving the run contract's ` +
        `healthcheck can run here. If the worker fails in confusing ways, re-run without the ` +
        `flag to see whether the environment is the cause.`,
    );
    return "skipped";
  }
  const contract = config.contract;
  // No contract, or a contract with no healthcheck: nothing to probe. The gate
  // is not a reason to require a contract — dispatch predates F2's, and a
  // project that has not defined one is not thereby suspected of a sandbox.
  if (contract === undefined) return "none";
  const result = await runContractHealthcheck(contract, root);
  if (result === undefined) return "none";
  if (result.ok) return "passed";

  const what = result.timedOut
    ? `timed out after ${result.timeoutSeconds}s`
    : `failed (exit ${result.exitCode ?? "unknown"})`;
  throw new DispatchPreflightError(
    `preflight: the run contract's healthcheck ${what} here — \`${result.command}\`. ` +
      `Nothing was spawned: a worker started in this environment inherits it, and would ` +
      `fail downstream in ways that look like anything but the real cause.\n` +
      `If that healthcheck passes when you run it by hand, the process dispatching is ` +
      `probably under an agent CLI's sandbox (codex's default sandbox blocks \`ps\`, which ` +
      `fails a pgid healthcheck). Give the dispatching CLI — and the routed agents — the ` +
      `unattended sandbox flags for their vendor: see "Unattended sandbox flags" in ` +
      `${SANDBOX_DOC}.\n` +
      `To dispatch anyway, re-run with --no-preflight (the skip is journaled).`,
  );
}

/** Journal the intent, carrying the invocation exactly as it will be spawned. */
async function journalStart(
  ctx: StoreContext,
  args: DispatchArgs,
  route: ResolvedRoute,
  invocation: ComposedInvocation,
  run: Run,
  preflightVerdict: PreflightVerdict,
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
      ...(args.slot === undefined ? {} : { slot: args.slot }),
      via: route.via,
      // What the environment probe found — or that it was waved through.
      preflight: preflightVerdict,
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
  outcome: { outcome: string; exit_code?: number; signal?: string; error?: string },
): Promise<void> {
  await appendEvent(ctx.layout, ctx.env, {
    type: DISPATCH_ENDED_EVENT_TYPE,
    actor: ctx.actor,
    run: run.id,
    item: args.item,
    payload: { responsibility: route.responsibility, agent: route.agent, ...outcome },
  });
}

/** A human's mid-run intervention, as the records read AFTER the worker exits. */
interface Intervention {
  kind: "paused" | "claimed";
  claimedBy?: string;
}

/**
 * What a human reached in and did while the worker was running, if anything
 * (PRD F6). Read AFTER the spawn, never from the pre-spawn objects: `nahel
 * pause` and `nahel claim` land in the window dispatch is blocked in, and
 * closing the run from the stale object would overwrite exactly the state the
 * human set — erasing the intervention with the dispatch it was meant to stop.
 *
 * Tolerant, like every read on an exit path: a record that will not parse
 * comes back as "no intervention" rather than turning a finished worker into a
 * crash. The pre-spawn behaviour is then what it always was.
 */
async function readIntervention(
  ctx: StoreContext,
  itemId: string,
  runId: string,
): Promise<Intervention | undefined> {
  const claimedBy = await readItem(ctx.layout, itemId).then(
    (read) => read.frontmatter.claimed_by,
    () => undefined,
  );
  // A claim covers the subtree and pauses the runs under it, so it is the more
  // specific finding: report it as a claim, with the claimant named.
  if (claimedBy !== undefined) return { kind: "claimed", claimedBy };
  const current = await readRun(ctx.layout, runId).then(
    (run) => run,
    () => undefined,
  );
  return current?.status === "paused" ? { kind: "paused" } : undefined;
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
  // A slot dispatch is the SAME responsibility down a different chain, so the
  // enum stays one `review` (ADR-0015) while either reviewer can be spawned.
  // Plain `review` IS slot 1: every review dispatch walks the slot chains, so
  // dispatch, the review loop, and the same-vendor warning can never disagree
  // about what a review route resolves to (a model-only routing.review falls
  // through to default here exactly as it does in the warning's resolution).
  const route =
    args.responsibility === "review"
      ? resolveReviewSlotRoute(config.routing, args.slot ?? 1)
      : resolveRoute(config.routing, args.responsibility);
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
  });

  await requireExistingItem(ctx.layout, args.item, "--item");

  // Last of the refusals, and still before any state changes: the probe costs
  // a subprocess, so it runs after the free checks — but a refused preflight
  // must leave the store as inert as a misrouted dispatch does.
  const preflightVerdict = await preflight(config, ctx.layout.root, args.noPreflight);

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
    item: args.item,
    run: run.id,
  });

  // Write-ahead: the invocation is journaled before the child exists, so the
  // record of what was dispatched survives any crash during the run.
  await journalStart(ctx, args, route, invocation, run, preflightVerdict);

  let result;
  try {
    result = await spawnDispatch({
      binary: invocation.binary,
      args: invocation.args,
      actorSpec: invocation.env.NAHEL_ACTOR,
      // The worker starts in the REPO being worked on, never in whatever
      // subdirectory the dispatcher stood in: its prompt and its own `nahel`
      // commands are root-relative (ADR-0016).
      cwd: ctx.layout.root,
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
  const intervention = await readIntervention(ctx, args.item, run.id);
  // The worker's outcome is journaled either way — the trail must show what it
  // did — but under an intervention the RUN RECORD is left as the human set
  // it: paused, claimed, and visible to `nahel status` as work someone took
  // over. (`nahel run end` would be refused under a claim anyway; events are
  // claim-exempt, which is why the dispatch.ended still lands.)
  await journalEnd(ctx, args, route, run, {
    outcome,
    exit_code: result.exitCode,
    // A worker that died to a signal never chose an exit status: the signal
    // IS the outcome, journaled so the bracket closes honestly (evqagdsd).
    ...(result.signal === undefined ? {} : { signal: result.signal }),
    ...(intervention === undefined
      ? {}
      : {
          intervention: intervention.kind,
          ...(intervention.claimedBy === undefined ? {} : { claimed_by: intervention.claimedBy }),
        }),
  });
  if (intervention === undefined) await endRun(ctx, run, outcome);
  await closeStoreContext(ctx);

  if (intervention !== undefined) {
    const who = intervention.claimedBy === undefined ? "" : ` by ${intervention.claimedBy}`;
    console.error(
      `⏸ intervention during the run: ${args.item} was ${intervention.kind}${who} while ` +
        `${route.agent} was working. The worker exited ${result.exitCode}; its outcome is ` +
        `journaled, and run ${run.id} is left as the human set it rather than ended. ` +
        `Stand down on this item and journal what the worker did ` +
        `(nahel/workflows/afk-run.md step 3).`,
    );
  }

  const where = ` (run ${run.id})`;
  const model = route.model === undefined ? "" : ` on ${route.model}`;
  const what = args.slot === undefined
    ? args.responsibility
    : `${args.responsibility} slot ${args.slot}`;
  if (outcome === SUCCESS) {
    console.log(`✅ dispatched ${what} → ${route.agent}${model}${where}`);
    return 0;
  }
  console.error(
    result.signal !== undefined
      ? `❌ ${route.agent} was killed by ${result.signal} for ${what}${where} — the worker ` +
          `died before finishing; its output and the dispatch bracket are journaled`
      : `❌ ${route.agent} exited ${result.exitCode} for ${what}${where}` +
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

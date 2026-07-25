import {
  DISPATCH_AGENT_KINDS,
  type DispatchAgentKind,
  type RoutingResponsibility,
} from "../schema/enums";
import type { Dispatch, DispatchAgent, Routing } from "../schema/records";

/**
 * Dispatch invocation composition (PRD F1.1–F1.3, ADR-0015/0016): the pure
 * half of `nahel dispatch`. Routing resolution, per-agent-CLI invocation
 * knowledge, and the composed argv/prompt are deterministic functions of
 * committed config plus the task args — no I/O, no clock, no LLM call. That
 * purity is what makes the invocation recorded with a dispatch PROVABLE:
 * the same config and task compose the same bytes on every machine.
 *
 * The install/agents.ts precedent applies: the table is data, the command
 * owns the I/O.
 */

/** A routing map named an agent CLI dispatch has no invocation knowledge for. */
export class UnknownAgentKindError extends Error {}

/** Routing could not produce a spawnable {agent, model} for a responsibility. */
export class DispatchRoutingError extends Error {}

/**
 * Shipped invocation defaults for every known agent kind (F1.3). Each is the
 * agent CLI's real headless form: a prompt passed as the trailing argument,
 * the model on the CLI's own flag.
 *
 * - `claude -p --model <model> <prompt>` (Claude Code's print mode)
 * - `codex exec --model <model> <prompt>` (Codex's non-interactive subcommand)
 * - `cursor-agent -p --model <model> <prompt>` (cursor-agent's print mode)
 *
 * A deployment whose binary lives elsewhere, or that wants standing flags,
 * overrides the whole entry in `config.dispatch` — data, never a code change
 * (ADR-0016 addendum, 2026-07-25).
 */
export const DISPATCH_AGENT_DEFAULTS: Record<DispatchAgentKind, DispatchAgent> = {
  claude: { binary: "claude", args: ["-p"], model_flag: "--model" },
  codex: { binary: "codex", args: ["exec"], model_flag: "--model" },
  "cursor-agent": { binary: "cursor-agent", args: ["-p"], model_flag: "--model" },
};

/** The orientation every dispatched worker is told to run before acting. */
export const ORIENTATION_COMMAND = "nahel brief";

/** What routing resolved to, and which config key it came from. */
export interface ResolvedRoute {
  responsibility: RoutingResponsibility;
  agent: string;
  model: string | undefined;
  /** The config key that answered — `routing.<responsibility>` or `routing.default`. */
  via: string;
}

/** Render the `nahel config set` command that fixes a missing route. */
function routingFix(routing: Routing | undefined, responsibility: RoutingResponsibility): string {
  // `config set` REPLACES the whole section, so the offered fix carries every
  // entry already configured — pasting it must never silently drop routes.
  const proposed: Record<string, unknown> = { ...routing };
  proposed[responsibility] = { agent: `<${DISPATCH_AGENT_KINDS.join("|")}>`, model: "<model>" };
  return `nahel config set routing --data '${JSON.stringify(proposed)}'`;
}

/**
 * Resolve a responsibility to a spawnable {agent, model} (F1.2, ADR-0015's
 * fallback chain): the responsibility-specific entry first, then the
 * configured default. Resolving through NEITHER fails loudly with the exact
 * config fix — there is no silent fallback to whatever agent is handy. An
 * entry that names only a model is equally unspawnable and refused the same
 * way; a missing model is fine (the agent CLI's own default applies).
 */
export function resolveRoute(
  routing: Routing | undefined,
  responsibility: RoutingResponsibility,
): ResolvedRoute {
  const specific = routing?.[responsibility];
  const entry = specific ?? routing?.default;
  const via = specific === undefined ? "routing.default" : `routing.${responsibility}`;
  if (entry === undefined) {
    throw new DispatchRoutingError(
      `no route for responsibility "${responsibility}": nahel/config has neither ` +
        `routing.${responsibility} nor routing.default — ` +
        `fix: ${routingFix(routing, responsibility)}`,
    );
  }
  if (entry.agent === undefined) {
    throw new DispatchRoutingError(
      `route ${via} names a model but no agent — dispatch needs an agent CLI to spawn — ` +
        `fix: ${routingFix(routing, responsibility)}`,
    );
  }
  return { responsibility, agent: entry.agent, model: entry.model, via };
}

/**
 * Resolve an agent kind to its invocation spec (F1.3): the shipped default,
 * replaced wholesale by `config.dispatch.<kind>` when present. A kind nahel
 * has no invocation knowledge for is refused HERE as well as by the schema —
 * routing's `agent` is a free string, so dispatch is the second gate.
 */
export function resolveAgent(agent: string, overrides: Dispatch | undefined): DispatchAgent {
  if (!(DISPATCH_AGENT_KINDS as readonly string[]).includes(agent)) {
    throw new UnknownAgentKindError(
      `unknown agent kind ${JSON.stringify(agent)} — dispatch knows how to invoke: ` +
        `${DISPATCH_AGENT_KINDS.join(", ")}. Fix the routing map, or teach nahel the CLI ` +
        `(a schema change: schema/enums.ts DISPATCH_AGENT_KINDS + its invocation default)`,
    );
  }
  const kind = agent as DispatchAgentKind;
  return overrides?.[kind] ?? DISPATCH_AGENT_DEFAULTS[kind];
}

/** Everything composition needs; all of it committed state or argv. */
export interface ComposeInput {
  responsibility: RoutingResponsibility;
  /** Agent kind (the routing map's `agent`) — becomes the worker's actor id. */
  agent: string;
  model: string | undefined;
  spec: DispatchAgent;
  /** The task the worker was dispatched to do (everything after `--`). */
  task: string;
  /** Work item the dispatch is for, when one was named. */
  item?: string;
  /** Run record opened for this dispatch, when an item was named. */
  run?: string;
}

/** The invocation as recorded and as spawned — the argv is the contract. */
export interface ComposedInvocation {
  binary: string;
  /** Base args, the model flag when one applies, and the prompt LAST. */
  args: string[];
  /** The one environment addition: the worker's own actor identity. */
  env: { NAHEL_ACTOR: string };
  /** The prompt (orientation preamble + task); also `args`' final entry. */
  prompt: string;
}

/**
 * The orientation preamble (F1.1): the mechanical half of the worker's
 * contract — run `nahel brief` BEFORE acting, mutate only through the CLI,
 * and (when the dispatch is item-scoped) which item and run to record
 * against. It leads the prompt deliberately: an agent reads top-down, and
 * orientation that trails the task is orientation that arrives too late.
 * Keeping it here rather than in workflow prose is what makes it
 * unforgettable and auditable.
 */
export function orientationPreamble(input: ComposeInput, actorSpec: string): string {
  const lines = [
    `You are a worker dispatched by nahel for the "${input.responsibility}" responsibility.`,
    `You are acting as ${actorSpec}: NAHEL_ACTOR is already set, so every state change you` +
      ` make through the nahel CLI is attributed to you.`,
    `Before acting on the task below, run \`${ORIENTATION_COMMAND}\` in this repository and` +
      ` follow it — it is your orientation.`,
    "Mutate project state only through the nahel CLI; never hand-edit state files.",
  ];
  if (input.item !== undefined) {
    lines.push(`Work item: ${input.item}.`);
  }
  if (input.run !== undefined) {
    lines.push(`Record progress on your run with \`nahel run update ${input.run} --phase <phase>\`.`);
  }
  return lines.join("\n");
}

/**
 * Compose the invocation: base args, the model flag when the route names a
 * model, and the prompt as the trailing argument. A route that names a model
 * the agent spec has no flag for is refused rather than silently dropped —
 * dispatching to the wrong model is worse than not dispatching.
 */
export function composeInvocation(input: ComposeInput): ComposedInvocation {
  const actorSpec = `agent:${input.agent}`;
  const prompt = `${orientationPreamble(input, actorSpec)}\n\nTask:\n${input.task}`;
  const args = [...input.spec.args];
  if (input.model !== undefined) {
    if (input.spec.model_flag === undefined) {
      throw new DispatchRoutingError(
        `routing asks for model ${JSON.stringify(input.model)} but the ${input.agent} invocation ` +
          `config sets no model_flag — add one (\`nahel config set dispatch …\`) or drop the model ` +
          `from the routing entry`,
      );
    }
    args.push(input.spec.model_flag, input.model);
  }
  args.push(prompt);
  return { binary: input.spec.binary, args, env: { NAHEL_ACTOR: actorSpec }, prompt };
}

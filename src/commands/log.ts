import { parseArgs } from "node:util";
import type { Command, CommandContext } from "../cli";
import { CORE_EVENT_TYPES, MUTATION_EVENT_TYPES } from "../schema/events";
import { NAHEL_ACTOR_VAR, resolveActor } from "../store/actor";
import {
  appendEvent,
  closeSession,
  newSessionSegmentId,
  SESSION_CLOSED_EVENT_TYPE,
} from "../store/journal";
import { itemExists, readConfig, readRun, storeLayout } from "../store/layout";
import { MUTATION_PAYLOAD_KEYS } from "../store/mutate";
import { rotateJournal } from "../store/rotate";

/**
 * `nahel log` (PRD F4): append a typed journal event — an *observation about
 * work* (test failed, decision made, assumption logged, …), as opposed to
 * mutations, which self-record through the store's mutate() choke point.
 * Thin over the store's appendEvent: run-ref'd events land in that run's
 * segment; non-run events land in a writer-scoped session segment minted for
 * this invocation (merge-safe random ID, the file created on first append —
 * no two writers ever share an active segment). The core event-type set is
 * open: unknown types are logged but flagged distinctly.
 */

const USAGE = "usage: nahel log <type> [--item <id>] [--run <id>] [--data <json|key=val>]";

/**
 * Commands never read the process environment (store purity contract), so the
 * NAHEL_ACTOR override *value* arrives on the context: the entry point reads
 * the variable and passes it down. A plain CommandContext (no override) is
 * structurally valid — resolution then falls back to the config actor entry.
 */
export interface LogCommandContext extends CommandContext {
  /** Value of the NAHEL_ACTOR environment variable, read at the entry point. */
  actorOverride?: string;
}

/** A user-input error: reported with the usage line appended. */
class UsageError extends Error {}

const CORE_TYPE_SET = new Set<string>(Object.values(CORE_EVENT_TYPES));

interface LogFlags {
  type: string;
  item?: string;
  run?: string;
  data: string[];
}

function parseFlags(argv: string[]): LogFlags {
  let values: { item?: string; run?: string; data?: string[] };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        item: { type: "string" },
        run: { type: "string" },
        data: { type: "string", multiple: true },
      },
      strict: true,
      allowPositionals: true,
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const [type, ...extra] = positionals;
  if (type === undefined || type === "") {
    throw new UsageError("missing event type");
  }
  if (extra.length > 0) {
    throw new UsageError(`unexpected extra arguments: ${extra.join(" ")}`);
  }
  if (type === SESSION_CLOSED_EVENT_TYPE) {
    throw new UsageError(
      `event type ${SESSION_CLOSED_EVENT_TYPE} is reserved — the store appends it when a session segment closes`,
    );
  }
  if (MUTATION_EVENT_TYPES.has(type)) {
    throw new UsageError(
      `event type ${type} is a core mutation type — mutations self-record through ` +
        "`nahel item`/`nahel run`; log is for observations about work",
    );
  }
  return {
    type,
    ...(values.item === undefined ? {} : { item: values.item }),
    ...(values.run === undefined ? {} : { run: values.run }),
    data: values.data ?? [],
  };
}

/**
 * Build the event payload from --data entries, merged left to right. Each
 * entry is either a JSON object or key=val (the value JSON-parsed when it is
 * valid JSON — numbers, booleans, quoted strings — else taken literally).
 */
function parsePayload(entries: string[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (trimmed.startsWith("{")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        throw new UsageError(
          `invalid --data JSON ${JSON.stringify(entry)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      Object.assign(payload, parsed as Record<string, unknown>);
    } else {
      const separator = trimmed.indexOf("=");
      if (separator <= 0) {
        throw new UsageError(
          `invalid --data ${JSON.stringify(entry)} — expected a JSON object or key=value`,
        );
      }
      const key = trimmed.slice(0, separator);
      const raw = trimmed.slice(separator + 1);
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
      payload[key] = value;
    }
  }
  // The store's replay machinery reads target/record/body from mutation
  // event payloads; banned here at top level so a logged observation can
  // never masquerade as a mutation (nested occurrences are plain data).
  for (const key of MUTATION_PAYLOAD_KEYS) {
    if (key in payload) {
      throw new UsageError(
        `--data key ${JSON.stringify(key)} is reserved for mutation payloads — ` +
          "mutations self-record through `nahel item`/`nahel run`",
      );
    }
  }
  return payload;
}

async function runLog(argv: string[], ctx: LogCommandContext): Promise<number> {
  try {
    const flags = parseFlags(argv);
    const payload = parsePayload(flags.data);

    const layout = storeLayout(ctx.cwd);
    // Identity comes from the config actor entry or the NAHEL_ACTOR override —
    // resolution failures (including a missing config) are hard errors with
    // the fix spelled out by the store.
    const config = await readConfig(layout);
    const actor = resolveActor(config.actor, ctx.actorOverride);

    // Refs are validated before anything is written.
    if (flags.item !== undefined && !(await itemExists(layout, flags.item))) {
      throw new Error(
        `--item ${flags.item} does not reference an existing work item — check the id`,
      );
    }
    if (flags.run !== undefined) {
      await readRun(layout, flags.run); // throws "run <id> not found" with the path
    }

    // Segment resolution: run events join the run's segment; non-run events
    // get this invocation's own writer-scoped session segment.
    const session = flags.run === undefined ? newSessionSegmentId(ctx.env) : undefined;
    const event = await appendEvent(layout, ctx.env, {
      type: flags.type,
      actor,
      ...(flags.run === undefined ? { session: session! } : { run: flags.run }),
      ...(flags.item === undefined ? {} : { item: flags.item }),
      payload,
    });

    // The per-invocation session segment is single-use by design: close it so
    // it becomes rotation-eligible, then run the opportunistic sweep (PRD F1:
    // rotation/archiving enforced by the CLI). The sweep is bounded (one pass
    // over active segments), deterministic, and silent when nothing is
    // eligible; run segments stay untouched until their run has ended.
    if (session !== undefined) {
      await closeSession(layout, ctx.env, actor, session);
    }
    await rotateJournal(layout);

    if (!CORE_TYPE_SET.has(flags.type)) {
      ctx.stderr(
        `⚠️ ${JSON.stringify(flags.type)} is not a core event type — logged as an open-extension type`,
      );
    }
    const segment = flags.run === undefined ? `session-${session}` : `run-${flags.run}`;
    ctx.stdout(`✅ logged ${flags.type} — event ${event.id} (seq ${event.seq}) → ${segment}`);
    return 0;
  } catch (error) {
    ctx.stderr(`❌ ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof UsageError) ctx.stderr(USAGE);
    return 1;
  }
}

export const logCommand: Command = {
  description:
    `append a typed journal event (observation about work; actor from config or ${NAHEL_ACTOR_VAR})`,
  run: runLog,
};

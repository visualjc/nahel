import { ACTOR_KINDS } from "../schema/enums";
import { actorSchema, type Actor } from "../schema/records";

/**
 * Actor resolution (PRD F9, trust boundary settled): identity comes from the
 * config actor entry or the NAHEL_ACTOR environment override — never a casual
 * per-command flag. The environment variable's *value* is read at the entry
 * point and passed in here; nothing deep in the store touches process.env.
 * This is a cooperative guardrail, not auth — no identity machinery beyond
 * validation belongs here (hard constraint 1).
 */

/** Name of the environment override; the entry point reads it and passes the value down. */
export const NAHEL_ACTOR_VAR = "NAHEL_ACTOR";

const SPEC_FORMAT = "<human|agent>:<id>[:<session>]";

/** Parse an actor spec string (the NAHEL_ACTOR format): `kind:id[:session]`. */
export function parseActorSpec(spec: string): Actor {
  const parts = spec.split(":");
  const [kind, id, session] = parts;
  if (parts.length < 2 || parts.length > 3 || !kind || !id || (parts.length === 3 && !session)) {
    throw new Error(`invalid actor spec ${JSON.stringify(spec)} — expected ${SPEC_FORMAT}`);
  }
  if (!(ACTOR_KINDS as readonly string[]).includes(kind)) {
    throw new Error(
      `invalid actor kind ${JSON.stringify(kind)} — expected ${SPEC_FORMAT} with kind human or agent`,
    );
  }
  return actorSchema.parse({ kind, id, ...(session === undefined ? {} : { session }) });
}

/**
 * Resolve the acting identity: the NAHEL_ACTOR override wins when set (and
 * must be valid — an invalid override never falls back silently); otherwise
 * the config actor entry, validated. No source at all is an error.
 */
export function resolveActor(
  configActor: Actor | undefined,
  nahelActorOverride: string | undefined,
): Actor {
  if (nahelActorOverride !== undefined) {
    return parseActorSpec(nahelActorOverride);
  }
  if (configActor !== undefined) {
    return actorSchema.parse(configActor);
  }
  throw new Error(
    `no actor identity: set an actor entry in nahel/config or the ${NAHEL_ACTOR_VAR} environment variable (${SPEC_FORMAT})`,
  );
}

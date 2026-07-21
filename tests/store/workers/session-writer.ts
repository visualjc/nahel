/**
 * Subprocess for the concurrent-writers test. Opens its own writer-scoped
 * session segment (random ID from the real Env) and appends `count` non-run
 * events. Prints the session segment id on success so the parent can assert
 * the two writers never shared a file.
 *
 * Usage: bun run session-writer.ts <root> <actorId> <count>
 */
import { systemEnv } from "../../../src/schema/env";
import { appendEvent, newSessionSegmentId } from "../../../src/store/journal";
import { ensureLayout } from "../../../src/store/layout";

const [root, actorId, countArg] = process.argv.slice(2);
const count = Number(countArg);
if (!root || !actorId || !Number.isInteger(count)) {
  console.error("usage: session-writer.ts <root> <actorId> <count>");
  process.exit(2);
}

const env = systemEnv();
const layout = await ensureLayout(root);
const session = newSessionSegmentId(env);

for (let i = 0; i < count; i++) {
  await appendEvent(layout, env, {
    type: "note",
    actor: { kind: "agent", id: actorId },
    payload: { writer: actorId, i },
    session,
  });
}

console.log(session);

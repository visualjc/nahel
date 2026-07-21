import { spyOn } from "bun:test";
import { itemCommand } from "../../src/commands/item";
import { logCommand } from "../../src/commands/log";
import { runCommand } from "../../src/commands/run";
import type { Env } from "../../src/schema/env";
import { ensureLayout, readItem, writeConfig, type StoreLayout } from "../../src/store/layout";
import { createStoreContext, mutate } from "../../src/store/mutate";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * View-test fixtures: a populated store built through the REAL commands
 * (item new/update → run start/update/end → log), never hand-written state —
 * views must render exactly what the write surface produces. Everything is
 * driven by one seeded ticking Env, so two builds with the same seed produce
 * byte-identical stores (the determinism tests depend on this).
 */

/** A store populated with a small but representative history. */
export interface PopulatedStore {
  root: string;
  layout: StoreLayout;
  env: Env;
  /** plan `demo-epic`, lane full — parent of the two tasks below. */
  epicId: string;
  /** feature `task-alpha` under the epic; has an ended run; claimed by jim. */
  taskAlphaId: string;
  /** bug `task-beta` under the epic; status in-progress; has the active run. */
  taskBetaId: string;
  /** chore `solo-chore` — a second root, outside the epic subtree. */
  soloChoreId: string;
  /** Active run of task-beta, phase `building`. */
  activeRunId: string;
  /** Ended run of task-alpha, outcome `success`. */
  endedRunId: string;
}

/**
 * Event types the fixture appends, in invocation order. The shared ticking
 * env makes every event's ts strictly increasing, so the merged journal
 * order equals this order.
 */
export const FIXTURE_EVENT_TYPES = [
  // Every item-mutating CLI invocation closes its own session segment, so a
  // session.closed marker follows each one (run-scoped invocations write to
  // run segments, which close via run end instead).
  "item.created", // demo-epic
  "session.closed",
  "item.created", // task-alpha
  "session.closed",
  "item.created", // task-beta
  "session.closed",
  "item.created", // solo-chore
  "session.closed",
  "item.updated", // task-beta → in-progress
  "session.closed",
  "run.started", // active run (task-beta)
  "run.updated", // active run → building
  "run.started", // ended run (task-alpha)
  "run.ended", // ended run → success
  "note", // logged against task-alpha
  "session.closed", // the store's marker: log closed its own session segment
  "test.failed", // logged against the active run (run ref only, no item ref)
  "item.claimed", // task-alpha claimed by human:jim via raw mutate() — the newest
  // event; a store-level context has no CLI lifecycle, so no close follows.
] as const;

/**
 * Drive a mutation-shaped command (item/run: run(argv, env, cwd)) with
 * console capture; returns the last stdout line (the printed id, for
 * new/start). Any non-zero exit is a fixture bug — fail loudly.
 */
async function runMutationCommand(
  command: { run(argv: string[], env: Env, cwd: string, actorOverride?: string): Promise<number> },
  argv: string[],
  env: Env,
  root: string,
): Promise<string> {
  const lines: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  try {
    const code = await command.run(argv, env, root);
    if (code !== 0) {
      throw new Error(`fixture command failed (${argv.join(" ")}): ${lines.join(" | ")}`);
    }
    return lines[lines.length - 1] ?? "";
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

/** Drive the ctx-shaped log command; non-zero exit is a fixture bug. */
async function runLogCommand(argv: string[], env: Env, root: string): Promise<void> {
  const errs: string[] = [];
  const code = await logCommand.run(argv, {
    env,
    cwd: root,
    stdout: () => {},
    stderr: (text) => errs.push(text),
  });
  if (code !== 0) {
    throw new Error(`fixture log command failed (${argv.join(" ")}): ${errs.join(" | ")}`);
  }
}

/**
 * Build the populated store. `tempDirs` receives the created root so the
 * caller's afterEach can rm it. Same seed → byte-identical store.
 */
export async function buildPopulatedStore(
  tempDirs: string[],
  seed = 42,
): Promise<PopulatedStore> {
  const root = await makeTempDir("nahel-views-");
  tempDirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig()); // actor: agent:claude-code
  const env = seededEnv({ seed, tickSeconds: 1 });

  const epicId = await runMutationCommand(
    itemCommand,
    ["new", "plan", "demo-epic", "full"],
    env,
    root,
  );
  const taskAlphaId = await runMutationCommand(
    itemCommand,
    ["new", "feature", "task-alpha", "direct", "--parent", epicId],
    env,
    root,
  );
  const taskBetaId = await runMutationCommand(
    itemCommand,
    ["new", "bug", "task-beta", "direct", "--parent", epicId],
    env,
    root,
  );
  const soloChoreId = await runMutationCommand(
    itemCommand,
    ["new", "chore", "solo-chore", "direct"],
    env,
    root,
  );
  await runMutationCommand(
    itemCommand,
    ["update", taskBetaId, "--status", "in-progress"],
    env,
    root,
  );
  const activeRunId = await runMutationCommand(runCommand, ["start", taskBetaId], env, root);
  await runMutationCommand(
    runCommand,
    ["update", activeRunId, "--phase", "building"],
    env,
    root,
  );
  const endedRunId = await runMutationCommand(runCommand, ["start", taskAlphaId], env, root);
  await runMutationCommand(runCommand, ["end", endedRunId, "success"], env, root);
  await runLogCommand(
    ["note", "--item", taskAlphaId, "--data", "text=observed a thing"],
    env,
    root,
  );
  await runLogCommand(
    ["test.failed", "--run", activeRunId, "--data", "case=merge"],
    env,
    root,
  );

  // Claim task-alpha through the mutate() choke point so the journal stays
  // consistent with the record (validate's journal.divergence check would
  // rightly flag a raw writeItem here as a hand-edit).
  const { frontmatter, body } = await readItem(layout, taskAlphaId);
  const claimCtx = await createStoreContext(root, env, { actorOverride: "human:jim" });
  await mutate(claimCtx, {
    target: "item",
    eventType: "item.claimed",
    frontmatter: { ...frontmatter, claimed_by: "jim" },
    body,
  });

  return {
    root,
    layout,
    env,
    epicId,
    taskAlphaId,
    taskBetaId,
    soloChoreId,
    activeRunId,
    endedRunId,
  };
}

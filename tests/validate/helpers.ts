import { rename, rm, writeFile } from "node:fs/promises";
import type { Env } from "../../src/schema/env";
import { CORE_EVENT_TYPES } from "../../src/schema/events";
import type {
  Actor,
  Config,
  JournalEvent,
  Run,
  WorkItemFrontmatter,
} from "../../src/schema/records";
import { writeHotState } from "../../src/store/hotstate";
import { ensureLayout, writeConfig, type StoreLayout } from "../../src/store/layout";
import { createStoreContext, mutate, type StoreContext } from "../../src/store/mutate";
import type { Finding } from "../../src/validate";
import { makeConfig, makeFrontmatter, makeRun, makeTempDir, seededEnv } from "../store/helpers";

/**
 * Validate-test fixtures: every fixture starts from a CLEAN store built
 * through the real store mutation path (mutate() → write-ahead journal →
 * record write), then seeds exactly one corruption per test by raw fs writes —
 * the same way real corruption arrives (hand edits, merges, crashes).
 */

export interface ValidateFixture {
  root: string;
  layout: StoreLayout;
  env: Env;
  /** Store context resolving to the config actor (agent:claude-code). */
  agent: StoreContext;
  /** Store context overridden to human:jim (intervention actor). */
  human: StoreContext;
}

/** Fresh initialized store in a real temp dir; root pushed onto tempDirs for cleanup. */
export async function setupFixture(
  tempDirs: string[],
  configOverrides: Partial<Config> = {},
): Promise<ValidateFixture> {
  const root = await makeTempDir("nahel-validate-");
  tempDirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig(configOverrides));
  const env = seededEnv({ tickSeconds: 1 });
  const agent = await createStoreContext(root, env);
  const human = await createStoreContext(root, env, { actorOverride: "human:jim" });
  return { root, layout, env, agent, human };
}

/** Create a work item through the choke point (journaled + written, in sync). */
export async function createItem(
  fixture: ValidateFixture,
  overrides: Partial<WorkItemFrontmatter> = {},
  body = "",
): Promise<WorkItemFrontmatter> {
  const frontmatter = makeFrontmatter(fixture.env, overrides);
  await mutate(fixture.agent, {
    target: "item",
    eventType: CORE_EVENT_TYPES.itemCreated,
    frontmatter,
    body,
  });
  return frontmatter;
}

/** Start a run through the choke point, with hot state mirroring the record. */
export async function createRun(
  fixture: ValidateFixture,
  itemId: string,
  overrides: Partial<Run> = {},
): Promise<Run> {
  const run = makeRun(fixture.env, itemId, overrides);
  await mutate(fixture.agent, {
    target: "run",
    eventType: CORE_EVENT_TYPES.runStarted,
    run,
  });
  await writeHotState(fixture.layout, run.id, {
    phase: run.phase,
    status: run.status,
    updated: fixture.env.now(),
  });
  return run;
}

/** The findings a specific check produced (tests assert per-check, verbosely). */
export function findingsFor(findings: readonly Finding[], check: string): Finding[] {
  return findings.filter((finding) => finding.check === check);
}

/** One hand-built journal event serialized as a JSONL line (for raw segment seeding). */
export function rawEventLine(overrides: Partial<JournalEvent> = {}): string {
  const actor: Actor = { kind: "agent", id: "codex" };
  const event: JournalEvent = {
    id: "e0e0e0e0",
    ts: "2026-07-16T12:00:00Z",
    seq: 0,
    type: "note",
    actor,
    payload: {},
    ...overrides,
  };
  return `${JSON.stringify(event)}\n`;
}

/**
 * Kill-inject the write-ahead crash window (same technique as
 * tests/store/crash-window.test.ts): make the NEXT item record write fail by
 * replacing nahel/items with a plain file — the journal event lands, the
 * record write dies.
 */
export async function sabotageItemWrites(itemsDir: string): Promise<void> {
  await rename(itemsDir, `${itemsDir}.parked`);
  await writeFile(itemsDir, "not a directory");
}

export async function healItemWrites(itemsDir: string): Promise<void> {
  await rm(itemsDir);
  await rename(`${itemsDir}.parked`, itemsDir);
}

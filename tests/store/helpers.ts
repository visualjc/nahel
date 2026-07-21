import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Env } from "../../src/schema/env";
import { generateId } from "../../src/schema/id";
import type {
  Config,
  ObservationFrontmatter,
  Run,
  WorkItemFrontmatter,
} from "../../src/schema/records";

/**
 * Deterministic Env with a seeded LCG RNG (distinct, reproducible IDs — unlike
 * fixedEnv's cycling list, which yields identical IDs) and an optional ticking
 * clock (each `now()` call advances by `tickSeconds`).
 */
export function seededEnv(
  options: { seed?: number; now?: string; tickSeconds?: number } = {},
): Env {
  let state = (options.seed ?? 42) >>> 0;
  const startMs = Date.parse(options.now ?? "2026-07-16T12:00:00Z");
  const tick = options.tickSeconds ?? 0;
  let calls = 0;
  return {
    now: () => {
      const iso = new Date(startMs + calls * tick * 1000).toISOString();
      calls += 1;
      return `${iso.slice(0, 19)}Z`;
    },
    random: () => {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      return state / 2 ** 32;
    },
  };
}

/** Fresh real temp directory for a test; caller may rm it in afterEach. */
export async function makeTempDir(prefix = "nahel-store-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** A valid config record for tests. */
export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    knowledge: {
      product: "PRODUCT.md",
      context: "CONTEXT.md",
      adr: "docs/adr",
    },
    actor: { kind: "agent", id: "claude-code" },
    ...overrides,
  };
}

/** A valid work-item frontmatter record; id and timestamps from env. */
export function makeFrontmatter(
  env: Env,
  overrides: Partial<WorkItemFrontmatter> = {},
): WorkItemFrontmatter {
  const ts = env.now();
  return {
    id: generateId(env),
    name: "test-item",
    type: "feature",
    status: "backlog",
    lane: "direct",
    depends_on: [],
    external_refs: [],
    created: ts,
    updated: ts,
    ...overrides,
  };
}

/** A valid observation record citing `sources`; id and timestamp from env. */
export function makeObservation(
  env: Env,
  sources: string[],
  overrides: Partial<ObservationFrontmatter> = {},
): ObservationFrontmatter {
  return {
    id: generateId(env),
    name: "test-observation",
    created: env.now(),
    tags: [],
    sources,
    ...overrides,
  };
}

/** A valid run record referencing `item`; id and timestamps from env. */
export function makeRun(env: Env, item: string, overrides: Partial<Run> = {}): Run {
  return {
    id: generateId(env),
    item,
    actor: { kind: "agent", id: "claude-code" },
    lane: "direct",
    phase: "starting",
    status: "active",
    started: env.now(),
    ...overrides,
  };
}

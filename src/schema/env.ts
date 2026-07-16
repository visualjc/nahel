/**
 * Env — the injected environment: the ONLY source of time and randomness in
 * the codebase (epic decision "Injected clock and RNG"; ADR-0004 determinism).
 * Production code constructs one `systemEnv()` at the entry point and threads
 * it down; tests supply fixed implementations so identical inputs produce
 * identical outputs.
 */
export interface Env {
  /** Current instant as an ISO-8601 UTC string, second precision: YYYY-MM-DDTHH:MM:SSZ. */
  readonly now: () => string;
  /** Uniform random number in [0, 1). */
  readonly random: () => number;
}

/** The real Env: wall clock (UTC, second precision) and Math.random. */
export function systemEnv(): Env {
  return {
    now: () => `${new Date().toISOString().slice(0, 19)}Z`,
    random: Math.random,
  };
}

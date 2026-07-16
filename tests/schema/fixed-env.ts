import type { Env } from "../../src/schema/env";

/**
 * Deterministic Env for tests: a frozen clock and a cycling RNG sequence.
 * Identical construction arguments always yield identical behavior, which is
 * what lets tests prove "identical inputs → identical outputs".
 */
export function fixedEnv(
  options: { now?: string; randoms?: readonly number[] } = {},
): Env {
  const now = options.now ?? "2026-07-16T12:00:00Z";
  const randoms = options.randoms ?? [0.5];
  let calls = 0;
  return {
    now: () => now,
    random: () => {
      const value = randoms[calls % randoms.length]!;
      calls += 1;
      return value;
    },
  };
}

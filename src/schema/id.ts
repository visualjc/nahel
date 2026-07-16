import type { Env } from "./env";

/**
 * The single ID generator shared by work items, runs, journal events, and
 * journal segments (ADR-0012: random short IDs are what make parallel
 * worktrees merge-safe — no sequential counters anywhere).
 *
 * Alphabet: lowercase Crockford base32 — digits plus letters minus the
 * ambiguous i, l, o, u.
 */
export const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Every Nahel ID is exactly this many characters. */
export const ID_LENGTH = 8;

/** Matches exactly one well-formed Nahel ID. */
export const ID_PATTERN = new RegExp(`^[${ID_ALPHABET}]{${ID_LENGTH}}$`);

/**
 * Generate one 8-char lowercase base32 ID. Pure over the injected RNG — no
 * filesystem, network, or ambient randomness — so a fixed Env yields a fixed
 * ID sequence.
 */
export function generateId(env: Env): string {
  let id = "";
  for (let i = 0; i < ID_LENGTH; i++) {
    const r = env.random();
    if (!(r >= 0 && r < 1)) {
      throw new Error(
        `Env.random() must return a number in [0, 1), got ${r} — check the injected RNG`,
      );
    }
    id += ID_ALPHABET[Math.floor(r * ID_ALPHABET.length)];
  }
  return id;
}

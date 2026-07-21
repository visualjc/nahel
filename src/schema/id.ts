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

/** A user-supplied id failed ID_PATTERN validation before reaching a path. */
export class InvalidIdError extends Error {}

/**
 * Validate a user-supplied id against ID_PATTERN, throwing InvalidIdError
 * when it fails. The store's path helpers call this ONCE at the choke point
 * (layout.itemPath / layout.runDir / journal.runSegmentPath / …) so a
 * crafted id like `../../PRODUCT` can never be joined into a path — ids from
 * argv are untrusted input (PR #12 review, blocker 2).
 */
export function requireValidId(id: string, what: string): string {
  if (!ID_PATTERN.test(id)) {
    throw new InvalidIdError(
      `invalid ${what} id ${JSON.stringify(id)} — ids are exactly ${ID_LENGTH} characters ` +
        `from the alphabet ${ID_ALPHABET}`,
    );
  }
  return id;
}

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

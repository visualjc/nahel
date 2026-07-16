import { describe, expect, test } from "bun:test";
import { systemEnv } from "../../src/schema/env";
import { generateId, ID_ALPHABET, ID_LENGTH, ID_PATTERN } from "../../src/schema/id";
import { fixedEnv } from "./fixed-env";

describe("schema/id", () => {
  describe("alphabet", () => {
    test("is 32 unique lowercase base32 characters", () => {
      expect(ID_ALPHABET).toHaveLength(32);
      expect(new Set(ID_ALPHABET).size).toBe(32);
      expect(ID_ALPHABET).toBe(ID_ALPHABET.toLowerCase());
      expect(ID_ALPHABET).toMatch(/^[0-9a-z]{32}$/);
    });

    test("excludes ambiguous characters i, l, o, u", () => {
      for (const ambiguous of ["i", "l", "o", "u"]) {
        expect(ID_ALPHABET.includes(ambiguous)).toBe(false);
      }
    });
  });

  describe("generateId", () => {
    test("returns an 8-char string drawn only from the alphabet", () => {
      const id = generateId(systemEnv());
      expect(id).toHaveLength(ID_LENGTH);
      expect(ID_LENGTH).toBe(8);
      for (const ch of id) {
        expect(ID_ALPHABET.includes(ch)).toBe(true);
      }
      expect(id).toMatch(ID_PATTERN);
    });

    test("is fully determined by the injected RNG (fixed Env → known id)", () => {
      const env = fixedEnv({
        randoms: [0.0, 0.5, 0.99, 0.25, 0.75, 0.125, 0.375, 0.625],
      });
      // floor(r * 32) → indices 0, 16, 31, 8, 24, 4, 12, 20 in the alphabet.
      expect(generateId(env)).toBe("0gz8r4cm");
    });

    test("identical fixed Envs produce identical id sequences", () => {
      const randoms = [0.03, 0.11, 0.42, 0.9, 0.66, 0.31, 0.77, 0.005, 0.55];
      const a = fixedEnv({ randoms });
      const b = fixedEnv({ randoms });
      for (let i = 0; i < 5; i++) {
        expect(generateId(a)).toBe(generateId(b));
      }
    });

    test("throws an actionable error when the RNG violates its [0, 1) contract", () => {
      expect(() => generateId(fixedEnv({ randoms: [1.0] }))).toThrow("[0, 1)");
      expect(() => generateId(fixedEnv({ randoms: [-0.1] }))).toThrow("[0, 1)");
      expect(() => generateId(fixedEnv({ randoms: [Number.NaN] }))).toThrow(
        "[0, 1)",
      );
    });

    test("system Env yields distinct ids across many draws (merge-safe randomness)", () => {
      const env = systemEnv();
      const ids = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        ids.add(generateId(env));
      }
      expect(ids.size).toBe(1000);
    });
  });
});

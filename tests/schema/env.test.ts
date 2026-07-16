import { describe, expect, test } from "bun:test";
import { systemEnv } from "../../src/schema/env";
import { fixedEnv } from "./fixed-env";

const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

describe("schema/env", () => {
  describe("systemEnv", () => {
    test("now() returns an ISO-8601 UTC string (YYYY-MM-DDTHH:MM:SSZ)", () => {
      const env = systemEnv();
      const ts = env.now();
      expect(ts).toMatch(ISO_8601_UTC);
      // Must be a real instant, parseable and within a minute of Date.now().
      const parsed = Date.parse(ts);
      expect(Number.isNaN(parsed)).toBe(false);
      expect(Math.abs(parsed - Date.now())).toBeLessThan(60_000);
    });

    test("random() returns numbers in [0, 1)", () => {
      const env = systemEnv();
      for (let i = 0; i < 100; i++) {
        const r = env.random();
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThan(1);
      }
    });
  });

  describe("fixed Env determinism", () => {
    test("two identically-constructed fixed Envs produce identical output streams", () => {
      const make = () =>
        fixedEnv({
          now: "2026-01-02T03:04:05Z",
          randoms: [0.12, 0.98, 0.0, 0.5],
        });
      const a = make();
      const b = make();
      for (let i = 0; i < 10; i++) {
        expect(a.now()).toBe(b.now());
        expect(a.random()).toBe(b.random());
      }
      expect(a.now()).toBe("2026-01-02T03:04:05Z");
    });
  });
});

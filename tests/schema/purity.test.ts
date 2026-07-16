import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCHEMA_DIR = join(import.meta.dir, "../../src/schema");

const EXPECTED_FILES = ["enums.ts", "env.ts", "events.ts", "id.ts", "records.ts"];

/** Module specifiers the schema layer must never import (I/O belongs to the store layer). */
const FORBIDDEN_IMPORT = /from\s+["'](node:)?(fs|fs\/promises|net|http|https|http2|dns|tls|child_process|worker_threads)["']/;

/** Ambient I/O and environment access forbidden everywhere in the layer. */
const FORBIDDEN_GLOBALS = [/\bfetch\s*\(/, /\bBun\.(file|write|spawn|serve|env)\b/, /\bprocess\.env\b/];

/** Ambient time/randomness — allowed only inside env.ts, the single source. */
const AMBIENT_TIME_RANDOMNESS = [/\bDate\b/, /\bMath\.random\b/, /\bcrypto\b/];

describe("schema layer purity", () => {
  test("src/schema contains exactly the five schema modules", () => {
    expect(readdirSync(SCHEMA_DIR).sort()).toEqual(EXPECTED_FILES);
  });

  for (const file of EXPECTED_FILES) {
    test(`${file} performs no fs or network access`, () => {
      const source = readFileSync(join(SCHEMA_DIR, file), "utf8");
      expect(source).not.toMatch(FORBIDDEN_IMPORT);
      for (const pattern of FORBIDDEN_GLOBALS) {
        expect(source).not.toMatch(pattern);
      }
    });
  }

  for (const file of EXPECTED_FILES.filter((f) => f !== "env.ts")) {
    test(`${file} never reaches for ambient time or randomness (env.ts is the only source)`, () => {
      const source = readFileSync(join(SCHEMA_DIR, file), "utf8");
      for (const pattern of AMBIENT_TIME_RANDOMNESS) {
        expect(source).not.toMatch(pattern);
      }
    });
  }
});

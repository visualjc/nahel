import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CANONICAL_WORKFLOWS } from "../../src/install/canonical-workflows";

/**
 * The single-source claim, made mechanical (bug mcm4ak0e). The workflow docs
 * `nahel init` ships are embedded in the binary at build time from THIS repo's
 * `nahel/workflows/*.md`. Nothing at runtime can notice a doc that was added to
 * the directory but never embedded — so this test notices, at test time, by
 * comparing the embedded set against the directory on disk. Paths are resolved
 * relative to this file, never cwd: the check is about the repo, not about
 * wherever the suite happens to be run from.
 */

const WORKFLOWS_DIR = join(import.meta.dir, "..", "..", "nahel", "workflows");

/** The stems on disk, sorted AS STEMS — "plan" sorts before "plan-frontier". */
function onDisk(): string[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -3))
    .sort();
}

describe("embedded canonical workflows mirror nahel/workflows/ exactly", () => {
  test("the embedded name set equals the directory's file stems — no additions, no omissions", () => {
    const expected = onDisk();
    expect(expected.length).toBeGreaterThan(0);
    const embedded = CANONICAL_WORKFLOWS.map((workflow) => workflow.name).sort();
    console.log(`[embedded ${embedded.length}] ${embedded.join(", ")}`);
    expect(embedded).toEqual(expected);
    // Names are unique — a duplicated import would pass the set check above
    // only if it also duplicated a stem, which the length guard catches.
    expect(new Set(embedded).size).toBe(CANONICAL_WORKFLOWS.length);
  });

  test("every embedded body is the file's bytes, not a stale copy", () => {
    for (const workflow of CANONICAL_WORKFLOWS) {
      expect(workflow.body).toBe(readFileSync(join(WORKFLOWS_DIR, `${workflow.name}.md`), "utf8"));
    }
  });
});

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseWorkflowDoc } from "../../src/install/workflow";
import { readFrontmatterFile } from "../../src/store/frontmatter";

/**
 * The feature-lane canonical workflow docs (PRD F1): prd-new, prd-parse,
 * epic-decompose, task-lifecycle. These tests prove each shipped doc is a
 * valid canonical workflow (frontmatter parses, name matches the file stem)
 * AND that its body drives exactly the CLI mechanics the lane depends on —
 * the docs are the product here, and a doc that drifted from the CLI would
 * instruct agents to run commands that do not exist.
 */

/** Read a shipped workflow doc and prove it valid per the canonical format. */
async function shippedWorkflow(file: string) {
  const path = join(import.meta.dir, "../../nahel/workflows", file);
  const { frontmatter, body } = await readFrontmatterFile(path);
  return { parsed: parseWorkflowDoc(file, frontmatter), body };
}

describe("feature-lane canonical workflow docs (F1)", () => {
  test("prd-new.md: grilling interview, statusless PRD in docs/prds/, deliverable recorded via --prd", async () => {
    const { parsed, body } = await shippedWorkflow("prd-new.md");
    expect(parsed.name).toBe("prd-new");
    expect(parsed.description.length).toBeGreaterThan(0);
    // Mechanics: the plan item is CLI-owned; the PRD is prose.
    expect(body).toContain("nahel item new plan");
    expect(body).toContain("--prd docs/prds/");
    // Real timestamps, never estimated (datetime rule).
    expect(body).toContain('date -u +"%Y-%m-%dT%H:%M:%SZ"');
    // ADR-0013: the PRD carries NO status field; the plan item owns the gate,
    // and the workflow stops at in-review — approval (done) is the human's.
    expect(body).toContain("NO status field");
    expect(body).toContain("--status in-review");
    expect(body).toContain("done");
    // Interview quality bar: the grill covers the load-bearing sections.
    for (const section of ["Goal", "Non-goals", "acceptance criteria", "Exit test", "Open questions"]) {
      expect(body).toContain(section);
    }
    // F7.3: the grilling skill dependency carries an inline fallback, and the
    // doc has a degraded-environment fallback; actor identity is stated.
    expect(body).toContain("grilling");
    expect(body).toContain("Fallback");
    expect(body).toContain("NAHEL_ACTOR");
  });

  test("prd-parse.md: approval-gated, creates the parent feature via the CLI with the lane heuristics", async () => {
    const { parsed, body } = await shippedWorkflow("prd-parse.md");
    expect(parsed.name).toBe("prd-parse");
    expect(parsed.description.length).toBeGreaterThan(0);
    // Precondition: the human approved — the plan item flipped to done.
    expect(body).toContain("done");
    expect(body).toContain("STOP");
    // Mechanics: parent feature item referencing the PRD by path, journaled.
    expect(body).toContain("nahel item new feature");
    expect(body).toContain("--prd docs/prds/");
    expect(body).toContain("nahel log note");
    // Lane heuristics are stated, per the lane vocabulary.
    for (const lane of ["direct", "epic-lite", "full"]) {
      expect(body).toContain(lane);
    }
    expect(body).toContain("Fallback");
    expect(body).toContain("NAHEL_ACTOR");
  });

  test("epic-decompose.md: session-sized, independently-verifiable children on a real-order DAG", async () => {
    const { parsed, body } = await shippedWorkflow("epic-decompose.md");
    expect(parsed.name).toBe("epic-decompose");
    expect(parsed.description.length).toBeGreaterThan(0);
    // Mechanics: children via --parent, ordering via --depends-on, sanity via status.
    expect(body).toContain("nahel item new");
    expect(body).toContain("--parent");
    expect(body).toContain("--depends-on");
    expect(body).toContain("nahel status");
    // Discipline ported from ccpm's epic-decompose.
    expect(body).toContain("one focused session");
    expect(body).toContain("independently verifiable");
    expect(body).toContain("DAG");
    expect(body).toContain("truly blocking");
    expect(body).toContain("Fallback");
    expect(body).toContain("NAHEL_ACTOR");
  });

  test("bug-lane.md: diagnosis-first — investigation doc, red-before-fix hard rule, waiver only after failed repro, root cause distilled", async () => {
    const { parsed, body } = await shippedWorkflow("bug-lane.md");
    expect(parsed.name).toBe("bug-lane");
    expect(parsed.description.length).toBeGreaterThan(0);
    // Mechanics compose task-lifecycle, never repeat it.
    expect(body).toContain("task-lifecycle");
    // F5.1: the durable investigation document, recorded on the item by path.
    expect(body).toContain("docs/investigations/");
    expect(body).toContain("--investigation");
    for (const section of ["symptoms", "repro status", "hypotheses", "root cause"]) {
      expect(body.toLowerCase()).toContain(section);
    }
    // F5.2 hard rule (acceptance: no done without repro-or-waiver): the
    // failing repro test comes before ANY fix — the tdd red-first posture.
    expect(body).toContain("HARD RULE");
    expect(body).toContain("failing repro test");
    expect(body).toContain("red");
    // Diagnosis discipline: pinned diagnosing-bugs skill with inline fallback.
    expect(body).toContain("diagnosing-bugs");
    expect(body).toContain("reproduce");
    expect(body).toContain("isolate");
    expect(body).toContain("one at a time");
    // F5.3 waiver path: an observation, tagged, item-referenced, valid ONLY
    // with documented failed repro attempts, provenance to the journal, and
    // restated in the PR body — never silently skipped.
    expect(body).toContain("nahel observe");
    expect(body).toContain("repro-waiver");
    expect(body).toContain("--item");
    expect(body).toContain("ONLY");
    expect(body).toContain("failed repro attempts");
    expect(body).toContain("sources");
    expect(body).toContain("PR body");
    // F5.4 close: root cause distilled with provenance; run ended honestly;
    // done stays the human's to grant.
    expect(body).toContain("nahel run end");
    expect(body).toContain("--status in-review");
    expect(body).toContain("done");
    expect(body).toContain("Fallback");
    expect(body).toContain("NAHEL_ACTOR");
  });

  test("task-lifecycle.md: the leaf loop — status flips, run phases, journaled findings, the claim rule", async () => {
    const { parsed, body } = await shippedWorkflow("task-lifecycle.md");
    expect(parsed.name).toBe("task-lifecycle");
    expect(parsed.description.length).toBeGreaterThan(0);
    // Mechanics: the full CLI loop.
    expect(body).toContain("--status in-progress");
    expect(body).toContain("nahel run start");
    expect(body).toContain("nahel run update");
    expect(body).toContain("--phase");
    expect(body).toContain("nahel run end");
    expect(body).toContain("success");
    expect(body).toContain("failure");
    expect(body).toContain("--status in-review");
    expect(body).toContain("--status blocked");
    expect(body).toContain("nahel log note");
    // done is granted by the human after merge/acceptance, never self-granted.
    expect(body).toContain("done");
    // TDD posture: red first, assertions never weakened.
    expect(body).toContain("red");
    expect(body).toContain("weaken");
    // The claim rule: stop and surface, never work around.
    expect(body).toContain("claim");
    expect(body).toContain("STOP");
    expect(body).toContain("Fallback");
    expect(body).toContain("NAHEL_ACTOR");
  });
});

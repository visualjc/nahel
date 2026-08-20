import { describe, expect, test } from "bun:test";
import { renderTaskDoc } from "../../src/dispatch/handoff";
import { parseFrontmatter } from "../../src/store/frontmatter";

/**
 * The handoff (task) document renderer (PRD F1): the pure half of "dispatch
 * writes the handoff document". The task no longer travels in argv — it
 * travels in `nahel/runs/<run-id>/task.md`, and this module renders that file.
 *
 * The load-bearing property is BYTE FIDELITY of the body: whatever the
 * dispatcher handed over is what the worker reads. A renderer that trims,
 * re-wraps, or re-encodes the task silently changes the brief a worker acts on.
 */

const INPUT = {
  run: "c3qbbmnz",
  item: "r4h2840z",
  responsibility: "implementation",
  created: "2026-08-20T17:04:05Z",
  task: "Implement the pointer prompt.\n",
};

describe("renderTaskDoc (F1 — frontmatter + the task body verbatim)", () => {
  test("frontmatter carries exactly run, item, responsibility, created", () => {
    const doc = renderTaskDoc(INPUT);
    console.log("[task doc]\n" + doc);
    const { frontmatter } = parseFrontmatter(doc);
    expect(Object.keys(frontmatter).sort()).toEqual([
      "created",
      "item",
      "responsibility",
      "run",
    ]);
    expect(frontmatter).toEqual({
      run: "c3qbbmnz",
      item: "r4h2840z",
      responsibility: "implementation",
      created: "2026-08-20T17:04:05Z",
    });
  });

  test("the orientation contract stays in the PROMPT — the document is task only", () => {
    // PRD F1: "the orientation contract stays in the prompt (F3), not in the
    // document". A renderer that also preambled here would give a worker two
    // sources for the same contract, and they would drift.
    const { body } = parseFrontmatter(renderTaskDoc(INPUT));
    expect(body).toBe(INPUT.task);
    expect(body).not.toContain("nahel brief");
  });

  test("rendering is deterministic — the same input renders byte-identical documents", () => {
    // The caller owns the clock (`created` is a parameter), so this module is
    // pure and a re-render of the same dispatch is the same bytes.
    expect(renderTaskDoc(INPUT)).toBe(renderTaskDoc(INPUT));
  });

  describe("the body round-trips byte-identically", () => {
    const bodies: Record<string, string> = {
      // A task that itself opens with a `---` line: the frontmatter split must
      // close on the renderer's own fence, not on the body's.
      "leading frontmatter fence": "---\nnot: my-frontmatter\n---\n\nDo the thing.\n",
      // A task pasted without a trailing newline — nothing may be appended.
      "no trailing newline": "Do the thing.",
      // Non-ASCII survives the YAML round trip unmangled.
      unicode: "Fix the ✓ marker, café naïve — 日本語テスト 🚀\n",
      "internal fences": "Step 1\n\n---\n\nStep 2\n",
      "trailing whitespace": "Do the thing.   \n\n\n",
      // Multi-hundred-KB: the size that hung codex when it travelled in argv
      // (journal nt93edc0). In a document it is just a file.
      "300 KB": `${"x".repeat(300_000)}\n`,
    };

    for (const [label, task] of Object.entries(bodies)) {
      test(label, () => {
        const doc = renderTaskDoc({ ...INPUT, task });
        const parsed = parseFrontmatter(doc);
        console.log(`[${label}] doc bytes=${doc.length} body bytes=${parsed.body.length}`);
        expect(parsed.body).toBe(task);
        expect(parsed.frontmatter["run"]).toBe(INPUT.run);
      });
    }
  });
});

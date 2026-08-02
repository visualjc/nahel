import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseWorkflowDoc } from "../../src/install/workflow";
import { readFrontmatterFile } from "../../src/store/frontmatter";

/**
 * The two wayfinder workflow docs (Phase 4 F7): charting a map, and working
 * one. Like every canonical workflow they are the product here — a doc that
 * drifted from the CLI would instruct agents to run commands that do not
 * exist — so these tests check both the format and the mechanics they drive.
 */

async function shippedWorkflow(file: string) {
  const path = join(import.meta.dir, "../../nahel/workflows", file);
  const { frontmatter, body } = await readFrontmatterFile(path);
  return { parsed: parseWorkflowDoc(file, frontmatter), body };
}

describe("chart-map.md — naming the destination and cutting the fog into tickets", () => {
  test("valid canonical doc: frontmatter parses and the name matches the file stem", async () => {
    const { parsed } = await shippedWorkflow("chart-map.md");
    expect(parsed.name).toBe("chart-map");
    expect(parsed.description.length).toBeGreaterThan(0);
    expect(parsed.args).toContain("<");
  });

  test("drives the real charting mechanics: destination first, then tickets, then the edges", async () => {
    const { body } = await shippedWorkflow("chart-map.md");
    expect(body).toContain("nahel roadmap map new");
    expect(body).toContain("--destination");
    expect(body).toContain("nahel roadmap ticket new");
    expect(body).toContain("--type");
    // Two passes: create the tickets, THEN wire the blocking edges — wiring as
    // you go means naming ids that do not exist yet.
    expect(body).toContain("nahel roadmap ticket update");
    expect(body).toContain("--blocked-by");
    expect(body).toContain("second pass");
    // The fog and the out-of-scope ruling are both charted, not left implicit.
    expect(body).toContain("--fog");
    expect(body).toContain("--out-of-scope");
    // Breadth first: the grill covers the whole map before any branch is deep.
    expect(body).toContain("breadth");
    // All four ticket types are named, so the author picks rather than defaults.
    for (const type of ["research", "prototype", "grilling", "task"]) {
      expect(body).toContain(type);
    }
  });

  test("states the layer's rules: nothing is refused, and state moves through the CLI", async () => {
    const { body } = await shippedWorkflow("chart-map.md");
    expect(body).toContain("advisory");
    expect(body).toContain("NAHEL_ACTOR");
    expect(body).toContain("Fallback");
    expect(body).toContain("never hand-edit");
  });
});

describe("work-map.md — one ticket, one decision, and the fog that graduates", () => {
  test("valid canonical doc: frontmatter parses and the name matches the file stem", async () => {
    const { parsed } = await shippedWorkflow("work-map.md");
    expect(parsed.name).toBe("work-map");
    expect(parsed.description.length).toBeGreaterThan(0);
  });

  test("drives the lifecycle: claim ONE, resolve with a decision, distill, release on abandon", async () => {
    const { body } = await shippedWorkflow("work-map.md");
    expect(body).toContain("nahel roadmap map show");
    expect(body).toContain("nahel roadmap ticket claim");
    expect(body).toContain("nahel roadmap ticket resolve");
    expect(body).toContain("--decision");
    expect(body).toContain("nahel roadmap ticket close");
    expect(body).toContain("--reason");
    expect(body).toContain("nahel roadmap ticket release");
    expect(body).toContain("nahel roadmap ticket distill");
    expect(body).toContain("one ticket");
  });

  test("names the surface each ticket type is answered with", async () => {
    const { body } = await shippedWorkflow("work-map.md");
    // The type is not decoration: it picks the surface that answers it.
    expect(body).toContain("grilling");
    expect(body).toContain("domain-modeling");
    expect(body).toContain("prototype-lane");
    expect(body).toContain("research");
  });

  test("states what survives the ticket: recall finds the decision, and fog graduates", async () => {
    const { body } = await shippedWorkflow("work-map.md");
    expect(body).toContain("nahel recall");
    expect(body).toContain("graduate");
    expect(body).toContain("--fog");
    expect(body).toContain("NAHEL_ACTOR");
    expect(body).toContain("Fallback");
  });

  test("blocking never refuses: a blocked ticket may be taken deliberately", async () => {
    const { body } = await shippedWorkflow("work-map.md");
    expect(body).toContain("advisory");
    expect(body).toContain("blocked");
  });
});

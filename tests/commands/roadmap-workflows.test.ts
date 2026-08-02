import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseWorkflowDoc } from "../../src/install/workflow";
import { SELF_RECORDED_EVENT_TYPES } from "../../src/schema/events";
import { readFrontmatterFile } from "../../src/store/frontmatter";

/**
 * The roadmap layer's three workflow docs: the two wayfinder ones (Phase 4 F7)
 * — charting a map, and working one — and the migration that adopts a store's
 * existing backlog into the layer (F6). Like every canonical workflow they are
 * the product here — a doc that drifted from the CLI would instruct agents to
 * run commands that do not exist — so these tests check both the format and
 * the mechanics they drive.
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

  test("a close states WHICH disposition it is — the two are not the same fact", async () => {
    const { body } = await shippedWorkflow("work-map.md");
    expect(body).toContain("--out-of-scope");
    expect(body).toContain("--invalidated-by");
    // And says why: an invalidated question was never beyond the destination.
    expect(body).toContain("beyond the destination");
    expect(body).toContain("invalidated");
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

/**
 * The migration doc (F6). The judgment "which backlog items are roadmap-shaped"
 * is exactly the judgment the CLI refuses to make (HC1), so the mechanism is a
 * WORKFLOW over verbs that already ship — and everything that makes the
 * migration auditable is therefore in the doc's own words: enumerate from the
 * store, journal the complete call before acting on it, and write nodes only.
 */
const MIGRATION_SELECTED_EVENT_TYPE = "roadmap.migration-selected";

describe("migrate-roadmap.md — the backlog a store already carries becomes its first roadmap (F6)", () => {
  test("valid canonical doc: frontmatter parses and the name matches the file stem", async () => {
    const { parsed } = await shippedWorkflow("migrate-roadmap.md");
    expect(parsed.name).toBe("migrate-roadmap");
    expect(parsed.description.length).toBeGreaterThan(0);
    expect(parsed.args).toContain("<");
  });

  test("enumerates FROM THE STORE, and says coverage — not a count", async () => {
    const { body } = await shippedWorkflow("migrate-roadmap.md");
    // The candidate set is read off the store, never off a document: a list in
    // a PRD or a roadmap doc is a snapshot of the day it was written.
    expect(body).toContain("nahel status");
    expect(body).toContain("coverage");
    expect(body).toContain("not a count");
    expect(body).toContain("backlog");
    // The doc must warn off the failure mode that produced the miscount: a
    // list copied out of a document instead of enumerated from the store.
    expect(body).toContain("docs/roadmap.md");
    expect(body).toContain("snapshot");
    // Deliberately-future items are coverage too — a `later` node still counts.
    expect(body).toContain("later");
  });

  test("the selection is a judgment, so the doc says whose it is and what a near-miss is", async () => {
    const { body } = await shippedWorkflow("migrate-roadmap.md");
    expect(body).toContain("judgment");
    expect(body).toContain("migrating agent");
    // HC1: the CLI derives and renders; it never decides what is roadmap-shaped.
    expect(body).toContain("never judges");
    expect(body).toContain("near-miss");
    expect(body).toContain("one-line reason");
    // The excluding call is what the reason exists to expose.
    expect(body).toContain("work, not roadmap intent");
  });

  test("the selected set is journaled FIRST — the complete call, before any node exists", async () => {
    const { body } = await shippedWorkflow("migrate-roadmap.md");
    expect(body).toContain(`nahel log ${MIGRATION_SELECTED_EVENT_TYPE}`);
    expect(body).toContain("--data included=");
    expect(body).toContain("--data excluded=");
    // Journal ORDER is the proof, so the doc must state the ordering rule and
    // why a set written afterwards proves nothing.
    expect(body).toContain("journal order");
    expect(body).toContain("before the first node");
    const selectionAt = body.indexOf(`nahel log ${MIGRATION_SELECTED_EVENT_TYPE}`);
    const firstNodeAt = body.indexOf("nahel roadmap node new");
    expect(selectionAt).toBeGreaterThan(-1);
    expect(firstNodeAt).toBeGreaterThan(-1);
    // The doc's own steps are in that order too — a reader follows the page.
    expect(selectionAt).toBeLessThan(firstNodeAt);
  });

  test("the type the doc teaches is one `nahel log` accepts, not a reserved self-recorded type", async () => {
    const { body } = await shippedWorkflow("migrate-roadmap.md");
    expect(body).toContain(MIGRATION_SELECTED_EVENT_TYPE);
    // `nahel log` refuses every self-recorded type by name; a doc teaching one
    // would send every migrating agent into a hard exit 1.
    expect(SELF_RECORDED_EVENT_TYPES.has(MIGRATION_SELECTED_EVENT_TYPE)).toBe(false);
  });

  test("migration writes NODE records only: the node names the item, and no item is touched", async () => {
    const { body } = await shippedWorkflow("migrate-roadmap.md");
    expect(body).toContain("nahel roadmap node new product");
    expect(body).toContain("nahel roadmap node new feature");
    // F1's canonical direction: --epic is the one-way node → item reference.
    expect(body).toContain("--epic");
    expect(body).toContain("one-way");
    // And the check that proves it, spelled as a command a reader can run.
    expect(body).toContain("git diff");
    expect(body).toContain("nahel/items/");
  });

  test("coverage is checked after the fact: the set and the nodes match exactly", async () => {
    const { body } = await shippedWorkflow("migrate-roadmap.md");
    expect(body).toContain("nahel roadmap node show");
    expect(body).toContain("nahel validate");
    // Both directions, because either alone passes a broken migration.
    expect(body).toContain("no orphan");
    expect(body).toContain("nothing invented");
  });

  test("states the layer's rules: actor attribution, no hand-editing, and the degraded fallback", async () => {
    const { body } = await shippedWorkflow("migrate-roadmap.md");
    expect(body).toContain("NAHEL_ACTOR");
    expect(body).toContain("never hand-edit");
    expect(body).toContain("Fallback");
    // Migration is a once-per-store act; ordinary roadmap intent afterwards is
    // just `node new`, not a second migration.
    expect(body).toContain("once");
  });
});

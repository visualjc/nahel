import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CORE_EVENT_TYPES } from "../../src/schema/events";
import { generateId } from "../../src/schema/id";
import type { RoadmapNodeFrontmatter } from "../../src/schema/records";
import { mutate } from "../../src/store/mutate";
import { validateStore } from "../../src/validate";
import { findingsFor, setupFixture, signConstitution, type ValidateFixture } from "./helpers";

/**
 * Roadmap node integrity (Phase 4 F1). Every fixture is built through the real
 * mutation path; the corruptions a merge or a hand edit really produces
 * (dangling refs, duplicate slugs, odd shapes) are seeded on top. Severity
 * follows the PRD exactly: record-to-record refs the store owns are errors,
 * and the link rules F1 calls soft are warnings that never fail validate.
 */

let dirs: string[] = [];

afterEach(async () => {
  dirs = [];
});

async function setup(): Promise<ValidateFixture> {
  const fixture = await setupFixture(dirs);
  await signConstitution(fixture);
  return fixture;
}

/** Create a node through the choke point (journaled + written, in sync). */
async function createNode(
  fixture: ValidateFixture,
  overrides: Partial<RoadmapNodeFrontmatter> = {},
  body = "intent\n",
): Promise<RoadmapNodeFrontmatter> {
  const ts = fixture.env.now();
  const frontmatter: RoadmapNodeFrontmatter = {
    id: generateId(fixture.env),
    name: "a-node",
    kind: "feature",
    horizon: "now",
    adrs: [],
    features: [],
    created: ts,
    updated: ts,
    ...overrides,
  };
  await mutate(fixture.agent, {
    target: "roadmap-node",
    eventType: CORE_EVENT_TYPES.roadmapNodeCreated,
    frontmatter,
    body,
  });
  return frontmatter;
}

/** A product node with one feature child under it — the well-formed baseline. */
async function healthyTree(fixture: ValidateFixture) {
  const product = await createNode(fixture, { kind: "product", name: "nahel" });
  const feature = await createNode(fixture, {
    name: "detached-state-repo",
    parent: product.id,
  });
  return { product, feature };
}

describe("validate — a well-formed roadmap reports nothing", () => {
  test("product → features, an initiative linking two of them, and existing ADR files: clean", async () => {
    const fixture = await setup();
    const { product, feature } = await healthyTree(fixture);
    const second = await createNode(fixture, { name: "changelog", parent: product.id });
    await createNode(fixture, {
      kind: "initiative",
      name: "developer-experience",
      parent: product.id,
      features: [feature.id, second.id],
    });
    await mkdir(join(fixture.root, "docs/adr"), { recursive: true });
    await writeFile(join(fixture.root, "docs/adr/0012-merge-safe-state.md"), "# ADR 12\n");
    await createNode(fixture, {
      kind: "product",
      name: "with-adrs",
      adrs: ["docs/adr/0012-merge-safe-state.md"],
    });

    const findings = await validateStore(fixture.layout);
    expect(findings.filter((f) => f.check.includes("roadmap"))).toEqual([]);
  });

  test("a store with no roadmap at all reports nothing — the directory is absent, not broken", async () => {
    const fixture = await setup();
    const findings = await validateStore(fixture.layout);
    expect(findings.filter((f) => f.check.includes("roadmap"))).toEqual([]);
  });
});

describe("validate — dangling node references", () => {
  test("a parent naming no node is an ERROR (nodes are never deleted), naming both ends", async () => {
    const fixture = await setup();
    const orphan = await createNode(fixture, { name: "orphan", parent: "zzzzzzzz" });

    const findings = findingsFor(await validateStore(fixture.layout), "refs.roadmap-parent");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain(orphan.id);
    expect(findings[0]!.message).toContain("zzzzzzzz");
  });

  test("a predecessor naming no node is a WARNING naming both ends (F1)", async () => {
    const fixture = await setup();
    const { product } = await healthyTree(fixture);
    const successor = await createNode(fixture, {
      name: "search-v2",
      parent: product.id,
      predecessor: "zzzzzzzz",
    });

    const findings = findingsFor(await validateStore(fixture.layout), "roadmap.predecessor-missing");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.message).toContain(successor.id);
    expect(findings[0]!.message).toContain("zzzzzzzz");
  });

  test("an initiative link to a missing node is a WARNING naming both ends", async () => {
    const fixture = await setup();
    const { product, feature } = await healthyTree(fixture);
    const initiative = await createNode(fixture, {
      kind: "initiative",
      name: "theme",
      parent: product.id,
      features: [feature.id, "zzzzzzzz"],
    });

    const findings = findingsFor(await validateStore(fixture.layout), "roadmap.initiative-link");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.message).toContain(initiative.id);
    expect(findings[0]!.message).toContain("zzzzzzzz");
  });

  test("an initiative link to a node that is NOT a feature is a WARNING naming both ends and the kind", async () => {
    const fixture = await setup();
    const { product } = await healthyTree(fixture);
    const initiative = await createNode(fixture, {
      kind: "initiative",
      name: "theme",
      parent: product.id,
      features: [product.id],
    });

    const findings = findingsFor(await validateStore(fixture.layout), "roadmap.initiative-link");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.message).toContain(initiative.id);
    expect(findings[0]!.message).toContain(product.id);
    expect(findings[0]!.message).toContain("product");
  });
});

describe("validate — ADR cross-references (F1)", () => {
  test("an ADR reference with no file on disk is a WARNING naming the node and the path", async () => {
    const fixture = await setup();
    const node = await createNode(fixture, {
      kind: "product",
      name: "nahel",
      adrs: ["docs/adr/0004-determinism.md", "docs/adr/0099-never-written.md"],
    });
    await mkdir(join(fixture.root, "docs/adr"), { recursive: true });
    await writeFile(join(fixture.root, "docs/adr/0004-determinism.md"), "# ADR 4\n");

    const findings = findingsFor(await validateStore(fixture.layout), "roadmap.adr-missing");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.message).toContain(node.id);
    expect(findings[0]!.message).toContain("docs/adr/0099-never-written.md");
    // Never an error and never a refused mutation: the node is still there.
    expect((await validateStore(fixture.layout)).some((f) => f.severity === "error")).toBe(false);
  });
});

describe("validate — soft structural shape (F1: warned about, never refused)", () => {
  test("a feature parented to a feature warns, naming the node", async () => {
    const fixture = await setup();
    const { product, feature } = await healthyTree(fixture);
    const nested = await createNode(fixture, { name: "nested", parent: feature.id });

    const findings = findingsFor(await validateStore(fixture.layout), "roadmap.shape");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.message).toContain(nested.id);
    expect(findings[0]!.message).toContain(feature.id);
    // The product and its direct feature child are fine.
    expect(findings[0]!.message).not.toContain(product.id);
  });

  test("a node with no product ancestor warns, naming the node", async () => {
    const fixture = await setup();
    const rootless = await createNode(fixture, { name: "rootless" });

    const findings = findingsFor(await validateStore(fixture.layout), "roadmap.shape");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.message).toContain(rootless.id);
    expect(findings[0]!.message).toContain("product");
  });

  test("a product node with no parent is the ROOT, not a finding", async () => {
    const fixture = await setup();
    await createNode(fixture, { kind: "product", name: "nahel" });
    expect(findingsFor(await validateStore(fixture.layout), "roadmap.shape")).toEqual([]);
  });

  test("a parent cycle does not hang the ancestor walk — it warns like any rootless node", async () => {
    const fixture = await setup();
    const a = await createNode(fixture, { name: "a" });
    const b = await createNode(fixture, { name: "b", parent: a.id });
    await mutate(fixture.agent, {
      target: "roadmap-node",
      eventType: CORE_EVENT_TYPES.roadmapNodeUpdated,
      frontmatter: { ...a, parent: b.id, updated: fixture.env.now() },
      body: "intent\n",
    });

    const findings = findingsFor(await validateStore(fixture.layout), "roadmap.shape");
    expect(findings).toHaveLength(2);
    for (const finding of findings) expect(finding.severity).toBe("warning");
  });
});

describe("validate — slug uniqueness after a merge", () => {
  test("two nodes sharing a slug is an ERROR naming both ids (the CLI refuses it; a merge does not)", async () => {
    const fixture = await setup();
    const first = await createNode(fixture, { kind: "product", name: "nahel" });
    // A merge brings in a second node with the same slug: disjoint FILES, so
    // git merges both cleanly and only validate can see the collision.
    const second = await createNode(fixture, {
      kind: "product",
      name: "temp-name",
    });
    await mutate(fixture.agent, {
      target: "roadmap-node",
      eventType: CORE_EVENT_TYPES.roadmapNodeUpdated,
      frontmatter: { ...second, name: "nahel", updated: fixture.env.now() },
      body: "intent\n",
    });

    const findings = findingsFor(await validateStore(fixture.layout), "roadmap.duplicate-name");
    expect(findings.length).toBeGreaterThan(0);
    const message = findings.map((f) => f.message).join(" ");
    expect(findings[0]!.severity).toBe("error");
    expect(message).toContain("nahel");
    expect(message).toContain(first.id);
    expect(message).toContain(second.id);
  });
});

describe("validate — node records are schema-checked and journal-compared like every other record", () => {
  test("a hand-corrupted node record is a schema error naming the file", async () => {
    const fixture = await setup();
    const node = await createNode(fixture, { name: "corrupted" });
    await writeFile(
      join(fixture.layout.roadmapDir, `${node.id}.md`),
      `---\nid: ${node.id}\nname: corrupted\nkind: epic\n---\nintent\n`,
    );

    const findings = findingsFor(await validateStore(fixture.layout), "schema.roadmap-node");
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.path).toContain(`${node.id}.md`);
  });

  test("a node record behind its journal event is journal.divergence, repairable — not a payload error", async () => {
    const fixture = await setup();
    const node = await createNode(fixture, { name: "behind" });
    // Hand-revert the record while the journal keeps the truth (the crash
    // window, or a bad hand edit).
    await writeFile(
      join(fixture.layout.roadmapDir, `${node.id}.md`),
      `---\nid: ${node.id}\nname: behind\nkind: feature\nhorizon: later\nadrs: []\nfeatures: []\ncreated: ${node.created}\nupdated: ${node.updated}\n---\nintent\n`,
    );

    const findings = await validateStore(fixture.layout);
    const divergence = findingsFor(findings, "journal.divergence");
    expect(divergence).toHaveLength(1);
    expect(divergence[0]!.message).toContain(node.id);
    // A roadmap mutation event is REPLAYABLE: it must never be reported as an
    // unreplayable payload just because the checker did not know its target.
    expect(findingsFor(findings, "journal.payload")).toEqual([]);
  });

  test("an in-sync roadmap node produces no journal findings at all", async () => {
    const fixture = await setup();
    await healthyTree(fixture);
    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, "journal.payload")).toEqual([]);
    expect(findingsFor(findings, "journal.divergence")).toEqual([]);
  });
});

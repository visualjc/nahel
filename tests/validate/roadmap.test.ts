import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CORE_EVENT_TYPES,
  QA_SWEEP_EVENT_TYPE,
  RELEASE_ANNOUNCED_EVENT_TYPE,
} from "../../src/schema/events";
import { appendEvent, readJournal } from "../../src/store/journal";
import { generateId } from "../../src/schema/id";
import type { JournalEvent, RoadmapNodeFrontmatter } from "../../src/schema/records";
import { mutate } from "../../src/store/mutate";
import { validateStore } from "../../src/validate";
import {
  createItem,
  findingsFor,
  setupFixture,
  signConstitution,
  type ValidateFixture,
} from "./helpers";

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

  test("a node that is its own parent warns, naming the self-loop — and the walk terminates", async () => {
    const fixture = await setup();
    const node = await createNode(fixture, { name: "selfish" });
    await mutate(fixture.agent, {
      target: "roadmap-node",
      eventType: CORE_EVENT_TYPES.roadmapNodeUpdated,
      frontmatter: { ...node, parent: node.id, updated: fixture.env.now() },
      body: "intent\n",
    });

    const findings = findingsFor(await validateStore(fixture.layout), "roadmap.shape");
    const selfLoop = findings.filter((f) => f.message.includes("its own parent"));
    expect(selfLoop).toHaveLength(1);
    expect(selfLoop[0]!.severity).toBe("warning");
    expect(selfLoop[0]!.message).toContain(node.id);
  });

  test("a node that is its own predecessor warns — lineage cannot start at itself", async () => {
    const fixture = await setup();
    const { product } = await healthyTree(fixture);
    const node = await createNode(fixture, { name: "loop", parent: product.id });
    await mutate(fixture.agent, {
      target: "roadmap-node",
      eventType: CORE_EVENT_TYPES.roadmapNodeUpdated,
      frontmatter: {
        ...node,
        parent: product.id,
        predecessor: node.id,
        updated: fixture.env.now(),
      },
      body: "intent\n",
    });

    const findings = findingsFor(await validateStore(fixture.layout), "roadmap.shape");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.message).toContain(node.id);
    expect(findings[0]!.message).toContain("its own predecessor");
    // A warning, never an error: nothing about it was refused at write time.
    expect((await validateStore(fixture.layout)).some((f) => f.severity === "error")).toBe(false);
  });

  test("an initiative linking fewer than two features warns — cardinality is judged HERE, not by the schema", async () => {
    const fixture = await setup();
    const { product, feature } = await healthyTree(fixture);
    const thin = await createNode(fixture, {
      kind: "initiative",
      name: "thin-theme",
      parent: product.id,
      features: [feature.id],
    });
    const empty = await createNode(fixture, {
      kind: "initiative",
      name: "empty-theme",
      parent: product.id,
    });

    const cardinality = findingsFor(
      await validateStore(fixture.layout),
      "roadmap.shape",
    ).filter((f) => f.message.includes("sideways"));
    expect(cardinality).toHaveLength(2);
    for (const finding of cardinality) expect(finding.severity).toBe("warning");
    const message = cardinality.map((f) => f.message).join(" ");
    expect(message).toContain(thin.id);
    expect(message).toContain(empty.id);
  });

  test("a record omitting adrs/features reads as empty and is judged softly — never a schema error", async () => {
    const fixture = await setup();
    const { product } = await healthyTree(fixture);
    const node = await createNode(fixture, { name: "bare", parent: product.id });
    // The shape a hand edit or an older writer produces: no link-list keys.
    await writeFile(
      join(fixture.layout.roadmapDir, `${node.id}.md`),
      `---\nid: ${node.id}\nname: bare\nkind: feature\nhorizon: now\nparent: ${product.id}\ncreated: ${node.created}\nupdated: ${node.updated}\n---\nintent\n`,
    );

    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, "schema.roadmap-node")).toEqual([]);
    expect(findingsFor(findings, "roadmap.shape")).toEqual([]);
    expect(findingsFor(findings, "roadmap.initiative-link")).toEqual([]);
    expect(findingsFor(findings, "roadmap.adr-missing")).toEqual([]);
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

    // Both shape rules fire for both members and the walk terminates: each is
    // a feature under a feature, and neither can reach a product.
    const findings = findingsFor(await validateStore(fixture.layout), "roadmap.shape");
    expect(findings).toHaveLength(4);
    for (const finding of findings) expect(finding.severity).toBe("warning");
    expect(findings.filter((f) => f.message.includes("no product ancestor"))).toHaveLength(2);
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

/**
 * The two derivation anomalies F2 turns into warnings (Phase 4 F2). Both are
 * advisory: the rollup still derives a status, nothing was refused at write
 * time, and neither fails `nahel validate`.
 */
describe("validate — the F2 derivation warnings", () => {
  test("a node naming an epic no item record carries is a warning naming both ends", async () => {
    const fixture = await setup();
    const product = await createNode(fixture, { kind: "product", name: "nahel" });
    const node = await createNode(fixture, {
      name: "dangling-epic",
      parent: product.id,
      epic: "aaaaaaaa",
    });

    const findings = await validateStore(fixture.layout);
    const epicMissing = findingsFor(findings, "roadmap.epic-missing");
    expect(epicMissing).toHaveLength(1);
    expect(epicMissing[0]!.severity).toBe("warning");
    expect(epicMissing[0]!.path).toContain(`${node.id}.md`);
    expect(epicMissing[0]!.message).toContain(node.id);
    expect(epicMissing[0]!.message).toContain("dangling-epic");
    expect(epicMissing[0]!.message).toContain("aaaaaaaa");
    // Advisory only — a dangling epic never fails validate.
    expect(findings.filter((finding) => finding.severity === "error")).toEqual([]);
  });

  test("an epic whose every child was dropped is a warning naming the node and the epic", async () => {
    const fixture = await setup();
    const product = await createNode(fixture, { kind: "product", name: "nahel" });
    const epic = await createItem(fixture, { name: "demo-epic", type: "plan", lane: "full" });
    await createItem(fixture, { name: "abandoned", status: "dropped", parent: epic.id });
    const node = await createNode(fixture, {
      name: "all-dropped-feature",
      parent: product.id,
      epic: epic.id,
    });

    const findings = await validateStore(fixture.layout);
    const dropped = findingsFor(findings, "roadmap.epic-all-dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.severity).toBe("warning");
    expect(dropped[0]!.path).toContain(`${node.id}.md`);
    expect(dropped[0]!.message).toContain("all-dropped-feature");
    expect(dropped[0]!.message).toContain(epic.id);
    expect(findings.filter((finding) => finding.severity === "error")).toEqual([]);
  });

  test("a healthy epic — one live child — warns about neither", async () => {
    const fixture = await setup();
    const product = await createNode(fixture, { kind: "product", name: "nahel" });
    const epic = await createItem(fixture, { name: "demo-epic", type: "plan", lane: "full" });
    await createItem(fixture, { name: "live-work", status: "in-progress", parent: epic.id });
    await createNode(fixture, { name: "healthy-feature", parent: product.id, epic: epic.id });

    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, "roadmap.epic-missing")).toEqual([]);
    expect(findingsFor(findings, "roadmap.epic-all-dropped")).toEqual([]);
  });

  test("an EMPTY epic warns about neither — no children is not the same as all dropped", async () => {
    const fixture = await setup();
    const product = await createNode(fixture, { kind: "product", name: "nahel" });
    const epic = await createItem(fixture, { name: "demo-epic", type: "plan", lane: "full" });
    await createNode(fixture, { name: "empty-feature", parent: product.id, epic: epic.id });

    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, "roadmap.epic-missing")).toEqual([]);
    expect(findingsFor(findings, "roadmap.epic-all-dropped")).toEqual([]);
  });

  test("a node with no epic at all warns about neither", async () => {
    const fixture = await setup();
    await healthyTree(fixture);

    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, "roadmap.epic-missing")).toEqual([]);
    expect(findingsFor(findings, "roadmap.epic-all-dropped")).toEqual([]);
  });

  test("an epic whose record is on disk but UNPARSEABLE is a schema error, not epic-missing", async () => {
    const fixture = await setup();
    const product = await createNode(fixture, { kind: "product", name: "nahel" });
    const epic = await createItem(fixture, { name: "demo-epic", type: "plan", lane: "full" });
    await createNode(fixture, { name: "a-feature", parent: product.id, epic: epic.id });
    await writeFile(
      join(fixture.layout.itemsDir, `${epic.id}.md`),
      `---\nid: ${epic.id}\nname: demo-epic\ntype: nonsense\n---\n`,
    );

    const findings = await validateStore(fixture.layout);
    // The unreadable epic is reported ONCE, as what it is: a corrupt record.
    expect(findingsFor(findings, "schema.item").length).toBeGreaterThan(0);
    expect(findingsFor(findings, "roadmap.epic-missing")).toEqual([]);
  });
});

/**
 * The PRD lifecycle (Phase 4 F10): a PRD is live until its feature is
 * released, and archived after. Both halves of that sentence are `validate`
 * warnings when they come apart — a released feature still pointing at a live
 * document, and a node still being built pointing into the archive, which is
 * the signal that someone is working against a CLOSED delta instead of
 * opening a new node.
 */
describe("validate — the PRD lifecycle (F10)", () => {
  /**
   * The payload of an ARCHIVAL-QUALIFIED release (A3): the three keys the
   * archival verb demands, so a case that drops one is asking about the gate
   * rather than about the lifecycle.
   */
  const FULL_RELEASE = {
    version: "0.3.0",
    channel: "github",
    announcement: "https://github.com/visualjc/nahel/releases/tag/v0.3.0",
  };

  /** A feature node covering an epic, with a `release.announced` over it. */
  async function releasedFeature(
    fixture: ValidateFixture,
    prd: string,
    release: Record<string, unknown> = FULL_RELEASE,
  ) {
    const product = await createNode(fixture, { kind: "product", name: "nahel" });
    const epic = await createItem(fixture, { name: "shipped-epic", type: "plan", lane: "full" });
    const node = await createNode(fixture, {
      name: "detached-state-repo",
      parent: product.id,
      epic: epic.id,
      prd,
    });
    const announced = await appendEvent(fixture.layout, fixture.env, {
      type: RELEASE_ANNOUNCED_EVENT_TYPE,
      actor: { kind: "agent", id: "claude-code" },
      item: epic.id,
      payload: release,
      session: fixture.agent.session,
    });
    return { product, epic, node, announced };
  }

  async function writeDoc(fixture: ValidateFixture, path: string): Promise<void> {
    await mkdir(join(fixture.root, path, ".."), { recursive: true });
    await writeFile(join(fixture.root, path), "# a document\n");
  }

  test("a released feature whose PRD is still live is a WARNING naming the node and the path", async () => {
    const fixture = await setup();
    const { node } = await releasedFeature(fixture, "docs/prds/detached-state.md");
    await writeDoc(fixture, "docs/prds/detached-state.md");

    const findings = findingsFor(await validateStore(fixture.layout), "roadmap.prd-unarchived");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.message).toContain(node.id);
    expect(findings[0]!.message).toContain("docs/prds/detached-state.md");
    expect(findings[0]!.fix).toContain("nahel roadmap archive");
  });

  test("the same feature, archived, reports nothing at all", async () => {
    const fixture = await setup();
    await releasedFeature(fixture, "docs/prds/archived/detached-state.md");
    await writeDoc(fixture, "docs/prds/archived/detached-state.md");

    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, "roadmap.prd-unarchived")).toEqual([]);
    expect(findingsFor(findings, "roadmap.closed-delta")).toEqual([]);
    expect(findingsFor(findings, "roadmap.prd-missing")).toEqual([]);
  });

  test("a node that is NOT released pointing into the archive is the closed-delta WARNING", async () => {
    const fixture = await setup();
    const product = await createNode(fixture, { kind: "product", name: "nahel" });
    const node = await createNode(fixture, {
      name: "detached-state-repo-again",
      parent: product.id,
      prd: "docs/prds/archived/detached-state.md",
    });
    await writeDoc(fixture, "docs/prds/archived/detached-state.md");

    const findings = findingsFor(await validateStore(fixture.layout), "roadmap.closed-delta");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.message).toContain(node.id);
    expect(findings[0]!.message).toContain("docs/prds/archived/detached-state.md");
    // The fix is the doctrine: a new node with a new PRD, not a reopened one.
    expect(findings[0]!.fix).toContain("predecessor");
  });

  test("a successor node with its OWN live PRD, naming the released one as predecessor, is clean", async () => {
    const fixture = await setup();
    const { node } = await releasedFeature(fixture, "docs/prds/archived/detached-state.md");
    await writeDoc(fixture, "docs/prds/archived/detached-state.md");
    await createNode(fixture, {
      name: "detached-state-repo-v2",
      parent: node.parent!,
      predecessor: node.id,
      prd: "docs/prds/detached-state-v2.md",
    });
    await writeDoc(fixture, "docs/prds/detached-state-v2.md");

    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, "roadmap.closed-delta")).toEqual([]);
    expect(findingsFor(findings, "roadmap.prd-unarchived")).toEqual([]);
    expect(findingsFor(findings, "roadmap.predecessor-missing")).toEqual([]);
  });

  test("a node whose `prd` names no file on disk is a WARNING — the item-side rule, node side", async () => {
    const fixture = await setup();
    const product = await createNode(fixture, { kind: "product", name: "nahel" });
    const node = await createNode(fixture, {
      name: "unwritten",
      parent: product.id,
      prd: "docs/prds/never-written.md",
    });

    const findings = findingsFor(await validateStore(fixture.layout), "roadmap.prd-missing");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.message).toContain(node.id);
    expect(findings[0]!.message).toContain("docs/prds/never-written.md");
  });
});

/**
 * Lifecycle-fact retraction (PR #26 follow-up A1). A retraction is an ordinary
 * logged event, so nothing about it is refused at write time — which is
 * exactly why `validate` has to read it back. Three shapes are worth saying,
 * and all three are WARNINGS: the derivation ignores an invalid retraction, so
 * the store still renders, it just renders as though the retraction were not
 * there.
 */
describe("validate — retracted lifecycle facts (A1)", () => {
  const COLUMN_RETRACTED = "roadmap.column-retracted";

  /** A feature node over an epic, with one covering sweep already logged. */
  async function sweptFeature(fixture: ValidateFixture) {
    const product = await createNode(fixture, { kind: "product", name: "nahel" });
    const epic = await createItem(fixture, { name: "swept-epic", type: "plan", lane: "full" });
    await createItem(fixture, { name: "leaf-work", status: "done", parent: epic.id });
    const node = await createNode(fixture, {
      name: "swept-feature",
      parent: product.id,
      epic: epic.id,
    });
    const sweep = await appendEvent(fixture.layout, fixture.env, {
      type: QA_SWEEP_EVENT_TYPE,
      actor: { kind: "agent", id: "claude-code" },
      item: epic.id,
      payload: { failed: 0 },
      session: fixture.agent.session,
    });
    return { product, epic, node, sweep };
  }

  /** Log one retraction with the payload given. */
  async function retract(
    fixture: ValidateFixture,
    payload: Record<string, unknown>,
  ): Promise<JournalEvent> {
    return appendEvent(fixture.layout, fixture.env, {
      type: COLUMN_RETRACTED,
      actor: { kind: "agent", id: "claude-code" },
      payload,
      session: fixture.agent.session,
    });
  }

  test("a retraction naming an event id the journal does not carry is a WARNING", async () => {
    const fixture = await setup();
    await sweptFeature(fixture);
    const retraction = await retract(fixture, { event: "zzzzzzzz", reason: "wrong epic" });

    const findings = findingsFor(
      await validateStore(fixture.layout),
      "roadmap.retraction-target-missing",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.message).toContain(retraction.id);
    expect(findings[0]!.message).toContain("zzzzzzzz");
    // It may still resolve: the event it names can arrive by a later merge.
    expect(findings[0]!.fix).toContain("merge");
  });

  test("a retraction naming a NON-lifecycle event is a WARNING naming the type it found", async () => {
    const fixture = await setup();
    const { node } = await sweptFeature(fixture);
    // The node's own creation act — a real event, and not a retractable fact.
    const events = await Array.fromAsync(readJournal(fixture.layout));
    const creation = events.find(
      (event) =>
        event.type === CORE_EVENT_TYPES.roadmapNodeCreated &&
        JSON.stringify(event.payload).includes(node.id),
    )!;
    const retraction = await retract(fixture, { event: creation.id, reason: "mistake" });

    const findings = findingsFor(
      await validateStore(fixture.layout),
      "roadmap.retraction-target-kind",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.message).toContain(retraction.id);
    expect(findings[0]!.message).toContain(creation.id);
    expect(findings[0]!.message).toContain(CORE_EVENT_TYPES.roadmapNodeCreated);
  });

  test("a retraction naming ANOTHER retraction is the same WARNING — retractions are not facts", async () => {
    const fixture = await setup();
    const { sweep } = await sweptFeature(fixture);
    const first = await retract(fixture, { event: sweep.id, reason: "wrong epic" });
    await retract(fixture, { event: first.id, reason: "changed my mind" });

    const findings = findingsFor(
      await validateStore(fixture.layout),
      "roadmap.retraction-target-kind",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain(first.id);
    // The fix is the doctrine: re-log the fact, never un-retract the retraction.
    expect(findings[0]!.fix).toContain("re-log");
  });

  test("a retraction with no readable `event`, or no reason, is MALFORMED", async () => {
    const fixture = await setup();
    const { sweep } = await sweptFeature(fixture);
    const noTarget = await retract(fixture, { reason: "forgot the target" });
    const blankTarget = await retract(fixture, { event: "   ", reason: "blank" });
    const noReason = await retract(fixture, { event: sweep.id });
    const blankReason = await retract(fixture, { event: sweep.id, reason: "  " });

    const findings = findingsFor(
      await validateStore(fixture.layout),
      "roadmap.retraction-malformed",
    );
    expect(findings).toHaveLength(4);
    expect(findings.every((finding) => finding.severity === "warning")).toBe(true);
    const messages = findings.map((finding) => finding.message).join("\n");
    for (const event of [noTarget, blankTarget, noReason, blankReason]) {
      expect(messages).toContain(event.id);
    }
  });

  test("a well-formed retraction of a real sweep reports NOTHING, and fails nothing", async () => {
    const fixture = await setup();
    const { sweep } = await sweptFeature(fixture);
    await retract(fixture, { event: sweep.id, reason: "logged against the wrong epic" });

    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, "roadmap.retraction-target-missing")).toEqual([]);
    expect(findingsFor(findings, "roadmap.retraction-target-kind")).toEqual([]);
    expect(findingsFor(findings, "roadmap.retraction-malformed")).toEqual([]);
    expect(findings.filter((finding) => finding.severity === "error")).toEqual([]);
  });
});

/**
 * The sweep count the stage rests on (PR #26 follow-up A2). The stage advances
 * to `tested` only on `failed === 0` exactly, so a winning sweep whose count is
 * missing, non-numeric or negative silently holds the feature at its dev row.
 * Silently is the problem: the workflow that logged it believes it recorded a
 * pass. A WARNING names the sweep and says what the stage did instead.
 *
 * A count GREATER than zero is not a defect — it is a sweep that found
 * failures, recorded correctly — so it warns about nothing.
 */
describe("validate — an unreadable sweep count (A2)", () => {
  /** A feature node whose epic holds one done leaf, plus one covering sweep. */
  async function sweptWith(fixture: ValidateFixture, payload: Record<string, unknown>) {
    const product = await createNode(fixture, { kind: "product", name: "nahel" });
    const epic = await createItem(fixture, { name: "swept-epic", type: "plan", lane: "full" });
    await createItem(fixture, { name: "leaf-work", status: "done", parent: epic.id });
    const node = await createNode(fixture, {
      name: "swept-feature",
      parent: product.id,
      epic: epic.id,
    });
    const sweep = await appendEvent(fixture.layout, fixture.env, {
      type: QA_SWEEP_EVENT_TYPE,
      actor: { kind: "agent", id: "claude-code" },
      item: epic.id,
      payload,
      session: fixture.agent.session,
    });
    return { node, epic, sweep };
  }

  test("a sweep with no `failed` count is a WARNING naming the sweep and the node", async () => {
    const fixture = await setup();
    const { node, sweep } = await sweptWith(fixture, { suite: "unit" });

    const findings = findingsFor(
      await validateStore(fixture.layout),
      "roadmap.sweep-failed-count",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.path).toContain(`${node.id}.md`);
    expect(findings[0]!.message).toContain(sweep.id);
    expect(findings[0]!.message).toContain("swept-feature");
    // It says what the stage did instead of advancing.
    expect(findings[0]!.message).toContain("built");
    expect(findings.filter((finding) => finding.severity === "error")).toEqual([]);
  });

  test("a non-numeric and a negative count are the same WARNING", async () => {
    for (const payload of [{ failed: "none" }, { failed: -1 }]) {
      const fixture = await setup();
      await sweptWith(fixture, payload);
      const findings = findingsFor(
        await validateStore(fixture.layout),
        "roadmap.sweep-failed-count",
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe("warning");
    }
  });

  test("failed = 0 and failed > 0 both warn about NOTHING — a found failure is not a defect", async () => {
    for (const payload of [{ failed: 0 }, { failed: 4 }]) {
      const fixture = await setup();
      await sweptWith(fixture, payload);
      expect(
        findingsFor(await validateStore(fixture.layout), "roadmap.sweep-failed-count"),
      ).toEqual([]);
    }
  });

  test("a RETRACTED unreadable sweep warns about nothing — it decides no column", async () => {
    const fixture = await setup();
    const { sweep } = await sweptWith(fixture, { suite: "unit" });
    await appendEvent(fixture.layout, fixture.env, {
      type: "roadmap.column-retracted",
      actor: { kind: "agent", id: "claude-code" },
      payload: { event: sweep.id, reason: "summarised from the wrong run" },
      session: fixture.agent.session,
    });

    expect(
      findingsFor(await validateStore(fixture.layout), "roadmap.sweep-failed-count"),
    ).toEqual([]);
  });
});

/**
 * The archival gate, read from the other side (PR #26 follow-up A3).
 * `roadmap.prd-unarchived` tells a human to run `nahel roadmap archive`, so it
 * must fire on exactly the nodes that verb ACCEPTS — a warning that names a
 * command which then refuses is a warning nobody can act on.
 *
 * The two now come from one predicate. A node whose stage reads `released` on a
 * release too thin to carry an archival is a different finding with a different
 * fix: re-log the release, and the PRD stays live until you do. Silence there
 * would be worse than either — the delta looks closed and nothing says why it
 * cannot be filed.
 */
describe("validate — stage released vs archival-qualified (A3)", () => {
  async function writeDoc(fixture: ValidateFixture, path: string): Promise<void> {
    await mkdir(join(fixture.root, path, ".."), { recursive: true });
    await writeFile(join(fixture.root, path), "# a document\n");
  }

  /** The same fixture the F10 block uses, with the release payload given. */
  async function feature(fixture: ValidateFixture, release: Record<string, unknown>) {
    const product = await createNode(fixture, { kind: "product", name: "nahel" });
    const epic = await createItem(fixture, { name: "shipped-epic", type: "plan", lane: "full" });
    const node = await createNode(fixture, {
      name: "detached-state-repo",
      parent: product.id,
      epic: epic.id,
      prd: "docs/prds/detached-state.md",
    });
    const announced = await appendEvent(fixture.layout, fixture.env, {
      type: RELEASE_ANNOUNCED_EVENT_TYPE,
      actor: { kind: "agent", id: "claude-code" },
      item: epic.id,
      payload: release,
      session: fixture.agent.session,
    });
    await writeDoc(fixture, "docs/prds/detached-state.md");
    return { node, epic, announced };
  }

  test("a release with only a version does NOT raise prd-unarchived — the verb would refuse", async () => {
    const fixture = await setup();
    await feature(fixture, { version: "0.3.0" });

    expect(findingsFor(await validateStore(fixture.layout), "roadmap.prd-unarchived")).toEqual([]);
  });

  test("it raises release-incomplete instead, naming the event and every missing key", async () => {
    const fixture = await setup();
    const { node, announced } = await feature(fixture, { version: "0.3.0", channel: "  " });

    const findings = findingsFor(
      await validateStore(fixture.layout),
      "roadmap.release-incomplete",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("warning");
    expect(findings[0]!.path).toContain(`${node.id}.md`);
    expect(findings[0]!.message).toContain(announced.id);
    expect(findings[0]!.message).toContain("channel");
    expect(findings[0]!.message).toContain("announcement");
    expect(findings[0]!.message).not.toContain("`version`");
    // Never the archival instruction: that command refuses this node.
    expect(findings[0]!.fix).not.toContain("nahel roadmap archive");
    expect(findings.filter((finding) => finding.severity === "error")).toEqual([]);
  });

  test("a complete release raises prd-unarchived and NOT release-incomplete", async () => {
    const fixture = await setup();
    await feature(fixture, {
      version: "0.3.0",
      channel: "github",
      announcement: "https://example.invalid/v0.3.0",
    });

    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, "roadmap.prd-unarchived")).toHaveLength(1);
    expect(findingsFor(findings, "roadmap.release-incomplete")).toEqual([]);
  });

  test("a RETRACTED release raises neither — the node is not released at all", async () => {
    const fixture = await setup();
    const { announced } = await feature(fixture, { version: "0.3.0" });
    await appendEvent(fixture.layout, fixture.env, {
      type: "roadmap.column-retracted",
      actor: { kind: "agent", id: "claude-code" },
      payload: { event: announced.id, reason: "announced against the wrong epic" },
      session: fixture.agent.session,
    });

    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, "roadmap.prd-unarchived")).toEqual([]);
    expect(findingsFor(findings, "roadmap.release-incomplete")).toEqual([]);
  });
});

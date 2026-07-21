import { afterEach, describe, expect, test } from "bun:test";
import { rm, unlink } from "node:fs/promises";
import { hotStatePath } from "../../src/store/hotstate";
import { ensureLayout, writeConfig } from "../../src/store/layout";
import { loadSnapshot } from "../../src/views/snapshot";
import { renderStatus } from "../../src/views/status";
import { makeConfig, makeFrontmatter, makeTempDir, seededEnv } from "../store/helpers";
import { buildPopulatedStore } from "./helpers";

/**
 * renderStatus (PRD F5): a PURE function snapshot → string. The work-item
 * tree via parent, type/status/lane per item, active runs with their phase,
 * claimed_by markers. Deterministic: same snapshot → byte-identical string.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("renderStatus — work-item tree", () => {
  test("renders the hierarchy: children indented under their parent, in creation order", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const rendered = renderStatus(await loadSnapshot(store.layout));
    const lines = rendered.split("\n");

    const epicLine = lines.findIndex((line) => line.includes("demo-epic"));
    const alphaLine = lines.findIndex((line) => line.includes("task-alpha"));
    const betaLine = lines.findIndex((line) => line.includes("task-beta"));
    const soloLine = lines.findIndex((line) => line.includes("solo-chore"));
    expect(epicLine).toBeGreaterThan(-1);
    // Children come right under their parent, before the next root.
    expect(alphaLine).toBeGreaterThan(epicLine);
    expect(betaLine).toBeGreaterThan(alphaLine);
    expect(soloLine).toBeGreaterThan(betaLine);
    // Children are indented one level deeper than their parent root.
    const indentOf = (line: string): number => line.length - line.trimStart().length;
    expect(indentOf(lines[alphaLine]!)).toBeGreaterThan(indentOf(lines[epicLine]!));
    expect(indentOf(lines[betaLine]!)).toBe(indentOf(lines[alphaLine]!));
    expect(indentOf(lines[soloLine]!)).toBe(indentOf(lines[epicLine]!));
  });

  test("every item line carries type, status, lane, and id", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const rendered = renderStatus(await loadSnapshot(store.layout));
    const lines = rendered.split("\n");

    const epicLine = lines.find((line) => line.includes("demo-epic"))!;
    expect(epicLine).toContain("plan");
    expect(epicLine).toContain("backlog");
    expect(epicLine).toContain("lane=full");
    expect(epicLine).toContain(`id=${store.epicId}`);

    const betaLine = lines.find((line) => line.includes("task-beta"))!;
    expect(betaLine).toContain("bug");
    expect(betaLine).toContain("in-progress");
    expect(betaLine).toContain("lane=direct");
    expect(betaLine).toContain(`id=${store.taskBetaId}`);
  });

  test("claimed items carry a claimed_by marker; unclaimed items carry none", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const rendered = renderStatus(await loadSnapshot(store.layout));
    const lines = rendered.split("\n");

    expect(lines.find((line) => line.includes("task-alpha"))).toContain("claimed_by=jim");
    for (const name of ["demo-epic", "task-beta", "solo-chore"]) {
      expect(lines.find((line) => line.includes(name))).not.toContain("claimed_by");
    }
  });

  test("an item with a missing parent record is rendered at the root and marked", () => {
    const env = seededEnv();
    const orphan = makeFrontmatter(env, { name: "orphan-item", parent: "zzzzzzzz" });
    const rendered = renderStatus({ items: [orphan], runs: [] });
    const line = rendered.split("\n").find((text) => text.includes("orphan-item"))!;
    expect(line).toContain("zzzzzzzz");
    expect(line).toContain("missing");
  });
});

describe("renderStatus — prd paths (F1, ADR-0013)", () => {
  test("with showPrd, an item carrying a prd renders prd=<path>; items without stay terse", () => {
    const env = seededEnv();
    const withPrd = makeFrontmatter(env, { name: "prd-item", prd: "docs/prds/auth.md" });
    const without = makeFrontmatter(env, { name: "plain-item" });
    const rendered = renderStatus({ items: [withPrd, without], runs: [] }, { showPrd: true });
    const lines = rendered.split("\n");
    expect(lines.find((line) => line.includes("prd-item"))).toContain("prd=docs/prds/auth.md");
    expect(lines.find((line) => line.includes("plain-item"))).not.toContain("prd=");
  });

  test("default rendering never shows prd — brief's composed item-statuses section stays terse", () => {
    const env = seededEnv();
    const withPrd = makeFrontmatter(env, { name: "prd-item", prd: "docs/prds/auth.md" });
    expect(renderStatus({ items: [withPrd], runs: [] })).not.toContain("prd=");
  });
});

describe("renderStatus — investigation paths (F5)", () => {
  test("with showInvestigation, an item carrying one renders investigation=<path>; items without stay terse", () => {
    const env = seededEnv();
    const bug = makeFrontmatter(env, {
      name: "bug-item",
      type: "bug",
      investigation: "docs/investigations/auth-500.md",
    });
    const without = makeFrontmatter(env, { name: "plain-item" });
    const rendered = renderStatus({ items: [bug, without], runs: [] }, { showInvestigation: true });
    const lines = rendered.split("\n");
    expect(lines.find((line) => line.includes("bug-item"))).toContain(
      "investigation=docs/investigations/auth-500.md",
    );
    expect(lines.find((line) => line.includes("plain-item"))).not.toContain("investigation=");
  });

  test("default rendering never shows investigation — brief's composed item-statuses section stays terse", () => {
    const env = seededEnv();
    const bug = makeFrontmatter(env, {
      name: "bug-item",
      type: "bug",
      investigation: "docs/investigations/auth-500.md",
    });
    expect(renderStatus({ items: [bug], runs: [] })).not.toContain("investigation=");
  });
});

describe("renderStatus — runs", () => {
  test("open runs are listed with item ref, phase, status, and start time; ended runs are not", async () => {
    const store = await buildPopulatedStore(tempDirs);
    const rendered = renderStatus(await loadSnapshot(store.layout));

    const runLine = rendered.split("\n").find((line) => line.includes(store.activeRunId))!;
    expect(runLine).toContain(`item=${store.taskBetaId}`);
    expect(runLine).toContain("phase=building");
    expect(runLine).toContain("status=active");
    expect(runLine).toMatch(/started=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);

    expect(rendered).not.toContain(store.endedRunId);
  });

  test("a run without hot state falls back to the run record's phase", async () => {
    const store = await buildPopulatedStore(tempDirs);
    await unlink(hotStatePath(store.layout, store.activeRunId));
    const rendered = renderStatus(await loadSnapshot(store.layout));
    expect(rendered.split("\n").find((line) => line.includes(store.activeRunId))).toContain(
      "phase=building",
    );
  });
});

describe("renderStatus — determinism and empty state", () => {
  test("an empty store renders explicit empty sections, not a blank string", async () => {
    const root = await makeTempDir("nahel-views-empty-");
    tempDirs.push(root);
    const layout = await ensureLayout(root);
    await writeConfig(layout, makeConfig());
    const rendered = renderStatus(await loadSnapshot(layout));
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).toContain("none");
  });

  test("same state → byte-identical output: repeated renders and identically-seeded stores agree", async () => {
    const a = await buildPopulatedStore(tempDirs, 99);
    const b = await buildPopulatedStore(tempDirs, 99);
    const snapshotA = await loadSnapshot(a.layout);
    expect(renderStatus(snapshotA)).toBe(renderStatus(snapshotA));
    expect(renderStatus(snapshotA)).toBe(renderStatus(await loadSnapshot(b.layout)));
  });
});

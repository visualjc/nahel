import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * F6's acceptance criteria, driven the way they are written: a store that has
 * a backlog and no roadmap is migrated by `nahel/workflows/migrate-roadmap.md`
 * read literally, in order, and the result is checked as COVERAGE — the set
 * the migration journaled and the nodes it produced must match exactly.
 *
 * The fixture is deliberately a judgment call, not a clean sweep: three
 * roadmap-shaped backlog items (one of them deliberately-future), a bug that
 * reads like a feature, a `feature`-typed item that is really a task under one
 * of the epics, a feature already delivered, and a chore nobody would mistake
 * for product intent. A migration that took "the feature-typed backlog items"
 * would get three of those wrong, which is why the selection is a judgment the
 * CLI never makes and the workflow journals before it acts.
 *
 * Like the journey and chart-map tests this file imports NOTHING from src/:
 * if the migration cannot be driven through the binary alone it is not
 * drivable by conversation (HC5), and the mechanism fails here.
 */

const CLI = join(import.meta.dir, "../../src/cli.ts");
/** The open-extension type the workflow doc teaches for the selected set. */
const MIGRATION_SELECTED = "roadmap.migration-selected";
/** The self-recorded type each `roadmap node new` writes (F1). */
const NODE_CREATED = "roadmap.node-created";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function nahel(cwd: string, ...args: string[]): CliResult {
  const result = spawnSync("bun", ["run", CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NAHEL_ACTOR: "agent:migration-agent" },
  });
  const output = { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  console.log(
    `$ nahel ${args.join(" ")}\n  exit ${output.code}` +
      (output.stdout.trim() === "" ? "" : `\n  stdout: ${output.stdout.trim()}`) +
      (output.stderr.trim() === "" ? "" : `\n  stderr: ${output.stderr.trim()}`),
  );
  return output;
}

function ok(result: CliResult, what: string): CliResult {
  if (result.code !== 0) {
    throw new Error(`${what} failed (exit ${result.code}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/** The payload of one `nahel progress` line — everything after the first `{`. */
function payloadOf(line: string): Record<string, unknown> {
  const at = line.indexOf("{");
  expect(at).toBeGreaterThan(-1);
  return JSON.parse(line.slice(at)) as Record<string, unknown>;
}

/** The `record` a mutation event carries, as a plain object of fields. */
function recordOf(line: string): Record<string, unknown> {
  const record = payloadOf(line)["record"];
  expect(typeof record).toBe("object");
  return record as Record<string, unknown>;
}

describe("E2E migration — a store's backlog becomes its first roadmap (F6)", () => {
  test(
    "migrate-roadmap.md through the public CLI: the set is journaled first, and the nodes match it exactly",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "nahel-migrate-"));
      tempDirs.push(root);
      git(root, "init", "--initial-branch=main");
      git(root, "config", "user.email", "test@nahel.test");
      git(root, "config", "user.name", "Nahel E2E");
      ok(nahel(root, "init"), "init");

      // ── the fixture store: a backlog, no roadmap ──────────────────────────
      const item = (type: string, name: string, lane: string, ...extra: string[]): string =>
        ok(nahel(root, "item", "new", type, name, lane, ...extra), `item new ${name}`).stdout.trim();

      // Roadmap-shaped: capabilities of the product nobody has built yet.
      const detached = item("feature", "detached-state-repo", "full");
      const changelog = item("feature", "changelog-and-product-updates", "epic-lite");
      // Deliberately future — coverage, so it gets a node on the `later` horizon.
      const mindmap = item("feature", "roadmap-mindmap-visualization", "full");

      // Near-misses: each one is arguable, so each one earns a journaled reason.
      const rotationBug = item("bug", "journal-rotation-drops-a-segment", "direct");
      const soft17 = item("feature", "dealer-soft-17-setting", "epic-lite");
      ok(nahel(root, "item", "update", soft17, "--status", "done"), "item update (delivered)");
      const flakyTest = item("feature", "retry-the-flaky-rotation-test", "direct",
        "--parent", detached);

      // Not a near-miss at all: nobody would file a dependency bump as product
      // intent, so the workflow's rule says it needs no line in the set.
      const bumpBun = item("chore", "bump-bun-to-1-2", "direct");

      git(root, "add", "-A");
      git(root, "commit", "-m", "fixture: a backlog and no roadmap");

      // ── step 1: enumerate the candidates FROM THE STORE ───────────────────
      const enumerated = ok(nahel(root, "status"), "status").stdout;
      for (const id of [detached, changelog, mindmap, rotationBug, soft17, flakyTest, bumpBun]) {
        expect(enumerated).toContain(`id=${id}`);
      }
      // The judgment is made off these two columns, so both must be readable.
      expect(enumerated).toContain("bug  backlog");
      expect(enumerated).toContain("chore  backlog");
      expect(enumerated).toContain("feature  done");

      // ── step 3: the selected set, BEFORE any node exists ──────────────────
      const included = [detached, changelog, mindmap];
      const excluded = [
        { id: rotationBug, reason: "a defect in shipped behaviour — work, not roadmap intent" },
        { id: soft17, reason: "already delivered — migration covers the backlog, not what shipped" },
        { id: flakyTest, reason: `a task under ${detached}'s epic, not a feature of the product` },
      ];
      ok(
        nahel(root, "log", MIGRATION_SELECTED,
          "--data", `included=${JSON.stringify(included)}`,
          "--data", `excluded=${JSON.stringify(excluded)}`),
        "log roadmap.migration-selected",
      );

      // ── step 4: the product node ──────────────────────────────────────────
      const product = ok(
        nahel(root, "roadmap", "node", "new", "product", "nahel", "--horizon", "now",
          "--intent", "Durable, tool-agnostic project state for agentic development.",
          "--design-doc", "docs/roadmap.md"),
        "roadmap node new (product)",
      ).stdout.trim();

      // ── step 5: one feature node per INCLUDED id, and no other ────────────
      const feature = (slug: string, horizon: string, epic: string, intent: string): string =>
        ok(
          nahel(root, "roadmap", "node", "new", "feature", slug, "--horizon", horizon,
            "--parent", product, "--epic", epic, "--intent", intent),
          `roadmap node new (${slug})`,
        ).stdout.trim();
      feature("detached-state-repo", "now", detached,
        "State that lives in its own repo, so a project's history is not the state's history.");
      feature("changelog-and-product-updates", "next", changelog,
        "What changed, rendered for the people who use the product rather than build it.");
      feature("roadmap-mindmap-visualization", "later", mindmap,
        "The tree as a picture — deliberately after the tree is worth looking at.");

      // ── AC 1: the set is the FIRST migration event, and it is complete ────
      const timeline = ok(nahel(root, "progress"), "progress").stdout.split("\n");
      const selections = timeline.filter((line) => line.includes(MIGRATION_SELECTED));
      expect(selections).toHaveLength(1);
      const selectionAt = timeline.indexOf(selections[0]!);
      const nodeLines = timeline.filter((line) => line.includes(NODE_CREATED));
      expect(nodeLines).toHaveLength(4); // one product + three features
      for (const line of nodeLines) expect(timeline.indexOf(line)).toBeGreaterThan(selectionAt);

      const set = payloadOf(selections[0]!);
      expect(set["included"]).toEqual(included);
      expect(set["excluded"]).toEqual(excluded);
      // Every near-miss carries a one-line reason — an id alone is an omission
      // a reviewer cannot argue with.
      for (const entry of set["excluded"] as { id: string; reason: string }[]) {
        expect(entry.reason.length).toBeGreaterThan(0);
      }
      // The chore is not a near-miss, so it is in neither list — the set names
      // the arguable calls, not every record in the store.
      expect(selections[0]!).not.toContain(bumpBun);

      // ── AC 2: the set and the nodes match EXACTLY, both directions ────────
      const featureRecords = nodeLines
        .map(recordOf)
        .filter((record) => record["kind"] === "feature");
      expect(featureRecords).toHaveLength(included.length);
      // Every node traces back to an id in the set — nothing invented.
      const covered = featureRecords.map((record) => record["epic"] as string);
      expect([...covered].sort()).toEqual([...included].sort());
      // …and read off the RECORDS, not just the events: every included id has a
      // node, addressed by the slug the migration gave it.
      for (const [slug, epic] of [
        ["detached-state-repo", detached],
        ["changelog-and-product-updates", changelog],
        ["roadmap-mindmap-visualization", mindmap],
      ] as const) {
        const shown = ok(nahel(root, "roadmap", "node", "show", slug), `node show ${slug}`).stdout;
        expect(shown).toContain(`epic=${epic}`);
        expect(shown).toContain(`parent=${product}`);
      }

      // ── AC 4: each migration act names the node and the item it covers ────
      for (const record of featureRecords) {
        expect(typeof record["name"]).toBe("string");
        expect(typeof record["epic"]).toBe("string");
        expect(included).toContain(record["epic"]);
      }

      // ── AC 3: `nahel roadmap` shows every migrated item, and only those ───
      const roadmap = ok(nahel(root, "roadmap"), "roadmap").stdout;
      expect(roadmap).toContain("nahel  product");
      expect(roadmap).toContain("now (1):");
      expect(roadmap).toContain("next (1):");
      expect(roadmap).toContain("later (1):");
      for (const slug of ["detached-state-repo", "changelog-and-product-updates",
        "roadmap-mindmap-visualization"]) {
        expect(roadmap).toContain(slug);
      }
      // No near-miss became a node behind the set's back.
      for (const name of ["journal-rotation-drops-a-segment", "dealer-soft-17-setting",
        "retry-the-flaky-rotation-test", "bump-bun-to-1-2"]) {
        expect(roadmap).not.toContain(name);
      }
      // The third generation is reachable from the node the item is under: the
      // excluded task shows up as WORK under its feature, which is why it never
      // needed a node of its own.
      const zoom = ok(nahel(root, "roadmap", "detached-state-repo"), "roadmap zoom").stdout;
      expect(zoom).toContain("retry-the-flaky-rotation-test");
      expect(zoom).toContain(`epic=${detached}`);

      // ── AC 5: node records only — every item record is byte-identical ─────
      const itemDiff = spawnSync("git", ["diff", "--exit-code", "--", "nahel/items/"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(itemDiff.stdout).toBe("");
      expect(itemDiff.status).toBe(0);
      expect(git(root, "status", "--porcelain", "--", "nahel/items/")).toBe("");
      // The roadmap records, by contrast, are new and untracked — the migration
      // did write, it just wrote on the other side of the reference.
      expect(git(root, "status", "--porcelain", "--", "nahel/roadmap/")).not.toBe("");

      // ── and the store is clean: none of this is a finding ─────────────────
      const validated = ok(nahel(root, "validate"), "validate (final)");
      expect(validated.stdout).not.toContain("error [");
      // The one warning this fixture does carry is its unsigned constitution —
      // every store with work on disk has it until a human signs — so the
      // assertion is that nothing about the ROADMAP is a finding, rather than
      // that the store is silent.
      expect(validated.stdout).not.toContain("roadmap");
    },
    { timeout: 180_000 },
  );
});

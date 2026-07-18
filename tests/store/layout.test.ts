import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureLayout,
  itemExists,
  itemPath,
  knowledgePaths,
  listItems,
  listRuns,
  observationPath,
  readConfig,
  readItem,
  readObservation,
  readRun,
  runDir,
  runRecordPath,
  storeLayout,
  writeConfig,
  writeItem,
  writeObservation,
  writeRun,
} from "../../src/store/layout";
import { makeConfig, makeFrontmatter, makeRun, makeTempDir, seededEnv } from "./helpers";

let dirs: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await makeTempDir();
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

describe("storeLayout / ensureLayout", () => {
  test("ensureLayout creates the full nahel/ directory structure per PRD F1", async () => {
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    expect(layout.root).toBe(root);
    for (const dir of [
      layout.nahelDir,
      layout.itemsDir,
      layout.runsDir,
      layout.journalDir,
      layout.journalArchiveDir,
      layout.observationsDir,
    ]) {
      expect((await stat(dir)).isDirectory()).toBe(true);
    }
    expect(layout.nahelDir).toBe(join(root, "nahel"));
    expect(layout.itemsDir).toBe(join(root, "nahel", "items"));
    expect(layout.runsDir).toBe(join(root, "nahel", "runs"));
    expect(layout.journalDir).toBe(join(root, "nahel", "journal"));
    expect(layout.journalArchiveDir).toBe(join(root, "nahel", "journal", "archive"));
    expect(layout.observationsDir).toBe(join(root, "nahel", "observations"));
    expect(layout.configPath).toBe(join(root, "nahel", "config"));
  });

  test("ensureLayout is idempotent: running twice never clobbers", async () => {
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    await writeConfig(layout, makeConfig());
    await ensureLayout(root);
    expect(await readConfig(layout)).toEqual(makeConfig());
  });
});

describe("config", () => {
  test("write/read round-trips a validated config", async () => {
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    const config = makeConfig();
    await writeConfig(layout, config);
    expect(await readConfig(layout)).toEqual(config);
  });

  test("readConfig gives an actionable error when nahel/config is missing", async () => {
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    expect(readConfig(layout)).rejects.toThrow(/config/);
  });

  test("readConfig rejects a config that fails schema validation", async () => {
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    await writeFile(layout.configPath, "knowledge:\n  product: PRODUCT.md\n");
    expect(readConfig(layout)).rejects.toThrow();
  });

  test("knowledgePaths resolves config-relative knowledge paths against the root", async () => {
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    const config = makeConfig();
    expect(knowledgePaths(layout, config)).toEqual({
      product: join(root, "PRODUCT.md"),
      context: join(root, "CONTEXT.md"),
      adr: join(root, "docs/adr"),
    });
  });

  // Containment (hard constraint 2, PR #12 review blocker 1): knowledgePaths
  // is the single resolution point, so it must refuse any path that is
  // absolute or does not resolve STRICTLY under the repo root.
  test("knowledgePaths refuses an absolute knowledge path", async () => {
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    const config = makeConfig({
      knowledge: { product: "/tmp/evil.md", context: "CONTEXT.md", adr: "docs/adr" },
    });
    expect(() => knowledgePaths(layout, config)).toThrow(/product/);
  });

  test("knowledgePaths refuses relative paths resolving above the root", async () => {
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    for (const knowledge of [
      { product: "../outside.md", context: "CONTEXT.md", adr: "docs/adr" },
      { product: "PRODUCT.md", context: "docs/../../outside.md", adr: "docs/adr" },
      { product: "PRODUCT.md", context: "CONTEXT.md", adr: "../adr" },
    ]) {
      expect(() => knowledgePaths(layout, makeConfig({ knowledge }))).toThrow(/repo/);
    }
  });

  test("knowledgePaths refuses a path resolving to the root itself (adr must be under it)", async () => {
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    const config = makeConfig({
      knowledge: { product: "PRODUCT.md", context: "CONTEXT.md", adr: "." },
    });
    expect(() => knowledgePaths(layout, config)).toThrow(/adr/);
  });

  test("knowledgePaths refuses a sibling-prefix escape (root '/a' vs '/a-evil')", async () => {
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    // Resolves to `${root}-evil/x.md`: starts with the root STRING but is
    // outside the root DIRECTORY — the classic prefix-check bug, pinned down.
    const config = makeConfig({
      knowledge: {
        product: `../${root.split("/").pop()}-evil/x.md`,
        context: "CONTEXT.md",
        adr: "docs/adr",
      },
    });
    expect(() => knowledgePaths(layout, config)).toThrow(/repo/);
  });
});

describe("path hardening — ids validated before any join (PR #12 review blocker 2)", () => {
  // Verified escape: `nahel item update ../../PRODUCT` read the repo-root
  // PRODUCT.md through itemPath's unvalidated join. The path helpers are the
  // single choke points, so they refuse any id failing ID_PATTERN.
  const badIds = [
    "../../PRODUCT",
    "..",
    "a/bcdefgh",
    "/tmp/evil",
    "ABCDEFGH", // uppercase — not in the id alphabet
    "abc1234", // 7 chars
    "",
  ];

  test("itemPath refuses traversal, absolute, and malformed ids", async () => {
    const layout = storeLayout(await tempRoot());
    for (const id of badIds) {
      expect(() => itemPath(layout, id)).toThrow(/invalid item id/);
    }
  });

  test("runDir and runRecordPath refuse invalid run ids", async () => {
    const layout = storeLayout(await tempRoot());
    for (const id of badIds) {
      expect(() => runDir(layout, id)).toThrow(/invalid run id/);
      expect(() => runRecordPath(layout, id)).toThrow(/invalid run id/);
    }
  });

  test("observationPath refuses invalid observation ids", async () => {
    const layout = storeLayout(await tempRoot());
    for (const id of badIds) {
      expect(() => observationPath(layout, id)).toThrow(/invalid observation id/);
    }
  });

  test("readItem with a traversal id refuses BEFORE reading outside nahel/items", async () => {
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    // Canary at the exact path ../../PRODUCT would reach from nahel/items.
    await writeFile(join(root, "PRODUCT.md"), "# canary constitution\n");
    expect(readItem(layout, "../../PRODUCT")).rejects.toThrow(/invalid item id/);
  });

  test("itemExists with an invalid id refuses instead of answering false", async () => {
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    await writeFile(join(root, "PRODUCT.md"), "# canary constitution\n");
    // False would mislead callers into "not found" paths; the id itself is
    // the error, and swallowing it hid the escape at the command layer.
    expect(itemExists(layout, "../../PRODUCT")).rejects.toThrow(/invalid item id/);
  });

  test("readRun with a traversal id refuses even when a plant exists at the target", async () => {
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    const env = seededEnv();
    // Plant a schema-valid run.json OUTSIDE nahel/runs, reachable by traversal.
    const plant = join(root, "plant");
    await mkdir(plant, { recursive: true });
    const planted = makeRun(env, makeFrontmatter(env).id);
    await writeFile(join(plant, "run.json"), `${JSON.stringify(planted)}\n`);
    expect(readRun(layout, "../../plant")).rejects.toThrow(/invalid run id/);
  });

  test("valid ids still resolve to their nahel/ paths", async () => {
    const layout = storeLayout(await tempRoot());
    expect(itemPath(layout, "abc123de")).toBe(join(layout.itemsDir, "abc123de.md"));
    expect(runDir(layout, "abc123de")).toBe(join(layout.runsDir, "abc123de"));
    expect(observationPath(layout, "abc123de")).toBe(
      join(layout.observationsDir, "abc123de.md"),
    );
  });
});

describe("work item records", () => {
  test("writeItem/readItem round-trips frontmatter and body", async () => {
    const env = seededEnv();
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    const frontmatter = makeFrontmatter(env);
    await writeItem(layout, frontmatter, "# Test item\n\nDetails.\n");
    const record = await readItem(layout, frontmatter.id);
    expect(record.frontmatter).toEqual(frontmatter);
    expect(record.body).toBe("# Test item\n\nDetails.\n");
  });

  test("item records live at nahel/items/{id}.md", async () => {
    const env = seededEnv();
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    const frontmatter = makeFrontmatter(env);
    await writeItem(layout, frontmatter, "");
    expect(itemPath(layout, frontmatter.id)).toBe(
      join(layout.itemsDir, `${frontmatter.id}.md`),
    );
    expect((await stat(itemPath(layout, frontmatter.id))).isFile()).toBe(true);
  });

  test("writeItem refuses an invalid record (bad status) before touching disk", async () => {
    const env = seededEnv();
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    const bad = { ...makeFrontmatter(env), status: "nonsense" };
    // @ts-expect-error deliberately invalid status
    expect(writeItem(layout, bad, "")).rejects.toThrow();
    expect(await listItems(layout)).toEqual([]);
  });

  test("readItem refuses a record whose frontmatter fails schema validation", async () => {
    const env = seededEnv();
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    const frontmatter = makeFrontmatter(env);
    await writeFile(
      itemPath(layout, frontmatter.id),
      "---\nid: not-a-valid-id-format\n---\nbody\n",
    );
    expect(readItem(layout, frontmatter.id)).rejects.toThrow();
  });

  test("readItem on a missing item names the item id", async () => {
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    expect(readItem(layout, "zzzzzzzz")).rejects.toThrow(/zzzzzzzz/);
  });

  test("listItems returns the ids of all item records", async () => {
    const env = seededEnv();
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    const a = makeFrontmatter(env);
    const b = makeFrontmatter(env);
    await writeItem(layout, a, "");
    await writeItem(layout, b, "");
    expect((await listItems(layout)).sort()).toEqual([a.id, b.id].sort());
  });
});

describe("run records", () => {
  test("writeRun/readRun round-trips a validated run", async () => {
    const env = seededEnv();
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    const run = makeRun(env, makeFrontmatter(env).id);
    await writeRun(layout, run);
    expect(await readRun(layout, run.id)).toEqual(run);
  });

  test("run records live at nahel/runs/{id}/run.json", async () => {
    const env = seededEnv();
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    const run = makeRun(env, makeFrontmatter(env).id);
    await writeRun(layout, run);
    expect(runRecordPath(layout, run.id)).toBe(
      join(layout.runsDir, run.id, "run.json"),
    );
    expect(JSON.parse(await readFile(runRecordPath(layout, run.id), "utf8"))).toEqual(run);
  });

  test("writeRun refuses an invalid run record", async () => {
    const env = seededEnv();
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    const bad = { ...makeRun(env, makeFrontmatter(env).id), status: "exploded" };
    // @ts-expect-error deliberately invalid status
    expect(writeRun(layout, bad)).rejects.toThrow();
  });

  test("readRun on a missing run names the run id", async () => {
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    expect(readRun(layout, "zzzzzzzz")).rejects.toThrow(/zzzzzzzz/);
  });

  test("listRuns returns the ids of all run records", async () => {
    const env = seededEnv();
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    const item = makeFrontmatter(env).id;
    const r1 = makeRun(env, item);
    const r2 = makeRun(env, item);
    await writeRun(layout, r1);
    await writeRun(layout, r2);
    expect((await listRuns(layout)).sort()).toEqual([r1.id, r2.id].sort());
  });
});

describe("observation records", () => {
  test("writeObservation/readObservation round-trips at nahel/observations/{id}.md", async () => {
    const env = seededEnv();
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    const frontmatter = {
      id: "abc123de",
      created: env.now(),
      tags: ["testing"],
      sources: ["def456gh"],
    };
    await writeObservation(layout, frontmatter, "The distilled fact.\n");
    const record = await readObservation(layout, frontmatter.id);
    expect(record.frontmatter).toEqual(frontmatter);
    expect(record.body).toBe("The distilled fact.\n");
    expect(observationPath(layout, frontmatter.id)).toBe(
      join(layout.observationsDir, "abc123de.md"),
    );
  });

  test("writeObservation refuses invalid frontmatter (bad source id)", async () => {
    const env = seededEnv();
    const root = await tempRoot();
    const layout = await ensureLayout(root);
    const bad = { id: "abc123de", created: env.now(), tags: [], sources: ["not valid"] };
    expect(writeObservation(layout, bad, "fact")).rejects.toThrow();
  });
});

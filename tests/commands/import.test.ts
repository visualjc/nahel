import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { importCommand } from "../../src/commands/import";
import type { JournalEvent, WorkItemFrontmatter } from "../../src/schema/records";
import { readJournal } from "../../src/store/journal";
import { ensureLayout, readItem, writeConfig, type StoreLayout } from "../../src/store/layout";
import { validateStore } from "../../src/validate";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel import --from-ccpm` (PRD F8): the end-to-end migration proof. A ccpm
 * source tree shaped exactly like Jim's real speed-count-game epic —
 * github-numbered task files, prose task names, `completed`/`closed` statuses,
 * a github mapping, a docs/prds PRD, plus an unmappable status, a bug-typed
 * task, an unresolvable dependency, and an unreferenced PRD to exercise every
 * branch — migrates into a fresh nahel store. Counts reconcile, statuses land
 * on the universal enum, the PRD relocates status-stripped, github refs
 * survive, validate stays green, and a re-run adds nothing.
 */

let dirs: string[] = [];
let logs: string[] = [];
let errs: string[] = [];
let logSpy: { mockRestore(): void };
let errSpy: { mockRestore(): void };

beforeEach(() => {
  logs = [];
  errs = [];
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.join(" "));
  });
  errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errs.push(args.join(" "));
  });
});

afterEach(async () => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

async function tmp(prefix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}

async function writeDoc(path: string, frontmatter: string[], body: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `---\n${frontmatter.join("\n")}\n---\n${body}`, "utf8");
}

/** A fresh, initialized nahel store to import INTO (agent actor, bare config). */
async function destStore(): Promise<{ root: string; layout: StoreLayout }> {
  const root = await tmp("nahel-import-dest-");
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig());
  return { root, layout };
}

/**
 * A ccpm source tree that mirrors the real speed-count-game shape and adds the
 * edge cases the acceptance criteria demand.
 */
async function ccpmSource(): Promise<string> {
  const root = await tmp("nahel-import-src-");
  const epicDir = join(root, ".claude", "epics", "speed-count-cards-from-seed");
  await writeDoc(
    join(epicDir, "epic.md"),
    [
      "name: speed-count-cards-from-seed",
      "status: completed",
      "created: 2026-02-18T00:05:58Z",
      "prd: docs/prds/speed-count-cards-from-seed.md",
      "updated: 2026-02-19T06:33:47Z",
      "github: https://github.com/visualjc/speed-count-web/issues/1",
    ],
    "# Epic: Seeded Decks\n",
  );
  // Task 2 depends on task 7 (a forward reference by github/filename number).
  await writeDoc(
    join(epicDir, "2.md"),
    [
      "name: Add URL seed parameter handling",
      "status: closed",
      "github: https://github.com/visualjc/speed-count-web/issues/2",
      "depends_on: [7]",
    ],
    "# Task: URL handling\n",
  );
  await writeDoc(
    join(epicDir, "7.md"),
    [
      "name: Add seeded game flow to GameViewModel",
      "status: closed",
      "github: https://github.com/visualjc/speed-count-web/issues/7",
      "depends_on: []",
    ],
    "# Task: ViewModel\n",
  );
  // Task 9: an explicit bug type, an unmappable status, and a dependency on a
  // task (99) that does not exist — dropped with a note.
  await writeDoc(
    join(epicDir, "9.md"),
    [
      "name: Investigate flaky shuffle under penetration reshuffle",
      "status: wontfix",
      "type: bug",
      "github: https://github.com/visualjc/speed-count-web/issues/9",
      "depends_on: [99]",
    ],
    "# Task: flaky shuffle\n",
  );
  // A non-task analysis file, and the github mapping (consistent — no mismatch).
  await writeDoc(join(epicDir, "9-analysis.md"), ["name: analysis"], "notes\n");
  await writeFile(
    join(epicDir, "github-mapping.md"),
    [
      "Epic: #1 - https://github.com/visualjc/speed-count-web/issues/1",
      "- #2: Add URL seed parameter handling - https://github.com/visualjc/speed-count-web/issues/2",
      "- #7: Add seeded game flow - https://github.com/visualjc/speed-count-web/issues/7",
      "- #9: Investigate flaky shuffle - https://github.com/visualjc/speed-count-web/issues/9",
    ].join("\n"),
    "utf8",
  );
  // The epic's PRD (as in the real repo, already under docs/prds with a status).
  await writeDoc(
    join(root, "docs", "prds", "speed-count-cards-from-seed.md"),
    ["name: speed-count-cards-from-seed", "status: complete", "created: 2026-02-18T00:02:30Z"],
    "# PRD: Seeded Decks\n",
  );
  // An unreferenced PRD under .claude/prds — still belongs in docs/prds.
  await writeDoc(
    join(root, ".claude", "prds", "future-idea.md"),
    ["name: future-idea", "status: backlog", "created: 2026-02-10T00:00:00Z"],
    "# PRD: Future Idea\n",
  );
  return root;
}

async function allItems(
  layout: StoreLayout,
): Promise<Map<string, WorkItemFrontmatter>> {
  const names = (await readdir(layout.itemsDir)).filter((n) => n.endsWith(".md"));
  const byId = new Map<string, WorkItemFrontmatter>();
  for (const name of names) {
    const { frontmatter } = await readItem(layout, name.slice(0, -3));
    byId.set(frontmatter.id, frontmatter);
  }
  return byId;
}

/** A stable snapshot of the items directory bytes, for the idempotency proof. */
async function itemsDirBytes(layout: StoreLayout): Promise<Record<string, string>> {
  const names = (await readdir(layout.itemsDir)).filter((n) => n.endsWith(".md")).sort();
  const bytes: Record<string, string> = {};
  for (const name of names) bytes[name] = await readFile(join(layout.itemsDir, name), "utf8");
  return bytes;
}

async function journalEvents(layout: StoreLayout): Promise<JournalEvent[]> {
  return Array.fromAsync(readJournal(layout));
}

describe("nahel import --from-ccpm — the speed-count-game migration (PRD F8)", () => {
  test("counts reconcile: one epic + three tasks become one parent feature and three parented children", async () => {
    const { root, layout } = await destStore();
    const source = await ccpmSource();
    const code = await importCommand.run(["--from-ccpm", "--source", source], seededEnv(), root);

    expect(errs.join("\n")).toBe("");
    expect(code).toBe(0);

    const items = [...(await allItems(layout)).values()];
    expect(items).toHaveLength(4);

    const epics = items.filter((i) => i.parent === undefined);
    const tasks = items.filter((i) => i.parent !== undefined);
    expect(epics).toHaveLength(1);
    expect(tasks).toHaveLength(3);

    const epic = epics[0]!;
    expect(epic.type).toBe("feature");
    expect(epic.lane).toBe("full");
    expect(epic.name).toBe("speed-count-cards-from-seed");
    // Every task is parented to the epic and runs the direct lane.
    for (const task of tasks) {
      expect(task.parent).toBe(epic.id);
      expect(task.lane).toBe("direct");
    }
    // The summary line reports the reconciled counts.
    expect(logs.join("\n")).toContain("4 item(s) created");
  });

  test("statuses land on the universal enum; an unmappable status falls to backlog with a journaled note", async () => {
    const { root, layout } = await destStore();
    const source = await ccpmSource();
    await importCommand.run(["--from-ccpm", "--source", source], seededEnv(), root);

    const items = [...(await allItems(layout)).values()];
    const bySlug = new Map(items.map((i) => [i.name, i]));
    // completed / closed → done.
    expect(bySlug.get("speed-count-cards-from-seed")!.status).toBe("done");
    expect(bySlug.get("add-url-seed-parameter-handling")!.status).toBe("done");
    // wontfix is unmappable → backlog, with a note naming the original.
    const bug = bySlug.get("investigate-flaky-shuffle-under-penetration-reshuffle")!;
    expect(bug.status).toBe("backlog");
    expect(bug.type).toBe("bug"); // from the explicit type field, not the name

    const note = (await journalEvents(layout)).find(
      (e) => e.type === "import.note" && e.payload["kind"] === "unmappable-status",
    );
    expect(note).toBeDefined();
    expect(note!.payload["original"]).toBe("wontfix");
    expect(note!.item).toBe(bug.id);
  });

  test("github issue numbers become external_refs; depends_on resolves to sibling item ids; unresolvable deps are dropped with a note", async () => {
    const { root, layout } = await destStore();
    const source = await ccpmSource();
    await importCommand.run(["--from-ccpm", "--source", source], seededEnv(), root);

    const items = [...(await allItems(layout)).values()];
    const bySlug = new Map(items.map((i) => [i.name, i]));

    expect(bySlug.get("speed-count-cards-from-seed")!.external_refs).toEqual([
      { provider: "github", id: "1" },
    ]);

    const task2 = bySlug.get("add-url-seed-parameter-handling")!;
    const task7 = bySlug.get("add-seeded-game-flow-to-gameviewmodel")!;
    expect(task2.external_refs).toEqual([{ provider: "github", id: "2" }]);
    // depends_on [7] resolved to task 7's NEW item id.
    expect(task2.depends_on).toEqual([task7.id]);

    // depends_on [99] had no sibling task — dropped, and noted.
    const bug = bySlug.get("investigate-flaky-shuffle-under-penetration-reshuffle")!;
    expect(bug.depends_on).toEqual([]);
    const drop = (await journalEvents(layout)).find(
      (e) => e.type === "import.note" && e.payload["kind"] === "unresolvable-depends-on",
    );
    expect(drop).toBeDefined();
    expect(drop!.payload["dropped"]).toBe("99");
  });

  test("the epic's PRD relocates to docs/prds with its status stripped; the owning item carries the relocated path; the unreferenced PRD relocates too", async () => {
    const { root, layout } = await destStore();
    const source = await ccpmSource();
    await importCommand.run(["--from-ccpm", "--source", source], seededEnv(), root);

    // The PRD landed under docs/prds with NO status field.
    const relocated = await readFile(
      join(root, "docs", "prds", "speed-count-cards-from-seed.md"),
      "utf8",
    );
    expect(relocated).not.toContain("status:");
    expect(relocated).toContain("name: speed-count-cards-from-seed");

    // The owning epic item points at the relocated path.
    const items = [...(await allItems(layout)).values()];
    const epic = items.find((i) => i.name === "speed-count-cards-from-seed")!;
    expect(epic.prd).toBe("docs/prds/speed-count-cards-from-seed.md");

    // The unreferenced PRD relocated as well, with a note.
    const orphan = await readFile(join(root, "docs", "prds", "future-idea.md"), "utf8");
    expect(orphan).not.toContain("status:");
    const note = (await journalEvents(layout)).find(
      (e) => e.type === "import.note" && e.payload["kind"] === "prd-unreferenced",
    );
    expect(note).toBeDefined();

    // The relocation was journaled with the stripped status recorded (lifted onto the item).
    const relocEvent = (await journalEvents(layout)).find(
      (e) => e.type === "import.prd-relocated" && e.item === epic.id,
    );
    expect(relocEvent).toBeDefined();
    expect(relocEvent!.payload["status_stripped"]).toBe("complete");
  });

  test("post-import `nahel validate` passes: no errors", async () => {
    const { root, layout } = await destStore();
    const source = await ccpmSource();
    await importCommand.run(["--from-ccpm", "--source", source], seededEnv(), root);

    const findings = await validateStore(layout, { now: "2026-07-21T00:00:00Z" });
    const errors = findings.filter((f) => f.severity === "error");
    expect(errors).toEqual([]);
  });

  test("re-running is idempotent: zero new items, zero new PRD copies, items-dir bytes unchanged, skips reported", async () => {
    const { root, layout } = await destStore();
    const source = await ccpmSource();
    const env = seededEnv();

    await importCommand.run(["--from-ccpm", "--source", source], env, root);
    const bytesAfterFirst = await itemsDirBytes(layout);
    const prdMtimeSource = await readFile(
      join(source, "docs", "prds", "speed-count-cards-from-seed.md"),
      "utf8",
    );

    // Second run: the source is untouched, and identity matching skips everything.
    logs = [];
    const code = await importCommand.run(["--from-ccpm", "--source", source], env, root);
    expect(code).toBe(0);

    // Not one new item file, and every existing one is byte-for-byte identical.
    const bytesAfterSecond = await itemsDirBytes(layout);
    expect(bytesAfterSecond).toEqual(bytesAfterFirst);
    expect(Object.keys(bytesAfterSecond)).toHaveLength(4);

    // The summary reports the skips (4 items) and zero creations.
    expect(logs.join("\n")).toContain("0 item(s) created");
    expect(logs.join("\n")).toContain("4 skipped");
    expect(logs.join("\n")).toContain("0 PRD(s) relocated");

    // The SOURCE repo was never mutated.
    expect(
      await readFile(join(source, "docs", "prds", "speed-count-cards-from-seed.md"), "utf8"),
    ).toBe(prdMtimeSource);
  });

  test("the import writes a single summary event with the reconciled counts", async () => {
    const { root, layout } = await destStore();
    const source = await ccpmSource();
    await importCommand.run(["--from-ccpm", "--source", source], seededEnv(), root);

    const summaries = (await journalEvents(layout)).filter((e) => e.type === "import.completed");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.payload).toEqual({
      items_created: 4,
      items_skipped: 0,
      prds_relocated: 2,
      notes: 3,
    });
  });

  test("--from-ccpm is required", async () => {
    const { root } = await destStore();
    const source = await ccpmSource();
    const code = await importCommand.run(["--source", source], seededEnv(), root);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("--from-ccpm");
  });
});

describe("nahel import --from-ccpm — github-mapping cross-check", () => {
  test("a mapping URL that disagrees with the task frontmatter is noted; frontmatter wins", async () => {
    const { root, layout } = await destStore();
    const source = await tmp("nahel-import-mismatch-");
    const epicDir = join(source, ".claude", "epics", "demo");
    await writeDoc(
      join(epicDir, "epic.md"),
      ["name: demo", "status: backlog", "github: https://github.com/o/r/issues/1"],
      "# Epic\n",
    );
    await writeDoc(
      join(epicDir, "2.md"),
      ["name: Do the thing", "status: open", "github: https://github.com/o/r/issues/2"],
      "# Task\n",
    );
    // The mapping records a DIFFERENT url for issue #2 than the task frontmatter.
    await writeFile(
      join(epicDir, "github-mapping.md"),
      ["Epic: #1 - https://github.com/o/r/issues/1", "- #2 - https://github.com/o/r/issues/999"].join(
        "\n",
      ),
      "utf8",
    );

    await importCommand.run(["--from-ccpm", "--source", source], seededEnv(), root);
    const note = (await journalEvents(layout)).find(
      (e) => e.type === "import.note" && e.payload["kind"] === "github-mapping-mismatch",
    );
    expect(note).toBeDefined();
    expect(note!.payload["frontmatter_url"]).toBe("https://github.com/o/r/issues/2");
    expect(note!.payload["mapping_url"]).toBe("https://github.com/o/r/issues/999");
  });
});

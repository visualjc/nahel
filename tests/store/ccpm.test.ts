import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CcpmSourceError,
  readCcpmSource,
  readSourceDoc,
  relocatePrd,
} from "../../src/store/ccpm";
import { parseFrontmatter } from "../../src/store/frontmatter";
import { makeTempDir } from "./helpers";

/**
 * The read side of `nahel import --from-ccpm` (PRD F8): filesystem access to a
 * ccpm source tree, shaped exactly like Jim's real speed-count-game epic —
 * task files named by github issue number (`2.md`), `<n>-analysis.md` files
 * that are NOT tasks, a github-mapping.md, and a PRD the epic references. The
 * source tree is read-only; the only write is the PRD relocation into the
 * CURRENT repo's docs/prds/.
 */

let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

async function tmp(prefix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}

async function writeDoc(path: string, frontmatter: string, body: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `---\n${frontmatter}\n---\n${body}`, "utf8");
}

/** Build a source tree shaped like the real speed-count-game epic. */
async function realShapedSource(): Promise<string> {
  const root = await tmp("nahel-ccpm-src-");
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
    ].join("\n"),
    "# Epic: Seeded Decks\n",
  );
  await writeDoc(
    join(epicDir, "2.md"),
    [
      "name: Add URL seed parameter handling",
      "status: closed",
      "created: 2026-02-18T00:09:29Z",
      "updated: 2026-02-19T02:53:06Z",
      "github: https://github.com/visualjc/speed-count-web/issues/2",
      "depends_on: [7]",
    ].join("\n"),
    "# Task: URL handling\n",
  );
  await writeDoc(
    join(epicDir, "7.md"),
    [
      "name: Add seeded game flow to GameViewModel",
      "status: closed",
      "created: 2026-02-18T00:09:29Z",
      "updated: 2026-02-19T02:53:06Z",
      "github: https://github.com/visualjc/speed-count-web/issues/7",
      "depends_on: []",
    ].join("\n"),
    "# Task: ViewModel\n",
  );
  // A `<n>-analysis.md` file — must NOT be treated as a task.
  await writeDoc(join(epicDir, "7-analysis.md"), ["name: analysis"].join("\n"), "notes\n");
  await writeFile(
    join(epicDir, "github-mapping.md"),
    "Epic: #1 - https://github.com/visualjc/speed-count-web/issues/1\n",
    "utf8",
  );
  // The PRD lives at docs/prds/ in the source (as in the real repo).
  await writeDoc(
    join(root, "docs", "prds", "speed-count-cards-from-seed.md"),
    ["name: speed-count-cards-from-seed", "status: complete", "created: 2026-02-18T00:02:30Z"].join(
      "\n",
    ),
    "# PRD\n",
  );
  return root;
}

describe("readCcpmSource — parsing a real-shaped ccpm tree", () => {
  test("finds the epic, its tasks in numeric order, and its mapping; excludes analysis files", async () => {
    const root = await realShapedSource();
    const source = await readCcpmSource(root);

    expect(source.epics).toHaveLength(1);
    const epic = source.epics[0]!;
    expect(epic.name).toBe("speed-count-cards-from-seed");
    expect(epic.frontmatter["status"]).toBe("completed");
    expect(epic.frontmatter["github"]).toBe(
      "https://github.com/visualjc/speed-count-web/issues/1",
    );

    // Tasks 2 and 7 only — 7-analysis.md, epic.md, github-mapping.md excluded.
    expect(epic.tasks.map((t) => t.stem)).toEqual(["2", "7"]);
    expect(epic.tasks[0]!.frontmatter["name"]).toBe("Add URL seed parameter handling");
    expect(epic.tasks[0]!.frontmatter["depends_on"]).toEqual([7]);
    expect(epic.mappingText).toContain("Epic: #1");
  });

  test("prds under .claude/prds are read; an empty prds dir yields none", async () => {
    const root = await realShapedSource();
    // The real repo keeps only a .gitkeep under .claude/prds.
    await mkdir(join(root, ".claude", "prds"), { recursive: true });
    await writeFile(join(root, ".claude", "prds", ".gitkeep"), "", "utf8");
    const source = await readCcpmSource(root);
    expect(source.prds).toEqual([]);
  });

  test("a missing .claude tree reads as empty, not an error", async () => {
    const root = await tmp("nahel-ccpm-empty-");
    const source = await readCcpmSource(root);
    expect(source).toEqual({ epics: [], prds: [] });
  });
});

describe("readSourceDoc — resolving an epic's referenced PRD", () => {
  test("reads a doc by its source-relative path", async () => {
    const root = await realShapedSource();
    const doc = await readSourceDoc(root, "docs/prds/speed-count-cards-from-seed.md");
    expect(doc).not.toBeNull();
    expect(doc!.frontmatter["status"]).toBe("complete");
  });

  test("returns null for a missing doc", async () => {
    const root = await realShapedSource();
    expect(await readSourceDoc(root, "docs/prds/nope.md")).toBeNull();
  });

  test("refuses a path that escapes the source root", async () => {
    const root = await realShapedSource();
    await expect(readSourceDoc(root, "../../etc/passwd")).rejects.toBeInstanceOf(
      CcpmSourceError,
    );
    await expect(readSourceDoc(root, "/etc/passwd")).rejects.toBeInstanceOf(CcpmSourceError);
  });
});

describe("relocatePrd — writing into the current repo's docs/prds", () => {
  test("writes docs/prds/<name> and reports the repo-relative dest", async () => {
    const current = await tmp("nahel-ccpm-dest-");
    const { dest, wrote } = await relocatePrd(
      current,
      "speed-count-cards-from-seed.md",
      { name: "speed-count-cards-from-seed", created: "2026-02-18T00:02:30Z" },
      "# PRD\n",
    );
    expect(dest).toBe("docs/prds/speed-count-cards-from-seed.md");
    expect(wrote).toBe(true);
    const written = await readFile(join(current, dest), "utf8");
    expect(parseFrontmatter(written).frontmatter["status"]).toBeUndefined();
  });

  test("is idempotent: re-writing identical content does not write again", async () => {
    const current = await tmp("nahel-ccpm-dest-idem-");
    const args = [
      current,
      "p.md",
      { name: "p", created: "2026-02-18T00:02:30Z" },
      "# body\n",
    ] as const;
    const first = await relocatePrd(...args);
    expect(first.wrote).toBe(true);
    const second = await relocatePrd(...args);
    expect(second.wrote).toBe(false);
  });
});

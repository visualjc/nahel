import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureBaseline,
  collectHandbackEvidence,
  GitError,
  type GitBaseline,
} from "../../src/store/baseline";
import { makeTempDir } from "./helpers";

/**
 * Git baseline capture + handback evidence (PRD F9). All tests run against
 * REAL git repos in temp dirs — no mocks. The store-level contract under test:
 * evidence is a deterministic function of repo state (byte-identical output
 * for identical state; porcelain/plumbing formats only, no locale or
 * relative-date formatting anywhere).
 */

const SHA = /^[0-9a-f]{40}$/;

let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

/** Run a real git command in a repo, returning stdout. */
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

/** Fresh temp dir that is NOT a git repo. */
async function makeBareDir(): Promise<string> {
  const root = await makeTempDir("nahel-baseline-");
  dirs.push(root);
  return root;
}

/** Fresh temp git repo with a deterministic identity and one initial commit. */
async function makeGitRepo(): Promise<string> {
  const root = await makeBareDir();
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "commit.gpgsign", "false");
  await writeFile(join(root, "README.md"), "# baseline test repo\n");
  git(root, "add", "README.md");
  git(root, "commit", "-q", "-m", "initial");
  return root;
}

describe("captureBaseline", () => {
  test("clean repo: HEAD SHA matches rev-parse and the dirty snapshot is empty", async () => {
    const root = await makeGitRepo();
    const baseline = await captureBaseline(root);
    expect(baseline.head).toMatch(SHA);
    expect(baseline.head).toBe(git(root, "rev-parse", "HEAD").trim());
    expect(baseline.dirty).toEqual([]);
  });

  test("dirty repo: the porcelain snapshot lists modified AND untracked files", async () => {
    const root = await makeGitRepo();
    await writeFile(join(root, "README.md"), "# baseline test repo\nedited\n");
    await writeFile(join(root, "note.txt"), "uncommitted\n");

    const baseline = await captureBaseline(root);
    expect(baseline.dirty).toContain(" M README.md");
    expect(baseline.dirty).toContain("?? note.txt");
    expect(baseline.dirty).toHaveLength(2);
  });

  test("a directory that is not a git repo fails with a GitError naming the command", async () => {
    const root = await makeBareDir();
    const attempt = captureBaseline(root);
    await expect(attempt).rejects.toBeInstanceOf(GitError);
    await expect(attempt).rejects.toThrow(/rev-parse/);
  });

  test("a repo with no commits yet (unborn HEAD) fails with a GitError", async () => {
    const root = await makeBareDir();
    git(root, "init", "-q");
    await expect(captureBaseline(root)).rejects.toBeInstanceOf(GitError);
  });

  test("identical repo state yields byte-identical baselines", async () => {
    const root = await makeGitRepo();
    await writeFile(join(root, "dirty.txt"), "dirty at claim\n");
    const first = await captureBaseline(root);
    const second = await captureBaseline(root);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe("collectHandbackEvidence", () => {
  test("no changes since baseline: empty commits, empty diff, empty dirty, empty exclusions", async () => {
    const root = await makeGitRepo();
    const baseline = await captureBaseline(root);
    const evidence = await collectHandbackEvidence(root, baseline);
    expect(evidence).toEqual({
      baseline_head: baseline.head,
      commits: [],
      diff: [],
      dirty: [],
      excluded_from_attribution: [],
    });
  });

  test("commits since baseline are listed as SHAs, oldest first, matching rev-list", async () => {
    const root = await makeGitRepo();
    const baseline = await captureBaseline(root);

    await writeFile(join(root, "README.md"), "# baseline test repo\nline two\n");
    git(root, "add", "README.md");
    git(root, "commit", "-q", "-m", "hand-fix one");
    await writeFile(join(root, "new.txt"), "brand new file\n");
    git(root, "add", "new.txt");
    git(root, "commit", "-q", "-m", "hand-fix two");

    const evidence = await collectHandbackEvidence(root, baseline);
    const expected = git(root, "rev-list", "--reverse", `${baseline.head}..HEAD`)
      .split("\n")
      .filter((line) => line !== "");
    expect(expected).toHaveLength(2);
    expect(evidence.commits).toEqual(expected);
    for (const sha of evidence.commits) expect(sha).toMatch(SHA);
  });

  test("diff summary baseline→HEAD carries per-file added/deleted line counts", async () => {
    const root = await makeGitRepo();
    const baseline = await captureBaseline(root);

    // README: one line replaced by two (numstat: +2 -1); new.txt: +1 -0.
    await writeFile(join(root, "README.md"), "# rewritten\nsecond line\n");
    await writeFile(join(root, "new.txt"), "brand new file\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "hand-fix");

    const evidence = await collectHandbackEvidence(root, baseline);
    expect(evidence.diff).toEqual([
      { file: "README.md", added: 2, deleted: 1 },
      { file: "new.txt", added: 1, deleted: 0 },
    ]);
  });

  test("binary files diff as '-' counts (git numstat convention), not NaN", async () => {
    const root = await makeGitRepo();
    const baseline = await captureBaseline(root);

    await writeFile(join(root, "blob.bin"), Buffer.from([0, 1, 2, 0, 255, 0, 7]));
    git(root, "add", "blob.bin");
    git(root, "commit", "-q", "-m", "binary blob");

    const evidence = await collectHandbackEvidence(root, baseline);
    expect(evidence.diff).toEqual([{ file: "blob.bin", added: "-", deleted: "-" }]);
  });

  test("dirty-at-claim changes surface as excluded_from_attribution; current dirty state is separate", async () => {
    const root = await makeGitRepo();
    // Human had an uncommitted edit BEFORE the claim: excluded from attribution.
    await writeFile(join(root, "wip.txt"), "work in progress before claim\n");
    const baseline = await captureBaseline(root);
    expect(baseline.dirty).toEqual(["?? wip.txt"]);

    // After the claim, a different file goes dirty and stays uncommitted.
    await writeFile(join(root, "after.txt"), "dirty after claim\n");

    const evidence = await collectHandbackEvidence(root, baseline);
    expect(evidence.excluded_from_attribution).toEqual(["?? wip.txt"]);
    expect(evidence.dirty).toEqual(["?? after.txt", "?? wip.txt"]);
  });

  test("identical repo state yields byte-identical evidence (deterministic formatting)", async () => {
    const root = await makeGitRepo();
    await writeFile(join(root, "wip.txt"), "dirty at claim\n");
    const baseline = await captureBaseline(root);

    await writeFile(join(root, "README.md"), "# baseline test repo\nfixed\n");
    git(root, "add", "README.md");
    git(root, "commit", "-q", "-m", "hand-fix");

    const first = await collectHandbackEvidence(root, baseline);
    const second = await collectHandbackEvidence(root, baseline);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test("a baseline head git does not know fails with a GitError", async () => {
    const root = await makeGitRepo();
    const bogus: GitBaseline = { head: "f".repeat(40), dirty: [] };
    await expect(collectHandbackEvidence(root, bogus)).rejects.toBeInstanceOf(GitError);
  });
});

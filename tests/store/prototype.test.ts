import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isPrototypeBranch,
  prototypeBranch,
  prototypeMiniPrdPath,
  PROTOTYPE_BRANCH_PREFIX,
  PrototypeError,
  removeVariantWorktree,
  scanPrototypeRefs,
  seedVariant,
} from "../../src/store/prototype";
import { makeTempDir } from "./helpers";

/**
 * The prototype lane's git plumbing (PRD F5.1, F5.2): branch/worktree naming
 * that makes a prototype ref mechanically recognizable, the variant seeding
 * that creates the throwaway workspace, and the read-only ref scan
 * `nahel validate` judges never-merge from. Real temp git repos throughout —
 * worktrees are a git feature, and a mocked git would prove nothing about the
 * invariant this module exists to enforce. Verbose by design.
 */

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/** A temp git repo with one commit on `main`; registered for cleanup. */
async function makeRepo(): Promise<string> {
  const root = await makeTempDir("nahel-proto-git-");
  dirs.push(root);
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "test@nahel.test");
  git(root, "config", "user.name", "Nahel Prototype Test");
  await writeFile(join(root, "README.md"), "# lab\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "founding commit");
  return root;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe("prototype ref naming — recognizability is what enforcement keys on (F5.2)", () => {
  test("branch names are prototype/<slug>/variant-<n>, and the prefix is the recognizer", () => {
    expect(prototypeBranch("speed-count", 1)).toBe("prototype/speed-count/variant-1");
    expect(prototypeBranch("speed-count", 12)).toBe("prototype/speed-count/variant-12");
    expect(prototypeBranch("speed-count", 1).startsWith(PROTOTYPE_BRANCH_PREFIX)).toBe(true);
  });

  test("isPrototypeBranch recognizes local and remote-tracking forms, and nothing else", () => {
    expect(isPrototypeBranch("prototype/speed-count/variant-1")).toBe(true);
    expect(isPrototypeBranch("origin/prototype/speed-count/variant-1")).toBe(true);
    expect(isPrototypeBranch("refs/heads/prototype/speed-count/variant-1")).toBe(true);
    expect(isPrototypeBranch("refs/remotes/origin/prototype/speed-count/variant-1")).toBe(true);
    // Near-misses stay unrecognized: the prefix is a path SEGMENT, not a substring.
    expect(isPrototypeBranch("main")).toBe(false);
    expect(isPrototypeBranch("feature/prototype-ish")).toBe(false);
    expect(isPrototypeBranch("prototypes/speed-count")).toBe(false);
    expect(isPrototypeBranch("fix/my-prototype/thing")).toBe(false);
  });

  test("mini-PRDs land at docs/prototypes/<slug>/variant-<n>.md — repo-relative, schema-safe", () => {
    expect(prototypeMiniPrdPath("speed-count", 2)).toBe("docs/prototypes/speed-count/variant-2.md");
    expect(prototypeMiniPrdPath("speed-count", 2).startsWith("/")).toBe(false);
    expect(prototypeMiniPrdPath("speed-count", 2)).not.toContain("..");
  });
});

describe("seedVariant — one throwaway workspace per variant (F5.1)", () => {
  test("creates the branch and worktree, seeds the mini-PRD in both trees, returns the base sha", async () => {
    const root = await makeRepo();
    const worktree = `${root}-variant-1`;
    dirs.push(worktree);
    const head = git(root, "rev-parse", "HEAD").trim();

    const base = await seedVariant(root, {
      branch: prototypeBranch("speed-count", 1),
      worktree,
      prd: prototypeMiniPrdPath("speed-count", 1),
      content: "# Mini-PRD variant 1\n",
    });

    // The base is HEAD at creation — the anchor never-merge enforcement needs.
    expect(base).toBe(head);
    expect(git(root, "branch", "--list", "prototype/speed-count/variant-1")).toContain("variant-1");
    expect(await exists(join(worktree, ".git"))).toBe(true);
    // Seeded in the worktree (the variant's working brief) AND in the main
    // tree (the durable record that outlives the throwaway).
    expect(await readFile(join(worktree, "docs/prototypes/speed-count/variant-1.md"), "utf8")).toBe(
      "# Mini-PRD variant 1\n",
    );
    expect(await readFile(join(root, "docs/prototypes/speed-count/variant-1.md"), "utf8")).toBe(
      "# Mini-PRD variant 1\n",
    );
    // The worktree really is checked out on its own branch.
    expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
      "prototype/speed-count/variant-1",
    );
  });

  test("refuses an existing branch rather than hijacking someone else's work", async () => {
    const root = await makeRepo();
    const worktree = `${root}-variant-1`;
    dirs.push(worktree);
    git(root, "branch", "prototype/speed-count/variant-1");

    await expect(
      seedVariant(root, {
        branch: prototypeBranch("speed-count", 1),
        worktree,
        prd: prototypeMiniPrdPath("speed-count", 1),
        content: "x",
      }),
    ).rejects.toThrow(PrototypeError);
    expect(await exists(worktree)).toBe(false);
  });

  test("refuses an occupied worktree path", async () => {
    const root = await makeRepo();
    const worktree = `${root}-variant-1`;
    dirs.push(worktree);
    await Bun.write(join(worktree, "keep.txt"), "occupied");

    await expect(
      seedVariant(root, {
        branch: prototypeBranch("speed-count", 1),
        worktree,
        prd: prototypeMiniPrdPath("speed-count", 1),
        content: "x",
      }),
    ).rejects.toThrow(PrototypeError);
    // Nothing half-created: the branch was never made.
    expect(git(root, "branch", "--list", "prototype/speed-count/variant-1").trim()).toBe("");
  });
});

describe("removeVariantWorktree — disposal is real, and refuses to eat uncommitted work", () => {
  test("removes a clean worktree; the branch survives as the reference-only record", async () => {
    const root = await makeRepo();
    const worktree = `${root}-variant-1`;
    dirs.push(worktree);
    await seedVariant(root, {
      branch: prototypeBranch("speed-count", 1),
      worktree,
      prd: prototypeMiniPrdPath("speed-count", 1),
      content: "x",
    });
    git(worktree, "add", "-A");
    git(worktree, "commit", "-m", "variant 1 throwaway");

    await removeVariantWorktree(root, worktree, false);

    expect(await exists(worktree)).toBe(false);
    expect(git(root, "branch", "--list", "prototype/speed-count/variant-1")).toContain("variant-1");
  });

  test("refuses a dirty worktree without --force, naming the fix", async () => {
    const root = await makeRepo();
    const worktree = `${root}-variant-1`;
    dirs.push(worktree);
    await seedVariant(root, {
      branch: prototypeBranch("speed-count", 1),
      worktree,
      prd: prototypeMiniPrdPath("speed-count", 1),
      content: "x",
    });

    await expect(removeVariantWorktree(root, worktree, false)).rejects.toThrow(PrototypeError);
    expect(await exists(worktree)).toBe(true);

    // --force is the deliberate door.
    await removeVariantWorktree(root, worktree, true);
    expect(await exists(worktree)).toBe(false);
  });
});

describe("scanPrototypeRefs — the read-only evidence never-merge enforcement judges from (F5.2)", () => {
  test("a freshly created variant sits AT its base: reachable from main, but nothing of it merged", async () => {
    const root = await makeRepo();
    const worktree = `${root}-variant-1`;
    dirs.push(worktree);
    const base = await seedVariant(root, {
      branch: prototypeBranch("speed-count", 1),
      worktree,
      prd: prototypeMiniPrdPath("speed-count", 1),
      content: "x",
    });

    const scan = await scanPrototypeRefs(root);
    expect(scan.error).toBeUndefined();
    expect(scan.defaultBranch).toBe("main");
    expect(scan.branches).toEqual([
      { branch: "prototype/speed-count/variant-1", tip: base, ancestorOfDefault: true },
    ]);
    expect(scan.remoteRefs).toEqual([]);
  });

  test("an ACTIVE variant has its own tip and is not reachable from main", async () => {
    const root = await makeRepo();
    const worktree = `${root}-variant-1`;
    dirs.push(worktree);
    const base = await seedVariant(root, {
      branch: prototypeBranch("speed-count", 1),
      worktree,
      prd: prototypeMiniPrdPath("speed-count", 1),
      content: "x",
    });
    git(worktree, "add", "-A");
    git(worktree, "commit", "-m", "throwaway implementation");

    const scan = await scanPrototypeRefs(root);
    const branch = scan.branches[0]!;
    expect(branch.tip).not.toBe(base);
    expect(branch.ancestorOfDefault).toBe(false);
  });

  test("a MERGED variant reports a tip past its base that main now contains — the violation", async () => {
    const root = await makeRepo();
    const worktree = `${root}-variant-1`;
    dirs.push(worktree);
    const base = await seedVariant(root, {
      branch: prototypeBranch("speed-count", 1),
      worktree,
      prd: prototypeMiniPrdPath("speed-count", 1),
      content: "x",
    });
    git(worktree, "add", "-A");
    git(worktree, "commit", "-m", "throwaway implementation");
    git(root, "merge", "--no-edit", "prototype/speed-count/variant-1");

    const scan = await scanPrototypeRefs(root);
    const branch = scan.branches[0]!;
    expect(branch.tip).not.toBe(base);
    expect(branch.ancestorOfDefault).toBe(true);
  });

  test("a pushed prototype ref shows up as a remote-tracking ref — the PR precondition", async () => {
    const root = await makeRepo();
    const worktree = `${root}-variant-1`;
    dirs.push(worktree);
    await seedVariant(root, {
      branch: prototypeBranch("speed-count", 1),
      worktree,
      prd: prototypeMiniPrdPath("speed-count", 1),
      content: "x",
    });
    const tip = git(root, "rev-parse", "prototype/speed-count/variant-1").trim();
    git(root, "update-ref", "refs/remotes/origin/prototype/speed-count/variant-1", tip);

    const scan = await scanPrototypeRefs(root);
    expect(scan.remoteRefs).toEqual(["origin/prototype/speed-count/variant-1"]);
  });

  test("non-prototype branches are invisible to the scan", async () => {
    const root = await makeRepo();
    git(root, "branch", "fix/some-bug");
    git(root, "branch", "epic/phase-2");

    const scan = await scanPrototypeRefs(root);
    expect(scan.branches).toEqual([]);
  });

  test("a directory that is not a git repo yields an error finding, never a throw", async () => {
    const root = await makeTempDir("nahel-proto-nogit-");
    dirs.push(root);

    const scan = await scanPrototypeRefs(root);
    expect(scan.error).toBeDefined();
    expect(scan.branches).toEqual([]);
    expect(scan.remoteRefs).toEqual([]);
  });
});

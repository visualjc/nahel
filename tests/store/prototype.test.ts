import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  headCommit,
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

  test("refuses a worktree INSIDE the repo — that is one `git add -A` from the forbidden merge", async () => {
    const root = await makeRepo();

    await expect(
      seedVariant(root, {
        branch: prototypeBranch("speed-count", 1),
        worktree: join(root, "prototypes/variant-1"),
        prd: prototypeMiniPrdPath("speed-count", 1),
        content: "x",
      }),
    ).rejects.toThrow(PrototypeError);
    expect(git(root, "branch", "--list", "prototype/speed-count/variant-1").trim()).toBe("");
    expect(await exists(join(root, "prototypes/variant-1"))).toBe(false);
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
      {
        branch: "prototype/speed-count/variant-1",
        tip: base,
        ancestorOfDefault: true,
        copiedToDefault: [],
        mergeBaseWithDefault: base,
      },
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
    // Nothing of it exists in main, by patch-id or by ancestry.
    expect(branch.copiedToDefault).toEqual([]);
  });

  test("MERGE-THEN-ADVANCE is visible as merge-base drift — the shape both other signals miss", async () => {
    // Merge the variant's T1 into main (real merge), then advance the variant
    // to T2: the tip (T2) is not in main, and `git cherry` reports nothing
    // because T1 is genuinely reachable from main — yet prototype code sits
    // merged on the default branch. The divergence point (merge-base) has
    // moved from the recorded base to T1, and that drift is the signal.
    const root = await makeRepo();
    const worktree = `${root}-variant-1`;
    dirs.push(worktree);
    const base = await seedVariant(root, {
      branch: prototypeBranch("speed-count", 1),
      worktree,
      prd: prototypeMiniPrdPath("speed-count", 1),
      content: "x",
    });
    await writeFile(join(worktree, "t1.ts"), "export const t1 = 1;\n");
    git(worktree, "add", "-A");
    git(worktree, "commit", "-m", "T1 throwaway");
    const t1 = git(worktree, "rev-parse", "HEAD").trim();
    // The seeded main-tree mini-PRD is untracked; commit it so the merge is
    // about history, not a dirty-tree refusal (fixture hygiene, not the shape).
    git(root, "add", "-A");
    git(root, "commit", "-m", "record mini-PRD");
    git(root, "merge", "--no-ff", "-m", "merge prototype T1", "prototype/speed-count/variant-1");
    await writeFile(join(worktree, "t2.ts"), "export const t2 = 2;\n");
    git(worktree, "add", "-A");
    git(worktree, "commit", "-m", "T2 throwaway");

    const scan = await scanPrototypeRefs(root);
    const branch = scan.branches[0]!;
    expect(branch.ancestorOfDefault).toBe(false);
    expect(branch.copiedToDefault).toEqual([]);
    expect(branch.mergeBaseWithDefault).toBe(t1);
    expect(branch.mergeBaseWithDefault).not.toBe(base);
  });

  test("a CHERRY-PICKED prototype commit is reported by patch-id — the copy path ancestry cannot see", async () => {
    // The gap this closes: `git cherry-pick` puts prototype code on the default
    // branch as a NEW commit, so the prototype branch is not an ancestor of
    // main and the ancestry check stays silent — while the code is merged in
    // every sense that matters (PRD F5.2, prototype-lane's rule 2 names
    // cherry-picks explicitly).
    const root = await makeRepo();
    const worktree = `${root}-variant-1`;
    dirs.push(worktree);
    await seedVariant(root, {
      branch: prototypeBranch("speed-count", 1),
      worktree,
      prd: prototypeMiniPrdPath("speed-count", 1),
      content: "x",
    });
    await writeFile(join(worktree, "fast-count.ts"), "export const count = () => 42;\n");
    // Just the code — the mini-PRD is the main tree's durable record, not part
    // of the throwaway commit anyone would lift.
    git(worktree, "add", "fast-count.ts");
    git(worktree, "commit", "-m", "throwaway fast count");
    const picked = git(worktree, "rev-parse", "HEAD").trim();

    // The main tree records its own mini-PRD copy (as a real repo does), then
    // someone lifts "just the tricky function" across.
    git(root, "add", "-A");
    git(root, "commit", "-m", "record the variant mini-PRD");
    git(root, "cherry-pick", picked);

    const scan = await scanPrototypeRefs(root);
    console.log("[cherry-picked scan]", JSON.stringify(scan.branches, null, 2));
    const branch = scan.branches[0]!;
    // Ancestry alone would clear this branch — that is the whole point.
    expect(branch.ancestorOfDefault).toBe(false);
    expect(branch.copiedToDefault).toEqual([picked]);
  });

  test("a rebase-style copy of every commit is reported too, and an untouched variant stays clean", async () => {
    const root = await makeRepo();
    const worktree = `${root}-variant-1`;
    dirs.push(worktree);
    await seedVariant(root, {
      branch: prototypeBranch("speed-count", 1),
      worktree,
      prd: prototypeMiniPrdPath("speed-count", 1),
      content: "x",
    });
    await writeFile(join(worktree, "a.ts"), "export const a = 1;\n");
    git(worktree, "add", "a.ts");
    git(worktree, "commit", "-m", "first");
    const first = git(worktree, "rev-parse", "HEAD").trim();
    await writeFile(join(worktree, "b.ts"), "export const b = 2;\n");
    git(worktree, "add", "b.ts");
    git(worktree, "commit", "-m", "second");
    const second = git(worktree, "rev-parse", "HEAD").trim();

    git(root, "add", "-A");
    git(root, "commit", "-m", "record the variant mini-PRD");
    git(root, "cherry-pick", first, second);

    const scan = await scanPrototypeRefs(root);
    console.log("[rebased scan]", JSON.stringify(scan.branches, null, 2));
    // Both commits, in git cherry's order (oldest first).
    expect(scan.branches[0]!.copiedToDefault).toEqual([first, second]);
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
    // The main tree commits its durable mini-PRD copy first, as a real repo does.
    git(root, "add", "-A");
    git(root, "commit", "-m", "record the variant mini-PRD");
    git(root, "merge", "--no-edit", "prototype/speed-count/variant-1");

    const scan = await scanPrototypeRefs(root);
    const branch = scan.branches[0]!;
    expect(branch.tip).not.toBe(base);
    expect(branch.ancestorOfDefault).toBe(true);
  });

  test("a merged variant reports nothing under patch-id — ancestry already owns that verdict", async () => {
    // `git cherry` lists commits NOT in upstream; after a real merge there are
    // none, so the two detections are complementary rather than double-counting.
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
    git(worktree, "commit", "-m", "throwaway implementation");
    git(root, "add", "-A");
    git(root, "commit", "-m", "record the variant mini-PRD");
    git(root, "merge", "--no-edit", "prototype/speed-count/variant-1");

    const branch = (await scanPrototypeRefs(root)).branches[0]!;
    expect(branch.ancestorOfDefault).toBe(true);
    expect(branch.copiedToDefault).toEqual([]);
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

  test("git output past the capture cap fails naming the command and the cap, not node's maxBuffer text", async () => {
    const root = await makeRepo();
    // A 4-byte cap that `git rev-parse HEAD` (a 41-byte SHA line) outruns —
    // the same overflow the 16 MiB production cap would see on a huge repo.
    const attempt = headCommit(root, 4);
    await expect(attempt).rejects.toBeInstanceOf(PrototypeError);
    await expect(attempt).rejects.toThrow(/rev-parse HEAD/);
    await expect(attempt).rejects.toThrow(/4-byte capture cap/);
    await expect(attempt).rejects.not.toThrow(/maxBuffer/);
  });

  test("a directory that is not a git repo yields an error finding, never a throw", async () => {
    const root = await makeTempDir("nahel-proto-nogit-");
    dirs.push(root);

    const scan = await scanPrototypeRefs(root);
    expect(scan.error).toBeDefined();
    expect(scan.branches).toEqual([]);
    expect(scan.remoteRefs).toEqual([]);
    // No repo, no prototype refs: nothing was left unverified, so validate
    // stays silent rather than reporting an unjudged invariant.
    expect(scan.scanFailed).toBeUndefined();
  });

  test("a real repo whose ref listing fails is an ABORT, not an absent repo", async () => {
    const root = await makeRepo();
    await writeFile(join(root, ".git", "packed-refs"), "not a refs database\n");

    const scan = await scanPrototypeRefs(root);
    expect(scan.error).toContain("packed-refs");
    expect(scan.scanFailed).toBe(true);
    expect(scan.branches).toEqual([]);
  });

  /**
   * git's repository-selection variables point it somewhere else entirely: an
   * inherited GIT_DIR makes every probe report "not a git repository" — about
   * the path in the ENVIRONMENT, never about the root we asked at. Read as
   * proof of absence, it turns a repo full of prototype refs into silence.
   */
  test("an inherited GIT_DIR does not make a real repo look absent", async () => {
    const root = await makeRepo();
    git(root, "branch", prototypeBranch("ambient", 1));

    const saved = process.env["GIT_DIR"];
    process.env["GIT_DIR"] = "/definitely-not-a-git-dir";
    try {
      const scan = await scanPrototypeRefs(root);
      expect(scan.error).toBeUndefined();
      expect(scan.scanFailed).toBeUndefined();
      expect(scan.branches.map((branch) => branch.branch)).toEqual([
        prototypeBranch("ambient", 1),
      ]);
    } finally {
      if (saved === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = saved;
    }
  });

  /**
   * Absence must be PROVEN, never inferred from a second failure. A fault that
   * stops git running at all — here a malformed config — fails the ref listing
   * AND the repo probe, and reading that as "there is no repo here" files a
   * real repo, prototype refs and all, under "nothing to verify".
   */
  test("a fault that breaks BOTH probes is an abort — absence is only git's own answer", async () => {
    const root = await makeRepo();
    await writeFile(join(root, ".git", "config"), "[core\nthis is not a config\n");

    const scan = await scanPrototypeRefs(root);
    expect(scan.scanFailed).toBe(true);
    expect(scan.error).toContain("bad config");
  });

  /**
   * The nastiest shape: git EXITS 0 and answers anyway, having quietly left
   * something out. `for-each-ref` warns "ignoring broken ref" on stderr and
   * returns a SHORT list — so a prototype branch can be missing from a scan
   * that looks entirely successful.
   */
  test("a broken ref leaves the listing incomplete at exit 0 — an abort, not an answer", async () => {
    const root = await makeRepo();
    await writeFile(join(root, ".git", "refs", "heads", "broken"), "garbage-not-a-sha\n");

    const scan = await scanPrototypeRefs(root);
    expect(scan.scanFailed).toBe(true);
    expect(scan.error).toContain("ignoring broken ref");
    expect(scan.branches).toEqual([]);
  });

  test("a prototype ref pointing at a missing object aborts the per-branch probes", async () => {
    const root = await makeRepo();
    await mkdir(join(root, ".git", "refs", "heads", "prototype", "ghost"), { recursive: true });
    // A well-formed SHA for an object that does not exist: for-each-ref lists
    // it happily and every judgment probe then fails with 128 — which used to
    // read as "not an ancestor, no copies", an all-clear nobody could see.
    await writeFile(
      join(root, ".git", "refs", "heads", "prototype", "ghost", "variant-1"),
      `${"0".repeat(39)}1\n`,
    );

    const scan = await scanPrototypeRefs(root);
    expect(scan.scanFailed).toBe(true);
    expect(scan.error).toMatch(/merge-base|cherry/);
  });

  describe("documented negatives stay silent — git's clean 'no' is an answer", () => {
    test("no resolvable default branch: both lookups return git's documented exit 1", async () => {
      const root = await makeRepo();
      git(root, "branch", "-m", "main", "trunk"); // no main, no master, no origin/HEAD
      git(root, "branch", prototypeBranch("quiet", 1));

      const scan = await scanPrototypeRefs(root);
      expect(scan.error).toBeUndefined();
      expect(scan.scanFailed).toBeUndefined();
      expect(scan.defaultBranch).toBeUndefined();
      expect(scan.branches).toHaveLength(1);
    });

    test("unrelated histories: merge-base exits 1 for 'no merge base', which is not an error", async () => {
      const root = await makeRepo();
      git(root, "checkout", "-q", "--orphan", prototypeBranch("orphan", 1));
      await writeFile(join(root, "orphan.txt"), "unrelated history\n");
      git(root, "add", "orphan.txt");
      git(root, "commit", "-m", "orphan root");
      git(root, "checkout", "-q", "main");

      const scan = await scanPrototypeRefs(root);
      expect(scan.error).toBeUndefined();
      expect(scan.scanFailed).toBeUndefined();
      expect(scan.branches).toHaveLength(1);
      expect(scan.branches[0]!.ancestorOfDefault).toBe(false); // is-ancestor exit 1
      expect(scan.branches[0]!.mergeBaseWithDefault).toBeUndefined(); // merge-base exit 1
    });
  });

  /**
   * The PROBE path (tryGit's non-throwing form) is where an output-cap
   * overflow does real damage: `git cherry` is how a cherry-picked prototype
   * commit is caught, and an overflow that comes back as an ordinary non-zero
   * exit makes copiedToDefault report ZERO copies — a never-merge violation
   * silently downgraded to a clean bill of health. A refusal must look like a
   * refusal, never like an answer.
   */
  test("an overflow inside the scan refuses instead of reporting a clean 'no copies'", async () => {
    const root = await makeRepo();
    const branch = prototypeBranch("capscan", 1);
    git(root, "checkout", "-q", "-b", branch);
    const shas: string[] = [];
    for (let i = 0; i < 10; i++) {
      await writeFile(join(root, `variant-${i}.txt`), `variant work ${i}\n`);
      git(root, "add", "-A");
      git(root, "commit", "-m", `variant commit ${i}`);
      shas.push(git(root, "rev-parse", "HEAD").trim());
    }
    git(root, "checkout", "-q", "main");
    // main moves on first, so the copies below land as NEW commits with the
    // variant's patch — a same-second cherry-pick straight onto the shared
    // base would recreate the variant's own commit objects verbatim and be a
    // fast-forward, not the copy this test is about.
    await writeFile(join(root, "mainline.txt"), "main moved on\n");
    git(root, "add", "-A");
    git(root, "commit", "-m", "mainline work");
    // Three of the variant's commits copied onto main — the exact violation
    // `git cherry` exists to catch.
    for (const sha of shas.slice(0, 3)) git(root, "cherry-pick", sha);

    // Control: at the production cap the scan SEES the violation.
    const honest = await scanPrototypeRefs(root);
    expect(honest.error).toBeUndefined();
    expect(honest.branches[0]!.copiedToDefault).toHaveLength(3);

    // A 200-byte cap: the branch listing (~114 bytes) still fits, `git cherry`
    // (10 lines of 43 bytes) does not — so the overflow lands on the probe.
    const capped = await scanPrototypeRefs(root, 200);
    expect(capped.error).toBeDefined();
    expect(capped.error).toContain("200-byte capture cap");
    // An abort inside a real repo: refs exist and went unjudged, which
    // validate has to report rather than pass over (HC6).
    expect(capped.scanFailed).toBe(true);
    // No half-answer: an empty branch list WITHOUT an error would read as
    // "scanned, nothing wrong".
    expect(capped.branches).toEqual([]);
    expect(capped.remoteRefs).toEqual([]);
  });
});

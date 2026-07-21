import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillsLock } from "../../src/schema/records";
import {
  ensureLayout,
  readSkillsLock,
  readSkillsManifest,
  storeLayout,
  writeSkillsLock,
} from "../../src/store/layout";
import {
  claudeSkillsDir,
  repoToUrl,
  resolveRef,
  restoreViaClone,
  restoreViaSkillsCli,
  skillsCacheDir,
  skillsCliAvailable,
  SkillsError,
} from "../../src/store/skills";
import { makeTempDir } from "./helpers";

/**
 * Skill fetch/placement (PRD F7, ADR-0009). Git-touching functions run against
 * REAL local git repos in temp dirs — no mocks, no network (file paths, not
 * remotes), mirroring baseline.test.ts. `repoToUrl` is pure and tested without
 * any I/O. The `skills` CLI delegation is exercised with a fake `skills`
 * executable placed on PATH so both branches are proven.
 */

const SHA = /^[0-9a-f]{40}$/;
let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}

/**
 * A source repo laid out like a skills repo: each named skill is a directory
 * with a SKILL.md. Returns the repo path and its single commit SHA.
 */
async function makeSkillsRepo(
  skills: Record<string, string>,
  layout: "root" | "skills-subdir" = "root",
): Promise<{ repo: string; sha: string }> {
  const repo = await tempDir("nahel-skillsrepo-");
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "commit.gpgsign", "false");
  const base = layout === "root" ? repo : join(repo, "skills");
  for (const [name, content] of Object.entries(skills)) {
    await mkdir(join(base, name), { recursive: true });
    await writeFile(join(base, name, "SKILL.md"), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "skills");
  return { repo, sha: git(repo, "rev-parse", "HEAD").trim() };
}

async function initTargetRepo(): Promise<ReturnType<typeof storeLayout>> {
  const root = await tempDir("nahel-target-");
  return ensureLayout(root);
}

describe("repoToUrl (pure normalization)", () => {
  test("owner/name shorthand expands to a GitHub HTTPS URL", () => {
    expect(repoToUrl("PromptDrivenDev/skills")).toBe(
      "https://github.com/PromptDrivenDev/skills.git",
    );
  });

  test("an explicit git URL and an scp-style remote pass through unchanged", () => {
    expect(repoToUrl("https://github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo.git",
    );
    expect(repoToUrl("git@github.com:owner/repo.git")).toBe("git@github.com:owner/repo.git");
  });

  test("a local filesystem path passes through unchanged", () => {
    expect(repoToUrl("/tmp/some/repo")).toBe("/tmp/some/repo");
    expect(repoToUrl("./local")).toBe("./local");
  });

  test("an empty or unrecognized spec throws SkillsError", () => {
    expect(() => repoToUrl("")).toThrow(SkillsError);
    expect(() => repoToUrl("no-slash-no-scheme")).toThrow(SkillsError);
  });
});

describe("resolveRef (git ls-remote against a local repo)", () => {
  test("resolves a branch to the exact HEAD SHA", async () => {
    const { repo, sha } = await makeSkillsRepo({ tdd: "# tdd\n" });
    const resolved = await resolveRef(repo, "HEAD");
    expect(resolved).toMatch(SHA);
    expect(resolved).toBe(sha);
  });

  test("resolves a tag to the tagged commit", async () => {
    const { repo, sha } = await makeSkillsRepo({ tdd: "# tdd\n" });
    git(repo, "tag", "v1.0.0");
    expect(await resolveRef(repo, "v1.0.0")).toBe(sha);
  });

  test("a ref that is already a 40-hex SHA passes through with no round-trip", async () => {
    const pinned = "a".repeat(40);
    expect(await resolveRef("owner/does-not-matter", pinned)).toBe(pinned);
  });

  test("an unknown ref throws SkillsError naming the ref", async () => {
    const { repo } = await makeSkillsRepo({ tdd: "# tdd\n" });
    await expect(resolveRef(repo, "no-such-branch")).rejects.toBeInstanceOf(SkillsError);
    await expect(resolveRef(repo, "no-such-branch")).rejects.toThrow(/no-such-branch/);
  });
});

describe("restoreViaClone (clone at pinned SHA + symlink)", () => {
  test("materializes the used skills at the exact locked commit as symlinks", async () => {
    const { repo, sha } = await makeSkillsRepo({
      "diagnosing-bugs": "# diagnosing\n",
      tdd: "# tdd\n",
      unused: "# unused\n",
    });
    const layout = await initTargetRepo();

    const placed = await restoreViaClone(layout, {
      repo,
      ref: "main",
      sha,
      skills: ["diagnosing-bugs", "tdd"],
    });
    expect(placed).toEqual(["diagnosing-bugs", "tdd"]);

    // Each placed skill is a symlink under .claude/skills resolving into the
    // pinned clone, and the unused skill is not placed.
    for (const name of ["diagnosing-bugs", "tdd"]) {
      const link = join(claudeSkillsDir(layout), name);
      const target = await readlink(link);
      expect(target).toContain(join(sha, ""));
      expect(await readFile(join(link, "SKILL.md"), "utf8")).toContain(name.split("-")[0]!);
    }
    await expect(readFile(join(claudeSkillsDir(layout), "unused"), "utf8")).rejects.toThrow();

    // The clone lives in the gitignored cache, keyed by SHA.
    expect(await readFile(join(skillsCacheDir(layout), sha, "SKILL_MARKER"), "utf8").catch(() => null))
      .toBeNull();
    expect(join(skillsCacheDir(layout), sha)).toContain(".nahel-skills");
  });

  test("restore is idempotent — a second run reuses the clone and re-links", async () => {
    const { repo, sha } = await makeSkillsRepo({ tdd: "# tdd\n" });
    const layout = await initTargetRepo();
    const entry = { repo, ref: "main", sha, skills: ["tdd"] };

    await restoreViaClone(layout, entry);
    const second = await restoreViaClone(layout, entry);
    expect(second).toEqual(["tdd"]);
    expect(await readFile(join(claudeSkillsDir(layout), "tdd", "SKILL.md"), "utf8")).toContain("tdd");
  });

  test("finds skills under a conventional skills/ subdirectory too", async () => {
    const { repo, sha } = await makeSkillsRepo({ grilling: "# grilling\n" }, "skills-subdir");
    const layout = await initTargetRepo();
    const placed = await restoreViaClone(layout, { repo, ref: "main", sha, skills: ["grilling"] });
    expect(placed).toEqual(["grilling"]);
    expect(await readFile(join(claudeSkillsDir(layout), "grilling", "SKILL.md"), "utf8")).toContain(
      "grilling",
    );
  });

  test("a used skill absent from the pinned commit throws SkillsError naming it", async () => {
    const { repo, sha } = await makeSkillsRepo({ tdd: "# tdd\n" });
    const layout = await initTargetRepo();
    const attempt = restoreViaClone(layout, { repo, ref: "main", sha, skills: ["missing"] });
    await expect(attempt).rejects.toBeInstanceOf(SkillsError);
    await expect(attempt).rejects.toThrow(/missing/);
  });

  test("restores the EXACT locked commit, not the tip of the branch", async () => {
    const { repo, sha } = await makeSkillsRepo({ tdd: "# v1\n" });
    // Advance the branch after locking: the lock still pins the old commit.
    await writeFile(join(repo, "tdd", "SKILL.md"), "# v2 tip\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "advance");

    const layout = await initTargetRepo();
    await restoreViaClone(layout, { repo, ref: "main", sha, skills: ["tdd"] });
    expect(await readFile(join(claudeSkillsDir(layout), "tdd", "SKILL.md"), "utf8")).toBe("# v1\n");
  });
});

describe("skills CLI delegation", () => {
  /** Put a fake `skills` executable on PATH; returns a restore function. */
  async function withFakeSkills(script: string): Promise<() => void> {
    const bin = await tempDir("nahel-fakebin-");
    await writeFile(join(bin, "skills"), script);
    await chmod(join(bin, "skills"), 0o755);
    const original = process.env["PATH"];
    process.env["PATH"] = `${bin}:${original ?? ""}`;
    return () => {
      process.env["PATH"] = original;
    };
  }

  test("skillsCliAvailable is false when no skills binary is on PATH", async () => {
    // The test environment has no `skills` CLI installed.
    expect(await skillsCliAvailable()).toBe(false);
  });

  test("skillsCliAvailable is true when a skills binary is on PATH", async () => {
    const restore = await withFakeSkills("#!/bin/sh\nexit 0\n");
    try {
      expect(await skillsCliAvailable()).toBe(true);
    } finally {
      restore();
    }
  });

  test("restoreViaSkillsCli invokes `skills add <url>@<sha> <names…>` and returns the names", async () => {
    const argsFile = join(await tempDir("nahel-args-"), "argv");
    const restore = await withFakeSkills(`#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\nexit 0\n`);
    try {
      const entry = {
        repo: "PromptDrivenDev/skills",
        ref: "main",
        sha: "b".repeat(40),
        skills: ["tdd", "grilling"],
      };
      const placed = await restoreViaSkillsCli(entry);
      expect(placed).toEqual(["tdd", "grilling"]);
      const argv = (await readFile(argsFile, "utf8")).split("\n").filter((l) => l !== "");
      expect(argv).toEqual([
        "add",
        "https://github.com/PromptDrivenDev/skills.git@" + "b".repeat(40),
        "tdd",
        "grilling",
      ]);
    } finally {
      restore();
    }
  });

  test("restoreViaSkillsCli surfaces a non-zero CLI exit as SkillsError", async () => {
    const restore = await withFakeSkills("#!/bin/sh\necho boom 1>&2\nexit 3\n");
    try {
      const attempt = restoreViaSkillsCli({
        repo: "a/b",
        ref: "main",
        sha: "c".repeat(40),
        skills: ["tdd"],
      });
      await expect(attempt).rejects.toBeInstanceOf(SkillsError);
    } finally {
      restore();
    }
  });
});

describe("store/layout — skills.yaml and skills.lock I/O", () => {
  test("readSkillsManifest returns null when skills.yaml is absent", async () => {
    const layout = await initTargetRepo();
    expect(await readSkillsManifest(layout)).toBeNull();
    expect(await readSkillsLock(layout)).toBeNull();
  });

  test("readSkillsManifest parses and validates a well-formed manifest", async () => {
    const layout = await initTargetRepo();
    await writeFile(
      layout.skillsManifestPath,
      "skills:\n  - repo: owner/name\n    ref: main\n    use: [tdd, grilling]\n",
    );
    const manifest = await readSkillsManifest(layout);
    expect(manifest).toEqual({
      skills: [{ repo: "owner/name", ref: "main", use: ["tdd", "grilling"] }],
    });
  });

  test("readSkillsManifest throws on an invalid manifest (unknown key)", async () => {
    const layout = await initTargetRepo();
    await writeFile(layout.skillsManifestPath, "skills: []\nbogus: 1\n");
    await expect(readSkillsManifest(layout)).rejects.toThrow();
  });

  test("writeSkillsLock then readSkillsLock round-trips a validated lock", async () => {
    const layout = await initTargetRepo();
    const lock: SkillsLock = {
      entries: [{ repo: "owner/name", ref: "main", sha: "d".repeat(40), skills: ["tdd"] }],
    };
    await writeSkillsLock(layout, lock);
    expect(await readSkillsLock(layout)).toEqual(lock);
    // Written at the repo root as skills.lock, pretty JSON with a trailing newline.
    const text = await readFile(layout.skillsLockPath, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(lock);
  });

  test("writeSkillsLock refuses an invalid lock (short sha)", async () => {
    const layout = await initTargetRepo();
    const bad = { entries: [{ repo: "a/b", ref: "main", sha: "abc", skills: ["tdd"] }] };
    await expect(writeSkillsLock(layout, bad as SkillsLock)).rejects.toThrow();
  });
});

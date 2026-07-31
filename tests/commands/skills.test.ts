import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandContext } from "../../src/cli";
import { skillsCommand } from "../../src/commands/skills";
import { ensureLayout, readSkillsLock, storeLayout, writeConfig } from "../../src/store/layout";
import { claudeSkillsDir } from "../../src/store/skills";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel skills` (PRD F7, ADR-0009): `lock` resolves skills.yaml refs to exact
 * commit SHAs; `restore` materializes the pinned skills at those commits. All
 * git runs against REAL local repos in temp dirs — no mocks, no network. The
 * test environment has no `skills` CLI, so restore exercises the proven
 * clone-and-symlink fallback (the acceptance path).
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
 * A local git repo with the named skills, returning its path + HEAD SHA. `at`
 * places it at a known path (a manifest naming it RELATIVELY needs that).
 */
async function makeSkillsRepo(
  skills: string[],
  at?: string,
): Promise<{ repo: string; sha: string }> {
  const repo = at ?? (await tempDir("nahel-skillsrepo-"));
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "commit.gpgsign", "false");
  for (const name of skills) {
    await mkdir(join(repo, name), { recursive: true });
    await writeFile(join(repo, name, "SKILL.md"), `# ${name}\n`);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "skills");
  return { repo, sha: git(repo, "rev-parse", "HEAD").trim() };
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function runSkills(root: string, args: string[]): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    env: seededEnv(),
    cwd: root,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  const code = await skillsCommand.run(args, ctx);
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

/** A fresh initialized target repo, returning its root. */
async function makeTarget(): Promise<string> {
  const root = await tempDir("nahel-target-");
  await ensureLayout(root);
  return root;
}

describe("nahel skills lock", () => {
  test("resolves each manifest source's ref to a SHA and writes skills.lock", async () => {
    const { repo, sha } = await makeSkillsRepo(["diagnosing-bugs", "tdd"]);
    const root = await makeTarget();
    await writeFile(
      join(root, "skills.yaml"),
      `skills:\n  - repo: ${repo}\n    ref: HEAD\n    use: [diagnosing-bugs, tdd]\n`,
    );

    const result = await runSkills(root, ["lock"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(sha);
    expect(result.stdout).toContain("wrote skills.lock (1 source(s))");

    const lock = await readSkillsLock(storeLayout(root));
    expect(lock).toEqual({
      entries: [{ repo, ref: "HEAD", sha, skills: ["diagnosing-bugs", "tdd"] }],
    });
    expect(lock!.entries[0]!.sha).toMatch(SHA);
  });

  test("no skills.yaml reports nothing to lock, exit 0", async () => {
    const root = await makeTarget();
    const result = await runSkills(root, ["lock"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("nothing to lock");
  });

  test("an unresolvable ref fails, exit 1", async () => {
    const { repo } = await makeSkillsRepo(["tdd"]);
    const root = await makeTarget();
    await writeFile(
      join(root, "skills.yaml"),
      `skills:\n  - repo: ${repo}\n    ref: no-such-ref\n    use: [tdd]\n`,
    );
    const result = await runSkills(root, ["lock"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no-such-ref");
  });
});

describe("nahel skills restore", () => {
  test("materializes the pinned skills at the locked commit (clone-and-symlink)", async () => {
    const { repo, sha } = await makeSkillsRepo(["diagnosing-bugs", "tdd"]);
    const root = await makeTarget();
    await writeFile(
      join(root, "skills.yaml"),
      `skills:\n  - repo: ${repo}\n    ref: HEAD\n    use: [diagnosing-bugs, tdd]\n`,
    );
    // Lock, then restore — the two-step, one-command-each flow.
    expect((await runSkills(root, ["lock"])).code).toBe(0);

    const result = await runSkills(root, ["restore"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("restored 1 skill source(s)");
    for (const name of ["diagnosing-bugs", "tdd"]) {
      expect(await readFile(join(claudeSkillsDir(storeLayout(root)), name, "SKILL.md"), "utf8")).toBe(
        `# ${name}\n`,
      );
    }
    expect(sha).toMatch(SHA);
  });

  test("a fresh clone restores the EXACT locked commit even after the branch advances", async () => {
    const { repo, sha } = await makeSkillsRepo(["tdd"]);
    const source = await makeTarget();
    await writeFile(
      join(source, "skills.yaml"),
      `skills:\n  - repo: ${repo}\n    ref: HEAD\n    use: [tdd]\n`,
    );
    await runSkills(source, ["lock"]);
    const lockText = await readFile(join(source, "skills.lock"), "utf8");

    // The upstream branch moves on after locking.
    await writeFile(join(repo, "tdd", "SKILL.md"), "# tdd v2 (tip)\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "advance");

    // A FRESH checkout carrying only the committed skills.lock restores in one
    // command to the pinned commit — not the moved tip.
    const fresh = await makeTarget();
    await writeFile(join(fresh, "skills.lock"), lockText);
    const result = await runSkills(fresh, ["restore"]);
    expect(result.code).toBe(0);
    expect(await readFile(join(claudeSkillsDir(storeLayout(fresh)), "tdd", "SKILL.md"), "utf8")).toBe(
      "# tdd\n",
    );
    expect(sha).toMatch(SHA);
  });

  test("skills.yaml present but no skills.lock points at `nahel skills lock`, exit 1", async () => {
    const { repo } = await makeSkillsRepo(["tdd"]);
    const root = await makeTarget();
    await writeFile(join(root, "skills.yaml"), `skills:\n  - repo: ${repo}\n    ref: HEAD\n    use: [tdd]\n`);
    const result = await runSkills(root, ["restore"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("nahel skills lock");
  });

  test("neither manifest nor lock reports nothing to restore, exit 0", async () => {
    const root = await makeTarget();
    const result = await runSkills(root, ["restore"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("nothing to restore");
  });
});

describe("nahel skills — run from a subdirectory (store root walk-up)", () => {
  /** An initialized store in a git repo — the walk needs both. */
  async function makeStoreRepo(): Promise<string> {
    const root = await tempDir("nahel-skills-subdir-");
    git(root, "init", "-q");
    await writeConfig(await ensureLayout(root), makeConfig());
    return root;
  }

  test("clone-and-symlink restore from a subdirectory places skills at the store root", async () => {
    const { repo } = await makeSkillsRepo(["tdd"]);
    const root = await makeStoreRepo();
    await writeFile(
      join(root, "skills.yaml"),
      `skills:\n  - repo: ${repo}\n    ref: HEAD\n    use: [tdd]\n`,
    );
    const sub = join(root, "nahel", "journal", "archive");
    await mkdir(sub, { recursive: true });

    expect((await runSkills(sub, ["lock"])).code).toBe(0);
    expect((await runSkills(sub, ["restore"])).code).toBe(0);
    expect(await readFile(join(claudeSkillsDir(storeLayout(root)), "tdd", "SKILL.md"), "utf8")).toBe(
      "# tdd\n",
    );
  });

  test("a RELATIVE repo spec is resolved from the STORE ROOT: lock + restore from a subdirectory", async () => {
    // `./vendor/…` in skills.yaml means "relative to the repo the manifest is
    // committed in" — the only reading that survives being run from anywhere.
    // Resolved from the process's own cwd it names a different directory
    // entirely: a missing path, or worse, a same-named sibling repo.
    const root = await makeStoreRepo();
    const { sha } = await makeSkillsRepo(["tdd"], join(root, "vendor", "skills-src"));
    await writeFile(
      join(root, "skills.yaml"),
      "skills:\n  - repo: ./vendor/skills-src\n    ref: HEAD\n    use: [tdd]\n",
    );
    const sub = join(root, "nahel", "journal", "archive");
    await mkdir(sub, { recursive: true });

    const locked = await runSkills(sub, ["lock"]);
    expect(locked.stderr).toBe("");
    expect(locked.code).toBe(0);
    expect((await readSkillsLock(storeLayout(root)))!.entries[0]!.sha).toBe(sha);

    const restored = await runSkills(sub, ["restore"]);
    expect(restored.stderr).toBe("");
    expect(restored.code).toBe(0);
    expect(await readFile(join(claudeSkillsDir(storeLayout(root)), "tdd", "SKILL.md"), "utf8")).toBe(
      "# tdd\n",
    );
  });

  test("restore alone clones a RELATIVE spec from the store root — a committed lock is enough", async () => {
    // The clone path on its own: skills.lock is committed, so a fresh checkout
    // restores in ONE command, from wherever the user happens to stand.
    const root = await makeStoreRepo();
    const { sha } = await makeSkillsRepo(["tdd"], join(root, "vendor", "skills-src"));
    await writeFile(
      join(root, "skills.lock"),
      `${JSON.stringify(
        { entries: [{ repo: "./vendor/skills-src", ref: "HEAD", sha, skills: ["tdd"] }] },
        null,
        2,
      )}\n`,
    );
    const sub = join(root, "nahel", "items");
    await mkdir(sub, { recursive: true });

    const result = await runSkills(sub, ["restore"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(await readFile(join(claudeSkillsDir(storeLayout(root)), "tdd", "SKILL.md"), "utf8")).toBe(
      "# tdd\n",
    );
  });

  test("the external skills CLI is run in the STORE ROOT, so both restore paths agree", async () => {
    // Which tool is installed must not change WHERE skills land: the git
    // fallback writes under layout.root, so the delegated CLI — which places
    // into .claude/skills/ relative to its own cwd — must run there too.
    const { repo } = await makeSkillsRepo(["tdd"]);
    const root = await makeStoreRepo();
    await writeFile(
      join(root, "skills.yaml"),
      `skills:\n  - repo: ${repo}\n    ref: HEAD\n    use: [tdd]\n`,
    );
    const sub = join(root, "nahel", "items");
    await mkdir(sub, { recursive: true });
    expect((await runSkills(sub, ["lock"])).code).toBe(0);

    // A real `skills` executable on PATH that records the directory it ran in.
    const binDir = await tempDir("nahel-skills-bin-");
    const record = join(binDir, "cwd.txt");
    await writeFile(join(binDir, "skills"), `#!/bin/sh\npwd > ${JSON.stringify(record)}\n`, "utf8");
    await chmod(join(binDir, "skills"), 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    try {
      const result = await runSkills(sub, ["restore"]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("via skills CLI");
      expect((await readFile(record, "utf8")).trim()).toBe(await realpath(root));
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe("nahel skills — usage", () => {
  test("missing subcommand is a usage error, exit 1", async () => {
    const root = await makeTarget();
    const result = await runSkills(root, []);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("usage");
  });

  test("an unknown subcommand is a usage error, exit 1", async () => {
    const root = await makeTarget();
    const result = await runSkills(root, ["frobnicate"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown skills subcommand");
  });

  test("extra positionals after the subcommand are a usage error, exit 1", async () => {
    const root = await makeTarget();
    const result = await runSkills(root, ["lock", "surprise"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unexpected extra arguments");
  });

  test("exports a registration-ready Command: a description and a run function", () => {
    expect(typeof skillsCommand.description).toBe("string");
    expect(skillsCommand.description.length).toBeGreaterThan(0);
    expect(typeof skillsCommand.run).toBe("function");
  });
});

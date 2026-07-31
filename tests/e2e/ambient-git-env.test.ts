import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Ambient git environment must not redirect nahel's own git questions (HC6).
 *
 * Every git call nahel makes asks about "the repo AT this root" — the checkout
 * it was pointed at. Git's repository-selection variables (GIT_DIR and its
 * relatives) override that from the outside: they are set by hooks, by CI
 * runners, by `git rebase --exec`, and by any shell that exported one and
 * forgot. Inherited, they turn nahel's answers into answers about a DIFFERENT
 * repository — and the two failures below are silent, which is what makes them
 * worth an end-to-end test through the real CLI rather than a unit test.
 */

const CLI = join(import.meta.dir, "../../src/cli.ts");

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn the real CLI in `cwd` with extra environment; echo the exchange. */
function nahel(cwd: string, env: Record<string, string>, ...args: string[]): CliResult {
  const result = spawnSync("bun", ["run", CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  const output = { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  console.log(
    `$ ${Object.keys(env).join(" ")} nahel ${args.join(" ")}\n  exit ${output.code}` +
      (output.stdout.trim() === "" ? "" : `\n  stdout: ${output.stdout.trim()}`) +
      (output.stderr.trim() === "" ? "" : `\n  stderr: ${output.stderr.trim()}`),
  );
  return output;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/** A real repo with a nahel store, one commit on main. */
async function makeRepo(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(root);
  git(root, "init", "-q", "--initial-branch=main");
  git(root, "config", "user.email", "test@nahel.test");
  git(root, "config", "user.name", "Ambient Env Test");
  await writeFile(join(root, "app.txt"), `${prefix} content\n`);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "initial");
  const init = nahel(root, {}, "init");
  if (init.code !== 0) throw new Error(`nahel init failed:\n${init.stdout}\n${init.stderr}`);
  return root;
}

/** Every journal line the store has written, active segments and archive. */
async function journalText(root: string): Promise<string> {
  const dirs = [join(root, "nahel", "journal"), join(root, "nahel", "journal", "archive")];
  let text = "";
  for (const dir of dirs) {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.endsWith(".jsonl")) continue;
      text += await readFile(join(dir, name), "utf8");
    }
  }
  return text;
}

describe("ambient GIT_DIR must not redirect nahel's git questions", () => {
  test(
    "validate still judges never-merge for THIS repo, not a repo the environment names",
    async () => {
      const root = await makeRepo("nahel-ambient-validate-");
      // A prototype variant whose commit is then copied onto main: the
      // never-merge violation `nahel validate` exists to catch.
      git(root, "checkout", "-q", "-b", "prototype/ambient/variant-1");
      await writeFile(join(root, "variant.txt"), "variant work\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "variant work");
      const copied = git(root, "rev-parse", "HEAD").trim();
      git(root, "checkout", "-q", "main");
      await writeFile(join(root, "mainline.txt"), "main moved on\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "mainline work");
      git(root, "cherry-pick", copied);

      // Control: the violation is visible with a clean environment.
      const clean = nahel(root, {}, "validate");
      expect(clean.stdout).toContain("prototype.merged");
      expect(clean.code).toBe(1);

      // The same repo, with an inherited GIT_DIR naming somewhere else. git
      // reports "not a git repository" ABOUT THAT PATH — a statement about the
      // environment, never evidence that this checkout is not a repo.
      const redirected = nahel(root, { GIT_DIR: "/definitely-not-a-git-dir" }, "validate");
      expect(redirected.stdout).toContain("prototype.merged");
      expect(redirected.code).toBe(1);
    },
    { timeout: 30_000 },
  );

  test(
    "claim records THIS repo's HEAD as its baseline, not the one GIT_DIR points at",
    async () => {
      const mine = await makeRepo("nahel-ambient-claim-");
      const other = await makeRepo("nahel-ambient-other-");
      const myHead = git(mine, "rev-parse", "HEAD").trim();
      const otherHead = git(other, "rev-parse", "HEAD").trim();
      expect(myHead).not.toBe(otherHead);

      const created = nahel(mine, {}, "item", "new", "feature", "ambient-item", "direct");
      expect(created.code).toBe(0);
      const itemId = created.stdout.trim().split("\n").pop()!;

      // GIT_DIR names ANOTHER real repo: git answers about it happily, at exit
      // 0 — nothing fails, so a wrong baseline would be journaled in silence
      // and every handback afterwards would be evidence about the wrong repo.
      const claim = nahel(
        mine,
        { GIT_DIR: join(other, ".git"), NAHEL_ACTOR: "human:jim" },
        "claim",
        itemId,
      );
      expect(claim.code).toBe(0);

      const journal = await journalText(mine);
      expect(journal).toContain(myHead);
      expect(journal).not.toContain(otherHead);
    },
    { timeout: 30_000 },
  );
});

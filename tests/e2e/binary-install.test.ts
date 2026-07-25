import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * PRD F8.1 acceptance criterion, verbatim: "A fresh machine (or clean PATH)
 * can install the compiled binary with one documented command and run `nahel
 * brief` in the lab repo."
 *
 * Proven for real, never simulated: the documented install command compiles
 * the current-platform binary and lands it in a temp bin dir, then the test
 * invokes bare `nahel` through a PATH containing ONLY that dir plus the
 * system dirs — no bun, no repo checkout on PATH — against a fresh git repo.
 * If the artifact secretly needs the source tree or a bun runtime, this
 * fails. Verbose by design: every exchange is echoed for debugging.
 */

const REPO_ROOT = join(import.meta.dir, "../..");

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function echo(label: string, result: Result): Result {
  console.log(
    `$ ${label}\n  exit ${result.code}` +
      (result.stdout.trim() === "" ? "" : `\n  stdout: ${result.stdout.trim()}`) +
      (result.stderr.trim() === "" ? "" : `\n  stderr: ${result.stderr.trim()}`),
  );
  return result;
}

describe("E2E compiled binary (PRD F8.1) — one documented command installs `nahel` on PATH", () => {
  test(
    "install:local builds the binary and a clean-PATH `nahel brief` works in a fresh repo",
    async () => {
      const binDir = await tempDir("nahel-bin-");

      // The documented install command — build + land on PATH in one step.
      // NAHEL_BIN_DIR redirects the install so the test never touches the
      // developer's real ~/.local/bin.
      const install = spawnSync("bun", ["run", "install:local"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, NAHEL_BIN_DIR: binDir },
      });
      echo("bun run install:local", {
        code: install.status ?? -1,
        stdout: install.stdout,
        stderr: install.stderr,
      });
      expect(install.status).toBe(0);

      // The installed artifact is a real executable file, not a wrapper
      // script pointing back at the checkout.
      const installed = join(binDir, "nahel");
      const info = await stat(installed);
      expect(info.isFile()).toBe(true);
      expect(info.mode & 0o111).toBeGreaterThan(0);
      expect(info.size).toBeGreaterThan(1_000_000); // a compiled binary, not a shim
      const head = (await Bun.file(installed).slice(0, 2).text()).trim();
      expect(head.startsWith("#!")).toBe(false);

      // A fresh repo and a clean PATH: only the install dir plus system dirs,
      // so `bun` is unreachable and nothing resolves into the checkout.
      const repo = await tempDir("nahel-lab-");
      const gitInit = spawnSync("git", ["init", "--initial-branch=main"], {
        cwd: repo,
        encoding: "utf8",
      });
      expect(gitInit.status).toBe(0);

      const cleanEnv = {
        PATH: `${binDir}:/usr/bin:/bin`,
        HOME: process.env.HOME ?? repo,
        NAHEL_ACTOR: "agent:binary-install-test",
      };
      const run = (...args: string[]): Result => {
        const result = spawnSync("nahel", args, { cwd: repo, encoding: "utf8", env: cleanEnv });
        return echo(`nahel ${args.join(" ")} (clean PATH)`, {
          code: result.status ?? -1,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      };

      // bun is genuinely absent from the clean PATH — the binary stands alone.
      const bunProbe = spawnSync("bun", ["--version"], { encoding: "utf8", env: cleanEnv });
      expect(bunProbe.error).toBeDefined();

      expect(run("--version").stdout.trim()).toMatch(/^nahel \d+\.\d+\.\d+$/);

      const init = run("init");
      expect(init.code).toBe(0);
      expect(init.stdout).toContain("nahel initialized");

      const brief = run("brief");
      expect(brief.code).toBe(0);
      expect(brief.stdout).toContain("== constitution (PRODUCT.md) ==");
      expect(brief.stdout).toContain("== knowledge & canonical truth ==");
      expect(brief.stdout).toContain("== item statuses ==");
    },
    { timeout: 120_000 },
  );
});

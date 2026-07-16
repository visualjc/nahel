import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * PRD success criterion 2 — the end-to-end journey test, verbatim: one
 * scripted `bun test` drives the whole thesis on a fresh temp git repo,
 * `init` → `item new` → `run start` → `log` → `item update` / `run update
 * --phase` → `run end` → `brief` renders all required sections reflecting
 * everything above → `validate` exits 0.
 *
 * THESIS PROOF CONSTRAINT: this file exercises ONLY the public CLI through
 * child-process invocations — zero imports from src/. If state cannot be
 * advanced and read back through the binary alone, the thesis fails.
 * Verbose by design: every CLI call is echoed with its output for debugging.
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

/** Spawn the real CLI in `cwd`; echo the full exchange for debugging. */
function nahel(cwd: string, ...args: string[]): CliResult {
  const result = spawnSync("bun", ["run", CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NAHEL_ACTOR: "agent:journey-agent" },
  });
  const output = { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  console.log(
    `$ nahel ${args.join(" ")}\n  exit ${output.code}` +
      (output.stdout.trim() === "" ? "" : `\n  stdout: ${output.stdout.trim()}`) +
      (output.stderr.trim() === "" ? "" : `\n  stderr: ${output.stderr.trim()}`),
  );
  return output;
}

/** Assert success loudly — failures carry the full CLI exchange. */
function ok(result: CliResult, what: string): CliResult {
  if (result.code !== 0) {
    throw new Error(`${what} failed (exit ${result.code}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

describe("E2E journey (PRD criterion 2) — the whole thesis through the public CLI", () => {
  test(
    "init → item new → run start → log → item update / run update --phase → run end → brief → validate 0",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "nahel-journey-"));
      tempDirs.push(root);
      git(root, "init", "--initial-branch=main");

      // init: scaffold state structure, config, and knowledge templates.
      const init = ok(nahel(root, "init"), "init");
      expect(init.stdout).toContain("nahel initialized");

      // item new: an epic and a child under it.
      const epicId = ok(
        nahel(root, "item", "new", "feature", "journey-epic", "full"),
        "item new (epic)",
      ).stdout.trim();
      expect(epicId).not.toBe("");
      const childId = ok(
        nahel(root, "item", "new", "feature", "journey-child", "direct", "--parent", epicId),
        "item new (child)",
      ).stdout.trim();
      expect(childId).not.toBe("");
      expect(childId).not.toBe(epicId);

      // run start on the child.
      const runId = ok(nahel(root, "run", "start", childId), "run start").stdout.trim();
      expect(runId).not.toBe("");

      // log: an observation about work, ref'd to the run.
      const logged = ok(
        nahel(
          root,
          "log",
          "test.failed",
          "--item",
          childId,
          "--run",
          runId,
          "--data",
          '{"test":"journey-auth-spec"}',
        ),
        "log",
      );
      expect(logged.stdout).toContain("test.failed");

      // item update + run update --phase.
      ok(nahel(root, "item", "update", childId, "--status", "in-progress"), "item update");
      ok(nahel(root, "run", "update", runId, "--phase", "building"), "run update --phase");

      // run end.
      ok(nahel(root, "run", "end", runId, "success"), "run end");

      // brief: all six required sections, in order, reflecting everything above.
      const brief = ok(nahel(root, "brief"), "brief").stdout;
      const sections = [
        "== constitution (PRODUCT.md) ==",
        "== knowledge & canonical truth ==",
        "== item statuses ==",
        "== recent activity (newest last) ==",
        "== pending human decisions ==",
        "== validate warnings ==",
      ];
      let cursor = -1;
      for (const section of sections) {
        const at = brief.indexOf(section);
        expect(at).toBeGreaterThan(cursor); // present AND in the fixed order
        cursor = at;
      }
      // Constitution extract: the scaffolded template's frozen headings.
      expect(brief).toContain("## Goal");
      expect(brief).toContain("## Hard constraints");
      // Statuses reflect the items created and updated above.
      expect(brief).toContain("journey-epic");
      expect(brief).toContain("journey-child");
      expect(brief).toContain("in-progress");
      // Activity reflects the journal: creation, the logged observation, the
      // phase move, and the run close — every mutation went through the CLI.
      expect(brief).toContain("item.created");
      expect(brief).toContain("test.failed");
      expect(brief).toContain("journey-auth-spec");
      expect(brief).toContain("run.updated");
      expect(brief).toContain("run.ended");
      expect(brief).toContain("agent:journey-agent");
      // No claims, blocks, or paused runs were made — decisions are explicit none.
      expect(brief).toContain("== pending human decisions ==\nnone");

      // validate: exit 0 on the state the journey produced.
      const validate = ok(nahel(root, "validate"), "validate");
      expect(validate.code).toBe(0);
      expect(validate.stderr).toBe("");
    },
    { timeout: 60_000 },
  );
});

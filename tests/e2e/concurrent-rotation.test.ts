import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * PR #12 review regression — concurrent-writer contract vs. the rotation
 * sweep: every successful mutation closes its session segment and sweeps all
 * closed segments, so concurrent CLI processes race between listSegments()
 * and rename(). Losing that race must not fail a command whose mutation
 * already succeeded (ADR-0012 cooperative concurrency: disjoint records,
 * shared journal directory). Exercises ONLY the public CLI through real
 * child processes — the race does not exist in-process.
 */

const CLI = join(import.meta.dir, "../../src/cli.ts");

const WRITERS = 24;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn one real CLI process without waiting, resolving with its full exchange. */
function nahelAsync(cwd: string, actor: string, ...args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", CLI, ...args], {
      cwd,
      env: { ...process.env, NAHEL_ACTOR: actor },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe("concurrent mutation commands vs. rotation sweep", () => {
  test(
    `${WRITERS} parallel item new processes: all exit 0, all items exist, every segment archived`,
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "nahel-concurrent-rotation-"));
      const git = spawnSync("git", ["init", "-q", cwd], { encoding: "utf8" });
      expect(git.status).toBe(0);
      const init = spawnSync("bun", ["run", CLI, "init", "--actor", "human:jim"], {
        cwd,
        encoding: "utf8",
      });
      expect(init.status).toBe(0);

      const results = await Promise.all(
        Array.from({ length: WRITERS }, (_, i) =>
          nahelAsync(cwd, `agent:writer-${i}`, "item", "new", "chore", `race-item-${i}`, "direct"),
        ),
      );

      // Every command must report success — a mutation that landed but
      // exited non-zero makes retries dangerous (the review's exact repro).
      for (const [i, result] of results.entries()) {
        if (result.code !== 0) {
          console.log(`writer ${i} exit ${result.code}\n  stderr: ${result.stderr.trim()}`);
        }
        expect(result.code).toBe(0);
      }

      // Every mutation exists exactly once.
      const items = await readdir(join(cwd, "nahel", "items"));
      expect(items.length).toBe(WRITERS);

      // No active session segments remain, and every closed segment was
      // archived — by whichever process won each race.
      const journal = await readdir(join(cwd, "nahel", "journal"));
      const activeSegments = journal.filter((name) => name.endsWith(".jsonl"));
      expect(activeSegments).toEqual([]);
      const archived = await readdir(join(cwd, "nahel", "journal", "archive"));
      expect(archived.filter((name) => name.startsWith("session-")).length).toBe(WRITERS);

      // The store itself is coherent after the storm.
      const validate = spawnSync("bun", ["run", CLI, "validate"], { cwd, encoding: "utf8" });
      expect(validate.status).toBe(0);
    },
    120_000,
  );
});

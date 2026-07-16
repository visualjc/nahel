import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { generateId } from "../../src/schema/id";
import { readItem } from "../../src/store/layout";
import { ensureLayout } from "../../src/store/layout";
import { makeTempDir, seededEnv } from "./helpers";

const WORKER = join(import.meta.dir, "workers", "kill-writer.ts");

let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

describe("atomic writes survive SIGKILL", () => {
  test(
    "a writer killed mid-rewrite never leaves a half-written record",
    async () => {
      const root = await makeTempDir();
      dirs.push(root);
      const itemId = generateId(seededEnv({ seed: Date.now() & 0xffff }));

      // Run several kill rounds so the SIGKILL lands at varied points in the
      // write path (temp-file write, fsync, rename).
      for (let round = 0; round < 5; round++) {
        const proc = Bun.spawn(["bun", "run", WORKER, root, itemId], {
          stdout: "pipe",
          stderr: "inherit",
        });
        // Wait for the worker's initial complete write, then let it churn.
        const reader = proc.stdout.getReader();
        const { value } = await reader.read();
        expect(new TextDecoder().decode(value)).toContain("ready");
        await Bun.sleep(20 + round * 17);
        proc.kill("SIGKILL");
        await proc.exited;

        // The surviving record must be one complete version: parseable
        // frontmatter, schema-valid, and a body that runs through to the
        // END sentinel with no truncation or interleaving.
        const layout = await ensureLayout(root);
        const record = await readItem(layout, itemId);
        expect(record.frontmatter.id).toBe(itemId);
        expect(["backlog", "in-progress"]).toContain(record.frontmatter.status);
        expect(record.body.endsWith("\nEND\n")).toBe(true);
        const letters = new Set(record.body.replace(/\nEND\n$/, "").split(""));
        expect(letters.size).toBe(1);
        expect(record.body.length).toBe(64 * 1024 + "\nEND\n".length);
      }
    },
    { timeout: 30_000 },
  );
});

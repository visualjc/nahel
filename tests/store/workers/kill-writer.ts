/**
 * Subprocess for the atomic-write kill test. Rewrites one work-item record in
 * a tight loop, alternating between two complete payloads, until SIGKILLed by
 * the parent test. Every payload ends with the END sentinel, so the parent can
 * prove the surviving file is one complete version — never a torn mix.
 *
 * Usage: bun run kill-writer.ts <root> <itemId>
 */
import { systemEnv } from "../../../src/schema/env";
import type { WorkItemFrontmatter } from "../../../src/schema/records";
import { ensureLayout, writeItem } from "../../../src/store/layout";

const [root, itemId] = process.argv.slice(2);
if (!root || !itemId) {
  console.error("usage: kill-writer.ts <root> <itemId>");
  process.exit(2);
}

const env = systemEnv();
const layout = await ensureLayout(root);

function frontmatter(status: WorkItemFrontmatter["status"]): WorkItemFrontmatter {
  const ts = env.now();
  return {
    id: itemId as string,
    name: "kill-target",
    type: "feature",
    status,
    lane: "direct",
    depends_on: [],
    external_refs: [],
    created: ts,
    updated: ts,
  };
}

// Two complete versions, each large enough that a torn write would be obvious.
const bodyA = `${"A".repeat(64 * 1024)}\nEND\n`;
const bodyB = `${"B".repeat(64 * 1024)}\nEND\n`;

await writeItem(layout, frontmatter("backlog"), bodyA);
console.log("ready");

// Rewrite forever; the parent SIGKILLs us mid-loop.
for (let i = 0; ; i++) {
  await writeItem(
    layout,
    frontmatter(i % 2 === 0 ? "in-progress" : "backlog"),
    i % 2 === 0 ? bodyB : bodyA,
  );
}

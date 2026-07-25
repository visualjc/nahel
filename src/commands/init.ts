import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Command, CommandContext } from "../cli";
import type { Config } from "../schema/records";
import { parseActorSpec } from "../store/actor";
import { readFrontmatterFile, writeFileAtomic } from "../store/frontmatter";
import {
  ensureLayout,
  knowledgePaths,
  readConfig,
  readTextFile,
  storeLayout,
  writeConfig,
} from "../store/layout";
import { mergeAgentsSection } from "../templates/agents";
import { CONTEXT_TEMPLATE } from "../templates/context";
import { productTemplate } from "../templates/product";

/**
 * `nahel init` (PRD F2, F8.3): non-interactive scaffold. Creates the `nahel/`
 * structure, writes config with flag-overridable knowledge-path defaults, and
 * emits the three knowledge templates. Never overwrites human content:
 * existing files are kept and reported, so re-running is always safe — a full
 * re-run no-ops, a partial one restores only what is missing (per the recorded
 * config, not fresh flags). The single exception is AGENTS.md's explicitly
 * marked nahel section, which is generator-owned and merged in (F8.3);
 * everything outside those markers survives byte for byte. Zero prompts, zero
 * ambient time — the change-log seed date comes from the injected Env.
 */

const DEFAULT_KNOWLEDGE = {
  product: "PRODUCT.md",
  context: "CONTEXT.md",
  adr: "docs/adr",
} as const;

const DEFAULT_ACTOR_SPEC = "human:maintainer";

/**
 * Existence probe through the store's read primitive (commands never touch
 * fs). `readFrontmatterFile` fails with `cannot read <path>` when the file is
 * absent; any other outcome — success, or a frontmatter parse error — means
 * the file exists. Store gap, noted: a first-class exists/readText primitive
 * in src/store would replace this error-shape dependence.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await readFrontmatterFile(path);
    return true;
  } catch (error) {
    return !(error instanceof Error && error.message.startsWith(`cannot read ${path}`));
  }
}

async function runInit(argv: string[], ctx: CommandContext): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      product: { type: "string" },
      context: { type: "string" },
      adr: { type: "string" },
      actor: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const layout = storeLayout(ctx.cwd);

  // Never clobber: an existing config is read and honored, never rewritten;
  // an existing-but-invalid config is refused before anything is created.
  let existing: Config | undefined;
  if (await fileExists(layout.configPath)) {
    try {
      existing = await readConfig(layout);
    } catch (error) {
      ctx.stderr(
        `❌ nahel/config exists but is not a valid config: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      ctx.stderr("Fix or remove nahel/config, then re-run `nahel init` — init never overwrites it.");
      return 1;
    }
    if (values.product !== undefined || values.context !== undefined || values.adr !== undefined || values.actor !== undefined) {
      ctx.stderr("⚠️ nahel/config already exists — flags ignored, recorded config used");
    }
  }

  // Validate all flag input before anything touches disk.
  const freshConfig: Config = {
    knowledge: {
      product: values.product ?? DEFAULT_KNOWLEDGE.product,
      context: values.context ?? DEFAULT_KNOWLEDGE.context,
      adr: values.adr ?? DEFAULT_KNOWLEDGE.adr,
    },
    actor: parseActorSpec(values.actor ?? DEFAULT_ACTOR_SPEC),
  };
  const config = existing ?? freshConfig;

  // Containment preflight (hard constraint 2): resolve the knowledge paths
  // BEFORE anything touches disk — an escaping path (lexical traversal or a
  // symlinked component) refuses the whole init with nothing created, not
  // even nahel/.
  let paths: Awaited<ReturnType<typeof knowledgePaths>>;
  try {
    paths = await knowledgePaths(layout, config);
  } catch (error) {
    ctx.stderr(`❌ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  await ensureLayout(ctx.cwd);

  const created: string[] = [];
  const kept: string[] = [];

  if (existing === undefined) {
    await writeConfig(layout, freshConfig);
    const { knowledge, actor } = freshConfig;
    created.push(
      `nahel/config created (knowledge: ${knowledge.product}, ${knowledge.context}, ${knowledge.adr}; actor: ${actor.kind}:${actor.id})`,
    );
  } else {
    kept.push("nahel/config exists — kept");
  }

  const date = ctx.env.now().slice(0, 10);
  const templates = [
    { label: config.knowledge.product, path: paths.product, content: productTemplate(date) },
    { label: config.knowledge.context, path: paths.context, content: CONTEXT_TEMPLATE },
  ];
  for (const { label, path, content } of templates) {
    if (await fileExists(path)) {
      kept.push(`${label} exists — kept (never overwritten)`);
    } else {
      await writeFileAtomic(path, content);
      created.push(`${label} created`);
    }
  }

  // AGENTS.md is the one merged file (PRD F8.3): a repo that already has one
  // gets the nahel orientation section appended instead of being skipped —
  // the section is regenerated in place afterwards, the rest is untouched.
  const agentsPath = join(ctx.cwd, "AGENTS.md");
  try {
    const merge = mergeAgentsSection(await readTextFile(agentsPath));
    if (merge.outcome === "unchanged") {
      kept.push("AGENTS.md exists — nahel section already current");
    } else {
      await writeFileAtomic(agentsPath, merge.content);
      created.push(
        merge.outcome === "created"
          ? "AGENTS.md created"
          : "AGENTS.md — nahel orientation section merged in (your content preserved)",
      );
    }
  } catch (error) {
    ctx.stderr(`⚠️ AGENTS.md left untouched: ${error instanceof Error ? error.message : String(error)}`);
    kept.push("AGENTS.md exists — left untouched (unmergeable nahel section markers)");
  }

  if (created.length === 0) {
    ctx.stdout("nahel already initialized — nothing to do");
    for (const line of kept) ctx.stdout(`  - ${line}`);
    return 0;
  }

  ctx.stdout("✅ nahel initialized");
  for (const line of created) ctx.stdout(`  - ${line}`);
  for (const line of kept) ctx.stdout(`  - ${line}`);
  ctx.stdout(
    `Next: review ${config.knowledge.product} — the constitution needs the maintainer's sign-off`,
  );
  return 0;
}

export const initCommand: Command = {
  description:
    "scaffold nahel/ state structure, config, and knowledge templates (non-interactive, re-run safe)",
  run: runInit,
};

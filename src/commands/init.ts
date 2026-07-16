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
  storeLayout,
  writeConfig,
} from "../store/layout";
import { AGENTS_TEMPLATE } from "../templates/agents";
import { CONTEXT_TEMPLATE } from "../templates/context";
import { productTemplate } from "../templates/product";

/**
 * `nahel init` (PRD F2): non-interactive scaffold. Creates the `nahel/`
 * structure, writes config with flag-overridable knowledge-path defaults, and
 * emits the three knowledge templates. Never overwrites anything: existing
 * files are kept and reported, so re-running is always safe — a full re-run
 * no-ops, a partial one restores only what is missing (per the recorded
 * config, not fresh flags). Zero prompts, zero ambient time — the change-log
 * seed date comes from the injected Env.
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

  const paths = knowledgePaths(layout, config);
  const date = ctx.env.now().slice(0, 10);
  const templates = [
    { label: config.knowledge.product, path: paths.product, content: productTemplate(date) },
    { label: config.knowledge.context, path: paths.context, content: CONTEXT_TEMPLATE },
    { label: "AGENTS.md", path: join(ctx.cwd, "AGENTS.md"), content: AGENTS_TEMPLATE },
  ];
  for (const { label, path, content } of templates) {
    if (await fileExists(path)) {
      kept.push(`${label} exists — kept (never overwritten)`);
    } else {
      await writeFileAtomic(path, content);
      created.push(`${label} created`);
    }
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

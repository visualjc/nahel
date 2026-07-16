import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Command, CommandContext } from "../cli";
import { AGENT_TARGETS, KNOWN_AGENTS } from "../install/agents";
import {
  parseWorkflowDoc,
  WORKFLOW_NAME_PATTERN,
  WORKFLOWS_RELATIVE_DIR,
  type WorkflowDoc,
} from "../install/workflow";
import { readFrontmatterFile, writeFileAtomic } from "../store/frontmatter";
import {
  listMarkdownDocs,
  readConfig,
  readTextFile,
  removeFile,
  storeLayout,
  workflowsDir,
} from "../store/layout";
import { UsageError } from "./item";

/**
 * `nahel install` (PRD F10): generate per-agent shims for every canonical
 * workflow doc in nahel/workflows/. Regeneration semantics: the prefix
 * directory is generator-owned and made to mirror the workflow set exactly —
 * identical input produces byte-identical files, and anything in the prefix
 * directory that no longer corresponds to a workflow is pruned. A doc with
 * invalid frontmatter is skipped with a warning (the rest still install);
 * an unknown agent fails fast with the known-agent list.
 */

const USAGE = `usage: nahel install --agent <agent> [--prefix <prefix>]
  agent: ${KNOWN_AGENTS.join(" | ")} (the shim target — agent entries are an additive lookup table)
  prefix: slash-command namespace directory, default "nd" (e.g. /nd:brief)`;

interface InstallFlags {
  agent: string;
  prefix: string;
}

function parseFlags(argv: string[]): InstallFlags {
  let values: { agent?: string; prefix?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: { agent: { type: "string" }, prefix: { type: "string" } },
      strict: true,
      allowPositionals: true,
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (positionals.length > 0) {
    throw new UsageError(`unexpected extra arguments: ${positionals.join(" ")}`);
  }
  if (values.agent === undefined) {
    throw new UsageError("missing --agent — say which agent to generate shims for");
  }
  const prefix = values.prefix ?? "nd";
  if (!WORKFLOW_NAME_PATTERN.test(prefix)) {
    throw new UsageError(
      `invalid --prefix ${JSON.stringify(prefix)} — must be a slug (lowercase letters/digits and single hyphens)`,
    );
  }
  return { agent: values.agent, prefix };
}

async function runInstall(argv: string[], ctx: CommandContext): Promise<number> {
  try {
    const flags = parseFlags(argv);
    const layout = storeLayout(ctx.cwd);
    // Initialized-repo gate: workflows live under nahel/, so a repo without
    // config gets the `nahel init` pointer instead of a confusing empty scan.
    await readConfig(layout);

    const target = AGENT_TARGETS[flags.agent];
    if (target === undefined) {
      ctx.stderr(
        `❌ unknown agent ${JSON.stringify(flags.agent)} — known agents: ${KNOWN_AGENTS.join(", ")}`,
      );
      return 1;
    }

    // Scan the canonical workflow docs; invalid ones are warned and skipped.
    const workflows: WorkflowDoc[] = [];
    for (const file of await listMarkdownDocs(workflowsDir(layout))) {
      const path = `${WORKFLOWS_RELATIVE_DIR}/${file}`;
      try {
        const { frontmatter } = await readFrontmatterFile(join(workflowsDir(layout), file));
        workflows.push({ frontmatter: parseWorkflowDoc(file, frontmatter), path });
      } catch (error) {
        ctx.stderr(
          `⚠️ skipped ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Regenerate the generator-owned prefix directory to mirror the workflows.
    const shimDirRelative = target.shimDir(flags.prefix);
    const shimDirAbsolute = join(ctx.cwd, shimDirRelative);
    const lines: string[] = [];
    for (const workflow of workflows) {
      const shimName = `${workflow.frontmatter.name}.md`;
      const shimPath = join(shimDirAbsolute, shimName);
      const desired = target.renderShim(workflow);
      const existing = await readTextFile(shimPath);
      if (existing === desired) {
        lines.push(`unchanged: ${join(shimDirRelative, shimName)}`);
      } else {
        await writeFileAtomic(shimPath, desired);
        lines.push(
          `${existing === null ? "created" : "updated"}: ${join(shimDirRelative, shimName)}`,
        );
      }
    }
    const shimNames = new Set(workflows.map((workflow) => `${workflow.frontmatter.name}.md`));
    for (const file of await listMarkdownDocs(shimDirAbsolute)) {
      if (shimNames.has(file)) continue;
      await removeFile(join(shimDirAbsolute, file));
      lines.push(`removed stale: ${join(shimDirRelative, file)}`);
    }

    if (workflows.length === 0 && lines.length === 0) {
      ctx.stdout(`no workflow docs in ${WORKFLOWS_RELATIVE_DIR}/ — nothing to install`);
      return 0;
    }
    ctx.stdout(
      `✅ installed ${workflows.length} shim(s) for agent ${flags.agent} under ${shimDirRelative}/`,
    );
    for (const line of lines) ctx.stdout(`  - ${line}`);
    return 0;
  } catch (error) {
    ctx.stderr(`❌ ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof UsageError) ctx.stderr(USAGE);
    return 1;
  }
}

export const installCommand: Command = {
  description:
    "generate per-agent slash-command shims from canonical workflow docs (nahel/workflows/*.md)",
  run: runInstall,
};

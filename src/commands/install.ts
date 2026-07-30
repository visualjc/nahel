import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Command, CommandContext } from "../cli";
import { AGENT_TARGETS, KNOWN_AGENTS, type AgentTarget, type ShimRoot } from "../install/agents";
import {
  parseWorkflowDoc,
  WORKFLOW_NAME_PATTERN,
  WORKFLOWS_RELATIVE_DIR,
  type WorkflowDoc,
} from "../install/workflow";
import { readFrontmatterFile, writeFileAtomic } from "../store/frontmatter";
import {
  listMarkdownDocs,
  openStore,
  readConfig,
  readTextFile,
  removeFile,
  workflowsDir,
} from "../store/layout";
import { UsageError } from "./item";

/**
 * `nahel install` (PRD F10, F8.2): generate per-agent shims for every
 * canonical workflow doc in nahel/workflows/. Regeneration semantics: the
 * generator's namespace is made to mirror the workflow set exactly — identical
 * input produces byte-identical files, and anything inside the namespace that
 * no longer corresponds to a workflow is pruned. The namespace is the whole
 * prefix directory for agents that get their own (claude), or a file-name
 * prefix for agents whose command directory belongs to the user (codex, whose
 * prompts live in ~/.codex/prompts alongside the user's own). A doc with
 * invalid frontmatter is skipped with a warning (the rest still install); an
 * unknown agent fails fast with the known-agent list, before any write.
 */

const USAGE = `usage: nahel install --agent <agent>[,<agent>...] [--prefix <prefix>]
  agent: ${KNOWN_AGENTS.join(" | ")} (the shim targets — agent entries are an additive lookup table)
  prefix: slash-command namespace, default "nd" (claude: /nd:brief, codex: /prompts:nd-brief)`;

interface InstallFlags {
  agents: string[];
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
  // One invocation may target several agents: --agent claude,codex.
  const agents = values.agent.split(",").map((agent) => agent.trim());
  if (agents.some((agent) => agent === "")) {
    throw new UsageError(
      `invalid --agent ${JSON.stringify(values.agent)} — expected a comma-separated agent list`,
    );
  }
  const prefix = values.prefix ?? "nd";
  if (!WORKFLOW_NAME_PATTERN.test(prefix)) {
    throw new UsageError(
      `invalid --prefix ${JSON.stringify(prefix)} — must be a slug (lowercase letters/digits and single hyphens)`,
    );
  }
  return { agents, prefix };
}

/** The variable codex reads its home from; `~/.codex` when it is unset. */
export const CODEX_HOME_VAR = "CODEX_HOME";
const CODEX_HOME_DIR = ".codex";

/**
 * Where a target's shims live, and how that path is shown to the user.
 * Repo-rooted targets go under the RESOLVED store root rather than cwd — an
 * install from a subdirectory writes the repo's shims, not a nested copy of
 * them — and stay repo-relative (path-standards.md); a home-rooted
 * one is shown as `~/…`; a codex-home one follows codex's own discovery —
 * `$CODEX_HOME` when the entry point saw it set, `~/.codex` otherwise — and
 * an env-moved home is shown in full, because that is the path the user has
 * to know. Undefined means the base cannot be resolved on this machine.
 */
function resolveShimRoot(
  root: ShimRoot,
  ctx: CommandContext,
  repoRoot: string,
): { base: string; display: string } | undefined {
  if (root === "repo") return { base: repoRoot, display: "" };
  if (root === "home") {
    return ctx.homeDir === undefined ? undefined : { base: ctx.homeDir, display: "~" };
  }
  if (ctx.codexHome !== undefined) return { base: ctx.codexHome, display: ctx.codexHome };
  return ctx.homeDir === undefined
    ? undefined
    : {
        base: join(ctx.homeDir, CODEX_HOME_DIR),
        display: join("~", CODEX_HOME_DIR),
      };
}

/**
 * Delete the shim files this target owns that are no longer wanted, and report
 * them. Ownership is the file-name namespace (`filePrefix`): with an empty
 * prefix the whole directory is the generator's — including hand-rolled docs
 * that never belonged there — while a non-empty prefix leaves every foreign
 * name (the user's own codex prompts) untouched.
 */
async function pruneStaleShims(
  target: AgentTarget,
  base: string,
  prefix: string,
  keep: ReadonlySet<string>,
): Promise<string[]> {
  const dir = join(base, target.shimDir(prefix));
  const filePrefix = target.filePrefix(prefix);
  const removed: string[] = [];
  for (const file of await listMarkdownDocs(dir)) {
    if (keep.has(file) || !file.startsWith(filePrefix)) continue;
    await removeFile(join(dir, file));
    removed.push(file);
  }
  return removed;
}

async function runInstall(argv: string[], ctx: CommandContext): Promise<number> {
  try {
    const flags = parseFlags(argv);
    const layout = await openStore(ctx.cwd);
    // Initialized-repo gate: workflows live under nahel/, so a repo without
    // config gets the `nahel init` pointer instead of a confusing empty scan.
    await readConfig(layout);

    // Resolve every requested target BEFORE any write: one unknown agent (or
    // one unresolvable base directory) fails the whole invocation with nothing
    // generated, so a multi-agent run is never half-applied.
    const targets: { agent: string; target: AgentTarget; base: string; display: string }[] = [];
    for (const agent of flags.agents) {
      const target = AGENT_TARGETS[agent];
      if (target === undefined) {
        ctx.stderr(
          `❌ unknown agent ${JSON.stringify(agent)} — known agents: ${KNOWN_AGENTS.join(", ")}`,
        );
        return 1;
      }
      const resolved = resolveShimRoot(target.root, ctx, layout.root);
      if (resolved === undefined) {
        const missing =
          target.root === "codex-home"
            ? `codex home (set ${CODEX_HOME_VAR}, or a home directory)`
            : "home directory";
        ctx.stderr(
          `❌ cannot resolve the ${missing} — agent ${agent} installs its shims outside ` +
            `the repo, under ${join(
              target.root === "codex-home" ? `$${CODEX_HOME_VAR}` : "~",
              target.shimDir(flags.prefix),
            )}/`,
        );
        return 1;
      }
      targets.push({
        agent,
        target,
        base: resolved.base,
        display: join(resolved.display, target.shimDir(flags.prefix)),
      });
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

    let reported = false;
    for (const { agent, target, base, display: displayDir } of targets) {
      // Regenerate the generator's namespace to mirror the workflow set.
      const shimDirAbsolute = join(base, target.shimDir(flags.prefix));
      const filePrefix = target.filePrefix(flags.prefix);
      const lines: string[] = [];
      const shimNames = new Set<string>();
      for (const workflow of workflows) {
        const shimName = `${filePrefix}${workflow.frontmatter.name}.md`;
        shimNames.add(shimName);
        const shimPath = join(shimDirAbsolute, shimName);
        const desired = target.renderShim(workflow);
        const existing = await readTextFile(shimPath);
        if (existing === desired) {
          lines.push(`unchanged: ${join(displayDir, shimName)}`);
        } else {
          await writeFileAtomic(shimPath, desired);
          lines.push(`${existing === null ? "created" : "updated"}: ${join(displayDir, shimName)}`);
        }
      }
      for (const file of await pruneStaleShims(target, base, flags.prefix, shimNames)) {
        lines.push(`removed stale: ${join(displayDir, file)}`);
      }

      // A repo with no workflows and no stale shims has nothing to say per
      // agent — the invocation reports that once, after the loop.
      if (lines.length === 0) continue;
      reported = true;
      ctx.stdout(
        `✅ installed ${workflows.length} shim(s) for agent ${agent} under ${displayDir}/${
          filePrefix === "" ? "" : ` (${filePrefix}*.md)`
        }`,
      );
      for (const line of lines) ctx.stdout(`  - ${line}`);
    }
    if (!reported) ctx.stdout(`no workflow docs in ${WORKFLOWS_RELATIVE_DIR}/ — nothing to install`);
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

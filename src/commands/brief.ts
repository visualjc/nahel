import { parseArgs } from "node:util";
import type { Command, CommandContext } from "../cli";
import { readConfig, storeLayout } from "../store/layout";
import { validateStore } from "../validate";
import { composeBrief, type BriefWarningsSource } from "../views/brief";
import { UsageError } from "./item";

/**
 * `nahel brief` (PRD F7): a thin I/O wrapper over composeBrief — the
 * deterministic onboarding pack. Read-only: writes nothing, journals nothing.
 * A missing PRODUCT.md is a finding INSIDE the brief (exit 0); only genuinely
 * unreadable state (uninitialized repo, corrupt records) exits non-zero.
 */

const USAGE = "usage: nahel brief";

/**
 * VALIDATE-WARNINGS SEAM (#9 integration, wired at merge): the brief surfaces
 * every validate finding, errors first (validateStore sorts deterministically),
 * as `severity: [check] message` lines. The clock reading feeds the compaction
 * age threshold (PRD F6.2) as data.
 */
const warningsSource =
  (now: string): BriefWarningsSource =>
  async (layout) =>
    (await validateStore(layout, { now })).map(
      (finding) => `${finding.severity}: [${finding.check}] ${finding.message}`,
    );

function parseFlags(argv: string[]): void {
  let positionals: string[];
  try {
    ({ positionals } = parseArgs({
      args: argv,
      options: {},
      strict: true,
      allowPositionals: true,
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (positionals.length > 0) {
    throw new UsageError(`unexpected extra arguments: ${positionals.join(" ")}`);
  }
}

async function runBrief(argv: string[], ctx: CommandContext): Promise<number> {
  try {
    parseFlags(argv);
    const layout = storeLayout(ctx.cwd);
    // Initialized-repo gate: a missing config errors with the `nahel init`
    // pointer instead of briefing an agent on a repo that has no state.
    const config = await readConfig(layout);
    ctx.stdout(await composeBrief(layout, config, warningsSource(ctx.env.now())));
    return 0;
  } catch (error) {
    ctx.stderr(`❌ ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof UsageError) ctx.stderr(USAGE);
    return 1;
  }
}

export const briefCommand: Command = {
  description:
    "render the onboarding pack: constitution extract, knowledge pointers, statuses, recent activity, pending decisions, warnings (4 KB target)",
  run: runBrief,
};

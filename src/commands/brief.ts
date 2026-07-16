import { parseArgs } from "node:util";
import type { Command, CommandContext } from "../cli";
import { readConfig, storeLayout } from "../store/layout";
import { composeBrief, NO_WARNINGS, type BriefWarningsSource } from "../views/brief";
import { UsageError } from "./item";

/**
 * `nahel brief` (PRD F7): a thin I/O wrapper over composeBrief — the
 * deterministic onboarding pack. Read-only: writes nothing, journals nothing.
 * A missing PRODUCT.md is a finding INSIDE the brief (exit 0); only genuinely
 * unreadable state (uninitialized repo, corrupt records) exits non-zero.
 */

const USAGE = "usage: nahel brief";

/**
 * VALIDATE-WARNINGS SEAM (#9 integration point). Until validate lands, the
 * stub reports no warnings. At merge the orchestrator swaps this constant for
 * validate's findings collector — a two-line change in this file:
 *
 *   import { collectWarnings } from "../views/validate";   // wherever #9 exports (layout) => Promise<string[]>
 *   const warningsSource: BriefWarningsSource = collectWarnings;
 */
const warningsSource: BriefWarningsSource = NO_WARNINGS;

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
    ctx.stdout(await composeBrief(layout, config, warningsSource));
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

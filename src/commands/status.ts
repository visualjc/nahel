import { parseArgs } from "node:util";
import type { Command, CommandContext } from "../cli";
import { readConfig, storeLayout } from "../store/layout";
import { loadSnapshot } from "../views/snapshot";
import { renderStatus } from "../views/status";
import { UsageError } from "./item";

/**
 * `nahel status` (PRD F5): a thin I/O wrapper over the pure view machinery —
 * loadSnapshot (the one store read pass) then renderStatus, or the raw
 * snapshot as JSON with --json. Read-only: writes nothing, journals nothing.
 * Unparseable state (a corrupt record, malformed hot state, an uninitialized
 * repo) exits non-zero with the store's error — never silently partial output.
 */

const USAGE = "usage: nahel status [--json]";

function parseFlags(argv: string[]): { json: boolean } {
  let values: { json?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: { json: { type: "boolean" } },
      strict: true,
      allowPositionals: true,
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (positionals.length > 0) {
    throw new UsageError(`unexpected extra arguments: ${positionals.join(" ")}`);
  }
  return { json: values.json === true };
}

async function runStatus(argv: string[], ctx: CommandContext): Promise<number> {
  try {
    const flags = parseFlags(argv);
    const layout = storeLayout(ctx.cwd);
    // Initialized-repo gate: a missing config errors with the `nahel init`
    // pointer instead of rendering a misleadingly empty tree.
    await readConfig(layout);
    const snapshot = await loadSnapshot(layout);
    // status is the DETAILED view: item lines include prd=<path> (F1) and
    // investigation=<path> (F5); brief composes the terse default rendering
    // and stays unchanged.
    ctx.stdout(
      flags.json
        ? JSON.stringify(snapshot, null, 2)
        : renderStatus(snapshot, { showPrd: true, showInvestigation: true }),
    );
    return 0;
  } catch (error) {
    ctx.stderr(`❌ ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof UsageError) ctx.stderr(USAGE);
    return 1;
  }
}

export const statusCommand: Command = {
  description:
    "show the work-item tree, open runs with phases, and claims (--json for the raw snapshot)",
  run: runStatus,
};

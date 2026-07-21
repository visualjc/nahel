import { parseArgs } from "node:util";
import type { Command, CommandContext } from "../cli";
import { storeLayout } from "../store/layout";
import { replayPending, type RepairedRecord } from "../store/mutate";
import { validateStore, type Finding } from "../validate";
import { UsageError } from "./item";

/**
 * `nahel validate` (PRD F8): a thin I/O wrapper over the validate library —
 * validateStore's findings rendered per the exit contract: 0 when clean or
 * warnings-only, non-zero when errors exist; a clean repo validates silently.
 * `--repair` is the ONLY flag that mutates: it invokes the store's
 * replayPending() BEFORE the checks run, so the report reflects the healed
 * store — and replay only materializes what the journal already records.
 */

const USAGE = "usage: nahel validate [--repair] [--json]";

function parseFlags(argv: string[]): { repair: boolean; json: boolean } {
  let values: { repair?: boolean; json?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: { repair: { type: "boolean" }, json: { type: "boolean" } },
      strict: true,
      allowPositionals: true,
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (positionals.length > 0) {
    throw new UsageError(`unexpected extra arguments: ${positionals.join(" ")}`);
  }
  return { repair: values.repair === true, json: values.json === true };
}

function renderFinding(finding: Finding): string[] {
  const lines = [`${finding.severity} [${finding.check}] ${finding.message}`];
  if (finding.path !== undefined) lines.push(`  at ${finding.path}`);
  if (finding.fix !== undefined) lines.push(`  fix: ${finding.fix}`);
  return lines;
}

async function runValidate(argv: string[], ctx: CommandContext): Promise<number> {
  try {
    const flags = parseFlags(argv);
    const layout = storeLayout(ctx.cwd);

    let repaired: RepairedRecord[] = [];
    if (flags.repair) {
      repaired = await replayPending(layout);
    }
    // The clock crosses into the pure checks as data: the compaction age
    // threshold (PRD F6.2) compares event timestamps against this reading.
    const findings = await validateStore(layout, { now: ctx.env.now() });
    const errors = findings.filter((finding) => finding.severity === "error").length;

    if (flags.json) {
      ctx.stdout(JSON.stringify({ repaired, findings }, null, 2));
    } else {
      for (const record of repaired) {
        ctx.stdout(`repaired ${record.target} ${record.id} from event ${record.eventId}`);
      }
      for (const finding of findings) {
        for (const line of renderFinding(finding)) ctx.stdout(line);
      }
      if (findings.length > 0) {
        ctx.stdout(`${errors} error(s), ${findings.length - errors} warning(s)`);
      }
    }
    return errors > 0 ? 1 : 0;
  } catch (error) {
    ctx.stderr(`❌ ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof UsageError) ctx.stderr(USAGE);
    return 1;
  }
}

export const validateCommand: Command = {
  description:
    "check store integrity — schema, refs, claims, journal (--repair replays journal-ahead mutations)",
  run: runValidate,
};

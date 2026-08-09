import type { Command, CommandContext } from "../cli";
import { openStore, readConfig } from "../store/layout";
import {
  DECISION_QUERY_HELP,
  DECISION_QUERY_USAGE,
  DecisionQueryUsageError,
  queryDecisionRowsWithSummary,
} from "../views/decision-query";
import { reconstructDecisionRows, renderDecisionRows } from "../views/decisions";

export const DECISIONS_HELP = [
  DECISION_QUERY_USAGE,
  "",
  "Read-only: writes nothing and journals nothing.",
  "",
  "Bare `nahel decisions` selects the newest 10 matching decisions, then displays that retained slice oldest to newest.",
  "",
  "Flags:",
  "  --since <7d|24h|ISO>  include dated decisions at or after the time; undated incomplete rows remain eligible",
  "  --by <human|agent|kind:id[:session]>  match a resolver kind or exact actor",
  "  --map <map-id|node-id|node-slug>  narrow to one current map",
  "  --provenance <direct-human|delegated|ratified|agent|incomplete>  require a proved badge",
  "  --limit <positive-integer>  retain this many newest matches (default 10)",
  "",
  "Examples:",
  "  nahel decisions",
  "  nahel decisions --since 24h",
  "  nahel decisions --by human",
  "  nahel decisions --map decision-digest",
  "  nahel decisions --provenance incomplete",
  "  nahel decisions --since 30d --limit 50",
  "",
  "Run the command, then follow its concrete ticket, map, and recall `↳` hints for evidence.",
  "If a row is incomplete, run `nahel validate` to inspect or repair missing links.",
].join("\n");

async function runDecisions(argv: string[], ctx: CommandContext): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    ctx.stdout(DECISIONS_HELP);
    return 0;
  }
  try {
    const layout = await openStore(ctx.cwd);
    await readConfig(layout);
    const result = await queryDecisionRowsWithSummary(await reconstructDecisionRows(layout), argv, {
      layout,
      now: ctx.env.now(),
    });
    ctx.stdout(renderDecisionRows(result.rows, result));
    return 0;
  } catch (error) {
    ctx.stderr(`❌ ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof DecisionQueryUsageError) {
      ctx.stderr(DECISION_QUERY_USAGE);
      ctx.stderr(DECISION_QUERY_HELP);
    }
    return 1;
  }
}

export const decisionsCommand: Command = {
  description: "show a compact, read-only ledger of resolved map decisions",
  run: runDecisions,
};

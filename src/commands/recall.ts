import { parseArgs } from "node:util";
import type { Command, CommandContext } from "../cli";
import type { ObservationRecord } from "../store/layout";
import { listObservations, readConfig, readObservation, storeLayout } from "../store/layout";
import { UsageError } from "./item";

/**
 * `nahel recall` (PRD F6.3): deterministic keyword search over observation
 * records. Case-insensitive substring match on name, body, and tags; ranked
 * by total match count, then recency (created), then id. No index — the
 * observations directory is scanned at query time. Zero LLM, zero network:
 * identical state produces identical ranked output on every machine.
 * Read-only: writes nothing, journals nothing.
 */

const USAGE = "usage: nahel recall <term> [<term>...]";

function parseTerms(argv: string[]): string[] {
  let positionals: string[];
  try {
    ({ positionals } = parseArgs({ args: argv, options: {}, strict: true, allowPositionals: true }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const terms = [...new Set(positionals.map((term) => term.toLowerCase()))].filter(
    (term) => term.length > 0,
  );
  if (terms.length === 0) throw new UsageError("recall takes at least one search term");
  return terms;
}

/** Non-overlapping occurrence count of `term` in `haystack` (both lowercase). */
function occurrences(haystack: string, term: string): number {
  let count = 0;
  let index = haystack.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(term, index + term.length);
  }
  return count;
}

interface RecallMatch {
  id: string;
  record: ObservationRecord;
  score: number;
}

/** Pure scoring: total occurrences of every term across name, body, and tags. */
export function scoreObservation(record: ObservationRecord, terms: readonly string[]): number {
  const haystacks = [
    record.frontmatter.name ?? "",
    record.body,
    ...record.frontmatter.tags,
  ].map((text) => text.toLowerCase());
  let score = 0;
  for (const term of terms) {
    for (const haystack of haystacks) score += occurrences(haystack, term);
  }
  return score;
}

function renderMatch(match: RecallMatch): string[] {
  const { frontmatter } = match.record;
  const name = frontmatter.name === undefined ? "(unnamed)" : frontmatter.name;
  const fact = match.record.body.split("\n", 1)[0] ?? "";
  const sources = frontmatter.sources.length === 0 ? "(none)" : frontmatter.sources.join(", ");
  return [
    `${frontmatter.id}  score ${match.score}  created ${frontmatter.created}  ${name}`,
    `  fact: ${fact}`,
    `  sources: ${sources}`,
  ];
}

async function runRecall(argv: string[], ctx: CommandContext): Promise<number> {
  try {
    const terms = parseTerms(argv);
    const layout = storeLayout(ctx.cwd);
    // Initialized-repo gate: a missing config errors with the `nahel init`
    // pointer instead of searching a repo that has no state.
    await readConfig(layout);

    const matches: RecallMatch[] = [];
    for (const id of (await listObservations(layout)).sort()) {
      const record = await readObservation(layout, id);
      const score = scoreObservation(record, terms);
      if (score > 0) matches.push({ id, record, score });
    }
    // Rank: match count desc, then recency (created desc), then id — a total
    // order, so the output is identical for identical state.
    matches.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      const createdA = a.record.frontmatter.created;
      const createdB = b.record.frontmatter.created;
      if (createdA !== createdB) return createdA < createdB ? 1 : -1;
      return a.id < b.id ? -1 : 1;
    });

    if (matches.length === 0) {
      ctx.stdout(`no observations match: ${terms.join(", ")}`);
      return 0;
    }
    ctx.stdout(`${matches.length} observation(s) match:`);
    for (const match of matches) {
      for (const line of renderMatch(match)) ctx.stdout(line);
    }
    return 0;
  } catch (error) {
    ctx.stderr(`❌ ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof UsageError) ctx.stderr(USAGE);
    return 1;
  }
}

export const recallCommand: Command = {
  description:
    "keyword-search observation records (name/body/tags, ranked by hits then recency; cites provenance event ids)",
  run: runRecall,
};

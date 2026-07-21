import { parseArgs } from "node:util";
import type { Env } from "../schema/env";
import { CORE_EVENT_TYPES } from "../schema/events";
import { generateId, ID_PATTERN } from "../schema/id";
import {
  observationFrontmatterSchema,
  workItemFrontmatterSchema,
  type ObservationFrontmatter,
} from "../schema/records";
import { readJournal } from "../store/journal";
import { closeStoreContext, mutate } from "../store/mutate";
import { commandContext, execute, requireValid, UsageError, type Command } from "./item";
import { parseDataEntries } from "./log";

/**
 * `nahel observe` (PRD F6.1): create ONE durable observation — a curated
 * fact distilled from the journal, with provenance journal event ids — in
 * nahel/observations/. Thin over the store: the mutation flows through
 * mutate(), which write-ahead journals observation.created with the full
 * record. Provenance is mandatory and verified: every cited source must be
 * a real journal event, or the observation is refused outright.
 */

const USAGE = `usage:
  nahel observe <slug> --data <json|key=val> [--data ...]
    Create an observation record (one fact per record) and print its id.
    --data speaks \`nahel log\`'s dialect (a JSON object or key=value) with keys:
      body     (required) the fact itself, stored as the record's markdown body
      sources  (required) provenance journal event id(s) — a string or JSON array
      tags     optional tag(s) — a string or JSON array of strings`;

/** Normalize a --data value that may be one string or a JSON array of them. */
function stringList(value: unknown, what: string): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value as string[];
  }
  throw new UsageError(`--data ${what} must be a string or a JSON array of strings`);
}

interface ObserveInput {
  name: string;
  body: string;
  tags: string[];
  sources: string[];
}

function parseObserveArgs(args: string[]): ObserveInput {
  const { values, positionals } = parseArgs({
    args,
    options: { data: { type: "string", multiple: true } },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    throw new UsageError(
      `observe takes exactly one <slug> — got ${positionals.length} positional argument(s)`,
    );
  }
  // The slug becomes the record's recall-searchable name.
  const name = requireValid(workItemFrontmatterSchema.shape.name, positionals[0], "slug");

  const data = parseDataEntries(values.data ?? []);
  for (const key of Object.keys(data)) {
    if (key !== "body" && key !== "sources" && key !== "tags") {
      throw new UsageError(
        `unknown --data key ${JSON.stringify(key)} — observe takes body, sources, tags`,
      );
    }
  }
  if (typeof data["body"] !== "string" || data["body"].trim() === "") {
    throw new UsageError("an observation IS its fact — pass a non-empty --data body=…");
  }
  const sources = [...new Set(data["sources"] === undefined ? [] : stringList(data["sources"], "sources"))];
  if (sources.length === 0) {
    throw new UsageError(
      "an observation requires provenance — pass at least one journal event id via --data sources=…",
    );
  }
  for (const source of sources) {
    if (!ID_PATTERN.test(source)) {
      throw new UsageError(
        `invalid source event id ${JSON.stringify(source)} — sources are journal event ids`,
      );
    }
  }
  const tags = data["tags"] === undefined ? [] : stringList(data["tags"], "tags");
  return { name, body: data["body"], tags, sources };
}

async function runObserve(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const input = parseObserveArgs(args);
  const ctx = await commandContext(cwd, env, actorOverride);

  // Provenance is verified against the real journal (active + archived —
  // event ids are stable across rotation, ADR-0012). Stream until every
  // cited id is found; anything left over does not exist.
  const missing = new Set(input.sources);
  for await (const event of readJournal(ctx.layout)) {
    missing.delete(event.id);
    if (missing.size === 0) break;
  }
  if (missing.size > 0) {
    throw new UsageError(
      `source event(s) not found in the journal: ${[...missing].sort().join(", ")} — ` +
        "observation provenance must cite real journal events",
    );
  }

  const frontmatter: ObservationFrontmatter = observationFrontmatterSchema.parse({
    id: generateId(env),
    name: input.name,
    created: env.now(),
    tags: input.tags,
    sources: input.sources,
  });
  const body = input.body.endsWith("\n") ? input.body : `${input.body}\n`;
  await mutate(ctx, {
    target: "observation",
    eventType: CORE_EVENT_TYPES.observationCreated,
    frontmatter,
    body,
  });
  await closeStoreContext(ctx);
  console.log(frontmatter.id);
  return 0;
}

export const observeCommand: Command = {
  name: "observe",
  description:
    "distill one durable observation (a fact with provenance journal event ids) into nahel/observations/",
  run: (argv, env, cwd, actorOverride) =>
    execute("run `nahel observe --help` for usage", async () => {
      if (argv.includes("--help") || argv.includes("-h")) {
        console.log(USAGE);
        return 0;
      }
      return runObserve(argv, env, cwd, actorOverride);
    }),
};

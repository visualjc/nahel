import { parseArgs } from "node:util";
import type { Env } from "../schema/env";
import { configSchema } from "../schema/records";
import { appendEvent } from "../store/journal";
import { readConfig, writeConfig } from "../store/layout";
import { closeStoreContext } from "../store/mutate";
import { commandContext, execute, UsageError, type Command } from "./item";
import { parseDataEntries } from "./log";

/**
 * `nahel config set` (PRD F4): atomically replace exactly one OPTIONAL
 * top-level section of `nahel/config`. The whole candidate config is
 * validated against configSchema before anything touches disk, the change is
 * journaled write-ahead as `config.updated` (payload: section name + new
 * value), and the write is the store's validate-then-atomic-rename — a
 * refusal or validation failure leaves the config byte-identical with
 * nothing journaled. This is the CLI path the inception and setup-routing
 * workflows write config through; agents never hand-edit state (hard
 * constraint 3). Core sections (knowledge paths, actor) are set at init and
 * deliberately NOT settable here.
 */

/** The open-extension event type recording a config section replacement. */
export const CONFIG_UPDATED_EVENT_TYPE = "config.updated";

/** The optional config sections `config set` may replace. */
export const SETTABLE_CONFIG_SECTIONS = [
  "compaction",
  "contract",
  "governance",
  "inception",
  "routing",
  "validate",
] as const;
export type SettableConfigSection = (typeof SETTABLE_CONFIG_SECTIONS)[number];

/** Core sections a workflow must never swap out from under a checkout. */
const CORE_CONFIG_SECTIONS = new Set(["knowledge", "actor"]);

const USAGE = `usage:
  nahel config set <section> --data <json|key=val> [--data ...]
    Atomically replace one optional nahel/config section. The resulting
    config is schema-validated before the write; the change is journaled
    write-ahead as config.updated. --data speaks \`nahel log\`'s dialect
    (a JSON object or key=value entries, merged left to right).
      section: ${SETTABLE_CONFIG_SECTIONS.join(" | ")}
    Core sections (knowledge, actor) are set by \`nahel init\` and cannot
    be replaced here.`;

function requireSettableSection(section: string): SettableConfigSection {
  if ((SETTABLE_CONFIG_SECTIONS as readonly string[]).includes(section)) {
    return section as SettableConfigSection;
  }
  if (CORE_CONFIG_SECTIONS.has(section)) {
    throw new UsageError(
      `config section ${JSON.stringify(section)} is core state set by \`nahel init\` — ` +
        `config set only replaces the optional sections: ${SETTABLE_CONFIG_SECTIONS.join(", ")}`,
    );
  }
  throw new UsageError(
    `unknown config section ${JSON.stringify(section)} — ` +
      `settable sections: ${SETTABLE_CONFIG_SECTIONS.join(", ")}`,
  );
}

async function runConfigSet(
  args: string[],
  env: Env,
  cwd: string,
  actorOverride?: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { data: { type: "string", multiple: true } },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    throw new UsageError(
      `config set takes exactly one <section> — got ${positionals.length} positional argument(s)`,
    );
  }
  const section = requireSettableSection(positionals[0]!);
  if (values.data === undefined || values.data.length === 0) {
    throw new UsageError(
      "config set replaces the whole section — pass its new value via --data " +
        "(an explicit `--data {}` empties a section whose fields are all optional)",
    );
  }
  const value = parseDataEntries(values.data);

  const ctx = await commandContext(cwd, env, actorOverride);
  const config = await readConfig(ctx.layout);

  // Validate the WHOLE candidate config before anything touches disk; a
  // malformed section payload refuses the invocation with the schema's own
  // section-scoped reasons, config untouched.
  const candidate = configSchema.safeParse({ ...config, [section]: value });
  if (!candidate.success) {
    const reasons = candidate.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new UsageError(`invalid config after setting ${section} — ${reasons}`);
  }

  // A no-op replacement writes nothing and journals nothing — re-running a
  // workflow's config step is harmless (the distill precedent).
  if (JSON.stringify(candidate.data[section]) === JSON.stringify(config[section])) {
    console.log(`config.${section} unchanged — nothing to do`);
    return 0;
  }

  // Write-ahead like every state change: the act lands in the journal first,
  // then the config is atomically replaced (a crash between the two is healed
  // by re-running the set — the replacement is idempotent).
  await appendEvent(ctx.layout, ctx.env, {
    type: CONFIG_UPDATED_EVENT_TYPE,
    actor: ctx.actor,
    session: ctx.session,
    payload: { section, value: candidate.data[section] },
  });
  await writeConfig(ctx.layout, candidate.data);
  await closeStoreContext(ctx);
  console.log(`✅ config.${section} set`);
  return 0;
}

export const configCommand: Command = {
  name: "config",
  description:
    "replace one optional nahel/config section (schema-validated, atomic, journaled as config.updated)",
  run: (argv, env, cwd, actorOverride) =>
    execute("run `nahel config --help` for usage", async () => {
      if (argv.includes("--help") || argv.includes("-h")) {
        console.log(USAGE);
        return 0;
      }
      const [subcommand, ...rest] = argv;
      if (subcommand !== "set") {
        throw new UsageError(
          subcommand === undefined
            ? "config takes a subcommand: set"
            : `unknown config subcommand ${JSON.stringify(subcommand)} — expected: set`,
        );
      }
      return runConfigSet(rest, env, cwd, actorOverride);
    }),
};

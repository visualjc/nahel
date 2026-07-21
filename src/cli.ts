#!/usr/bin/env bun
// nahel — deterministic CLI for the Nahel state model.
// Dispatch structure: a registry table of thin command verbs over the store
// layer. All ambient process access (argv, cwd, exit, real clock) happens
// here at the entry point and is injected down — commands stay pure over
// their CommandContext, per-command flags are parsed with node:util parseArgs
// inside each command.

import { briefCommand } from "./commands/brief";
import { configCommand } from "./commands/config";
import { distillCommand } from "./commands/distill";
import { doctorCommand } from "./commands/doctor";
import { initCommand } from "./commands/init";
import { installCommand } from "./commands/install";
import { claimCommand, handbackCommand, pauseCommand } from "./commands/intervene";
import { itemCommand } from "./commands/item";
import { logCommand } from "./commands/log";
import { observeCommand } from "./commands/observe";
import { progressCommand } from "./commands/progress";
import { recallCommand } from "./commands/recall";
import { runCommand } from "./commands/run";
import { skillsCommand } from "./commands/skills";
import { statusCommand } from "./commands/status";
import { validateCommand } from "./commands/validate";
import { systemEnv, type Env } from "./schema/env";
import { NAHEL_ACTOR_VAR } from "./store/actor";

export const VERSION = "0.0.1";

/** Everything a command may touch beyond its own argv — injected at the entry point. */
export interface CommandContext {
  /** Injected clock + RNG — the only source of time and randomness. */
  env: Env;
  /** Repo root the command operates on. */
  cwd: string;
  /**
   * NAHEL_ACTOR spec value (`kind:id[:session]`), if set. The entry point
   * reads it from the process environment; commands only ever see this
   * injected value (see store/actor.ts).
   */
  actorOverride?: string;
  /**
   * Whether a named environment variable is set on this machine (PRD F2). A
   * PRESENCE predicate, never a value accessor: cli.ts is the single reader of
   * the ambient process environment and hands `nahel doctor` only yes/no per
   * name, so a secret VALUE has no path into any command (ADR-0014).
   */
  envPresent?: (name: string) => boolean;
  /** Write one line of normal output. */
  stdout: (text: string) => void;
  /** Write one line of error/warning output. */
  stderr: (text: string) => void;
}

/** One CLI verb: a thin async function over the store layer plus its help line. */
export interface Command {
  description: string;
  run: (argv: string[], ctx: CommandContext) => Promise<number>;
}

/**
 * The command registry. Registering a new verb is exactly two lines: one
 * import at the top of this file, one entry here.
 */
/** Adapt a mutation-command shape (run(argv, env, cwd, actorOverride?)) to the registry's CommandContext shape. */
function adapt(command: {
  description: string;
  run(argv: string[], env: Env, cwd: string, actorOverride?: string): Promise<number>;
}): Command {
  return {
    description: command.description,
    run: (argv, ctx) => command.run(argv, ctx.env, ctx.cwd, ctx.actorOverride),
  };
}

export const COMMANDS: Record<string, Command> = {
  brief: briefCommand,
  claim: adapt(claimCommand),
  config: adapt(configCommand),
  distill: adapt(distillCommand),
  doctor: doctorCommand,
  handback: adapt(handbackCommand),
  init: initCommand,
  install: installCommand,
  item: adapt(itemCommand),
  log: logCommand,
  observe: adapt(observeCommand),
  pause: adapt(pauseCommand),
  progress: progressCommand,
  recall: recallCommand,
  run: adapt(runCommand),
  skills: skillsCommand,
  status: statusCommand,
  validate: validateCommand,
};

function helpText(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const commandLines = Object.entries(COMMANDS).map(
    ([name, command]) => `  ${name.padEnd(width)}  ${command.description}`,
  );
  return [
    `nahel ${VERSION} — deterministic CLI for the Nahel state model`,
    "",
    "Usage: nahel <command> [options]",
    "",
    "Commands:",
    ...commandLines,
    "",
    "Global flags:",
    "  --version, -v  print the version",
    "  --help, -h     print this help",
  ].join("\n");
}

/** Dispatch argv to the registered command; returns the process exit code. */
export async function main(argv: string[], ctx: CommandContext): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    ctx.stdout(helpText());
    return 0;
  }
  if (name === "--version" || name === "-v") {
    ctx.stdout(`nahel ${VERSION}`);
    return 0;
  }
  const command = COMMANDS[name];
  if (command === undefined) {
    ctx.stderr(`❌ unknown command: ${name} — run \`nahel help\` for the command list`);
    return 1;
  }
  try {
    return await command.run(rest, ctx);
  } catch (error) {
    ctx.stderr(`❌ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  // cli.ts is the single ambient-process reader: argv, cwd, exit, the real
  // clock, and the NAHEL_ACTOR environment override are all read here and
  // injected down — no other src/ layer touches process.env.
  const code = await main(Bun.argv.slice(2), {
    env: systemEnv(),
    cwd: process.cwd(),
    actorOverride: process.env[NAHEL_ACTOR_VAR],
    // A var is "set" only when present AND non-empty: an empty value in a .env
    // is not a filled secret. Presence, never the value, crosses into commands.
    envPresent: (name) => {
      const value = process.env[name];
      return typeof value === "string" && value.length > 0;
    },
    stdout: console.log,
    stderr: console.error,
  });
  process.exit(code);
}

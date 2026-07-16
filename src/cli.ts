#!/usr/bin/env bun
// nahel — deterministic CLI for the Nahel state model.
// Dispatch structure: a registry table of thin command verbs over the store
// layer. All ambient process access (argv, cwd, exit, real clock) happens
// here at the entry point and is injected down — commands stay pure over
// their CommandContext, per-command flags are parsed with node:util parseArgs
// inside each command.

import { initCommand } from "./commands/init";
import { itemCommand } from "./commands/item";
import { runCommand } from "./commands/run";
import { systemEnv, type Env } from "./schema/env";

export const VERSION = "0.0.1";

/** Everything a command may touch beyond its own argv — injected at the entry point. */
export interface CommandContext {
  /** Injected clock + RNG — the only source of time and randomness. */
  env: Env;
  /** Repo root the command operates on. */
  cwd: string;
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
/** Adapt a mutation-command shape (run(argv, env, cwd)) to the registry's CommandContext shape. */
function adapt(command: {
  description: string;
  run(argv: string[], env: Env, cwd: string): Promise<number>;
}): Command {
  return {
    description: command.description,
    run: (argv, ctx) => command.run(argv, ctx.env, ctx.cwd),
  };
}

export const COMMANDS: Record<string, Command> = {
  init: initCommand,
  item: adapt(itemCommand),
  run: adapt(runCommand),
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
  const code = await main(Bun.argv.slice(2), {
    env: systemEnv(),
    cwd: process.cwd(),
    stdout: console.log,
    stderr: console.error,
  });
  process.exit(code);
}

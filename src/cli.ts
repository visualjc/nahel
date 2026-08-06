#!/usr/bin/env bun
// nahel — deterministic CLI for the Nahel state model.
// Dispatch structure: a registry table of thin command verbs over the store
// layer. All ambient process access (argv, cwd, home dir, exit, real clock)
// happens here at the entry point and is injected down — commands stay pure
// over their CommandContext, per-command flags are parsed with node:util
// parseArgs inside each command.

import { homedir } from "node:os";
import { briefCommand } from "./commands/brief";
import { configCommand } from "./commands/config";
import { dispatchCommand } from "./commands/dispatch";
import { distillCommand } from "./commands/distill";
import { doctorCommand } from "./commands/doctor";
import { initCommand } from "./commands/init";
import { importCommand } from "./commands/import";
import { CODEX_HOME_VAR, installCommand } from "./commands/install";
import { claimCommand, handbackCommand, pauseCommand } from "./commands/intervene";
import { itemCommand } from "./commands/item";
import { logCommand } from "./commands/log";
import { observeCommand } from "./commands/observe";
import { planCommand } from "./commands/plan";
import { progressCommand } from "./commands/progress";
import { prototypeCommand } from "./commands/prototype";
import { recallCommand } from "./commands/recall";
import { roadmapCommand } from "./commands/roadmap";
import { runCommand } from "./commands/run";
import { skillsCommand } from "./commands/skills";
import { standupCommand } from "./commands/standup";
import { statusCommand } from "./commands/status";
import { validateCommand } from "./commands/validate";
import { systemEnv, type Env } from "./schema/env";
import { NAHEL_ACTOR_VAR } from "./store/actor";

import { version as VERSION } from "../package.json";

/**
 * The version is package.json's `version`, bundled into the binary at build
 * time — one source of truth, so a release bumps exactly one place.
 */
export { VERSION };

/** Everything a command may touch beyond its own argv — injected at the entry point. */
export interface CommandContext {
  /** Injected clock + RNG — the only source of time and randomness. */
  env: Env;
  /** Repo root the command operates on. */
  cwd: string;
  /**
   * The user's home directory, injected at the entry point (PRD F8.2). Needed
   * only by generators whose target lives outside the repo — codex reads its
   * custom prompts from ~/.codex/prompts and nowhere else. Optional: commands
   * that need it say so when it is absent rather than guessing a path.
   */
  homeDir?: string;
  /**
   * `$CODEX_HOME`, if the environment sets it (PRD F8.2). Codex discovers its
   * custom prompts under `$CODEX_HOME/prompts` and nowhere else, defaulting to
   * `~/.codex` — a deployment that moved it would otherwise get shims written
   * where its codex never looks. Read here with every other ambient value;
   * absent means "use the default", which the install command owns.
   */
  codexHome?: string;
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
  dispatch: adapt(dispatchCommand),
  distill: adapt(distillCommand),
  doctor: doctorCommand,
  handback: adapt(handbackCommand),
  import: adapt(importCommand),
  init: initCommand,
  install: installCommand,
  item: adapt(itemCommand),
  log: logCommand,
  observe: adapt(observeCommand),
  pause: adapt(pauseCommand),
  plan: planCommand,
  progress: progressCommand,
  prototype: adapt(prototypeCommand),
  recall: recallCommand,
  roadmap: adapt(roadmapCommand),
  run: adapt(runCommand),
  skills: skillsCommand,
  standup: standupCommand,
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
  // cli.ts is the single ambient-process reader: argv, cwd, the home
  // directory, exit, the real clock, and the NAHEL_ACTOR environment override
  // are all read here and injected down — no other src/ layer touches the
  // ambient process.
  // An empty CODEX_HOME is not a location: treat it as unset, like envPresent.
  const codexHome = process.env[CODEX_HOME_VAR];
  const code = await main(Bun.argv.slice(2), {
    env: systemEnv(),
    cwd: process.cwd(),
    homeDir: homedir(),
    ...(codexHome === undefined || codexHome === "" ? {} : { codexHome }),
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

import { parseArgs } from "node:util";
import type { Command, CommandContext } from "../cli";
import { runHealthcheck } from "../store/healthcheck";
import { readConfig, storeLayout } from "../store/layout";
import { UsageError } from "./item";

/**
 * `nahel doctor` (PRD F2, ADR-0014): verify the run contract for THIS machine.
 * Read-only over state (writes nothing, journals nothing); the only side
 * effect is running the contract's healthcheck. Exit codes carry the branch a
 * workflow needs:
 *
 *   0  contract present, env complete, healthcheck (if any) passed
 *   1  unusable state / usage error (uninitialized repo, malformed config)
 *   2  contract MISSING — autonomy-gated; fix by inception/setup
 *   3  env INCOMPLETE — this machine isn't set up; named vars are unset
 *   4  healthcheck FAILED
 *
 * Env vars are checked by NAME through the injected presence predicate; a
 * secret VALUE never enters this command's output, state, or errors — only the
 * names of the vars that are missing, and only when they are missing.
 */

const USAGE = "usage: nahel doctor";

/** Distinct exit codes so workflows branch on the doctor's finding. */
export const DOCTOR_EXIT = {
  ok: 0,
  error: 1,
  contractMissing: 2,
  envIncomplete: 3,
  healthcheckFailed: 4,
} as const;

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

async function runDoctor(argv: string[], ctx: CommandContext): Promise<number> {
  try {
    parseFlags(argv);
    const layout = storeLayout(ctx.cwd);
    // Initialized-repo gate: a missing/malformed config errors with the
    // `nahel init` pointer (exit 1) rather than a confusing contract verdict.
    const config = await readConfig(layout);

    const contract = config.contract;
    if (contract === undefined) {
      ctx.stdout(
        "contract missing: nahel/config has no `contract` section — run inception/setup " +
          "to define launch/seed/test (doctor and AFK lanes are autonomy-gated until then)",
      );
      return DOCTOR_EXIT.contractMissing;
    }

    // Presence, never values: the predicate answers yes/no per name.
    const envPresent = ctx.envPresent ?? (() => false);
    const missing = (contract.env ?? []).filter((name) => !envPresent(name));
    if (missing.length > 0) {
      ctx.stdout(
        `env incomplete: this machine is missing ${missing.length} required ` +
          `env var(s): ${missing.join(", ")}`,
      );
      ctx.stdout("set them in your local (gitignored) env file, then re-run nahel doctor");
      return DOCTOR_EXIT.envIncomplete;
    }

    if (contract.healthcheck !== undefined) {
      const result = await runHealthcheck(contract.healthcheck);
      if (!result.ok) {
        ctx.stdout(
          `healthcheck failed (exit ${result.exitCode ?? "unknown"}): ${contract.healthcheck}`,
        );
        return DOCTOR_EXIT.healthcheckFailed;
      }
      ctx.stdout("contract OK: env complete, healthcheck passed");
      return DOCTOR_EXIT.ok;
    }

    ctx.stdout("contract OK: env complete (no healthcheck defined)");
    return DOCTOR_EXIT.ok;
  } catch (error) {
    ctx.stderr(`❌ ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof UsageError) ctx.stderr(USAGE);
    return DOCTOR_EXIT.error;
  }
}

export const doctorCommand: Command = {
  description:
    "verify the run contract on this machine: contract present, named env vars set (names only, never values), healthcheck runnable",
  run: runDoctor,
};

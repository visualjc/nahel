import { parseArgs } from "node:util";
import type { Command, CommandContext } from "../cli";
import type { SkillsLockEntry } from "../schema/records";
import {
  readSkillsLock,
  readSkillsManifest,
  storeLayout,
  writeSkillsLock,
  type StoreLayout,
} from "../store/layout";
import {
  resolveRef,
  restoreViaClone,
  restoreViaSkillsCli,
  skillsCliAvailable,
} from "../store/skills";
import { UsageError } from "./item";

/**
 * `nahel skills` (PRD F7, ADR-0009): manage pinned skill dependencies.
 *
 *   nahel skills lock     resolve each skills.yaml source's ref to an exact
 *                         commit SHA (git ls-remote) and write skills.lock.
 *   nahel skills restore  materialize the pinned skills at their locked
 *                         commits — delegating to the external `skills` CLI
 *                         when it is on PATH, else a dumb clone-and-symlink.
 *
 * Both subcommands touch the network by nature (git talks to a remote); that
 * is acceptable for environment setup, exactly like `nahel doctor`'s
 * healthcheck. This command stays a thin verb: all git/CLI spawning lives in
 * the store (store/skills.ts), all parsing/validation in the schema layer.
 */

const USAGE = "usage: nahel skills <lock|restore>";

function parseSubcommand(argv: string[]): string {
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
  const [sub, ...extra] = positionals;
  if (sub === undefined) throw new UsageError("missing subcommand");
  if (extra.length > 0) throw new UsageError(`unexpected extra arguments: ${extra.join(" ")}`);
  return sub;
}

/** Resolve every manifest source's ref to a SHA and write skills.lock. */
async function lock(layout: StoreLayout, ctx: CommandContext): Promise<number> {
  const manifest = await readSkillsManifest(layout);
  if (manifest === null) {
    ctx.stdout("no skills.yaml — nothing to lock");
    return 0;
  }
  const entries: SkillsLockEntry[] = [];
  for (const source of manifest.skills) {
    const sha = await resolveRef(source.repo, source.ref);
    entries.push({ repo: source.repo, ref: source.ref, sha, skills: source.use });
    ctx.stdout(`locked ${source.repo}@${source.ref} → ${sha}`);
  }
  await writeSkillsLock(layout, { entries });
  ctx.stdout(`wrote skills.lock (${entries.length} source(s))`);
  return 0;
}

/** Materialize the pinned skills from skills.lock at their locked commits. */
async function restore(layout: StoreLayout, ctx: CommandContext): Promise<number> {
  const locked = await readSkillsLock(layout);
  if (locked === null) {
    if ((await readSkillsManifest(layout)) === null) {
      ctx.stdout("no skills.lock — nothing to restore");
      return 0;
    }
    ctx.stderr("❌ skills.yaml exists but skills.lock does not — run `nahel skills lock` first");
    return 1;
  }
  const useCli = await skillsCliAvailable();
  for (const entry of locked.entries) {
    const placed = useCli
      ? await restoreViaSkillsCli(entry)
      : await restoreViaClone(layout, entry);
    ctx.stdout(`restored ${entry.repo}@${entry.sha}: ${placed.join(", ")}`);
  }
  const via = useCli ? " via skills CLI" : "";
  ctx.stdout(`restored ${locked.entries.length} skill source(s)${via}`);
  return 0;
}

async function runSkills(argv: string[], ctx: CommandContext): Promise<number> {
  try {
    const sub = parseSubcommand(argv);
    const layout = storeLayout(ctx.cwd);
    if (sub === "lock") return await lock(layout, ctx);
    if (sub === "restore") return await restore(layout, ctx);
    throw new UsageError(`unknown skills subcommand: ${sub}`);
  } catch (error) {
    ctx.stderr(`❌ ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof UsageError) ctx.stderr(USAGE);
    return 1;
  }
}

export const skillsCommand: Command = {
  description:
    "manage pinned skill dependencies: `lock` resolves skills.yaml refs to commit SHAs, `restore` materializes them at the locked commits",
  run: runSkills,
};

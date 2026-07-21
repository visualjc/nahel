import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { CommandContext } from "../../src/cli";
import { doctorCommand } from "../../src/commands/doctor";
import type { Contract } from "../../src/schema/records";
import { ensureLayout, writeConfig } from "../../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel doctor` (PRD F2, ADR-0014): verifies the run contract for THIS
 * machine. Exit codes carry the branch a workflow needs — 2 contract missing
 * (autonomy-gated), 3 env incomplete (this machine isn't set up), 4
 * healthcheck failed, 0 OK. Named env vars are checked through an injected
 * presence predicate: doctor never has a channel to a secret VALUE.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface DoctorResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Write a config (optionally with a contract) and run doctor over it. */
async function runDoctor(
  options: { contract?: Contract; present?: string[]; args?: string[] } = {},
): Promise<DoctorResult> {
  const root = await makeTempDir("nahel-doctor-");
  tempDirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig(options.contract ? { contract: options.contract } : {}));
  return runDoctorAt(root, options.present ?? [], options.args ?? []);
}

async function runDoctorAt(root: string, present: string[], args: string[]): Promise<DoctorResult> {
  const set = new Set(present);
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    env: seededEnv(),
    cwd: root,
    envPresent: (name) => set.has(name),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  const code = await doctorCommand.run(args, ctx);
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

describe("nahel doctor — contract missing (exit 2)", () => {
  test("no contract section reports contract missing with exit 2", async () => {
    const result = await runDoctor();
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("contract missing");
  });
});

describe("nahel doctor — env incomplete (exit 3)", () => {
  const contract: Contract = {
    launch: "bun run dev",
    seed: "bun run seed",
    test: "bun test",
    env: ["DATABASE_URL", "STRIPE_SECRET_KEY"],
  };

  test("unset named env vars are listed by NAME only, exit 3", async () => {
    const result = await runDoctor({ contract, present: ["DATABASE_URL"] });
    expect(result.code).toBe(3);
    expect(result.stdout).toContain("STRIPE_SECRET_KEY"); // the missing one
    expect(result.stdout).not.toContain("DATABASE_URL"); // the present one is not "missing"
  });

  test("the missing distinction is separate from contract-missing (3 vs 2)", async () => {
    const missing = await runDoctor({ present: [] }); // no contract
    const incomplete = await runDoctor({ contract, present: [] }); // contract, no env
    expect(missing.code).toBe(2);
    expect(incomplete.code).toBe(3);
  });
});

describe("nahel doctor — env complete", () => {
  const base = { launch: "l", seed: "s", test: "t" };

  test("no healthcheck defined reports contract OK, exit 0", async () => {
    const result = await runDoctor({ contract: { ...base, env: ["TOKEN"] }, present: ["TOKEN"] });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("contract OK");
  });

  test("a passing healthcheck reports OK, exit 0", async () => {
    const result = await runDoctor({ contract: { ...base, healthcheck: "exit 0" } });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("contract OK");
  });

  test("a failing healthcheck is exit 4, reporting failure without its runtime output", async () => {
    // The `''` splits the sentinel in the command TEXT (doctor may echo that
    // committed, secret-free string) but the shell prints it concatenated —
    // so "LEAKEDOUTPUT" appears only in the healthcheck's OUTPUT, never in the
    // command. Asserting its absence proves doctor never surfaces that output.
    const result = await runDoctor({
      contract: { ...base, healthcheck: "echo LEAKED''OUTPUT; exit 7" },
    });
    expect(result.code).toBe(4);
    expect(result.stdout).toContain("healthcheck failed (exit 7)");
    expect(result.stdout).not.toContain("LEAKEDOUTPUT"); // never echoes healthcheck output
  });

  test("a healthcheck that outruns healthcheck_timeout_seconds reports a distinct timeout message, still exit 4 (Finding 6 / PR #13)", async () => {
    const start = Date.now();
    const result = await runDoctor({
      contract: { ...base, healthcheck: "sleep 5", healthcheck_timeout_seconds: 1 },
    });
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(3000); // killed, not hung on the full sleep
    expect(result.code).toBe(4); // same exit branch as a failed healthcheck
    expect(result.stdout).toContain("timed out after 1s"); // but a distinct message
    expect(result.stdout).not.toContain("healthcheck failed (exit"); // not the plain-failure line
  });
});

describe("nahel doctor — hard errors and usage", () => {
  test("an uninitialized directory points at nahel init, exit 1", async () => {
    const root = await makeTempDir("nahel-doctor-bare-");
    tempDirs.push(root);
    const result = await runDoctorAt(root, [], []);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("nahel init");
  });

  test("unexpected positionals are a usage error, exit 1", async () => {
    const result = await runDoctor({ args: ["surprise"] });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("usage");
  });

  test("exports a registration-ready Command: a description and a run function", () => {
    expect(typeof doctorCommand.description).toBe("string");
    expect(doctorCommand.description.length).toBeGreaterThan(0);
    expect(typeof doctorCommand.run).toBe("function");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * F7's first acceptance criterion, driven the way it is written: a map is
 * charted END TO END through the CLI plus its workflow on a real feature node
 * — all five sections populated, tickets of three of the four types, blocking
 * wired — and then one session works it: claim one ticket, resolve it, record
 * the decision, graduate a fog line, distill the ticket, and find the decision
 * again with `nahel recall`.
 *
 * The steps below are `nahel/workflows/chart-map.md` and `work-map.md` read
 * literally, in order. Like the journey test this file imports NOTHING from
 * src/: if the two docs cannot be driven by their own commands alone, the
 * workflows are not drivable by conversation (HC5) and this fails.
 */

const CLI = join(import.meta.dir, "../../src/cli.ts");

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function nahel(cwd: string, ...args: string[]): CliResult {
  const result = spawnSync("bun", ["run", CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NAHEL_ACTOR: "agent:chart-agent" },
  });
  const output = { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  console.log(
    `$ nahel ${args.join(" ")}\n  exit ${output.code}` +
      (output.stdout.trim() === "" ? "" : `\n  stdout: ${output.stdout.trim()}`) +
      (output.stderr.trim() === "" ? "" : `\n  stderr: ${output.stderr.trim()}`),
  );
  return output;
}

function ok(result: CliResult, what: string): CliResult {
  if (result.code !== 0) {
    throw new Error(`${what} failed (exit ${result.code}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

describe("E2E wayfinder — chart a map, then work exactly one ticket off it (F7)", () => {
  test(
    "chart-map.md then work-map.md, through the public CLI alone",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "nahel-chart-"));
      tempDirs.push(root);
      git(root, "init", "--initial-branch=main");
      ok(nahel(root, "init"), "init");

      // A real roadmap tree to chart against: a product and a feature under it.
      const product = ok(
        nahel(root, "roadmap", "node", "new", "product", "nahel", "--horizon", "now",
          "--intent", "Durable, tool-agnostic project state for agentic development."),
        "roadmap node new (product)",
      ).stdout.trim();
      ok(
        nahel(root, "roadmap", "node", "new", "feature", "deployment-devops-workflows",
          "--horizon", "now", "--parent", product,
          "--intent", "Deploy and release, drivable by a fresh agent."),
        "roadmap node new (feature)",
      );

      // chart-map step 2: the destination and the notes.
      const map = ok(
        nahel(root, "roadmap", "map", "new", "--node", "deployment-devops-workflows",
          "--destination", "a deploy a fresh agent can drive with no tribal knowledge",
          "--notes", "Two stores to cover; the CLI already records deploy and release events."),
        "map new",
      ).stdout.trim();
      expect(map).not.toBe("");

      // chart-map step 4: one ticket per sharp question, three of the four types.
      const research = ok(
        nahel(root, "roadmap", "ticket", "new", "--map", "deployment-devops-workflows",
          "--type", "research", "--question", "which deploy target do we own?"),
        "ticket new (research)",
      ).stdout.trim();
      const grilling = ok(
        nahel(root, "roadmap", "ticket", "new", "--map", "deployment-devops-workflows",
          "--type", "grilling", "--question", "who signs off on a release?"),
        "ticket new (grilling)",
      ).stdout.trim();
      const task = ok(
        nahel(root, "roadmap", "ticket", "new", "--map", "deployment-devops-workflows",
          "--type", "task", "--question", "wire deploy.completed into the stage view"),
        "ticket new (task)",
      ).stdout.trim();

      // chart-map step 5: the blocking edges, in a second pass.
      ok(
        nahel(root, "roadmap", "ticket", "update", task, "--blocked-by", research,
          "--blocked-by", grilling),
        "ticket update --blocked-by",
      );

      // chart-map steps 6 and 7: the fog, and the out-of-scope ruling.
      ok(
        nahel(root, "roadmap", "map", "update", "deployment-devops-workflows",
          "--fog", "how does a rollback get journaled?",
          "--fog", "does staging need its own environment name?",
          "--out-of-scope", "marketing announcements — a later phase owns them"),
        "map update (fog + out of scope)",
      );

      // chart-map step 8: all five sections read back from one command.
      const charted = ok(nahel(root, "roadmap", "map", "show", "deployment-devops-workflows"),
        "map show").stdout;
      expect(charted).toContain("a deploy a fresh agent can drive with no tribal knowledge");
      expect(charted).toContain("Two stores to cover");
      expect(charted).toContain("decisions so far (0)");
      expect(charted).toContain("how does a rollback get journaled?");
      expect(charted).toContain("marketing announcements");
      expect(charted).toContain("tickets (3)");
      expect(charted).toContain(`blocked by ${research}, ${grilling}`);
      ok(nahel(root, "validate"), "validate (after charting)");

      // work-map step 2: claim exactly ONE ticket.
      ok(nahel(root, "roadmap", "ticket", "claim", research), "ticket claim");
      expect(
        ok(nahel(root, "roadmap", "ticket", "show", research), "ticket show").stdout,
      ).toContain("claimant=agent:chart-agent");

      // work-map step 4: the decision.
      ok(
        nahel(root, "roadmap", "ticket", "resolve", research,
          "--decision", "we own the fly.io deploy and nothing downstream of it"),
        "ticket resolve",
      );

      // work-map step 5: a fog line graduates into a ticket, the rest re-stated.
      ok(
        nahel(root, "roadmap", "ticket", "new", "--map", "deployment-devops-workflows",
          "--type", "prototype", "--question", "how does a rollback get journaled?"),
        "ticket new (graduated fog)",
      );
      ok(
        nahel(root, "roadmap", "map", "update", "deployment-devops-workflows",
          "--fog", "does staging need its own environment name?"),
        "map update (fog after graduation)",
      );

      // work-map step 6: recall finds the decision, so the body may go.
      const recalled = ok(nahel(root, "recall", "fly.io"), "recall").stdout;
      expect(recalled).toContain("we own the fly.io deploy");
      ok(nahel(root, "roadmap", "ticket", "distill", research), "ticket distill");

      // The map now carries the decision, one fog line, and four tickets — and
      // the decision survives the body that was thrown away.
      const worked = ok(nahel(root, "roadmap", "map", "show", "deployment-devops-workflows"),
        "map show (after)").stdout;
      expect(worked).toContain("decisions so far (1)");
      expect(worked).toContain("we own the fly.io deploy and nothing downstream of it");
      expect(worked).toContain("not yet specified (1)");
      expect(worked).toContain("tickets (4)");
      expect(ok(nahel(root, "recall", "fly.io"), "recall (after distill)").stdout).toContain(
        "we own the fly.io deploy",
      );

      // And the store is clean: nothing about the whole exercise is a finding.
      const validated = ok(nahel(root, "validate"), "validate (final)");
      expect(validated.code).toBe(0);
      expect(validated.stdout).not.toContain("error");
    },
    { timeout: 120_000 },
  );
});

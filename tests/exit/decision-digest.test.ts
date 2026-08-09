import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readdir, readFile, rm } from "node:fs/promises";
import { relative, join } from "node:path";
import { main, type CommandContext } from "../../src/cli";
import { readTicket } from "../../src/store/layout";
import { makeTempDir, seededEnv } from "../store/helpers";
import {
  addExcludedClosures,
  addProvenanceCases,
  addSameTimestampTie,
  chartDecisionMaps,
  createFreshDecisionStore,
  createResolvedDecisionSet,
  distillAndLocateArchivedResolution,
  installWorkflowShims,
  introduceIncompleteJoin,
  repairIncompleteJoin,
  type CliResult,
  type DriveNahel,
  type DriveOptions,
} from "./decision-digest-fixture";

/**
 * Decision Digest comprehensive EXIT TEST.
 *
 * Focused F1-F8 tests own every individual rule. This test owns only their
 * composition: can a fresh store be charted, populated, compactly discovered,
 * filtered, widened, zoomed, validated, repaired, and reread as one workflow
 * without any read mutating the store or disturbing unrelated help/workflows?
 */

let roots: string[] = [];
let consoleOut: string[] = [];
let consoleErr: string[] = [];
let outSpy: { mockRestore(): void };
let errSpy: { mockRestore(): void };

beforeEach(() => {
  consoleOut = [];
  consoleErr = [];
  outSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    consoleOut.push(args.join(" "));
  });
  errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    consoleErr.push(args.join(" "));
  });
});

afterEach(async () => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function driver(root: string): DriveNahel {
  const fixtureEnv = seededEnv({
    seed: 4_081,
    now: "2026-08-09T08:00:00Z",
    tickSeconds: 60,
  });
  return async (args: string[], options: DriveOptions = {}): Promise<CliResult> => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const outStart = consoleOut.length;
    const errStart = consoleErr.length;
    const ctx: CommandContext = {
      cwd: root,
      env: options.env ?? fixtureEnv,
      homeDir: root,
      actorOverride: options.actor ?? "agent:codex",
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    };
    const code = await main(args, ctx);
    stdout.push(...consoleOut.slice(outStart));
    stderr.push(...consoleErr.slice(errStart));
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  };
}

async function snapshotTree(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    snapshot.set(relative(root, path), await readFile(path, "utf8"));
  }
  return snapshot;
}

function subtree(snapshot: ReadonlyMap<string, string>, prefix: string): Map<string, string> {
  return new Map([...snapshot].filter(([path]) => path.startsWith(prefix)));
}

function ticketIds(output: string): string[] {
  return output
    .split("\n")
    .flatMap((line) => /^  ticket ([0-9a-z]{8}) /.exec(line)?.[1] ?? []);
}

function ticketBlock(output: string, ticket: string): string {
  const lines = output.split("\n");
  const at = lines.findIndex((line) => line.startsWith(`  ticket ${ticket} `));
  expect(at).toBeGreaterThan(0);
  return lines.slice(at - 1, at + 2).join("\n");
}

function occurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

function hintArgs(output: string, prefix: string): string[] {
  const line = output.split("\n").find((candidate) => candidate.startsWith(`↳ ${prefix}`));
  expect(line).toBeDefined();
  return line!
    .slice("↳ nahel ".length, line!.indexOf("  — "))
    .split(" ");
}

function ok(result: CliResult, label: string): CliResult {
  expect(`${label}: ${result.stderr}`).toBe(`${label}: `);
  expect(result.code).toBe(0);
  return result;
}

describe("Decision Digest — composed comprehensive exit", () => {
  test(
    "discovers, queries, zooms, repairs, and rereads a fresh durable decision ledger",
    async () => {
      const root = await makeTempDir("nahel-decision-digest-exit-");
      roots.push(root);
      const drive = driver(root);

      // Arrangement is deliberately explicit and ordered. Each named helper
      // owns one concern; none replaces the focused F1-F8 acceptance tests.
      const layout = await createFreshDecisionStore(drive, root);
      const maps = await chartDecisionMaps(drive);
      const resolved = await createResolvedDecisionSet(drive, maps);
      const provenance = await addProvenanceCases(drive, maps);
      const closures = await addExcludedClosures(drive, maps, provenance.directHuman);
      const archived = await distillAndLocateArchivedResolution(drive, layout, resolved);
      const tie = await addSameTimestampTie(drive, layout, maps);
      const incomplete = await introduceIncompleteJoin(layout, provenance.incomplete);
      await installWorkflowShims(drive);

      expect((await readTicket(layout, archived.ticket)).body).toBe("");
      expect(archived.ticket).toBe(resolved.distilled);
      expect(incomplete.ticket).toBe(provenance.incomplete);
      expect(tie.ticketsInOrder).toHaveLength(2);
      expect(tie.timestamp).toBe("2026-08-09T11:30:00Z");
      expect(tie.seq).toBe(0);

      const beforeReads = await snapshotTree(root);
      const workflowBytes = subtree(beforeReads, "nahel/workflows/");
      const shimBytes = subtree(beforeReads, ".claude/commands/nd/");
      expect(workflowBytes.size).toBeGreaterThan(0);
      expect(shimBytes.size).toBe(workflowBytes.size);

      // Discover globally, then use the complete focused help surface.
      const globalHelp = ok(await drive(["help"]), "global help").stdout;
      expect(occurrences(globalHelp, "  decisions  show a compact, read-only ledger")).toBe(1);
      const roadmapHelp = ok(await drive(["roadmap", "--help"]), "roadmap help").stdout;
      const decisionsHelp = ok(await drive(["decisions", "--help"]), "decisions help").stdout;
      expect(ok(await drive(["decisions", "-h"]), "decisions -h").stdout).toBe(decisionsHelp);
      expect(decisionsHelp).toContain("Read-only: writes nothing and journals nothing.");
      expect(decisionsHelp).toContain("nahel decisions --since 30d --limit 50");
      const mapHelpExample = ok(
        await drive(["decisions", "--map", "decision-digest"]),
        "map help example",
      ).stdout;
      expect(ticketIds(mapHelpExample).length).toBeGreaterThan(0);
      expect(mapHelpExample).toContain(`map decision-digest (${maps.primary.map})`);

      // Compact default: 14 eligible rows become the newest 10, displayed
      // oldest-to-newest. The only ambiguity is the deliberate timestamp tie,
      // whose helper returns the canonical event-id order.
      const compact = ok(await drive(["decisions"]), "compact decisions").stdout;
      const expectedDefault = [
        ...resolved.tickets.slice(4),
        provenance.directHuman,
        provenance.delegated,
        provenance.ratified,
        provenance.agent,
        provenance.incomplete,
        ...tie.ticketsInOrder,
      ];
      expect(compact.split("\n")[0]).toBe(
        "decisions: 14 matching · showing 10 · limit 10 · oldest → newest · 4 older omitted",
      );
      expect(ticketIds(compact)).toEqual(expectedDefault);
      expect(ticketBlock(compact, provenance.directHuman)).toContain(
        "resolver human:jim:planning · badges [direct-human]",
      );
      expect(ticketBlock(compact, provenance.delegated)).toContain(
        "resolver agent:codex:delegated · badges [delegated]",
      );
      expect(ticketBlock(compact, provenance.ratified)).toContain(
        "resolver agent:codex:ratified · badges [ratified] [agent]",
      );
      expect(ticketBlock(compact, provenance.agent)).toContain(
        "resolver agent:codex:ordinary · badges [agent]",
      );
      const incompleteBlock = ticketBlock(compact, provenance.incomplete);
      expect(incompleteBlock).toContain("resolver agent:codex:repair · badges [agent] [incomplete]");
      expect(incompleteBlock).not.toContain("direct-human");
      expect(incompleteBlock).not.toContain("delegated");
      expect(incompleteBlock).not.toContain("ratified");
      expect(compact).toContain(`map ${maps.primary.slug} (${maps.primary.map}) · node ${maps.primary.node}`);
      expect(compact).toContain(`map ${maps.secondary.slug} (${maps.secondary.map}) · node ${maps.secondary.node}`);
      expect(compact).toContain("↳ nahel validate  — inspect or repair incomplete store links");

      // Every v1 filter, a combined intersection, and the documented widening
      // path are driven through the command registry—not through view helpers.
      const since = ok(await drive(["decisions", "--since", "24h"]), "since filter").stdout;
      expect(ticketIds(since)).toEqual(expectedDefault);
      const byHuman = ok(await drive(["decisions", "--by", "human"]), "actor filter").stdout;
      expect(ticketIds(byHuman)).toEqual([provenance.directHuman]);
      const byMap = ok(
        await drive(["decisions", "--map", maps.secondary.map, "--limit", "50"]),
        "map filter",
      ).stdout;
      expect(ticketIds(byMap)).toContain(provenance.incomplete);
      expect(ticketIds(byMap).every((ticket) => !resolved.tickets.slice(0, 4).includes(ticket))).toBe(true);
      const provenanceExpectations: Array<[string, string]> = [
        ["direct-human", provenance.directHuman],
        ["delegated", provenance.delegated],
        ["ratified", provenance.ratified],
        ["agent", provenance.agent],
        ["incomplete", provenance.incomplete],
      ];
      for (const [badge, ticket] of provenanceExpectations) {
        const filtered = ok(
          await drive(["decisions", "--provenance", badge, "--limit", "50"]),
          `${badge} filter`,
        ).stdout;
        expect(ticketIds(filtered)).toContain(ticket);
      }
      const limited = ok(await drive(["decisions", "--limit", "2"]), "limit filter").stdout;
      expect(ticketIds(limited)).toEqual(tie.ticketsInOrder);
      const combined = ok(
        await drive([
          "decisions",
          "--since",
          "30d",
          "--by",
          "agent:codex:delegated",
          "--map",
          maps.primary.slug,
          "--provenance",
          "delegated",
          "--limit",
          "50",
        ]),
        "combined query",
      ).stdout;
      expect(ticketIds(combined)).toEqual([provenance.delegated]);

      const widened = ok(
        await drive(["decisions", "--since", "30d", "--limit", "50"]),
        "widened decisions",
      ).stdout;
      expect(widened.split("\n")[0]).toBe(
        "decisions: 14 matching · showing 14 · limit 50 · oldest → newest · none omitted",
      );
      expect(ticketIds(widened)).toHaveLength(14);
      expect(widened).not.toContain(closures.outOfScope);
      expect(widened).not.toContain(closures.invalidated);
      expect(ticketIds(widened)).toContain(archived.ticket);
      expect(widened.indexOf(tie.ticketsInOrder[0])).toBeLessThan(
        widened.indexOf(tie.ticketsInOrder[1]),
      );

      // Follow the concrete evidence hints exactly as printed.
      for (const prefix of [
        "nahel roadmap ticket show ",
        "nahel roadmap map show ",
        "nahel recall ",
      ]) {
        ok(await drive(hintArgs(widened, prefix)), `zoom ${prefix.trim()}`);
      }

      // Recall's quoted-phrase hint is executable against this decision store.
      const recallHelp = ok(await drive(["recall", "--help"]), "recall help").stdout;
      const phrase = /Example: nahel recall "([^"]+)"/.exec(recallHelp)?.[1];
      expect(phrase).toBe("decision digest");
      const recalled = ok(await drive(["recall", phrase!]), "quoted recall").stdout;
      expect(recalled).toContain(provenance.directHuman);

      // Validation identifies the missing observation, but every help/read/zoom
      // above—including the refused validation—left the whole store untouched.
      const invalid = await drive(["validate"]);
      expect(invalid.code).toBe(1);
      expect(invalid.stdout).toContain(incomplete.observation);
      expect(await snapshotTree(root)).toEqual(beforeReads);

      // Repair is the one intentional mutation. Rereading enriches the SAME
      // ticket row, removes incomplete, and creates no stale duplicate.
      const repaired = ok(await repairIncompleteJoin(drive), "validate --repair");
      expect(repaired.stdout).toContain(`repaired observation ${incomplete.observation}`);
      const afterRepairBytes = await snapshotTree(root);
      const reread = ok(
        await drive(["decisions", "--since", "30d", "--limit", "50"]),
        "reread after repair",
      ).stdout;
      expect(occurrences(reread, provenance.incomplete)).toBe(1);
      expect(ticketBlock(reread, provenance.incomplete)).toContain(
        "resolver agent:codex:repair · badges [agent]",
      );
      expect(ticketBlock(reread, provenance.incomplete)).not.toContain("incomplete");
      expect(ticketIds(ok(
        await drive(["decisions", "--provenance", "incomplete", "--limit", "50"]),
        "incomplete after repair",
      ).stdout)).toEqual([]);
      ok(await drive(["validate"]), "validate after repair");
      expect(await snapshotTree(root)).toEqual(afterRepairBytes);

      // The new read stayed feature-local: unrelated help and the installed
      // canonical workflow/shim artifacts are byte-identical throughout.
      expect(ok(await drive(["help"]), "global help after").stdout).toBe(globalHelp);
      expect(ok(await drive(["roadmap", "--help"]), "roadmap help after").stdout).toBe(roadmapHelp);
      const finalBytes = await snapshotTree(root);
      expect(subtree(finalBytes, "nahel/workflows/")).toEqual(workflowBytes);
      expect(subtree(finalBytes, ".claude/commands/nd/")).toEqual(shimBytes);
    },
    { timeout: 120_000 },
  );
});

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { main, VERSION, type CommandContext } from "../../src/cli";
import { ensureLayout, roadmapNodePath, writeConfig } from "../../src/store/layout";
import { renderDecisionRows, type DecisionRow } from "../../src/views/decisions";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

const dirs: string[] = [];

async function snapshotTree(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(path, await readFile(path, "utf8"));
  }
  return files;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("nahel decisions — public CLI rendering", () => {
  test("renders one resolved decision with durable identity, proof, and runnable zoom hints", async () => {
    const root = await makeTempDir("nahel-decisions-cli-");
    dirs.push(root);
    await writeConfig(await ensureLayout(root), makeConfig());

    const stdout: string[] = [];
    const stderr: string[] = [];
    const consoleLines: string[] = [];
    const consoleSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.join(" "));
    });
    const ctx: CommandContext = {
      cwd: root,
      env: seededEnv({ seed: 71, now: "2026-08-08T12:00:00Z" }),
      actorOverride: "human:jim:planning",
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    };
    const create = async (args: string[]): Promise<string> => {
      const before = consoleLines.length;
      expect(await main(["roadmap", ...args], ctx)).toBe(0);
      expect(stderr).toEqual([]);
      return consoleLines.slice(before).at(-1)!;
    };

    try {
      const node = await create([
        "node",
        "new",
        "feature",
        "durable-decisions",
        "--horizon",
        "now",
        "--intent",
        "Keep decisions durable.",
      ]);
      const map = await create([
        "map",
        "new",
        "--node",
        node,
        "--destination",
        "a durable decision ledger",
      ]);
      const ticket = await create([
        "ticket",
        "new",
        "--map",
        map,
        "--type",
        "research",
        "--question",
        "Which records define a decision row?",
      ]);
      await create([
        "ticket",
        "resolve",
        ticket,
        "--decision",
        "Use current durable store facts.",
      ]);

      expect(await main(["decisions"], ctx)).toBe(0);

      expect(stderr).toEqual([]);
      expect(stdout.join("\n")).toBe(
        [
          "decisions: 1 matching · showing 1 · limit 10 · oldest → newest · none omitted",
          "",
          "2026-08-08T12:00:00Z  Use current durable store facts.",
          `  ticket ${ticket} · map durable-decisions (${map}) · node ${node}`,
          "  resolver human:jim:planning · badges [direct-human]",
          "",
          `↳ nahel roadmap ticket show ${ticket}  — inspect the question and decision`,
          `↳ nahel roadmap map show ${map}  — inspect the map and nearby decisions`,
          `↳ nahel recall ${ticket}  — inspect the decision observation and source events`,
          "↳ nahel decisions --help  — filter or widen this ledger",
        ].join("\n"),
      );
      for (const args of [
        ["roadmap", "ticket", "show", ticket],
        ["roadmap", "map", "show", map],
        ["recall", ticket],
        ["decisions", "--help"],
      ]) {
        expect(await main(args, ctx)).toBe(0);
      }
      expect(stderr).toEqual([]);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  test("renderer omits unproved time, resolver, and title from an incomplete row", () => {
    const row: DecisionRow = {
      ticketId: "ticket01",
      ticketType: "task",
      decision: "Keep only proved facts.",
      mapId: "map00001",
      nodeId: "node0001",
      resolutionEventId: "event001",
      citedSourceEventIds: [],
      sourceEvents: [],
      missingSourceEventIds: [],
      missing: ["resolution-event", "node"],
      incomplete: true,
      provenance: ["incomplete"],
    };

    const rendered = renderDecisionRows([row]);

    expect(rendered).toContain("\n\nKeep only proved facts.\n");
    expect(rendered).toContain("  ticket ticket01 · map map00001 · node node0001");
    expect(rendered).toContain("  badges [incomplete]");
    expect(rendered).not.toContain("resolver");
    expect(rendered).not.toContain("undefined");
  });

  test("renderer stops at the stable map id when the map-to-node join is missing", () => {
    const row: DecisionRow = {
      ticketId: "ticket02",
      ticketType: "task",
      decision: "Keep the map identity.",
      mapId: "map00002",
      citedSourceEventIds: [],
      sourceEvents: [],
      missingSourceEventIds: [],
      missing: ["map"],
      incomplete: true,
      provenance: ["incomplete"],
    };

    const rendered = renderDecisionRows([row]);

    expect(rendered).toContain("  ticket ticket02 · map map00002");
    expect(rendered).not.toContain("node undefined");
    expect(rendered).not.toContain("nahel roadmap map show map00002");
    expect(rendered).toContain("nahel roadmap ticket show ticket02");
    expect(rendered).toContain("nahel recall ticket02");
    expect(rendered).toContain("nahel validate");
  });

  test("an empty result points only to focused help and fabricates no evidence target", async () => {
    const root = await makeTempDir("nahel-decisions-empty-");
    dirs.push(root);
    await writeConfig(await ensureLayout(root), makeConfig());
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await main(["decisions"], {
      cwd: root,
      env: seededEnv(),
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toBe(
      [
        "decisions: no decisions matched · limit 10 · oldest → newest · none omitted",
        "",
        "↳ nahel decisions --help  — filter or widen this ledger",
      ].join("\n"),
    );
  });

  test("reports omitted older matches while rendering the newest 10 oldest to newest", async () => {
    const root = await makeTempDir("nahel-decisions-omitted-");
    dirs.push(root);
    await writeConfig(await ensureLayout(root), makeConfig());
    const stdout: string[] = [];
    const stderr: string[] = [];
    const consoleLines: string[] = [];
    const consoleSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.join(" "));
    });
    const ctx: CommandContext = {
      cwd: root,
      env: seededEnv({ seed: 711, now: "2026-08-08T12:00:00Z", tickSeconds: 1 }),
      actorOverride: "agent:codex",
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    };
    const create = async (args: string[]): Promise<string> => {
      const before = consoleLines.length;
      expect(await main(["roadmap", ...args], ctx)).toBe(0);
      return consoleLines.slice(before).at(-1)!;
    };

    try {
      const node = await create([
        "node", "new", "feature", "many-decisions", "--horizon", "now", "--intent", "Keep a bounded digest.",
      ]);
      const map = await create([
        "map", "new", "--node", node, "--destination", "a compact ledger",
      ]);
      const tickets: string[] = [];
      for (let index = 1; index <= 11; index += 1) {
        const ticket = await create([
          "ticket", "new", "--map", map, "--type", "task", "--question", `Question ${index}?`,
        ]);
        tickets.push(ticket);
        await create([
          "ticket", "resolve", ticket, "--decision", `Decision ${index}.`,
        ]);
      }

      expect(await main(["decisions"], ctx)).toBe(0);
      const rendered = stdout.join("\n");

      expect(stderr).toEqual([]);
      expect(rendered.split("\n")[0]).toBe(
        "decisions: 11 matching · showing 10 · limit 10 · oldest → newest · 1 older omitted",
      );
      expect(rendered).not.toContain(tickets[0]!);
      for (const ticket of tickets.slice(1)) expect(rendered).toContain(ticket);
      expect(rendered.indexOf(tickets[1]!)).toBeLessThan(rendered.indexOf(tickets[10]!));
    } finally {
      consoleSpy.mockRestore();
    }
  });

  test("an incomplete row omits an unproved title and points to validation", async () => {
    const root = await makeTempDir("nahel-decisions-incomplete-");
    dirs.push(root);
    const layout = await ensureLayout(root);
    await writeConfig(layout, makeConfig());
    const stdout: string[] = [];
    const stderr: string[] = [];
    const consoleLines: string[] = [];
    const consoleSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.join(" "));
    });
    const ctx: CommandContext = {
      cwd: root,
      env: seededEnv({ seed: 712, now: "2026-08-08T12:00:00Z" }),
      actorOverride: "human:jim",
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    };
    const create = async (args: string[]): Promise<string> => {
      const before = consoleLines.length;
      expect(await main(["roadmap", ...args], ctx)).toBe(0);
      return consoleLines.slice(before).at(-1)!;
    };

    try {
      const node = await create([
        "node", "new", "feature", "missing-title", "--horizon", "now", "--intent", "Keep partial facts visible.",
      ]);
      const map = await create([
        "map", "new", "--node", node, "--destination", "an honest incomplete row",
      ]);
      const ticket = await create([
        "ticket", "new", "--map", map, "--type", "prototype", "--question", "What survives a missing node?",
      ]);
      await create([
        "ticket", "resolve", ticket, "--decision", "Render only durable facts.",
      ]);
      await rm(roadmapNodePath(layout, node));

      expect(await main(["decisions"], ctx)).toBe(0);
      const rendered = stdout.join("\n");

      expect(stderr).toEqual([]);
      expect(rendered).toContain(`ticket ${ticket} · map ${map} · node ${node}`);
      expect(rendered).toContain("resolver human:jim · badges [direct-human] [incomplete]");
      expect(rendered).not.toContain("undefined");
      expect(rendered).not.toContain("missing-title");
      expect(rendered).toContain("↳ nahel validate  — inspect or repair incomplete store links");
      expect(await main(["validate"], ctx)).toBe(1);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe("nahel decisions — focused help", () => {
  test("global help adds exactly one concise discovery row", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(
      await main([], {
        cwd: "/store-does-not-exist",
        env: seededEnv(),
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      }),
    ).toBe(0);
    expect(stderr).toEqual([]);
    const discovery =
      "  decisions  show a compact, read-only ledger of resolved map decisions\n";
    expect(stdout.join("\n").split(discovery)).toHaveLength(2);
    expect(stdout.join("\n").replace(discovery, "")).toBe(
      [
        `nahel ${VERSION} — deterministic CLI for the Nahel state model`,
        "",
        "Usage: nahel <command> [options]",
        "",
        "Commands:",
        "  brief      render the onboarding pack: constitution extract, knowledge pointers, statuses, recent activity, pending decisions, qa state, warnings (4 KB target)",
        "  claim      claim an item and its subtree for a human: pause covered runs, refuse agent mutations",
        "  config     replace one optional nahel/config section (schema-validated, atomic, journaled as config.updated)",
        "  dispatch   spawn the agent CLI routing assigns to a responsibility (composed invocation + run record, journaled)",
        "  distill    mark archived journal segments as distilled (adds marker files under nahel/journal/distilled/, journals the act)",
        "  doctor     verify the run contract on this machine: contract present, named env vars set (names only, never values), healthcheck runnable",
        "  handback   release a claim you hold, journaling deterministic evidence of the hand-fix",
        "  import     migrate a ccpm project into this nahel store (import --from-ccpm)",
        "  init       scaffold nahel/ state structure, config, and knowledge templates (non-interactive, re-run safe); --hands-off \"<paragraph>\" records a hands-off founding",
        "  install    generate per-agent slash-command shims from canonical workflow docs (nahel/workflows/*.md)",
        "  item       create and update work items (item new | item update)",
        "  log        append a typed journal event (observation about work; actor from config or NAHEL_ACTOR)",
        "  observe    distill one durable observation (a fact with provenance journal event ids) into nahel/observations/",
        "  pause      suspend an active run (status becomes paused; hot state follows)",
        "  plan       render the planning briefing for a roadmap node: what moved since your last session, the decisions so far, the frontier, the fog, and what the partner may settle here (plan [ref])",
        "  progress   show the journal timeline, newest last (--item covers the subtree; --since, --limit)",
        "  prototype  run the prototype lane: spawn variant worktrees, promote a winner, dispose of the rest",
        "  recall     keyword-search observation records (name/body/tags, ranked by hits then recency; cites provenance event ids)",
        "  roadmap    read the roadmap and zoom into it, and create or update its nodes — the intent layer above work items (roadmap [ref], roadmap node new | update | show, roadmap ack)",
        "  run        drive the run lifecycle (run start | run update --phase | run end)",
        "  skills     manage pinned skill dependencies: `lock` resolves skills.yaml refs to commit SHAs, `restore` materializes them at the locked commits",
        "  standup    show what moved in a time window, grouped by roadmap node and item (--since 7d|24h|ISO)",
        "  status     show the work-item tree, open runs with phases, and claims (--json for the raw snapshot)",
        "  validate   check store integrity — schema, refs, claims, journal (--repair replays journal-ahead mutations)",
        "",
        "Global flags:",
        "  --version, -v  print the version",
        "  --help, -h     print this help",
      ].join("\n"),
    );
  });

  test("--help and -h are byte-identical, store-independent, and explain the complete read path", async () => {
    const expected = [
      "usage: nahel decisions [--since <7d|24h|ISO>] [--by <human|agent|kind:id[:session]>] [--map <map-id|node-id|node-slug>] [--provenance <direct-human|delegated|ratified|agent|incomplete>] [--limit <positive-integer>]",
      "",
      "Read-only: writes nothing and journals nothing.",
      "",
      "Bare `nahel decisions` selects the newest 10 matching decisions, then displays that retained slice oldest to newest.",
      "",
      "Flags:",
      "  --since <7d|24h|ISO>  include decisions at or after a relative whole-hour/day or ISO UTC time",
      "  --by <human|agent|kind:id[:session]>  match a resolver kind or exact actor",
      "  --map <map-id|node-id|node-slug>  narrow to one current map",
      "  --provenance <direct-human|delegated|ratified|agent|incomplete>  require a proved badge",
      "  --limit <positive-integer>  retain this many newest matches (default 10)",
      "",
      "Examples:",
      "  nahel decisions",
      "  nahel decisions --since 24h",
      "  nahel decisions --by human",
      "  nahel decisions --map decision-digest",
      "  nahel decisions --provenance incomplete",
      "  nahel decisions --since 30d --limit 50",
      "",
      "Run the command, then follow its concrete ticket, map, and recall `↳` hints for evidence.",
      "If a row is incomplete, run `nahel validate` to inspect or repair missing links.",
    ].join("\n");

    for (const flag of ["--help", "-h"]) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await main(["decisions", flag], {
        cwd: "/store-does-not-exist",
        env: seededEnv(),
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      });
      expect(code).toBe(0);
      expect(stderr).toEqual([]);
      expect(stdout.join("\n")).toBe(expected);
    }
  });

  test("success, help, and invalid-option refusal are read-only with focused refusal guidance", async () => {
    const root = await makeTempDir("nahel-decisions-read-only-");
    dirs.push(root);
    const layout = await ensureLayout(root);
    await writeConfig(layout, makeConfig());
    const before = await snapshotTree(layout.nahelDir);
    const invoke = async (args: string[]) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await main(["decisions", ...args], {
        cwd: root,
        env: seededEnv(),
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      });
      return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
    };

    expect((await invoke([])).code).toBe(0);
    expect((await invoke(["--help"])).code).toBe(0);
    const refused = await invoke(["--json"]);

    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("--json");
    expect(refused.stderr).toEndWith(
      [
        "usage: nahel decisions [--since <7d|24h|ISO>] [--by <human|agent|kind:id[:session]>] [--map <map-id|node-id|node-slug>] [--provenance <direct-human|delegated|ratified|agent|incomplete>] [--limit <positive-integer>]",
        "run `nahel decisions --help` for details",
      ].join("\n"),
    );
    expect(await snapshotTree(layout.nahelDir)).toEqual(before);
  });
});

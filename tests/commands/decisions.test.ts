import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { main, type CommandContext } from "../../src/cli";
import { ensureLayout, writeConfig } from "../../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

const dirs: string[] = [];

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
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

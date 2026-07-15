import { describe, expect, test } from "bun:test";
import { VERSION } from "../src/cli";

describe("cli", () => {
  test("exposes a semver version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("--version prints the version", async () => {
    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "--version"]);
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out.trim()).toBe(`nahel ${VERSION}`);
  });
});

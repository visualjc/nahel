import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { validateStore } from "../../src/validate";
import { findingsFor, setupFixture } from "./helpers";

/**
 * Skills lockfile drift (PRD F7, ADR-0009). Drift is a `nahel validate`
 * WARNING, computed deterministically from skills.yaml and skills.lock ALONE —
 * no network. A repo with neither file (the common case) produces nothing.
 * These run over the real validate pipeline: files written into the fixture
 * root, collectValidationInput reads them, the pure check reports.
 */

let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

async function writeManifest(root: string, yaml: string): Promise<void> {
  await writeFile(`${root}/skills.yaml`, yaml);
}
async function writeLock(root: string, lock: unknown): Promise<void> {
  await writeFile(`${root}/skills.lock`, `${JSON.stringify(lock, null, 2)}\n`);
}

describe("validate — skills drift (warnings only)", () => {
  test("no skills.yaml and no skills.lock produces no skills findings", async () => {
    const fixture = await setupFixture(dirs);
    const findings = await validateStore(fixture.layout);
    const skills = findings.filter((f) => f.check.startsWith("skills."));
    expect(skills).toEqual([]);
  });

  test("a manifest and lock that agree produce no drift findings", async () => {
    const fixture = await setupFixture(dirs);
    await writeManifest(
      fixture.root,
      "skills:\n  - repo: owner/name\n    ref: main\n    use: [tdd]\n",
    );
    await writeLock(fixture.root, {
      entries: [{ repo: "owner/name", ref: "main", sha: SHA_A, skills: ["tdd"] }],
    });
    const findings = await validateStore(fixture.layout);
    expect(findings.filter((f) => f.check.startsWith("skills."))).toEqual([]);
  });

  test("a manifest source with no lock entry is a skills.unlocked warning", async () => {
    const fixture = await setupFixture(dirs);
    await writeManifest(
      fixture.root,
      "skills:\n  - repo: owner/name\n    ref: main\n    use: [tdd]\n",
    );
    // No skills.lock at all.
    const findings = await validateStore(fixture.layout);
    const unlocked = findingsFor(findings, "skills.unlocked");
    expect(unlocked).toHaveLength(1);
    expect(unlocked[0]!.severity).toBe("warning");
    expect(unlocked[0]!.message).toContain("owner/name");
    expect(unlocked[0]!.fix).toContain("nahel skills lock");
  });

  test("a lock entry absent from the manifest is a skills.orphaned warning", async () => {
    const fixture = await setupFixture(dirs);
    await writeManifest(fixture.root, "skills: []\n");
    await writeLock(fixture.root, {
      entries: [{ repo: "owner/gone", ref: "main", sha: SHA_A, skills: ["tdd"] }],
    });
    const findings = await validateStore(fixture.layout);
    const orphaned = findingsFor(findings, "skills.orphaned");
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0]!.severity).toBe("warning");
    expect(orphaned[0]!.message).toContain("owner/gone");
  });

  test("a ref changed since locking is a skills.stale warning naming both refs", async () => {
    const fixture = await setupFixture(dirs);
    await writeManifest(
      fixture.root,
      "skills:\n  - repo: owner/name\n    ref: v2.0.0\n    use: [tdd]\n",
    );
    await writeLock(fixture.root, {
      entries: [{ repo: "owner/name", ref: "v1.0.0", sha: SHA_B, skills: ["tdd"] }],
    });
    const findings = await validateStore(fixture.layout);
    const stale = findingsFor(findings, "skills.stale");
    expect(stale).toHaveLength(1);
    expect(stale[0]!.severity).toBe("warning");
    expect(stale[0]!.message).toContain("v1.0.0");
    expect(stale[0]!.message).toContain("v2.0.0");
  });

  test("drift never fails validate — warnings only, exit stays clean", async () => {
    const fixture = await setupFixture(dirs);
    await writeManifest(
      fixture.root,
      "skills:\n  - repo: owner/name\n    ref: main\n    use: [tdd]\n",
    );
    const findings = await validateStore(fixture.layout);
    expect(findings.every((f) => f.severity === "warning")).toBe(true);
  });

  test("a malformed skills.lock is a schema error, and drift is NOT double-reported", async () => {
    const fixture = await setupFixture(dirs);
    await writeManifest(
      fixture.root,
      "skills:\n  - repo: owner/name\n    ref: main\n    use: [tdd]\n",
    );
    await writeFile(`${fixture.root}/skills.lock`, "{ not json");
    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, "schema.skills-lock")).toHaveLength(1);
    // The lock did not parse, so it is treated as absent for drift: the
    // manifest source reports unlocked, but there is no orphaned/stale noise.
    expect(findingsFor(findings, "skills.orphaned")).toEqual([]);
    expect(findingsFor(findings, "skills.stale")).toEqual([]);
  });

  test("a malformed skills.yaml is a schema error", async () => {
    const fixture = await setupFixture(dirs);
    await writeManifest(fixture.root, "skills: []\nbogus: true\n");
    const findings = await validateStore(fixture.layout);
    expect(findingsFor(findings, "schema.skills-manifest")).toHaveLength(1);
    expect(findingsFor(findings, "schema.skills-manifest")[0]!.severity).toBe("error");
  });
});

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { skillsLockSchema, skillsManifestSchema } from "../../src/schema/records";

/**
 * The COMMITTED manifest and lock, checked as data (planning-partner F7,
 * epic-review finding 4). Restore itself needs the network, so the suite
 * cannot prove the pinned commit still serves these skills — that was
 * verified live at vendoring time and re-verified at epic close. What the
 * suite CAN prove deterministically is that the shipped files are the shape
 * `nahel skills restore` consumes: both parse, the lock covers the manifest
 * exactly, and the pin is a real SHA — so a hand-edit that desyncs them
 * fails here instead of at the next restore.
 */

const root = join(import.meta.dir, "..", "..");

describe("the committed skills manifest and lock agree (F7)", () => {
  test("skills.yaml parses against the manifest schema and pins the two D6 skills", async () => {
    const manifest = skillsManifestSchema.parse(
      parseYaml(await readFile(join(root, "skills.yaml"), "utf8")),
    );
    expect(manifest.skills).toHaveLength(1);
    const source = manifest.skills[0]!;
    expect(source.repo).toBe("mattpocock/skills");
    expect([...source.use].sort()).toEqual(["domain-modeling", "grilling"]);
  });

  test("skills.lock parses against the lock schema and covers the manifest entry for entry", async () => {
    const manifest = skillsManifestSchema.parse(
      parseYaml(await readFile(join(root, "skills.yaml"), "utf8")),
    );
    const lock = skillsLockSchema.parse(
      JSON.parse(await readFile(join(root, "skills.lock"), "utf8")),
    );
    expect(lock.entries).toHaveLength(manifest.skills.length);
    for (const [i, source] of manifest.skills.entries()) {
      const entry = lock.entries[i]!;
      expect(entry.repo).toBe(source.repo);
      expect(entry.ref).toBe(source.ref);
      expect(entry.skills).toEqual(source.use);
      expect(entry.sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

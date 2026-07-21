import { describe, expect, test } from "bun:test";
import type { ZodType } from "zod";
import { skillsLockSchema, skillsManifestSchema } from "../../src/schema/records";

/**
 * Skills dependency schemas (PRD F7, ADR-0009). `skills.yaml` declares the
 * pinned skill sources ({repo, ref, use}); `skills.lock` records each source
 * resolved to an exact commit SHA plus the skill names placed. `kind` is
 * implicitly markdown in v1 — the schema carries no kind field (adding one
 * speculatively is forbidden). Objects are strict: a typo'd key is a
 * validation error, never silent state.
 */

function rejectionIssues(schema: ZodType, value: unknown, label: string): string[] {
  const result = schema.safeParse(value);
  if (result.success) {
    throw new Error(`${label}: expected validation to fail but it passed`);
  }
  const rendered = result.error.issues.map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`,
  );
  console.log(`[${label}]`, rendered);
  return rendered;
}

function expectAccepted(schema: ZodType, value: unknown, label: string): void {
  const result = schema.safeParse(value);
  if (!result.success) {
    console.log(`[${label}] unexpected issues:`, result.error.issues);
  }
  expect(result.success).toBe(true);
}

const SHA = "a".repeat(40);

describe("skillsManifestSchema (skills.yaml)", () => {
  test("accepts a well-formed manifest: repo, ref, and a non-empty use list", () => {
    expectAccepted(
      skillsManifestSchema,
      {
        skills: [
          { repo: "PromptDrivenDev/skills", ref: "main", use: ["diagnosing-bugs", "tdd"] },
          { repo: "https://github.com/owner/repo.git", ref: "v1.2.0", use: ["grilling"] },
        ],
      },
      "valid manifest",
    );
  });

  test("accepts an empty skills list (a repo may declare no sources yet)", () => {
    expectAccepted(skillsManifestSchema, { skills: [] }, "empty manifest");
  });

  test("rejects an unknown top-level key (strict)", () => {
    const issues = rejectionIssues(
      skillsManifestSchema,
      { skills: [], extra: true },
      "manifest extra key",
    );
    expect(issues.join(" ")).toMatch(/unrecognized|extra/i);
  });

  test("rejects an unknown entry key like a speculative kind field", () => {
    rejectionIssues(
      skillsManifestSchema,
      { skills: [{ repo: "a/b", ref: "main", use: ["x"], kind: "markdown" }] },
      "manifest entry kind",
    );
  });

  test("rejects an empty repo", () => {
    rejectionIssues(
      skillsManifestSchema,
      { skills: [{ repo: "", ref: "main", use: ["x"] }] },
      "empty repo",
    );
  });

  test("rejects an empty use list (a source that places nothing is a mistake)", () => {
    rejectionIssues(
      skillsManifestSchema,
      { skills: [{ repo: "a/b", ref: "main", use: [] }] },
      "empty use",
    );
  });

  test("rejects a non-slug skill name (names become path components)", () => {
    rejectionIssues(
      skillsManifestSchema,
      { skills: [{ repo: "a/b", ref: "main", use: ["../escape"] }] },
      "unsafe skill name",
    );
  });
});

describe("skillsLockSchema (skills.lock)", () => {
  test("accepts a well-formed lock: repo, ref, 40-hex sha, and placed skills", () => {
    expectAccepted(
      skillsLockSchema,
      {
        entries: [
          { repo: "PromptDrivenDev/skills", ref: "main", sha: SHA, skills: ["tdd"] },
        ],
      },
      "valid lock",
    );
  });

  test("accepts an empty entries list", () => {
    expectAccepted(skillsLockSchema, { entries: [] }, "empty lock");
  });

  test("rejects a short or non-hex sha", () => {
    rejectionIssues(
      skillsLockSchema,
      { entries: [{ repo: "a/b", ref: "main", sha: "abc123", skills: ["tdd"] }] },
      "short sha",
    );
    rejectionIssues(
      skillsLockSchema,
      { entries: [{ repo: "a/b", ref: "main", sha: "Z".repeat(40), skills: ["tdd"] }] },
      "non-hex sha",
    );
  });

  test("rejects an unknown entry key (strict)", () => {
    rejectionIssues(
      skillsLockSchema,
      { entries: [{ repo: "a/b", ref: "main", sha: SHA, skills: ["tdd"], kind: "markdown" }] },
      "lock entry kind",
    );
  });

  test("rejects a missing sha", () => {
    rejectionIssues(
      skillsLockSchema,
      { entries: [{ repo: "a/b", ref: "main", skills: ["tdd"] }] },
      "missing sha",
    );
  });
});

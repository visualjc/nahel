import { describe, expect, test } from "bun:test";
import {
  extractGithubIssueId,
  mapCcpmStatus,
  mapCcpmType,
  parseGithubMapping,
  slugifyCcpmName,
} from "../../src/commands/import";

/**
 * F8 (`nahel import --from-ccpm`) — the pure mapping layer that turns ccpm
 * frontmatter into nahel-schema field values. These functions carry no I/O:
 * they are the deterministic contract the migration is proven against, and
 * they encode the exact status/type/slug/github decisions the importer makes
 * (PRD F8.1). Every quirk found in Jim's real speed-count-game epic is a case
 * here: prose task names that must slugify, `completed`/`closed` statuses,
 * github issue URLs, and the mapping file's `#N - url` lines.
 */

describe("slugifyCcpmName — prose titles become schema-valid slugs", () => {
  test("a real ccpm task title becomes a hyphen slug", () => {
    // "Add URL seed parameter handling" — task 2.md's `name:` in the real epic.
    expect(slugifyCcpmName("Add URL seed parameter handling")).toBe(
      "add-url-seed-parameter-handling",
    );
  });

  test("an already-slug epic name is preserved verbatim", () => {
    expect(slugifyCcpmName("speed-count-cards-from-seed")).toBe("speed-count-cards-from-seed");
  });

  test("punctuation, underscores, and repeated separators collapse to single hyphens", () => {
    expect(slugifyCcpmName("Foo_bar: baz (qux)!!")).toBe("foo-bar-baz-qux");
  });

  test("leading/trailing separators are trimmed", () => {
    expect(slugifyCcpmName("  --Hello World--  ")).toBe("hello-world");
  });

  test("a title with no slug-able characters yields the empty string for the caller to backfill", () => {
    expect(slugifyCcpmName("!!!")).toBe("");
  });
});

describe("mapCcpmStatus — ccpm statuses onto the universal enum (PRD open question 2)", () => {
  test("backlog and open map to backlog", () => {
    expect(mapCcpmStatus("backlog")).toEqual({ status: "backlog" });
    expect(mapCcpmStatus("open")).toEqual({ status: "backlog" });
  });

  test("in-progress spellings all map to in-progress", () => {
    expect(mapCcpmStatus("in-progress")).toEqual({ status: "in-progress" });
    expect(mapCcpmStatus("in_progress")).toEqual({ status: "in-progress" });
    expect(mapCcpmStatus("started")).toEqual({ status: "in-progress" });
  });

  test("blocked maps to blocked", () => {
    expect(mapCcpmStatus("blocked")).toEqual({ status: "blocked" });
  });

  test("completed, closed, done, and the PRD's `complete` all map to done", () => {
    expect(mapCcpmStatus("completed")).toEqual({ status: "done" });
    expect(mapCcpmStatus("closed")).toEqual({ status: "done" });
    expect(mapCcpmStatus("done")).toEqual({ status: "done" });
    expect(mapCcpmStatus("complete")).toEqual({ status: "done" });
  });

  test("mapping is case- and whitespace-insensitive", () => {
    expect(mapCcpmStatus("  In-Progress ")).toEqual({ status: "in-progress" });
  });

  test("an unmappable status falls to backlog and reports the original for a journaled note", () => {
    expect(mapCcpmStatus("wontfix")).toEqual({ status: "backlog", original: "wontfix" });
  });

  test("a missing status defaults to backlog silently (no original to name)", () => {
    expect(mapCcpmStatus(undefined)).toEqual({ status: "backlog" });
  });
});

describe("mapCcpmType — bug only from an explicit type field, never from the name", () => {
  test("type: bug in frontmatter yields a bug item", () => {
    expect(mapCcpmType({ type: "bug" })).toBe("bug");
    expect(mapCcpmType({ type: "BUG" })).toBe("bug");
  });

  test("no type field yields feature (the ccpm default)", () => {
    expect(mapCcpmType({})).toBe("feature");
  });

  test("a name containing 'bug' does NOT infer a bug — only the type field counts", () => {
    expect(mapCcpmType({ name: "Fix the bug in the parser" })).toBe("feature");
  });

  test("a non-bug explicit type still yields feature (v1 only distinguishes bug)", () => {
    expect(mapCcpmType({ type: "task" })).toBe("feature");
  });
});

describe("extractGithubIssueId — issue number from a github URL", () => {
  test("pulls the trailing issue number", () => {
    expect(
      extractGithubIssueId("https://github.com/visualjc/speed-count-web/issues/1"),
    ).toBe("1");
    expect(
      extractGithubIssueId("https://github.com/visualjc/speed-count-web/issues/42"),
    ).toBe("42");
  });

  test("a non-issue or absent url yields undefined", () => {
    expect(extractGithubIssueId("https://github.com/visualjc/speed-count-web")).toBeUndefined();
    expect(extractGithubIssueId(undefined)).toBeUndefined();
    expect(extractGithubIssueId(123)).toBeUndefined();
  });
});

describe("parseGithubMapping — github-mapping.md as issue# → url", () => {
  test("parses both the Epic line and the task list lines", () => {
    const text = [
      "# GitHub Issue Mapping",
      "",
      "Epic: #1 - https://github.com/visualjc/speed-count-web/issues/1",
      "",
      "Tasks:",
      "- #4: Implement seeded Fisher-Yates shuffle in DeckModel - https://github.com/visualjc/speed-count-web/issues/4",
      "- #2: Add URL seed parameter handling - https://github.com/visualjc/speed-count-web/issues/2",
      "",
      "Synced: 2026-02-18T15:11:01Z",
    ].join("\n");
    const map = parseGithubMapping(text);
    expect(map.get("1")).toBe("https://github.com/visualjc/speed-count-web/issues/1");
    expect(map.get("4")).toBe("https://github.com/visualjc/speed-count-web/issues/4");
    expect(map.get("2")).toBe("https://github.com/visualjc/speed-count-web/issues/2");
    expect(map.size).toBe(3);
  });
});

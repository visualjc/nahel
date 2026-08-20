import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { InvalidIdError } from "../../src/schema/id";
import { resultDocPath, storeLayout, taskDocPath } from "../../src/store/layout";
import {
  RESULT_DOC_CONTRACT,
  RESULT_DOC_FILENAME,
  RESULT_DOC_STATUSES,
  RUNS_RELATIVE_DIR,
  TASK_DOC_FILENAME,
  parseResultDoc,
  resultDocFrontmatterSchema,
  resultDocRelativePath,
  taskDocRelativePath,
} from "../../src/store/result";

/**
 * The result-doc contract (PRD F4): a worker-authored `result.md` is
 * frontmatter (`run`, `item`, `status`, `summary`) plus free markdown. These
 * tests pin the parse gate and the path helpers that address the document.
 */

const RUN_ID = "8j44rq9g";
const ITEM_ID = "9akby10d";

/** A conforming frontmatter mapping; `overrides` bends exactly one field. */
function makeResultFrontmatter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run: RUN_ID,
    item: ITEM_ID,
    status: "success",
    summary: "implemented the result-doc contract and its tests",
    ...overrides,
  };
}

describe("parseResultDoc — conforming documents", () => {
  test("a conforming frontmatter parses back to the typed record, field for field", () => {
    const input = makeResultFrontmatter();
    const parsed = parseResultDoc(input);
    expect(parsed).toEqual({
      run: RUN_ID,
      item: ITEM_ID,
      status: "success",
      summary: "implemented the result-doc contract and its tests",
    });
  });

  test.each([...RESULT_DOC_STATUSES])("status %s is accepted (PRD F4 enum)", (status) => {
    const parsed = parseResultDoc(makeResultFrontmatter({ status }));
    expect(parsed.status).toBe(status);
  });

  test("unknown extra keys are TOLERATED — result docs are worker-authored, not nahel-written", () => {
    const parsed = parseResultDoc(
      makeResultFrontmatter({ tokens_used: 1234, notes: ["worker added this"] }),
    );
    expect(parsed.status).toBe("success");
    expect(parsed.summary).toBe("implemented the result-doc contract and its tests");
    expect(
      (parsed as Record<string, unknown>).tokens_used,
      "an extra key must not become part of the typed record",
    ).toBeUndefined();
  });

  test("the schema itself is non-strict: safeParse succeeds with an unknown key", () => {
    const result = resultDocFrontmatterSchema.safeParse(
      makeResultFrontmatter({ unexpected: "tolerated" }),
    );
    expect(result.success, "non-strict schema must accept unknown keys").toBe(true);
  });
});

describe("parseResultDoc — each missing required key is its own named error", () => {
  test.each(["run", "item", "status", "summary"])(
    "a document missing %s throws an error naming that field",
    (field) => {
      const frontmatter = makeResultFrontmatter();
      delete frontmatter[field];
      let message = "";
      try {
        parseResultDoc(frontmatter);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, `omitting ${field} must throw, not parse`).not.toBe("");
      expect(
        message,
        `the error for a missing ${field} must name ${field}; got: ${message}`,
      ).toContain(field);
      expect(
        message,
        `the error must be flagged as invalid result frontmatter; got: ${message}`,
      ).toContain("result");
    },
  );

  test("a missing key does not report a DIFFERENT field's name", () => {
    const frontmatter = makeResultFrontmatter();
    delete frontmatter.status;
    expect(() => parseResultDoc(frontmatter)).toThrow(/status/);
    try {
      parseResultDoc(frontmatter);
    } catch (error) {
      expect(
        (error as Error).message,
        "the status error must not blame summary — findings name the failing field",
      ).not.toContain("summary");
    }
  });
});

describe("parseResultDoc — field-level rejections", () => {
  test("a status outside the enum is rejected and the message names status", () => {
    expect(() => parseResultDoc(makeResultFrontmatter({ status: "done" }))).toThrow(/status/);
  });

  test("an empty summary is rejected — a result with no summary says nothing", () => {
    expect(() => parseResultDoc(makeResultFrontmatter({ summary: "" }))).toThrow(/summary/);
  });

  test("a multi-line summary is rejected — summary is ONE line by contract", () => {
    expect(() =>
      parseResultDoc(makeResultFrontmatter({ summary: "first line\nsecond line" })),
    ).toThrow(/summary/);
  });

  test("a summary with a trailing newline is rejected too (still not one line)", () => {
    expect(() => parseResultDoc(makeResultFrontmatter({ summary: "done\n" }))).toThrow(
      /summary/,
    );
  });

  test("a malformed run id is rejected and the message names run", () => {
    expect(() => parseResultDoc(makeResultFrontmatter({ run: "../../etc" }))).toThrow(/run/);
  });

  test("a malformed item id is rejected and the message names item", () => {
    expect(() => parseResultDoc(makeResultFrontmatter({ item: "TOOLONG12345" }))).toThrow(
      /item/,
    );
  });

  test("a non-string run (a number) is rejected", () => {
    expect(() => parseResultDoc(makeResultFrontmatter({ run: 12345678 }))).toThrow(/run/);
  });
});

describe("RESULT_DOC_CONTRACT — the single source the worker prompt embeds", () => {
  test("names every required frontmatter key, so schema and prompt cannot drift", () => {
    for (const key of ["run", "item", "status", "summary"]) {
      expect(
        RESULT_DOC_CONTRACT,
        `the prompt contract must mention the required key ${key}`,
      ).toContain(key);
    }
  });

  test("names every status enum value", () => {
    for (const status of RESULT_DOC_STATUSES) {
      expect(
        RESULT_DOC_CONTRACT,
        `the prompt contract must mention the status value ${status}`,
      ).toContain(status);
    }
  });

  test("names the result document's file name", () => {
    expect(RESULT_DOC_CONTRACT).toContain(RESULT_DOC_FILENAME);
  });

  test("is a non-empty multi-line block of prose (embeddable in a prompt as-is)", () => {
    expect(RESULT_DOC_CONTRACT.length, "contract must not be empty").toBeGreaterThan(0);
    expect(
      RESULT_DOC_CONTRACT.split("\n").length,
      "contract is a few fixed lines",
    ).toBeGreaterThan(1);
  });
});

describe("filename constants", () => {
  test("the task and result documents have their fixed names", () => {
    expect(TASK_DOC_FILENAME).toBe("task.md");
    expect(RESULT_DOC_FILENAME).toBe("result.md");
  });
});

describe("absolute path helpers (store layout)", () => {
  const layout = storeLayout("/repo");

  test("taskDocPath lands in the run dir beside the run record", () => {
    expect(taskDocPath(layout, RUN_ID)).toBe(join("/repo", "nahel", "runs", RUN_ID, "task.md"));
  });

  test("resultDocPath lands in the run dir beside the run record", () => {
    expect(resultDocPath(layout, RUN_ID)).toBe(
      join("/repo", "nahel", "runs", RUN_ID, "result.md"),
    );
  });

  test.each([
    ["a traversal attempt", "../../etc"],
    ["an empty id", ""],
    ["an uppercase id", "8J44RQ9G"],
    ["an id with an ambiguous letter", "8j44rqil"],
    ["a too-short id", "8j44rq9"],
  ])("taskDocPath refuses %s before any join", (_label, id) => {
    expect(() => taskDocPath(layout, id)).toThrow(InvalidIdError);
  });

  test.each([
    ["a traversal attempt", "../../etc"],
    ["an empty id", ""],
    ["an uppercase id", "8J44RQ9G"],
  ])("resultDocPath refuses %s before any join", (_label, id) => {
    expect(() => resultDocPath(layout, id)).toThrow(InvalidIdError);
  });
});

describe("repo-relative POSIX path helpers", () => {
  test("taskDocRelativePath renders nahel/runs/<run-id>/task.md", () => {
    expect(taskDocRelativePath(RUN_ID)).toBe(`${RUNS_RELATIVE_DIR}/${RUN_ID}/task.md`);
    expect(taskDocRelativePath(RUN_ID)).toBe(`nahel/runs/${RUN_ID}/task.md`);
  });

  test("resultDocRelativePath renders nahel/runs/<run-id>/result.md", () => {
    expect(resultDocRelativePath(RUN_ID)).toBe(`nahel/runs/${RUN_ID}/result.md`);
  });

  test("relative forms are POSIX ALWAYS — never a backslash, whatever the host", () => {
    expect(taskDocRelativePath(RUN_ID)).not.toContain("\\");
    expect(resultDocRelativePath(RUN_ID)).not.toContain("\\");
  });

  test.each([
    ["a traversal attempt", "../../etc"],
    ["an empty id", ""],
    ["an uppercase id", "8J44RQ9G"],
  ])("taskDocRelativePath refuses %s — a pointer must never render a crafted id", (_l, id) => {
    expect(() => taskDocRelativePath(id)).toThrow(InvalidIdError);
  });

  test.each([
    ["a traversal attempt", "../../etc"],
    ["an empty id", ""],
    ["an uppercase id", "8J44RQ9G"],
  ])("resultDocRelativePath refuses %s", (_l, id) => {
    expect(() => resultDocRelativePath(id)).toThrow(InvalidIdError);
  });
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { itemCommand } from "../../src/commands/item";
import type { Env } from "../../src/schema/env";
import { ID_PATTERN } from "../../src/schema/id";
import type { Config, JournalEvent } from "../../src/schema/records";
import { readJournal, SESSION_CLOSED_EVENT_TYPE } from "../../src/store/journal";
import {
  ensureLayout,
  itemExists,
  listItems,
  readItem,
  writeConfig,
  writeItem,
  type StoreLayout,
} from "../../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel item new` / `nahel item update` (PRD F3). The command objects are
 * exercised directly (cli.ts registration is issue #4). All journaling
 * assertions READ the journal — the commands themselves never log directly;
 * the store's mutate() choke point auto-journals every mutation.
 */

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

let dirs: string[] = [];
let logs: string[] = [];
let errs: string[] = [];
let logSpy: { mockRestore(): void };
let errSpy: { mockRestore(): void };

beforeEach(() => {
  logs = [];
  errs = [];
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.join(" "));
  });
  errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errs.push(args.join(" "));
  });
});

afterEach(async () => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

function stderr(): string {
  return errs.join("\n");
}

async function setup(options: { actor?: Config["actor"] } = {}) {
  const root = await makeTempDir("nahel-cmd-item-");
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(
    layout,
    makeConfig(options.actor === undefined ? {} : { actor: options.actor }),
  );
  const env = seededEnv({ tickSeconds: 1 });
  return { root, layout, env };
}

async function journalEvents(layout: StoreLayout): Promise<JournalEvent[]> {
  const events: JournalEvent[] = [];
  for await (const event of readJournal(layout)) events.push(event);
  return events;
}

/** Create an item through the command and return its printed id. */
async function newItem(env: Env, root: string, args: string[] = []): Promise<string> {
  const before = logs.length;
  const code = await itemCommand.run(
    ["new", "feature", "test-item", "direct", ...args],
    env,
    root,
  );
  expect(code).toBe(0);
  const id = logs[before];
  if (id === undefined) throw new Error("item new printed nothing");
  return id;
}

describe("itemCommand shape", () => {
  test("is a registration-ready command object", () => {
    expect(itemCommand.name).toBe("item");
    expect(itemCommand.description.length).toBeGreaterThan(0);
    expect(typeof itemCommand.run).toBe("function");
  });
});

describe("item new", () => {
  test("creates a backlog record with a generated id and prints the id", async () => {
    const { root, layout, env } = await setup();
    const code = await itemCommand.run(["new", "feature", "auth-login", "direct"], env, root);

    expect(stderr()).toBe("");
    expect(code).toBe(0);
    expect(logs).toHaveLength(1);
    const id = logs[0]!;
    expect(id).toMatch(ID_PATTERN);

    const { frontmatter, body } = await readItem(layout, id);
    expect(frontmatter.id).toBe(id);
    expect(frontmatter.name).toBe("auth-login");
    expect(frontmatter.type).toBe("feature");
    expect(frontmatter.status).toBe("backlog");
    expect(frontmatter.lane).toBe("direct");
    expect(frontmatter.parent).toBeUndefined();
    expect(frontmatter.depends_on).toEqual([]);
    expect(frontmatter.external_refs).toEqual([]);
    expect(frontmatter.created).toMatch(TIMESTAMP);
    expect(frontmatter.updated).toBe(frontmatter.created);
    expect(body).toBe("");
  });

  test("auto-journals item.created via the choke point — the event carries the full record", async () => {
    const { root, layout, env } = await setup();
    const id = await newItem(env, root);

    // Two events: the mutation, then the invocation's session-close marker
    // (the CLI closes its per-invocation session segment on success).
    const events = await journalEvents(layout);
    expect(events).toHaveLength(2);
    expect(events[1]!.type).toBe(SESSION_CLOSED_EVENT_TYPE);
    const event = events[0]!;
    expect(event.type).toBe("item.created");
    expect(event.actor).toEqual({ kind: "agent", id: "claude-code" });
    expect(event.item).toBe(id);
    expect(event.run).toBeUndefined();
    const { frontmatter } = await readItem(layout, id);
    expect(event.payload).toEqual({ target: "item", record: frontmatter, body: "" });
  });

  test("--parent, repeated --depends-on, and repeated --external-ref populate the record", async () => {
    const { root, layout, env } = await setup();
    const parent = await newItem(env, root);
    const depA = await newItem(env, root);
    const depB = await newItem(env, root);

    const code = await itemCommand.run(
      [
        "new", "bug", "child-item", "epic-lite",
        "--parent", parent,
        "--depends-on", depA,
        "--depends-on", depB,
        "--external-ref", "github:123",
        "--external-ref", "linear:ENG-9",
      ],
      env,
      root,
    );
    expect(stderr()).toBe("");
    expect(code).toBe(0);

    const { frontmatter } = await readItem(layout, logs[logs.length - 1]!);
    expect(frontmatter.type).toBe("bug");
    expect(frontmatter.lane).toBe("epic-lite");
    expect(frontmatter.parent).toBe(parent);
    expect(frontmatter.depends_on).toEqual([depA, depB]);
    expect(frontmatter.external_refs).toEqual([
      { provider: "github", id: "123" },
      { provider: "linear", id: "ENG-9" },
    ]);
  });

  test("rejects a --parent that references no existing item, writing nothing", async () => {
    const { root, layout, env } = await setup();
    const code = await itemCommand.run(
      ["new", "feature", "orphan", "direct", "--parent", "zzzzzzzz"],
      env,
      root,
    );
    expect(code).toBe(1);
    expect(stderr()).toContain("zzzzzzzz");
    expect(stderr()).toContain("does not reference an existing item");
    expect(logs).toEqual([]);
    expect(await journalEvents(layout)).toEqual([]);
    expect(await listItems(layout)).toEqual([]);
  });

  test("rejects a --depends-on that references no existing item, writing nothing", async () => {
    const { root, layout, env } = await setup();
    const code = await itemCommand.run(
      ["new", "feature", "dangling", "direct", "--depends-on", "zzzzzzzz"],
      env,
      root,
    );
    expect(code).toBe(1);
    expect(stderr()).toContain("zzzzzzzz");
    expect(stderr()).toContain("does not reference an existing item");
    expect(await journalEvents(layout)).toEqual([]);
    expect(await listItems(layout)).toEqual([]);
  });

  test("rejects an invalid type, listing the valid values", async () => {
    const { root, layout, env } = await setup();
    const code = await itemCommand.run(["new", "epicness", "x-item", "direct"], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain("epicness");
    expect(stderr()).toContain("feature, bug, chore, plan, prototype, qa");
    expect(await journalEvents(layout)).toEqual([]);
  });

  test("rejects an invalid lane, listing the valid values", async () => {
    const { root, layout, env } = await setup();
    const code = await itemCommand.run(["new", "feature", "x-item", "warp"], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain("warp");
    expect(stderr()).toContain("direct, epic-lite, full");
    expect(await journalEvents(layout)).toEqual([]);
  });

  test("rejects a non-slug name with the slug rule spelled out", async () => {
    const { root, layout, env } = await setup();
    const code = await itemCommand.run(["new", "feature", "Not A Slug!", "direct"], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain("Not A Slug!");
    expect(stderr()).toContain("slug");
    expect(await journalEvents(layout)).toEqual([]);
  });

  test("rejects an unknown flag by name", async () => {
    const { root, env } = await setup();
    const code = await itemCommand.run(
      ["new", "feature", "x-item", "direct", "--bogus", "y"],
      env,
      root,
    );
    expect(code).toBe(1);
    expect(stderr()).toContain("--bogus");
  });

  test("rejects a malformed --external-ref, showing the expected format", async () => {
    const { root, layout, env } = await setup();
    const code = await itemCommand.run(
      ["new", "feature", "x-item", "direct", "--external-ref", "github"],
      env,
      root,
    );
    expect(code).toBe(1);
    expect(stderr()).toContain("<provider>:<id>");
    expect(await journalEvents(layout)).toEqual([]);
  });

  test("rejects missing positionals with a usage error", async () => {
    const { root, env } = await setup();
    const code = await itemCommand.run(["new", "feature"], env, root);
    expect(code).toBe(1);
    expect(stderr().length).toBeGreaterThan(0);
  });
});

describe("item update", () => {
  test("--status transitions the item; the CLI bumps `updated` and preserves `created`", async () => {
    const { root, layout, env } = await setup();
    const id = await newItem(env, root);
    const before = await readItem(layout, id);

    const code = await itemCommand.run(["update", id, "--status", "in-progress"], env, root);
    expect(stderr()).toBe("");
    expect(code).toBe(0);

    const after = await readItem(layout, id);
    expect(after.frontmatter.status).toBe("in-progress");
    expect(after.frontmatter.created).toBe(before.frontmatter.created);
    expect(after.frontmatter.updated).toMatch(TIMESTAMP);
    expect(after.frontmatter.updated > before.frontmatter.updated).toBe(true);
    // Nothing else moved.
    expect(after.frontmatter.name).toBe(before.frontmatter.name);
    expect(after.frontmatter.lane).toBe(before.frontmatter.lane);
  });

  test("--lane, --parent, --depends-on and --external-ref update fields; lists replace wholesale", async () => {
    const { root, layout, env } = await setup();
    const id = await newItem(env, root);
    const parent = await newItem(env, root);
    const depA = await newItem(env, root);
    const depB = await newItem(env, root);

    let code = await itemCommand.run(
      [
        "update", id,
        "--lane", "full",
        "--parent", parent,
        "--depends-on", depA,
        "--depends-on", depB,
        "--external-ref", "github:7",
      ],
      env,
      root,
    );
    expect(stderr()).toBe("");
    expect(code).toBe(0);
    let record = await readItem(layout, id);
    expect(record.frontmatter.lane).toBe("full");
    expect(record.frontmatter.parent).toBe(parent);
    expect(record.frontmatter.depends_on).toEqual([depA, depB]);
    expect(record.frontmatter.external_refs).toEqual([{ provider: "github", id: "7" }]);

    // A later --depends-on / --external-ref replaces the whole list.
    code = await itemCommand.run(
      ["update", id, "--depends-on", depB, "--external-ref", "linear:X-1"],
      env,
      root,
    );
    expect(code).toBe(0);
    record = await readItem(layout, id);
    expect(record.frontmatter.depends_on).toEqual([depB]);
    expect(record.frontmatter.external_refs).toEqual([{ provider: "linear", id: "X-1" }]);
  });

  test("auto-journals item.updated carrying the post-mutation record", async () => {
    const { root, layout, env } = await setup();
    const id = await newItem(env, root);
    await itemCommand.run(["update", id, "--status", "blocked"], env, root);

    // Each invocation journals its mutation plus its session-close marker.
    const events = await journalEvents(layout);
    expect(events).toHaveLength(4);
    const updated = events[2]!;
    expect(updated.type).toBe("item.updated");
    expect(updated.item).toBe(id);
    expect(updated.actor).toEqual({ kind: "agent", id: "claude-code" });
    const { frontmatter, body } = await readItem(layout, id);
    expect(updated.payload).toEqual({ target: "item", record: frontmatter, body });
  });

  test("preserves the markdown body across updates", async () => {
    const { root, layout, env } = await setup();
    const id = await newItem(env, root);
    const { frontmatter } = await readItem(layout, id);
    await writeItem(layout, frontmatter, "# Notes\n\nHand-written prose.\n");

    await itemCommand.run(["update", id, "--status", "in-progress"], env, root);
    expect((await readItem(layout, id)).body).toBe("# Notes\n\nHand-written prose.\n");
  });

  test("rejects an invalid status enum with the valid values, changing nothing", async () => {
    const { root, layout, env } = await setup();
    const id = await newItem(env, root);
    const code = await itemCommand.run(["update", id, "--status", "finished"], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain("finished");
    expect(stderr()).toContain("backlog, in-progress, blocked, in-review, done, dropped");
    expect((await readItem(layout, id)).frontmatter.status).toBe("backlog");
    // Only item.created and its session-close marker — the refusal wrote nothing.
    expect(await journalEvents(layout)).toHaveLength(2);
  });

  test("rejects unknown flags by name (field typos never become silent state)", async () => {
    const { root, layout, env } = await setup();
    const id = await newItem(env, root);
    const code = await itemCommand.run(["update", id, "--priority", "high"], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain("--priority");
    expect(await journalEvents(layout)).toHaveLength(2); // item.created + its close marker
  });

  test("fails actionably on an unknown item id", async () => {
    const { root, env } = await setup();
    const code = await itemCommand.run(["update", "zzzzzzzz", "--status", "done"], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain("zzzzzzzz");
    expect(stderr()).toContain("not found");
  });

  test("requires at least one change flag", async () => {
    const { root, env } = await setup();
    const id = await newItem(env, root);
    const code = await itemCommand.run(["update", id], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain("nothing to update");
  });

  test("rejects an item as its own --parent and as its own --depends-on", async () => {
    const { root, env } = await setup();
    const id = await newItem(env, root);
    expect(await itemCommand.run(["update", id, "--parent", id], env, root)).toBe(1);
    expect(stderr()).toContain("own parent");
    errs = [];
    expect(await itemCommand.run(["update", id, "--depends-on", id], env, root)).toBe(1);
    expect(stderr()).toContain("itself");
  });

  test("--parent must reference an existing item at write time", async () => {
    const { root, layout, env } = await setup();
    const id = await newItem(env, root);
    const code = await itemCommand.run(["update", id, "--parent", "zzzzzzzz"], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain("does not reference an existing item");
    expect((await readItem(layout, id)).frontmatter.parent).toBeUndefined();
  });

  // F1 (ADR-0013): work items reference their PRD by repo-relative path;
  // the CLI is the only writer, following the set/clear flag conventions.
  describe("prd path (--prd / --clear-prd)", () => {
    test("item new --prd records the repo-relative path and round-trips it", async () => {
      const { root, layout, env } = await setup();
      const id = await newItem(env, root, ["--prd", "docs/prds/auth-login.md"]);

      const { frontmatter } = await readItem(layout, id);
      expect(frontmatter.prd).toBe("docs/prds/auth-login.md");
      // Journaled like any mutation: the write-ahead payload IS the record.
      const events = await journalEvents(layout);
      expect((events[0]!.payload["record"] as Record<string, unknown>)["prd"]).toBe(
        "docs/prds/auth-login.md",
      );
    });

    test("item new without --prd records no prd key at all", async () => {
      const { root, layout, env } = await setup();
      const id = await newItem(env, root);
      const { frontmatter } = await readItem(layout, id);
      expect("prd" in frontmatter).toBe(false);
    });

    test("item new --prd rejects an absolute path with the repo-relative rule, nothing created", async () => {
      const { root, layout, env } = await setup();
      const code = await itemCommand.run(
        ["new", "feature", "bad-prd", "direct", "--prd", "/etc/prds/x.md"],
        env,
        root,
      );
      expect(code).toBe(1);
      expect(stderr()).toContain("repo-relative");
      expect(await listItems(layout)).toEqual([]);
    });

    test('item new --prd rejects a ".." traversal path, nothing created', async () => {
      const { root, layout, env } = await setup();
      const code = await itemCommand.run(
        ["new", "feature", "bad-prd", "direct", "--prd", "../outside.md"],
        env,
        root,
      );
      expect(code).toBe(1);
      expect(stderr()).toContain("..");
      expect(await listItems(layout)).toEqual([]);
    });

    test("item update --prd sets the path on an existing item, journaled", async () => {
      const { root, layout, env } = await setup();
      const id = await newItem(env, root);
      const code = await itemCommand.run(
        ["update", id, "--prd", "docs/prds/test-item.md"],
        env,
        root,
      );
      expect(stderr()).toBe("");
      expect(code).toBe(0);

      const after = await readItem(layout, id);
      expect(after.frontmatter.prd).toBe("docs/prds/test-item.md");
      expect(after.frontmatter.updated > after.frontmatter.created).toBe(true);
      const events = await journalEvents(layout);
      expect(events[events.length - 2]!.payload["record"]).toEqual(after.frontmatter);
    });

    test("item update --prd rejects an invalid path and writes nothing", async () => {
      const { root, layout, env } = await setup();
      const id = await newItem(env, root);
      const code = await itemCommand.run(
        ["update", id, "--prd", "docs/../../etc/passwd"],
        env,
        root,
      );
      expect(code).toBe(1);
      expect(stderr()).toContain("..");
      expect((await readItem(layout, id)).frontmatter.prd).toBeUndefined();
    });

    test("--clear-prd removes the field; the journaled record carries NO prd key", async () => {
      const { root, layout, env } = await setup();
      const id = await newItem(env, root, ["--prd", "docs/prds/test-item.md"]);

      const code = await itemCommand.run(["update", id, "--clear-prd"], env, root);
      expect(stderr()).toBe("");
      expect(code).toBe(0);

      const after = await readItem(layout, id);
      expect("prd" in after.frontmatter).toBe(false);
      const events = await journalEvents(layout);
      const updated = events[events.length - 2]!;
      expect(updated.type).toBe("item.updated");
      expect("prd" in (updated.payload["record"] as Record<string, unknown>)).toBe(false);
    });

    test("--clear-prd counts as a change on its own — no 'nothing to update'", async () => {
      const { root, env } = await setup();
      const id = await newItem(env, root);
      expect(await itemCommand.run(["update", id, "--clear-prd"], env, root)).toBe(0);
    });

    test("--prd and --clear-prd together: mutually exclusive error, nothing written", async () => {
      const { root, layout, env } = await setup();
      const id = await newItem(env, root, ["--prd", "docs/prds/test-item.md"]);
      const code = await itemCommand.run(
        ["update", id, "--prd", "docs/prds/other.md", "--clear-prd"],
        env,
        root,
      );
      expect(code).toBe(1);
      expect(stderr()).toContain("mutually exclusive");
      expect(stderr()).toContain("--clear-prd");
      expect((await readItem(layout, id)).frontmatter.prd).toBe("docs/prds/test-item.md");
    });

    test("a missing PRD file is NOT a write-time error — the path is a reference (ADR-0012)", async () => {
      const { root, layout, env } = await setup();
      // Nothing at docs/prds/never-written.md; creation must still succeed —
      // knowledge documents can arrive by a later merge.
      const id = await newItem(env, root, ["--prd", "docs/prds/never-written.md"]);
      expect((await readItem(layout, id)).frontmatter.prd).toBe("docs/prds/never-written.md");
    });
  });

  // F5: bug items reference their investigation document by repo-relative
  // path, following the --prd set/clear flag conventions exactly.
  describe("investigation path (--investigation / --clear-investigation)", () => {
    test("item new --investigation records the repo-relative path and round-trips it", async () => {
      const { root, layout, env } = await setup();
      const id = await newItem(env, root, ["--investigation", "docs/investigations/auth-500.md"]);

      const { frontmatter } = await readItem(layout, id);
      expect(frontmatter.investigation).toBe("docs/investigations/auth-500.md");
      // Journaled like any mutation: the write-ahead payload IS the record.
      const events = await journalEvents(layout);
      expect((events[0]!.payload["record"] as Record<string, unknown>)["investigation"]).toBe(
        "docs/investigations/auth-500.md",
      );
    });

    test("item new without --investigation records no investigation key at all", async () => {
      const { root, layout, env } = await setup();
      const id = await newItem(env, root);
      const { frontmatter } = await readItem(layout, id);
      expect("investigation" in frontmatter).toBe(false);
    });

    test("item new --investigation rejects an absolute path with the repo-relative rule, nothing created", async () => {
      const { root, layout, env } = await setup();
      const code = await itemCommand.run(
        ["new", "bug", "bad-investigation", "direct", "--investigation", "/etc/inv/x.md"],
        env,
        root,
      );
      expect(code).toBe(1);
      expect(stderr()).toContain("repo-relative");
      expect(await listItems(layout)).toEqual([]);
    });

    test('item new --investigation rejects a ".." traversal path, nothing created', async () => {
      const { root, layout, env } = await setup();
      const code = await itemCommand.run(
        ["new", "bug", "bad-investigation", "direct", "--investigation", "../outside.md"],
        env,
        root,
      );
      expect(code).toBe(1);
      expect(stderr()).toContain("..");
      expect(await listItems(layout)).toEqual([]);
    });

    test("item update --investigation sets the path on an existing item, journaled", async () => {
      const { root, layout, env } = await setup();
      const id = await newItem(env, root);
      const code = await itemCommand.run(
        ["update", id, "--investigation", "docs/investigations/test-item.md"],
        env,
        root,
      );
      expect(stderr()).toBe("");
      expect(code).toBe(0);

      const after = await readItem(layout, id);
      expect(after.frontmatter.investigation).toBe("docs/investigations/test-item.md");
      expect(after.frontmatter.updated > after.frontmatter.created).toBe(true);
      const events = await journalEvents(layout);
      expect(events[events.length - 2]!.payload["record"]).toEqual(after.frontmatter);
    });

    test("item update --investigation rejects an invalid path and writes nothing", async () => {
      const { root, layout, env } = await setup();
      const id = await newItem(env, root);
      const code = await itemCommand.run(
        ["update", id, "--investigation", "docs/../../etc/passwd"],
        env,
        root,
      );
      expect(code).toBe(1);
      expect(stderr()).toContain("..");
      expect((await readItem(layout, id)).frontmatter.investigation).toBeUndefined();
    });

    test("--clear-investigation removes the field; the journaled record carries NO investigation key", async () => {
      const { root, layout, env } = await setup();
      const id = await newItem(env, root, ["--investigation", "docs/investigations/test-item.md"]);

      const code = await itemCommand.run(["update", id, "--clear-investigation"], env, root);
      expect(stderr()).toBe("");
      expect(code).toBe(0);

      const after = await readItem(layout, id);
      expect("investigation" in after.frontmatter).toBe(false);
      const events = await journalEvents(layout);
      const updated = events[events.length - 2]!;
      expect(updated.type).toBe("item.updated");
      expect("investigation" in (updated.payload["record"] as Record<string, unknown>)).toBe(false);
    });

    test("--clear-investigation counts as a change on its own — no 'nothing to update'", async () => {
      const { root, env } = await setup();
      const id = await newItem(env, root);
      expect(await itemCommand.run(["update", id, "--clear-investigation"], env, root)).toBe(0);
    });

    test("--investigation and --clear-investigation together: mutually exclusive error, nothing written", async () => {
      const { root, layout, env } = await setup();
      const id = await newItem(env, root, ["--investigation", "docs/investigations/test-item.md"]);
      const code = await itemCommand.run(
        ["update", id, "--investigation", "docs/investigations/other.md", "--clear-investigation"],
        env,
        root,
      );
      expect(code).toBe(1);
      expect(stderr()).toContain("mutually exclusive");
      expect(stderr()).toContain("--clear-investigation");
      expect((await readItem(layout, id)).frontmatter.investigation).toBe(
        "docs/investigations/test-item.md",
      );
    });

    test("a missing investigation file is NOT a write-time error — the path is a reference (ADR-0012)", async () => {
      const { root, layout, env } = await setup();
      // Nothing at docs/investigations/never-written.md; creation must still
      // succeed — the document may arrive by a later merge.
      const id = await newItem(env, root, ["--investigation", "docs/investigations/never-written.md"]);
      expect((await readItem(layout, id)).frontmatter.investigation).toBe(
        "docs/investigations/never-written.md",
      );
    });
  });

  // PR #12 review: without explicit clear flags the CLI could SET
  // parent/depends_on/external_refs but never CLEAR them — forcing hand-edits,
  // which violates CLI-only mutation (hard constraint 3).
  describe("clearing fields (--clear-parent, --clear-depends-on, --clear-external-refs)", () => {
    test("--clear-parent removes the parent and the journaled record carries NO parent key", async () => {
      const { root, layout, env } = await setup();
      const parent = await newItem(env, root);
      const id = await newItem(env, root, ["--parent", parent]);
      expect((await readItem(layout, id)).frontmatter.parent).toBe(parent);

      const code = await itemCommand.run(["update", id, "--clear-parent"], env, root);
      expect(stderr()).toBe("");
      expect(code).toBe(0);

      const after = await readItem(layout, id);
      expect(after.frontmatter.parent).toBeUndefined();
      expect("parent" in after.frontmatter).toBe(false);

      // Journaled like any mutation: the write-ahead payload IS the cleared
      // record. The invocation's session-close marker follows it.
      const events = await journalEvents(layout);
      const updated = events[events.length - 2]!;
      expect(updated.type).toBe("item.updated");
      expect(events[events.length - 1]!.type).toBe(SESSION_CLOSED_EVENT_TYPE);
      expect(updated.payload["record"]).toEqual(after.frontmatter);
      expect("parent" in (updated.payload["record"] as Record<string, unknown>)).toBe(false);
    });

    test("--clear-depends-on and --clear-external-refs empty the lists, journaled", async () => {
      const { root, layout, env } = await setup();
      const dep = await newItem(env, root);
      const id = await newItem(env, root, ["--depends-on", dep, "--external-ref", "github:9"]);

      const code = await itemCommand.run(
        ["update", id, "--clear-depends-on", "--clear-external-refs"],
        env,
        root,
      );
      expect(stderr()).toBe("");
      expect(code).toBe(0);

      const after = await readItem(layout, id);
      expect(after.frontmatter.depends_on).toEqual([]);
      expect(after.frontmatter.external_refs).toEqual([]);
      // The mutation precedes the invocation's session-close marker.
      const events = await journalEvents(layout);
      expect(events[events.length - 2]!.payload["record"]).toEqual(after.frontmatter);
    });

    test("a clear flag counts as a change on its own — no 'nothing to update'", async () => {
      const { root, env } = await setup();
      const id = await newItem(env, root);
      // Clearing an already-absent parent is a no-op edit, not a usage error.
      expect(await itemCommand.run(["update", id, "--clear-parent"], env, root)).toBe(0);
    });

    test("each clear flag conflicts with its set flag: error, nothing written", async () => {
      const { root, layout, env } = await setup();
      const other = await newItem(env, root);
      const id = await newItem(env, root);
      const combos: string[][] = [
        ["--parent", other, "--clear-parent"],
        ["--depends-on", other, "--clear-depends-on"],
        ["--external-ref", "github:1", "--clear-external-refs"],
      ];
      for (const combo of combos) {
        errs = [];
        const code = await itemCommand.run(["update", id, ...combo], env, root);
        expect(code).toBe(1);
        expect(stderr()).toContain(combo[combo.length - 1]!);
        expect(stderr()).toContain("mutually exclusive");
      }
      // Refusals wrote nothing: only the two item.created events and their
      // invocations' session-close markers exist.
      expect(await journalEvents(layout)).toHaveLength(4);
      const record = await readItem(layout, id);
      expect(record.frontmatter.parent).toBeUndefined();
      expect(record.frontmatter.depends_on).toEqual([]);
      expect(record.frontmatter.external_refs).toEqual([]);
    });

    test("an agent clearing the parent of an item inside a claimed subtree is refused", async () => {
      const { root, layout, env } = await setup(); // config actor: agent
      const parent = await newItem(env, root);
      const child = await newItem(env, root, ["--parent", parent]);
      const record = await readItem(layout, parent);
      await writeItem(layout, { ...record.frontmatter, claimed_by: "jim" }, record.body);

      // Clearing the parent would MOVE the child out of the claimed subtree —
      // the claim covers it NOW (on-disk chain), so the agent is refused.
      const code = await itemCommand.run(["update", child, "--clear-parent"], env, root);
      expect(code).toBe(1);
      expect(stderr()).toContain("claim");
      const after = await readItem(layout, child);
      expect(after.frontmatter.parent).toBe(parent); // untouched
    });

    test("the claimant's human actor can clear the parent inside their own claimed subtree", async () => {
      const { root, layout, env } = await setup();
      const parent = await newItem(env, root);
      const child = await newItem(env, root, ["--parent", parent]);
      const record = await readItem(layout, parent);
      await writeItem(layout, { ...record.frontmatter, claimed_by: "jim" }, record.body);

      const code = await itemCommand.run(
        ["update", child, "--clear-parent"],
        env,
        root,
        "human:jim",
      );
      expect(code).toBe(0);
      expect((await readItem(layout, child)).frontmatter.parent).toBeUndefined();
    });
  });

  describe("re-open guard (done|dropped resurrection needs --reopen)", () => {
    test("refuses re-opening a done item without --reopen", async () => {
      const { root, layout, env } = await setup();
      const id = await newItem(env, root);
      await itemCommand.run(["update", id, "--status", "done"], env, root);

      const code = await itemCommand.run(["update", id, "--status", "in-progress"], env, root);
      expect(code).toBe(1);
      expect(stderr()).toContain("--reopen");
      expect(stderr()).toContain(id);
      expect((await readItem(layout, id)).frontmatter.status).toBe("done");
    });

    test("refuses re-opening a dropped item without --reopen", async () => {
      const { root, layout, env } = await setup();
      const id = await newItem(env, root);
      await itemCommand.run(["update", id, "--status", "dropped"], env, root);

      const code = await itemCommand.run(["update", id, "--status", "backlog"], env, root);
      expect(code).toBe(1);
      expect(stderr()).toContain("--reopen");
      expect((await readItem(layout, id)).frontmatter.status).toBe("dropped");
    });

    test("--reopen explicitly resurrects a done item", async () => {
      const { root, layout, env } = await setup();
      const id = await newItem(env, root);
      await itemCommand.run(["update", id, "--status", "done"], env, root);

      const code = await itemCommand.run(
        ["update", id, "--status", "in-progress", "--reopen"],
        env,
        root,
      );
      expect(stderr()).toBe("");
      expect(code).toBe(0);
      expect((await readItem(layout, id)).frontmatter.status).toBe("in-progress");
    });

    test("done → dropped is not a re-opening and needs no flag", async () => {
      const { root, layout, env } = await setup();
      const id = await newItem(env, root);
      await itemCommand.run(["update", id, "--status", "done"], env, root);

      const code = await itemCommand.run(["update", id, "--status", "dropped"], env, root);
      expect(code).toBe(0);
      expect((await readItem(layout, id)).frontmatter.status).toBe("dropped");
    });

    test("non-status fields of a closed item stay editable without --reopen", async () => {
      const { root, layout, env } = await setup();
      const id = await newItem(env, root);
      await itemCommand.run(["update", id, "--status", "done"], env, root);

      const code = await itemCommand.run(["update", id, "--lane", "full"], env, root);
      expect(code).toBe(0);
      const { frontmatter } = await readItem(layout, id);
      expect(frontmatter.lane).toBe("full");
      expect(frontmatter.status).toBe("done");
    });
  });

  describe("claim enforcement surfaced at the CLI", () => {
    test("an agent actor is refused on a claimed item with a clear error; nothing is written", async () => {
      const { root, layout, env } = await setup(); // config actor: agent claude-code
      const id = await newItem(env, root);
      const record = await readItem(layout, id);
      await writeItem(layout, { ...record.frontmatter, claimed_by: "jim" }, record.body);

      const code = await itemCommand.run(["update", id, "--status", "in-progress"], env, root);
      expect(code).toBe(1);
      expect(stderr()).toContain(id);
      expect(stderr()).toContain("jim");
      expect(stderr()).toContain("handback");

      const after = await readItem(layout, id);
      expect(after.frontmatter.status).toBe("backlog");
      expect(after.frontmatter.claimed_by).toBe("jim");
      // Refusal journals nothing: item.created + its close marker only.
      expect(await journalEvents(layout)).toHaveLength(2);
    });

    test("creating an item under a claimed parent is refused for agents", async () => {
      const { root, layout, env } = await setup();
      const parent = await newItem(env, root);
      const record = await readItem(layout, parent);
      await writeItem(layout, { ...record.frontmatter, claimed_by: "jim" }, record.body);

      const code = await itemCommand.run(
        ["new", "feature", "under-claim", "direct", "--parent", parent],
        env,
        root,
      );
      expect(code).toBe(1);
      expect(stderr()).toContain("jim");
      expect(await journalEvents(layout)).toHaveLength(2); // item.created + close marker
    });

    test("moving an unclaimed item under a claimed parent via --parent is refused for agents", async () => {
      const { root, layout, env } = await setup(); // config actor: agent claude-code
      const parent = await newItem(env, root);
      const record = await readItem(layout, parent);
      await writeItem(layout, { ...record.frontmatter, claimed_by: "jim" }, record.body);
      const id = await newItem(env, root); // unclaimed, outside the claimed subtree

      const code = await itemCommand.run(["update", id, "--parent", parent], env, root);
      expect(code).toBe(1);
      expect(stderr()).toContain(parent);
      expect(stderr()).toContain("jim");
      expect(stderr()).toContain("handback");

      // Refusal writes nothing: parent unchanged, no journal event beyond the
      // two item.created events and their invocations' close markers.
      expect((await readItem(layout, id)).frontmatter.parent).toBeUndefined();
      expect(await journalEvents(layout)).toHaveLength(4);
    });

    test("a human config actor passes the claim check", async () => {
      const { root, layout, env } = await setup({ actor: { kind: "human", id: "jim" } });
      const id = await newItem(env, root);
      const record = await readItem(layout, id);
      await writeItem(layout, { ...record.frontmatter, claimed_by: "jim" }, record.body);

      const code = await itemCommand.run(["update", id, "--status", "in-progress"], env, root);
      expect(stderr()).toBe("");
      expect(code).toBe(0);
      const after = await readItem(layout, id);
      expect(after.frontmatter.status).toBe("in-progress");
      expect(after.frontmatter.claimed_by).toBe("jim"); // claim preserved by update
    });

    test("an explicit actorOverride wins over the config actor", async () => {
      // The NAHEL_ACTOR environment variable itself is read only by the
      // cli.ts entry point (see tests/cli.test.ts for the end-to-end env
      // contract); at the command layer the override arrives as an argument.
      const { root, layout, env } = await setup(); // config actor: agent
      const id = await newItem(env, root);
      const record = await readItem(layout, id);
      await writeItem(layout, { ...record.frontmatter, claimed_by: "jim" }, record.body);

      const code = await itemCommand.run(
        ["update", id, "--status", "in-progress"],
        env,
        root,
        "human:jim",
      );
      expect(stderr()).toBe("");
      expect(code).toBe(0);

      const events = await journalEvents(layout);
      expect(events[events.length - 1]!.actor).toEqual({ kind: "human", id: "jim" });
    });
  });
});

describe("item — dispatch and help", () => {
  test("--help documents both verbs including the --reopen guard, exit 0", async () => {
    const { root, env } = await setup();
    const code = await itemCommand.run(["--help"], env, root);
    expect(code).toBe(0);
    const help = logs.join("\n");
    expect(help).toContain("item new");
    expect(help).toContain("item update");
    expect(help).toContain("--reopen");
    expect(help).toContain("done");
    expect(help).toContain("dropped");
  });

  test("no subcommand is a usage error", async () => {
    const { root, env } = await setup();
    expect(await itemCommand.run([], env, root)).toBe(1);
    expect(stderr().length).toBeGreaterThan(0);
  });

  test("an unknown subcommand is named in the error", async () => {
    const { root, env } = await setup();
    expect(await itemCommand.run(["delete", "zzzzzzzz"], env, root)).toBe(1);
    expect(stderr()).toContain("delete");
  });

  test("verifies the item record exists on disk exactly where layout says (sanity)", async () => {
    const { root, layout, env } = await setup();
    const id = await newItem(env, root);
    expect(await itemExists(layout, id)).toBe(true);
  });
});

describe("item — ids validated before any path join (PR #12 review blocker 2)", () => {
  // Verified escape: `nahel item update ../../PRODUCT --status x` reached the
  // repo-root PRODUCT.md through the unvalidated itemPath join.
  test("item update with a traversal id refuses and touches nothing outside nahel/items", async () => {
    const { root, layout, env } = await setup();
    const canary = "# canary constitution — must never be read as an item\n";
    await writeFile(join(root, "PRODUCT.md"), canary);

    const code = await itemCommand.run(
      ["update", "../../PRODUCT", "--status", "in-progress"],
      env,
      root,
    );
    expect(code).toBe(1);
    expect(stderr()).toContain("invalid item id");
    // The canary is untouched and nothing was journaled.
    expect(await readFile(join(root, "PRODUCT.md"), "utf8")).toBe(canary);
    expect(await journalEvents(layout)).toEqual([]);
    expect(await listItems(layout)).toEqual([]);
  });

  test("item update with an absolute-ish id refuses with an invalid-id error", async () => {
    const { root, layout, env } = await setup();
    const code = await itemCommand.run(["update", "/tmp/evil", "--status", "done"], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain("invalid item id");
    expect(await journalEvents(layout)).toEqual([]);
  });

  test("item new with a traversal --parent refuses with an invalid-id error", async () => {
    const { root, layout, env } = await setup();
    await writeFile(join(root, "PRODUCT.md"), "# canary\n");

    const code = await itemCommand.run(
      ["new", "feature", "sneaky", "direct", "--parent", "../../PRODUCT"],
      env,
      root,
    );
    expect(code).toBe(1);
    expect(stderr()).toContain("invalid item id");
    expect(await listItems(layout)).toEqual([]);
    expect(await journalEvents(layout)).toEqual([]);
  });

  test("item new with a traversal --depends-on refuses with an invalid-id error", async () => {
    const { root, layout, env } = await setup();
    const code = await itemCommand.run(
      ["new", "feature", "sneaky", "direct", "--depends-on", "../../PRODUCT"],
      env,
      root,
    );
    expect(code).toBe(1);
    expect(stderr()).toContain("invalid item id");
    expect(await listItems(layout)).toEqual([]);
  });
});

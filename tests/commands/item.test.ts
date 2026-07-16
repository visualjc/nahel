import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { itemCommand } from "../../src/commands/item";
import type { Env } from "../../src/schema/env";
import { ID_PATTERN } from "../../src/schema/id";
import type { Config, JournalEvent } from "../../src/schema/records";
import { readJournal } from "../../src/store/journal";
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

    const events = await journalEvents(layout);
    expect(events).toHaveLength(1);
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

    const events = await journalEvents(layout);
    expect(events).toHaveLength(2);
    const updated = events[1]!;
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
    expect(await journalEvents(layout)).toHaveLength(1); // only item.created
  });

  test("rejects unknown flags by name (field typos never become silent state)", async () => {
    const { root, layout, env } = await setup();
    const id = await newItem(env, root);
    const code = await itemCommand.run(["update", id, "--priority", "high"], env, root);
    expect(code).toBe(1);
    expect(stderr()).toContain("--priority");
    expect(await journalEvents(layout)).toHaveLength(1);
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
      expect(await journalEvents(layout)).toHaveLength(1); // refusal journals nothing
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
      expect(await journalEvents(layout)).toHaveLength(1);
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
      // two item.created events.
      expect((await readItem(layout, id)).frontmatter.parent).toBeUndefined();
      expect(await journalEvents(layout)).toHaveLength(2);
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

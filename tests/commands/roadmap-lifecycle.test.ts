import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { itemCommand } from "../../src/commands/item";
import { logCommand } from "../../src/commands/log";
import { roadmapCommand } from "../../src/commands/roadmap";
import type { Env } from "../../src/schema/env";
import {
  DEPLOY_COMPLETED_EVENT_TYPE,
  DEPLOY_ENVIRONMENT_PAYLOAD_KEY,
  QA_SWEEP_EVENT_TYPE,
  RELEASE_ANNOUNCED_EVENT_TYPE,
  RELEASE_VERSION_PAYLOAD_KEY,
} from "../../src/schema/events";
import { ID_PATTERN } from "../../src/schema/id";
import type { JournalEvent } from "../../src/schema/records";
import { readJournal } from "../../src/store/journal";
import { ensureLayout, writeConfig, type StoreLayout } from "../../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * The lifecycle tail (Phase 4 F9): `deploy.completed` and `release.announced`
 * recorded through `nahel log` like the QA types, and the single-word STAGE
 * they roll into by precedence.
 *
 * Every case here drives the REAL path — the log command writes the event into
 * a real store, and the roadmap command reads it back — because F2's stage
 * tests feed featureStatus hand-built events, and a store whose logged events
 * never reached the view would pass those and render `unknown` for a released
 * feature. What is under test is the whole path: log → journal → derivation →
 * rendered line.
 */

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

async function setup() {
  const root = await makeTempDir("nahel-roadmap-lifecycle-");
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig());
  const env = seededEnv({ tickSeconds: 1 });
  return { root, layout, env };
}

/** Run the roadmap command, expect success, and return everything it printed. */
async function view(env: Env, root: string, args: string[] = []): Promise<string> {
  const before = logs.length;
  const code = await roadmapCommand.run(args, env, root);
  expect(stderr()).toBe("");
  expect(code).toBe(0);
  return logs.slice(before).join("\n");
}

async function newNode(env: Env, root: string, args: string[]): Promise<string> {
  const before = logs.length;
  expect(await roadmapCommand.run(["node", "new", ...args], env, root)).toBe(0);
  const id = logs[before];
  expect(id).toMatch(ID_PATTERN);
  return id!;
}

async function newItem(env: Env, root: string, args: string[]): Promise<string> {
  const before = logs.length;
  expect(await itemCommand.run(["new", ...args], env, root)).toBe(0);
  const id = logs[before];
  expect(id).toMatch(ID_PATTERN);
  return id!;
}

/** Record an open-extension event; `log` warns about the type, which is expected. */
async function log(env: Env, root: string, args: string[]): Promise<void> {
  expect(
    await logCommand.run(args, {
      env,
      cwd: root,
      stdout: (text: string) => logs.push(text),
      stderr: (text: string) => errs.push(text),
    }),
  ).toBe(0);
  errs = [];
}

/** Run `nahel log` expecting a refusal, and return what it said. */
async function logRefused(env: Env, root: string, args: string[]): Promise<string> {
  const before = errs.length;
  expect(
    await logCommand.run(args, {
      env,
      cwd: root,
      stdout: (text: string) => logs.push(text),
      stderr: (text: string) => errs.push(text),
    }),
  ).toBe(1);
  const said = errs.slice(before).join("\n");
  errs = [];
  return said;
}

async function journalEvents(layout: StoreLayout): Promise<JournalEvent[]> {
  return Array.fromAsync(readJournal(layout));
}

/** The ts of the one event of this type in the store — the value the columns print. */
async function tsOf(layout: StoreLayout, type: string): Promise<string> {
  const matches = (await journalEvents(layout)).filter((event) => event.type === type);
  expect(matches).toHaveLength(1);
  return matches[0]!.ts;
}

/**
 * A product with one feature whose epic holds one done leaf: dev `built`, so
 * every stage above it is reached by logging events and nothing else.
 */
async function feature(env: Env, root: string) {
  await newNode(env, root, [
    "product",
    "nahel",
    "--horizon",
    "now",
    "--intent",
    "Durable, tool-agnostic project state.",
    "--design-doc",
    "docs/roadmap.md",
  ]);
  const epic = await newItem(env, root, ["plan", "lifecycle-epic", "full"]);
  const leaf = await newItem(env, root, ["feature", "leaf-work", "direct", "--parent", epic]);
  expect(await itemCommand.run(["update", leaf, "--status", "done"], env, root)).toBe(0);
  const node = await newNode(env, root, [
    "feature",
    "detached-state-repo",
    "--horizon",
    "now",
    "--intent",
    "Get state out of the repo.",
    "--parent",
    "nahel",
    "--epic",
    epic,
  ]);
  return { epic, leaf, node };
}

/**
 * The deploy invocation the glossary defines, one payload key per PRD field.
 * The two keys the columns RENDER come from the constants the renderer reads,
 * so a test store can never be filled through a key the view does not look at.
 */
function deployArgs(item: string): string[] {
  return [
    DEPLOY_COMPLETED_EVENT_TYPE,
    "--item",
    item,
    "--data",
    `${DEPLOY_ENVIRONMENT_PAYLOAD_KEY}=production`,
    "--data",
    "ref=3ba7a70",
    "--data",
    "shipped=the detached state repo",
  ];
}

/** The release invocation the glossary defines. */
function releaseArgs(item: string): string[] {
  return [
    RELEASE_ANNOUNCED_EVENT_TYPE,
    "--item",
    item,
    "--data",
    `${RELEASE_VERSION_PAYLOAD_KEY}=0.3.0`,
    "--data",
    "channel=github",
    "--data",
    "announcement=https://github.com/visualjc/nahel/releases/tag/v0.3.0",
  ];
}

describe("the two lifecycle types are recordable through `nahel log` (F9)", () => {
  test("a deploy lands in the journal with its payload verbatim and its item attribution", async () => {
    const { root, layout, env } = await setup();
    const { epic } = await feature(env, root);

    await log(env, root, deployArgs(epic));

    const [event] = (await journalEvents(layout)).filter(
      (each) => each.type === DEPLOY_COMPLETED_EVENT_TYPE,
    );
    expect(event).toBeDefined();
    expect(event!.item).toBe(epic);
    expect(event!.payload).toEqual({
      environment: "production",
      ref: "3ba7a70",
      shipped: "the detached state repo",
    });
  });

  test("a release lands the same way — version, channel, and the announcement pointer", async () => {
    const { root, layout, env } = await setup();
    const { epic } = await feature(env, root);

    await log(env, root, releaseArgs(epic));

    const [event] = (await journalEvents(layout)).filter(
      (each) => each.type === RELEASE_ANNOUNCED_EVENT_TYPE,
    );
    expect(event).toBeDefined();
    expect(event!.item).toBe(epic);
    expect(event!.payload).toEqual({
      version: "0.3.0",
      channel: "github",
      announcement: "https://github.com/visualjc/nahel/releases/tag/v0.3.0",
    });
  });

  test("neither type is CLI-self-recorded: `log` accepts both, refusing only the reserved acts", async () => {
    const { root, env } = await setup();
    const { epic } = await feature(env, root);

    await log(env, root, deployArgs(epic));
    await log(env, root, releaseArgs(epic));
    // The contrast: a self-recorded type IS refused, and says who records it.
    expect(await logRefused(env, root, ["roadmap.node-created", "--item", epic])).toContain(
      "is reserved",
    );
  });

  test("neither may carry a mutation payload key — a lifecycle event can never masquerade as one", async () => {
    const { root, layout, env } = await setup();
    const { epic } = await feature(env, root);

    for (const type of [DEPLOY_COMPLETED_EVENT_TYPE, RELEASE_ANNOUNCED_EVENT_TYPE]) {
      const said = await logRefused(env, root, [
        type,
        "--item",
        epic,
        "--data",
        'record={"id":"0e0fh3em"}',
      ]);
      expect(said).toContain("reserved for mutation payloads");
    }
    // Nothing was written: the refusal happens before the append.
    const events = await journalEvents(layout);
    expect(events.filter((each) => each.type === DEPLOY_COMPLETED_EVENT_TYPE)).toHaveLength(0);
    expect(events.filter((each) => each.type === RELEASE_ANNOUNCED_EVENT_TYPE)).toHaveLength(0);
  });
});

describe("the stage walked through the REAL logging path (F9's precedence table)", () => {
  test("release + deploy + sweep + built epic → released, with every column filled", async () => {
    const { root, layout, env } = await setup();
    const { epic, node } = await feature(env, root);

    await log(env, root, [QA_SWEEP_EVENT_TYPE, "--item", epic, "--data", "failed=0"]);
    await log(env, root, deployArgs(epic));
    await log(env, root, releaseArgs(epic));

    const out = await view(env, root, ["detached-state-repo"]);
    expect(out).toContain(
      `status: released  dev=built  qa=tested ${await tsOf(layout, QA_SWEEP_EVENT_TYPE)}  ` +
        `deploy=deployed production ${await tsOf(layout, DEPLOY_COMPLETED_EVENT_TYPE)}  ` +
        `release=released 0.3.0 ${await tsOf(layout, RELEASE_ANNOUNCED_EVENT_TYPE)}`,
    );
    expect(out).toContain(`id=${node}`);
  });

  test("no release → deployed: the same store minus the release event", async () => {
    const { root, env } = await setup();
    const { epic } = await feature(env, root);

    await log(env, root, [QA_SWEEP_EVENT_TYPE, "--item", epic, "--data", "failed=0"]);
    await log(env, root, deployArgs(epic));

    expect(await view(env, root, ["detached-state-repo"])).toContain("status: deployed  dev=built");
  });

  test("no release or deploy → tested", async () => {
    const { root, env } = await setup();
    const { epic } = await feature(env, root);

    await log(env, root, [QA_SWEEP_EVENT_TYPE, "--item", epic, "--data", "failed=0"]);

    expect(await view(env, root, ["detached-state-repo"])).toContain("status: tested  dev=built");
  });

  test("no covering events at all → the dev rollup itself: built", async () => {
    const { root, env } = await setup();
    await feature(env, root);

    expect(await view(env, root, ["detached-state-repo"])).toContain(
      "status: built  dev=built  qa=—  deploy=—  release=—",
    );
  });

  test("no covering events, unfinished work → in-flight", async () => {
    const { root, env } = await setup();
    const { epic } = await feature(env, root);
    await newItem(env, root, ["feature", "more-work", "direct", "--parent", epic]);

    expect(await view(env, root, ["detached-state-repo"])).toContain("status: in-flight");
  });

  test("no covering events, no epic recorded → planned", async () => {
    const { root, env } = await setup();
    await feature(env, root);
    await newNode(env, root, [
      "feature",
      "architecture-docs-wiki",
      "--horizon",
      "now",
      "--intent",
      "Publish the architecture docs.",
      "--parent",
      "nahel",
    ]);

    expect(await view(env, root, ["architecture-docs-wiki"])).toContain(
      "status: planned  dev=planned",
    );
  });

  test("no covering events, an epic id naming no item → unknown", async () => {
    const { root, env } = await setup();
    await feature(env, root);
    await newNode(env, root, [
      "feature",
      "roadmap-mindmap-visualization",
      "--horizon",
      "later",
      "--intent",
      "Draw the tree.",
      "--parent",
      "nahel",
      "--epic",
      "zzzzzzzz",
    ]);

    expect(await view(env, root, ["roadmap-mindmap-visualization"])).toContain(
      "status: unknown  dev=unknown",
    );
  });

  test("a deploy recorded AFTER a release leaves the stage at released — precedence, not recency", async () => {
    const { root, layout, env } = await setup();
    const { epic } = await feature(env, root);

    await log(env, root, releaseArgs(epic));
    await log(env, root, deployArgs(epic));

    // The deploy really is the later event in the store's total order.
    const deployTs = await tsOf(layout, DEPLOY_COMPLETED_EVENT_TYPE);
    const releaseTs = await tsOf(layout, RELEASE_ANNOUNCED_EVENT_TYPE);
    expect(deployTs > releaseTs).toBe(true);

    const out = await view(env, root, ["detached-state-repo"]);
    expect(out).toContain("status: released");
    // Both facts are still shown — precedence collapses the WORD, not the columns.
    expect(out).toContain(`deploy=deployed production ${deployTs}`);
    expect(out).toContain(`release=released 0.3.0 ${releaseTs}`);
  });

  test("an event attributed to a leaf UNDER the epic covers the feature too", async () => {
    const { root, env } = await setup();
    const { leaf } = await feature(env, root);

    await log(env, root, releaseArgs(leaf));

    expect(await view(env, root, ["detached-state-repo"])).toContain("status: released");
  });

  test("an event attributed outside the epic's subtree covers nothing", async () => {
    const { root, env } = await setup();
    await feature(env, root);
    const stray = await newItem(env, root, ["chore", "unrelated-work", "direct"]);

    await log(env, root, releaseArgs(stray));

    expect(await view(env, root, ["detached-state-repo"])).toContain("status: built");
  });

  test("the stage also renders on the product level's feature line", async () => {
    const { root, env } = await setup();
    const { epic, node } = await feature(env, root);

    await log(env, root, deployArgs(epic));

    expect(await view(env, root)).toContain(`detached-state-repo  deployed  dev=built`);
    expect(await view(env, root)).toContain(`id=${node}`);
  });

  test("nothing about the stage is written: the node record carries no stage field", async () => {
    const { root, layout, env } = await setup();
    const { epic, node } = await feature(env, root);
    await log(env, root, releaseArgs(epic));

    const text = await Bun.file(`${layout.roadmapDir}/${node}.md`).text();
    expect(text).not.toContain("stage");
    expect(text).not.toContain("released");
  });
});

/**
 * Both types are DOCUMENTED VOCABULARY (F9's first acceptance criterion), and
 * the glossary is where this project's vocabulary lives — the same place F1's
 * roadmap node and F7's decision ticket were defined. A type nobody documented
 * is a type a workflow author has to reverse-engineer from a renderer, and the
 * payload keys the columns read are exactly the keys that would be guessed
 * wrong. The two rendered keys are asserted through the CONSTANTS the renderer
 * reads, so renaming one in code fails the glossary that still teaches the old
 * spelling.
 */
describe("the vocabulary the two types are recorded under (F9)", () => {
  /** One glossary entry, by its bolded term — the line is the definition. */
  async function entry(term: string): Promise<string> {
    const glossary = await Bun.file(join(import.meta.dir, "../../CONTEXT.md")).text();
    const line = glossary.split("\n").find((each) => each.startsWith(`- **${term}** —`));
    expect(line).toBeDefined();
    return line!;
  }

  test("the glossary defines both types with the payload keys their columns render", async () => {
    const defined = await entry("Lifecycle event");
    for (const type of [DEPLOY_COMPLETED_EVENT_TYPE, RELEASE_ANNOUNCED_EVENT_TYPE]) {
      expect(defined).toContain(`\`${type}\``);
    }
    expect(defined).toContain(`\`${DEPLOY_ENVIRONMENT_PAYLOAD_KEY}\``);
    expect(defined).toContain(`\`${RELEASE_VERSION_PAYLOAD_KEY}\``);
    // The rest of each PRD-named field, so the whole shape is written down.
    for (const key of ["ref", "shipped", "channel", "announcement"]) {
      expect(defined).toContain(`\`${key}\``);
    }
  });

  test("the glossary states how they are recorded: through `nahel log`, never self-recorded", async () => {
    const defined = await entry("Lifecycle event");
    expect(defined).toContain("nahel log");
    expect(defined).toContain("--item");
    expect(defined).toContain("self-record");
    expect(defined).toContain("mutation payload key");
  });

  test("the glossary defines the stage as precedence over recency, in the table's order", async () => {
    const defined = await entry("Stage");
    const order = [
      RELEASE_ANNOUNCED_EVENT_TYPE,
      DEPLOY_COMPLETED_EVENT_TYPE,
      QA_SWEEP_EVENT_TYPE,
    ].map((type) => {
      const at = defined.indexOf(type);
      expect(at).toBeGreaterThan(-1);
      return at;
    });
    for (let i = 1; i < order.length; i += 1) expect(order[i]!).toBeGreaterThan(order[i - 1]!);
    // Every word the stage can be, and the two rules that make it stable.
    for (const stage of [
      "released",
      "deployed",
      "tested",
      "built",
      "in-flight",
      "planned",
      "unknown",
    ]) {
      expect(defined).toContain(`\`${stage}\``);
    }
    expect(defined).toContain("first match wins");
    expect(defined).toContain("not recency");
    expect(defined).toContain("no stage field");
  });
});

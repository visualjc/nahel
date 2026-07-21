import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import type { Env } from "../../src/schema/env";
import { generateId } from "../../src/schema/id";
import type { JournalEvent } from "../../src/schema/records";
import { knowledgePaths, readConfig, readItem, writeItem } from "../../src/store/layout";
import { GOAL_HEADING, HARD_CONSTRAINTS_HEADING } from "../../src/templates/product";
import {
  BRIEF_BUDGET_BYTES,
  composeBrief,
  extractSection,
  NO_WARNINGS,
  renderBrief,
  withoutDoneDetail,
  type BriefInputs,
} from "../../src/views/brief";
import { collectProgress, renderProgress } from "../../src/views/progress";
import { loadSnapshot } from "../../src/views/snapshot";
import { renderStatus } from "../../src/views/status";
import { makeFrontmatter, makeRun, seededEnv } from "../store/helpers";
import { buildPopulatedStore, type PopulatedStore } from "./helpers";

/**
 * `nahel brief` view (PRD F7, task #8): the deterministic onboarding pack.
 * Six required sections in FIXED order; goal + hard constraints extracted
 * VERBATIM from PRODUCT.md by the frozen heading convention; the status and
 * progress renderers COMPOSED, never re-implemented; a 4 KB target budget
 * with fixed-priority truncation (oldest activity → done-item detail →
 * constitution clip with pointer) where every truncation is visibly marked
 * and no required section is ever dropped.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

const GOAL_TEXT =
  "Nahel gives agentic development a durable, tool-agnostic project state substrate so any fresh agent can act correctly.";
const CONSTRAINTS_TEXT =
  "1. The CLI is deterministic: no LLM calls, no network, no ambient clock.\n2. Agents never hand-edit state files — every mutation has a CLI verb.";

/** A constitution with known goal/constraints text, built on the frozen headings. */
function productMarkdown(goal: string, constraints: string): string {
  return [
    "# Test Project — Product Constitution",
    "",
    GOAL_HEADING,
    "",
    goal,
    "",
    "## Domain facts",
    "",
    "- A domain fact that must never leak into the extracted sections.",
    "",
    HARD_CONSTRAINTS_HEADING,
    "",
    constraints,
    "",
    "## Non-goals",
    "",
    "- A non-goal that must never leak into the extracted sections.",
    "",
  ].join("\n");
}

/** Populated store (real commands) plus a PRODUCT.md with known sections. */
async function populatedWithProduct(): Promise<PopulatedStore> {
  const store = await buildPopulatedStore(tempDirs);
  const config = await readConfig(store.layout);
  await writeFile(
    (await knowledgePaths(store.layout, config)).product,
    productMarkdown(GOAL_TEXT, CONSTRAINTS_TEXT),
  );
  return store;
}

async function briefOf(store: PopulatedStore): Promise<string> {
  return composeBrief(store.layout, await readConfig(store.layout));
}

/** Pure-renderer inputs with an empty store and a small known constitution. */
function makeInputs(overrides: Partial<BriefInputs> = {}): BriefInputs {
  return {
    snapshot: { items: [], runs: [] },
    events: [],
    productText: productMarkdown(GOAL_TEXT, CONSTRAINTS_TEXT),
    productPath: "PRODUCT.md",
    contextPath: "CONTEXT.md",
    adrPath: "docs/adr",
    warnings: [],
    ...overrides,
  };
}

/** A synthetic journal event with a distinct, greppable payload. */
function makeEvent(env: Env, i: number): JournalEvent {
  return {
    id: generateId(env),
    ts: `2026-07-16T12:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
    seq: i,
    type: "note",
    actor: { kind: "agent", id: "claude-code" },
    payload: { text: `synthetic-event-${i} with enough padding to cost real bytes` },
  };
}

const SECTION_HEADERS = [
  "== constitution (PRODUCT.md) ==",
  "== knowledge & canonical truth ==",
  "== item statuses ==",
  "== recent activity (newest last) ==",
  "== pending human decisions ==",
  "== validate warnings ==",
] as const;

describe("extractSection — verbatim heading slicing", () => {
  test("returns the section body verbatim, stopping at the next heading", () => {
    const text = productMarkdown(GOAL_TEXT, CONSTRAINTS_TEXT);
    expect(extractSection(text, GOAL_HEADING)).toBe(GOAL_TEXT);
    expect(extractSection(text, HARD_CONSTRAINTS_HEADING)).toBe(CONSTRAINTS_TEXT);
  });

  test("multi-line markdown content is preserved exactly, never summarized", () => {
    const body = "First paragraph.\n\n- bullet **bold**\n- `code`\n\n> quote line";
    const text = `# Title\n\n${GOAL_HEADING}\n\n${body}\n\n## Next section\n\nother`;
    expect(extractSection(text, GOAL_HEADING)).toBe(body);
  });

  test("a section running to end-of-file is captured whole", () => {
    const text = `${HARD_CONSTRAINTS_HEADING}\n\n1. only constraint`;
    expect(extractSection(text, HARD_CONSTRAINTS_HEADING)).toBe("1. only constraint");
  });

  test("returns null when the heading is absent (prefix matches do not count)", () => {
    expect(extractSection("## Goals\n\nnot the frozen heading", GOAL_HEADING)).toBeNull();
    expect(extractSection("body with ## Goal inline", GOAL_HEADING)).toBeNull();
  });
});

describe("withoutDoneDetail — done-item pruning for the truncation ladder", () => {
  test("drops done items but keeps done ancestors of live work", () => {
    const env = seededEnv();
    const doneParent = makeFrontmatter(env, { name: "done-parent", status: "done" });
    const liveChild = makeFrontmatter(env, {
      name: "live-child",
      status: "in-progress",
      parent: doneParent.id,
    });
    const doneLeaf = makeFrontmatter(env, { name: "done-leaf", status: "done" });
    const pruned = withoutDoneDetail([doneParent, liveChild, doneLeaf]);
    expect(pruned.items.map((item) => item.name)).toEqual(["done-parent", "live-child"]);
    expect(pruned.omitted).toBe(1);
  });

  test("a store with no done items prunes nothing", () => {
    const env = seededEnv();
    const items = [makeFrontmatter(env), makeFrontmatter(env, { status: "blocked" })];
    const pruned = withoutDoneDetail(items);
    expect(pruned.items).toEqual(items);
    expect(pruned.omitted).toBe(0);
  });
});

describe("renderBrief — required sections in fixed order", () => {
  test("all six section headers appear, in the PRD's fixed order", () => {
    const brief = renderBrief(makeInputs());
    let previous = -1;
    for (const header of SECTION_HEADERS) {
      const at = brief.indexOf(header);
      expect(at).toBeGreaterThan(previous);
      previous = at;
    }
  });

  test("even under maximal truncation pressure, no required section is dropped", () => {
    const brief = renderBrief(
      makeInputs({ productText: productMarkdown("g".repeat(8000), CONSTRAINTS_TEXT) }),
    );
    for (const header of SECTION_HEADERS) expect(brief).toContain(header);
  });
});

describe("renderBrief — verbatim constitution extraction", () => {
  test("goal and hard constraints appear verbatim under their frozen headings", () => {
    const brief = renderBrief(makeInputs());
    expect(brief).toContain(`${GOAL_HEADING}\n\n${GOAL_TEXT}`);
    expect(brief).toContain(`${HARD_CONSTRAINTS_HEADING}\n\n${CONSTRAINTS_TEXT}`);
    // Neighboring sections never leak into the extract.
    expect(brief).not.toContain("domain fact");
    expect(brief).not.toContain("non-goal");
  });

  test("missing PRODUCT.md is a stated finding, not an error — the brief still renders", () => {
    const brief = renderBrief(makeInputs({ productText: null }));
    expect(brief).toContain("finding:");
    expect(brief).toContain("PRODUCT.md");
    expect(brief).toContain("missing");
    for (const header of SECTION_HEADERS) expect(brief).toContain(header);
  });

  test("a missing conventional heading is a per-heading finding; the other section still extracts", () => {
    const noGoal = `# T\n\n${HARD_CONSTRAINTS_HEADING}\n\n${CONSTRAINTS_TEXT}\n`;
    const brief = renderBrief(makeInputs({ productText: noGoal }));
    expect(brief).toContain(`finding: PRODUCT.md has no "${GOAL_HEADING}" section`);
    expect(brief).toContain(`${HARD_CONSTRAINTS_HEADING}\n\n${CONSTRAINTS_TEXT}`);
  });
});

describe("renderBrief — knowledge pointers and canonical truth locations", () => {
  test("points at the configured knowledge paths and every nahel state layer", () => {
    const brief = renderBrief(
      makeInputs({ productPath: "docs/PRODUCT.md", contextPath: "docs/CONTEXT.md", adrPath: "docs/decisions" }),
    );
    expect(brief).toContain("docs/PRODUCT.md");
    expect(brief).toContain("docs/CONTEXT.md");
    expect(brief).toContain("docs/decisions");
    for (const layer of [
      "nahel/items/",
      "nahel/runs/",
      "nahel/journal/",
      "nahel/observations/",
      "nahel/config",
    ]) {
      expect(brief).toContain(layer);
    }
  });
});

describe("renderBrief — composes the status and progress renderers", () => {
  test("the item-statuses section is renderStatus output verbatim (no re-rendering)", async () => {
    const store = await populatedWithProduct();
    const snapshot = await loadSnapshot(store.layout);
    const brief = await briefOf(store);
    expect(brief).toContain(renderStatus(snapshot));
  });

  test("the recent-activity section is renderProgress output verbatim when under budget", () => {
    const env = seededEnv();
    const events = Array.from({ length: 5 }, (_, i) => makeEvent(env, i));
    const brief = renderBrief(makeInputs({ events }));
    expect(brief).toContain(renderProgress(events));
    expect(brief).not.toContain("older events truncated");
  });

  test("when activity is truncated, the surviving lines are still renderProgress verbatim over the newest events", async () => {
    const store = await populatedWithProduct();
    const events = await collectProgress(store.layout);
    const brief = await briefOf(store);
    const marker = brief.match(/\[… (\d+) older events truncated — full timeline: nahel progress\]/);
    expect(marker).not.toBeNull(); // this fixture sits just over budget by design
    const dropped = Number(marker![1]);
    expect(brief).toContain(renderProgress(events.slice(dropped)));
  });

  test("an empty store renders explicit empty markers through the composed renderers", () => {
    const brief = renderBrief(makeInputs());
    expect(brief).toContain("work items: none");
    expect(brief).toContain("no journal events");
  });
});

describe("renderBrief — pending human decisions", () => {
  test("claims, blocked items, and paused runs are each listed", () => {
    const env = seededEnv();
    const claimed = makeFrontmatter(env, { name: "claimed-item", claimed_by: "jim" });
    const blocked = makeFrontmatter(env, { name: "blocked-item", status: "blocked" });
    const pausedRun = makeRun(env, claimed.id, { status: "paused" });
    const brief = renderBrief(
      makeInputs({ snapshot: { items: [claimed, blocked], runs: [{ run: pausedRun, hotState: null }] } }),
    );
    const section = brief.split("== pending human decisions ==")[1]!;
    expect(section).toContain(`claim: claimed-item id=${claimed.id} claimed_by=jim`);
    expect(section).toContain(`blocked: blocked-item id=${blocked.id}`);
    expect(section).toContain(`paused run: ${pausedRun.id} item=${claimed.id}`);
  });

  test("with nothing pending the section says none explicitly", () => {
    const brief = renderBrief(makeInputs());
    expect(brief).toContain("== pending human decisions ==\nnone");
  });
});

describe("renderBrief — responsibility routing (PRD F3, ADR-0015)", () => {
  test("absent routing renders no routing block at all (zero noise)", () => {
    const brief = renderBrief(makeInputs());
    expect(brief).not.toContain("== responsibility routing ==");
  });

  test("a configured routing map is surfaced, each responsibility with its agent/model", () => {
    const brief = renderBrief(
      makeInputs({
        routing: {
          architecture: { agent: "codex", model: "gpt-5" },
          implementation: { model: "claude-opus-4" },
          review: { agent: "codex" },
          default: { agent: "claude-code", model: "claude-sonnet-4" },
        },
      }),
    );
    const section = brief.split("== responsibility routing ==")[1]!.split("\n\n")[0]!;
    expect(section).toContain("architecture: agent=codex model=gpt-5");
    expect(section).toContain("implementation: model=claude-opus-4");
    expect(section).toContain("review: agent=codex");
    expect(section).toContain("default: agent=claude-code model=claude-sonnet-4");
  });

  test("the routing block sits after knowledge and before item statuses", () => {
    const brief = renderBrief(makeInputs({ routing: { implementation: { agent: "codex" } } }));
    const knowledge = brief.indexOf("== knowledge & canonical truth ==");
    const routing = brief.indexOf("== responsibility routing ==");
    const statuses = brief.indexOf("== item statuses ==");
    expect(knowledge).toBeGreaterThanOrEqual(0);
    expect(routing).toBeGreaterThan(knowledge);
    expect(statuses).toBeGreaterThan(routing);
  });

  test("only configured responsibilities appear — an empty map stays silent", () => {
    const oneLine = renderBrief(makeInputs({ routing: { review: { model: "gpt-5" } } }));
    const section = oneLine.split("== responsibility routing ==")[1]!.split("\n\n")[0]!;
    expect(section).toContain("review: model=gpt-5");
    expect(section).not.toContain("architecture");
    expect(section).not.toContain("implementation");
    expect(section).not.toContain("default");
    // A present-but-empty routing object has nothing to route → no block.
    expect(renderBrief(makeInputs({ routing: {} }))).not.toContain(
      "== responsibility routing ==",
    );
  });

  test("composeBrief threads config.routing through to the rendered brief", async () => {
    const store = await populatedWithProduct();
    const config = await readConfig(store.layout);
    const brief = await composeBrief(store.layout, {
      ...config,
      routing: { implementation: { agent: "claude-code", model: "claude-opus-4" } },
    });
    expect(brief).toContain("== responsibility routing ==");
    expect(brief).toContain("implementation: agent=claude-code model=claude-opus-4");
  });
});

describe("renderBrief — validate warnings seam", () => {
  test("injected warnings render one per line; the default stub renders none", async () => {
    const withWarnings = renderBrief(
      makeInputs({ warnings: ["claim conflict on item x", "dangling parent ref y"] }),
    );
    expect(withWarnings).toContain(
      "== validate warnings ==\nclaim conflict on item x\ndangling parent ref y",
    );
    const stubbed = renderBrief(makeInputs({ warnings: await NO_WARNINGS(undefined as never) }));
    expect(stubbed).toContain("== validate warnings ==\nnone");
  });
});

describe("renderBrief — 4 KB budget and truncation priority", () => {
  test("exactly at budget: no truncation fires and the output is byte-exact", () => {
    const probe = renderBrief(makeInputs({ productText: productMarkdown("G", CONSTRAINTS_TEXT) }));
    const pad = BRIEF_BUDGET_BYTES - byteLength(probe);
    expect(pad).toBeGreaterThan(0); // the probe must sit under budget for this test to mean anything
    const exact = renderBrief(
      makeInputs({ productText: productMarkdown(`G${"y".repeat(pad)}`, CONSTRAINTS_TEXT) }),
    );
    expect(byteLength(exact)).toBe(BRIEF_BUDGET_BYTES);
    expect(exact).not.toContain("truncated");
    expect(exact).not.toContain("omitted");
  });

  test("one byte over budget with no droppable activity: the constitution is clipped, visibly, with a file pointer", () => {
    const probe = renderBrief(makeInputs({ productText: productMarkdown("G", CONSTRAINTS_TEXT) }));
    const pad = BRIEF_BUDGET_BYTES - byteLength(probe);
    const over = renderBrief(
      makeInputs({ productText: productMarkdown(`G${"y".repeat(pad + 1)}`, CONSTRAINTS_TEXT) }),
    );
    expect(byteLength(over)).toBeLessThanOrEqual(BRIEF_BUDGET_BYTES);
    expect(over).toContain("[… constitution truncated — read PRODUCT.md in full]");
  });

  test("over budget with activity present: oldest events drop first, marked, before anything else", () => {
    const env = seededEnv();
    const events = Array.from({ length: 60 }, (_, i) => makeEvent(env, i));
    const brief = renderBrief(makeInputs({ events }));
    expect(byteLength(brief)).toBeLessThanOrEqual(BRIEF_BUDGET_BYTES);
    expect(brief).toMatch(/\[… \d+ older events truncated — full timeline: nahel progress\]/);
    expect(brief).toContain("synthetic-event-59"); // newest survives
    expect(brief).not.toContain("synthetic-event-0 "); // oldest dropped
    expect(brief).not.toContain("constitution truncated");
    expect(brief).not.toContain("done items omitted");
  });

  test("after all activity is dropped, done-item detail goes next, marked, keeping live items", () => {
    const env = seededEnv();
    const done = Array.from({ length: 80 }, (_, i) =>
      makeFrontmatter(env, { name: `done-item-${i}`, status: "done" }),
    );
    const live = makeFrontmatter(env, { name: "live-item", status: "in-progress" });
    const brief = renderBrief(makeInputs({ snapshot: { items: [...done, live], runs: [] } }));
    expect(byteLength(brief)).toBeLessThanOrEqual(BRIEF_BUDGET_BYTES);
    expect(brief).toContain("[… 80 done items omitted — full tree: nahel status]");
    expect(brief).toContain("live-item");
    expect(brief).not.toContain("done-item-0");
    expect(brief).not.toContain("constitution truncated");
  });

  test("an oversized constitution alone is clipped last, marked, with every section intact", () => {
    const brief = renderBrief(
      makeInputs({ productText: productMarkdown("g".repeat(8000), CONSTRAINTS_TEXT) }),
    );
    expect(byteLength(brief)).toBeLessThanOrEqual(BRIEF_BUDGET_BYTES);
    expect(brief).toContain("[… constitution truncated — read PRODUCT.md in full]");
    for (const header of SECTION_HEADERS) expect(brief).toContain(header);
  });

  test("a busy real store's brief lands under budget with the activity truncation marked", async () => {
    const store = await populatedWithProduct();
    const { logCommand } = await import("../../src/commands/log");
    for (let i = 0; i < 80; i += 1) {
      const code = await logCommand.run(
        ["note", "--item", store.taskBetaId, "--data", `text=bulk-note-${i} padding padding padding`],
        { env: store.env, cwd: store.root, stdout: () => {}, stderr: () => {} },
      );
      expect(code).toBe(0);
    }
    const brief = await briefOf(store);
    expect(byteLength(brief)).toBeLessThanOrEqual(BRIEF_BUDGET_BYTES);
    expect(brief).toMatch(/\[… \d+ older events truncated — full timeline: nahel progress\]/);
    expect(brief).toContain("bulk-note-79"); // newest activity survives
  });
});

describe("renderBrief — determinism", () => {
  test("same state → byte-identical brief: repeated renders and identically-seeded stores agree", async () => {
    const a = await populatedWithProduct();
    const briefA1 = await briefOf(a);
    const briefA2 = await briefOf(a);
    expect(briefA1).toBe(briefA2);

    const b = await buildPopulatedStore(tempDirs); // same default seed as `a`
    const configB = await readConfig(b.layout);
    await writeFile(
      (await knowledgePaths(b.layout, configB)).product,
      productMarkdown(GOAL_TEXT, CONSTRAINTS_TEXT),
    );
    expect(await briefOf(b)).toBe(briefA1);
  });
});

describe("brief — PRD success-criterion-1 rubric coverage", () => {
  test("a populated repo's brief answers all five rubric points", async () => {
    const store = await populatedWithProduct();
    // Rubric (d) needs a pending decision beyond the fixture's claim: block solo-chore.
    const solo = await readItem(store.layout, store.soloChoreId);
    await writeItem(store.layout, { ...solo.frontmatter, status: "blocked" }, solo.body);

    const brief = await briefOf(store);

    // (a) project goal — verbatim.
    expect(brief).toContain(GOAL_TEXT);
    // (b) hard constraints — verbatim.
    expect(brief).toContain(CONSTRAINTS_TEXT);
    // (c) what is in progress — the in-progress item and its active run's phase.
    expect(brief).toContain("task-beta");
    expect(brief).toContain("in-progress");
    expect(brief).toContain("phase=building");
    // (d) correct next action — pending decisions: the claim and the blocked item.
    expect(brief).toContain("claimed_by=jim");
    expect(brief).toContain(`blocked: solo-chore id=${store.soloChoreId}`);
    // (e) where canonical truth lives per state layer.
    for (const location of [
      "PRODUCT.md",
      "CONTEXT.md",
      "docs/adr",
      "nahel/items/",
      "nahel/runs/",
      "nahel/journal/",
      "nahel/observations/",
      "nahel/config",
    ]) {
      expect(brief).toContain(location);
    }
  });
});

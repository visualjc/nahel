import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { itemCommand } from "../../src/commands/item";
import { prototypeCommand } from "../../src/commands/prototype";
import type { Env } from "../../src/schema/env";
import {
  PROTOTYPE_DISPOSED_EVENT_TYPE,
  PROTOTYPE_MERGE_REFUSED_EVENT_TYPE,
  PROTOTYPE_PROMOTED_EVENT_TYPE,
  PROTOTYPE_PROMOTION_REFUSED_EVENT_TYPE,
  PROTOTYPE_VARIANTS_CREATED_EVENT_TYPE,
} from "../../src/schema/events";
import type { Config, JournalEvent, WorkItemFrontmatter } from "../../src/schema/records";
import { readJournal } from "../../src/store/journal";
import {
  ensureLayout,
  listItems,
  readItem,
  writeConfig,
  writeItem,
  type StoreLayout,
} from "../../src/store/layout";
import { validateStore } from "../../src/validate";
import { makeConfig, makeFrontmatter, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel prototype` (PRD F5): the prototype lane's deterministic half —
 * variant worktrees with seeded mini-PRDs (F5.1), never-merge enforced by
 * mechanism rather than prose (F5.2), the promotion path onto the plan lane
 * (F5.3) and its tier ratchet refusal (F5.4). Real temp git repos: worktrees
 * are the deliverable, so nothing here is simulated.
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
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function stdout(): string {
  return logs.join("\n");
}
function stderr(): string {
  return errs.join("\n");
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

interface Lab {
  root: string;
  layout: StoreLayout;
  env: Env;
  /** The prototype work item variants are spawned from. */
  item: WorkItemFrontmatter;
  /** Temp directory the tests park variant worktrees in. */
  worktreeDir: string;
}

/** A temp git repo + initialized store + one `prototype` work item. */
async function setup(
  options: { config?: Partial<Config>; item?: Partial<WorkItemFrontmatter> } = {},
): Promise<Lab> {
  const root = await makeTempDir("nahel-cmd-proto-");
  dirs.push(root);
  const worktreeDir = await makeTempDir("nahel-cmd-proto-wt-");
  dirs.push(worktreeDir);

  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig(options.config ?? {}));
  const env = seededEnv({ tickSeconds: 1 });
  const item = makeFrontmatter(env, {
    name: "speed-count",
    type: "prototype",
    lane: "direct",
    ...options.item,
  });
  await writeItem(layout, item, "");

  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "test@nahel.test");
  git(root, "config", "user.name", "Nahel Prototype Test");
  git(root, "add", "-A");
  git(root, "commit", "-m", "founding: nahel scaffold + prototype item");
  return { root, layout, env, item, worktreeDir };
}

async function run(lab: Lab, ...argv: string[]): Promise<number> {
  return prototypeCommand.run(argv, lab.env, lab.root);
}

async function runItem(lab: Lab, ...argv: string[]): Promise<number> {
  return itemCommand.run(argv, lab.env, lab.root);
}

async function journalEvents(layout: StoreLayout): Promise<JournalEvent[]> {
  const events: JournalEvent[] = [];
  for await (const event of readJournal(layout)) events.push(event);
  return events;
}

function eventsOfType(events: JournalEvent[], type: string): JournalEvent[] {
  return events.filter((event) => event.type === type);
}

/** Every item record on disk except the seed prototype item. */
async function spawnedItems(lab: Lab): Promise<WorkItemFrontmatter[]> {
  const ids = (await listItems(lab.layout)).filter((id) => id !== lab.item.id).sort();
  const items = [];
  for (const id of ids) items.push((await readItem(lab.layout, id)).frontmatter);
  return items;
}

describe("nahel prototype start --variants N (F5.1)", () => {
  test("two variants yield two worktrees, two mini-PRDs, two items — and zero ceremony", async () => {
    const lab = await setup();
    const head = git(lab.root, "rev-parse", "HEAD").trim();

    const code = await run(
      lab,
      "start",
      lab.item.id,
      "--variants",
      "2",
      "--worktree-dir",
      lab.worktreeDir,
      "--approach",
      "brute-force in-memory counter",
      "--approach",
      "event-sourced tally",
    );
    expect(code).toBe(0);

    // Two branches, mechanically recognizable as prototype refs.
    const branches = git(lab.root, "branch", "--format=%(refname:short)")
      .split("\n")
      .filter((line) => line !== "");
    expect(branches).toContain("prototype/speed-count/variant-1");
    expect(branches).toContain("prototype/speed-count/variant-2");

    // Two worktrees, each on its own branch and each holding its mini-PRD.
    for (const variant of [1, 2]) {
      const worktree = join(lab.worktreeDir, `${basename(lab.root)}-prototype-speed-count-variant-${variant}`);
      expect(await exists(worktree)).toBe(true);
      expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
        `prototype/speed-count/variant-${variant}`,
      );
      const prd = await readFile(
        join(worktree, `docs/prototypes/speed-count/variant-${variant}.md`),
        "utf8",
      );
      expect(prd).toContain(`variant-${variant}`);
      // The approach statement IS the mini-PRD's point.
      expect(prd).toContain(variant === 1 ? "brute-force in-memory counter" : "event-sourced tally");
      // The never-merge invariant travels with the workspace.
      expect(prd.toLowerCase()).toContain("never merge");
      // And the durable copy survives the throwaway, in the main tree.
      expect(
        await exists(join(lab.root, `docs/prototypes/speed-count/variant-${variant}.md`)),
      ).toBe(true);
    }

    // Two child items: type prototype, lane direct (ceremony stripped), each
    // recording its own mini-PRD as its deliverable.
    const spawned = await spawnedItems(lab);
    expect(spawned).toHaveLength(2);
    for (const child of spawned) {
      expect(child.type).toBe("prototype");
      expect(child.lane).toBe("direct");
      expect(child.parent).toBe(lab.item.id);
      expect(child.status).toBe("in-progress");
      expect(child.prd).toMatch(/^docs\/prototypes\/speed-count\/variant-[12]\.md$/);
    }
    expect(spawned.map((child) => child.name).sort()).toEqual([
      "speed-count-variant-1",
      "speed-count-variant-2",
    ]);

    // The creation act is journaled with each variant's BASE — the anchor the
    // never-merge check joins against.
    const events = await journalEvents(lab.layout);
    const created = eventsOfType(events, PROTOTYPE_VARIANTS_CREATED_EVENT_TYPE);
    expect(created).toHaveLength(1);
    const payload = created[0]!.payload as {
      slug: string;
      variants: { branch: string; base: string; worktree: string; prd: string; item: string }[];
    };
    expect(payload.slug).toBe("speed-count");
    expect(payload.variants).toHaveLength(2);
    for (const variant of payload.variants) {
      expect(variant.base).toBe(head);
      expect(variant.branch).toStartWith("prototype/speed-count/variant-");
      expect(spawned.map((child) => child.id)).toContain(variant.item);
    }

    // Zero ceremony: no dispatch, no review, no test-first bookkeeping.
    for (const event of events) {
      expect(event.type).not.toStartWith("dispatch.");
      expect(event.type).not.toContain("review");
    }

    // The freshly created variants do not trip never-merge enforcement.
    const findings = await validateStore(lab.layout);
    expect(findings.filter((finding) => finding.check.startsWith("prototype."))).toEqual([]);
  }, 60_000);

  test("worktrees default to siblings of the repo when --worktree-dir is omitted", async () => {
    const lab = await setup();
    const expected = join(
      dirname(lab.root),
      `${basename(lab.root)}-prototype-speed-count-variant-1`,
    );
    dirs.push(expected);

    expect(await run(lab, "start", lab.item.id, "--variants", "1")).toBe(0);
    expect(await exists(expected)).toBe(true);
  }, 60_000);

  test("refuses a non-prototype item — the lane is the TYPE's, not a flag's", async () => {
    const lab = await setup({ item: { type: "feature" } });
    expect(await run(lab, "start", lab.item.id, "--variants", "2")).toBe(1);
    expect(stderr()).toContain("prototype");
    expect(stderr()).toContain("feature");
    expect(await spawnedItems(lab)).toEqual([]);
  });

  test("refuses a nonsense variant count, naming the range", async () => {
    const lab = await setup();
    for (const bad of ["0", "-1", "two", "99"]) {
      logs = [];
      errs = [];
      expect(await run(lab, "start", lab.item.id, "--variants", bad)).toBe(1);
      expect(stderr()).toContain("--variants");
    }
    expect(await spawnedItems(lab)).toEqual([]);
  });

  test("refuses more approach statements than variants — a dropped approach is a lost idea", async () => {
    const lab = await setup();
    expect(
      await run(
        lab,
        "start",
        lab.item.id,
        "--variants",
        "1",
        "--approach",
        "a",
        "--approach",
        "b",
      ),
    ).toBe(1);
    expect(stderr()).toContain("--approach");
  });
});

describe("never-merge, enforced by the CLI (F5.2)", () => {
  test("a prototype item cannot be flipped to in-review — the refusal is journaled", async () => {
    const lab = await setup();
    expect(await runItem(lab, "update", lab.item.id, "--status", "in-review")).toBe(1);
    expect(stderr()).toContain("prototype");
    expect(stderr()).toContain("never merges");
    expect(stderr()).toContain("nahel prototype promote");

    // State untouched.
    expect((await readItem(lab.layout, lab.item.id)).frontmatter.status).toBe(lab.item.status);
    // Refusal journaled — a refusal nobody can audit is prose, not mechanism.
    const refusals = eventsOfType(
      await journalEvents(lab.layout),
      PROTOTYPE_MERGE_REFUSED_EVENT_TYPE,
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.item).toBe(lab.item.id);
    expect(refusals[0]!.payload["status"]).toBe("in-review");
  });

  test("`done` is refused the same way — merged is exactly what a prototype never gets to be", async () => {
    const lab = await setup();
    expect(await runItem(lab, "update", lab.item.id, "--status", "done")).toBe(1);
    const refusals = eventsOfType(
      await journalEvents(lab.layout),
      PROTOTYPE_MERGE_REFUSED_EVENT_TYPE,
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.payload["status"]).toBe("done");
  });

  test("every other status still moves freely — dropped is a prototype's honest terminal state", async () => {
    const lab = await setup();
    expect(await runItem(lab, "update", lab.item.id, "--status", "in-progress")).toBe(0);
    expect(await runItem(lab, "update", lab.item.id, "--status", "blocked")).toBe(0);
    expect(await runItem(lab, "update", lab.item.id, "--status", "dropped")).toBe(0);
    expect((await readItem(lab.layout, lab.item.id)).frontmatter.status).toBe("dropped");
    expect(
      eventsOfType(await journalEvents(lab.layout), PROTOTYPE_MERGE_REFUSED_EVENT_TYPE),
    ).toEqual([]);
  });

  test("non-prototype items are untouched by the seam — feature items reach review as always", async () => {
    const lab = await setup({ item: { type: "feature" } });
    expect(await runItem(lab, "update", lab.item.id, "--status", "in-review")).toBe(0);
    expect((await readItem(lab.layout, lab.item.id)).frontmatter.status).toBe("in-review");
  });

  test("validate flags a prototype branch whose code reached the default branch", async () => {
    const lab = await setup();
    expect(
      await run(lab, "start", lab.item.id, "--variants", "1", "--worktree-dir", lab.worktreeDir),
    ).toBe(0);
    const worktree = join(
      lab.worktreeDir,
      `${basename(lab.root)}-prototype-speed-count-variant-1`,
    );
    await writeFile(join(worktree, "throwaway.ts"), "export const spike = 1;\n");
    git(worktree, "add", "-A");
    git(worktree, "commit", "-m", "throwaway spike");
    git(lab.root, "merge", "--no-edit", "prototype/speed-count/variant-1");

    const findings = await validateStore(lab.layout);
    const merged = findings.filter((finding) => finding.check === "prototype.merged");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.severity).toBe("error");
    expect(merged[0]!.message).toContain("prototype/speed-count/variant-1");
  }, 60_000);
});

describe("nahel prototype promote — the path onto the plan lane (F5.3, F5.4)", () => {
  /** Spawn one variant and return its item id + worktree path. */
  async function startOne(lab: Lab): Promise<{ id: string; worktree: string }> {
    expect(
      await run(lab, "start", lab.item.id, "--variants", "1", "--worktree-dir", lab.worktreeDir),
    ).toBe(0);
    const [variant] = await spawnedItems(lab);
    return {
      id: variant!.id,
      worktree: join(lab.worktreeDir, `${basename(lab.root)}-prototype-speed-count-variant-1`),
    };
  }

  test("refuses on a seed-tier project, naming the inception upgrade (F5.4)", async () => {
    const lab = await setup({ config: { inception: { tier: "seed" } } });
    const variant = await startOne(lab);
    logs = [];
    errs = [];

    expect(await run(lab, "promote", variant.id)).toBe(1);
    expect(stderr()).toContain("seed");
    expect(stderr()).toContain("upgrade inception first");
    expect(stderr()).toContain("nahel/workflows/inception.md");

    // No plan item was born, and the refusal is on the record.
    const items = await spawnedItems(lab);
    expect(items.filter((item) => item.type === "plan")).toEqual([]);
    const refusals = eventsOfType(
      await journalEvents(lab.layout),
      PROTOTYPE_PROMOTION_REFUSED_EVENT_TYPE,
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.payload["tier"]).toBe("seed");
  }, 60_000);

  test("refuses when no tier is recorded at all — unfounded is not standard", async () => {
    const lab = await setup();
    const variant = await startOne(lab);
    logs = [];
    errs = [];

    expect(await run(lab, "promote", variant.id)).toBe(1);
    expect(stderr()).toContain("no inception tier");
    expect(stderr()).toContain("nahel/workflows/inception.md");
  }, 60_000);

  test("at standard tier it opens a plan item carrying the mini-PRD, and journals the promotion", async () => {
    const lab = await setup({ config: { inception: { tier: "standard" } } });
    const variant = await startOne(lab);
    logs = [];
    errs = [];

    expect(await run(lab, "promote", variant.id)).toBe(0);
    const planId = stdout().trim();

    const plan = (await readItem(lab.layout, planId)).frontmatter;
    expect(plan.type).toBe("plan");
    expect(plan.lane).toBe("full");
    expect(plan.status).toBe("backlog");
    // The plan item AUTHORS the full PRD — it does not inherit the mini-PRD as
    // its own deliverable (ADR-0013), so `prd` stays unset until prd-new.
    expect(plan.prd).toBeUndefined();

    const { body } = await readItem(lab.layout, planId);
    expect(body).toContain("docs/prototypes/speed-count/variant-1.md");
    expect(body).toContain("prototype/speed-count/variant-1");
    expect(body).toContain("reference-only");
    expect(body).toContain("nahel/workflows/prd-new.md");
    // Approval is the plan lane's, per governance.product — never assumed here.
    expect(body).toContain("governance.product");

    const promoted = eventsOfType(
      await journalEvents(lab.layout),
      PROTOTYPE_PROMOTED_EVENT_TYPE,
    );
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.payload["plan"]).toBe(planId);
    expect(promoted[0]!.payload["variant"]).toBe(variant.id);
    expect(promoted[0]!.payload["tier"]).toBe("standard");
    expect(promoted[0]!.payload["mini_prd"]).toBe("docs/prototypes/speed-count/variant-1.md");

    // Promotion opens a path; it never closes the variant or touches its code.
    expect((await readItem(lab.layout, variant.id)).frontmatter.status).toBe("in-progress");
    expect(await exists(variant.worktree)).toBe(true);
  }, 60_000);

  test("refuses to promote anything that is not a prototype variant", async () => {
    const lab = await setup({ config: { inception: { tier: "standard" } } });
    await startOne(lab);
    logs = [];
    errs = [];
    // The parent prototype item has no mini-PRD of its own: only variants promote.
    expect(await run(lab, "promote", lab.item.id)).toBe(1);
    expect(stderr()).toContain("mini-PRD");
  }, 60_000);
});

describe("nahel prototype dispose — the losers' disposal, journaled (F5.3)", () => {
  test("removes the worktree, drops the item, and records why", async () => {
    const lab = await setup();
    expect(
      await run(lab, "start", lab.item.id, "--variants", "1", "--worktree-dir", lab.worktreeDir),
    ).toBe(0);
    const [variant] = await spawnedItems(lab);
    const worktree = join(
      lab.worktreeDir,
      `${basename(lab.root)}-prototype-speed-count-variant-1`,
    );
    git(worktree, "add", "-A");
    git(worktree, "commit", "-m", "throwaway");
    logs = [];
    errs = [];

    expect(await run(lab, "dispose", variant!.id, "--reason", "slower than variant 2")).toBe(0);

    expect(await exists(worktree)).toBe(false);
    expect((await readItem(lab.layout, variant!.id)).frontmatter.status).toBe("dropped");
    // The branch survives: reference-only, and still visible to never-merge checks.
    expect(git(lab.root, "branch", "--list", "prototype/speed-count/variant-1")).toContain(
      "variant-1",
    );

    const disposed = eventsOfType(
      await journalEvents(lab.layout),
      PROTOTYPE_DISPOSED_EVENT_TYPE,
    );
    expect(disposed).toHaveLength(1);
    expect(disposed[0]!.item).toBe(variant!.id);
    expect(disposed[0]!.payload["reason"]).toBe("slower than variant 2");
    expect(disposed[0]!.payload["branch"]).toBe("prototype/speed-count/variant-1");
  }, 60_000);

  test("refuses to eat uncommitted work without --force", async () => {
    const lab = await setup();
    expect(
      await run(lab, "start", lab.item.id, "--variants", "1", "--worktree-dir", lab.worktreeDir),
    ).toBe(0);
    const [variant] = await spawnedItems(lab);
    const worktree = join(
      lab.worktreeDir,
      `${basename(lab.root)}-prototype-speed-count-variant-1`,
    );
    logs = [];
    errs = [];

    expect(await run(lab, "dispose", variant!.id)).toBe(1);
    expect(stderr()).toContain("--force");
    expect(await exists(worktree)).toBe(true);
    expect((await readItem(lab.layout, variant!.id)).frontmatter.status).toBe("in-progress");

    logs = [];
    errs = [];
    expect(await run(lab, "dispose", variant!.id, "--force")).toBe(0);
    expect(await exists(worktree)).toBe(false);
  }, 60_000);
});

describe("usage surface", () => {
  test("--help prints the three subcommands and exits 0", async () => {
    const lab = await setup();
    expect(await run(lab, "--help")).toBe(0);
    expect(stdout()).toContain("prototype start");
    expect(stdout()).toContain("prototype promote");
    expect(stdout()).toContain("prototype dispose");
  });

  test("an unknown subcommand refuses with the known ones", async () => {
    const lab = await setup();
    expect(await run(lab, "judge")).toBe(1);
    expect(stderr()).toContain("start");
  });
});

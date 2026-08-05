import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { COMMANDS, type CommandContext } from "../../src/cli";
import { logCommand } from "../../src/commands/log";
import { planCommand } from "../../src/commands/plan";
import { roadmapCommand } from "../../src/commands/roadmap";
import { CORE_EVENT_TYPES } from "../../src/schema/events";
import type { Env } from "../../src/schema/env";
import { ID_PATTERN } from "../../src/schema/id";
import type { JournalEvent } from "../../src/schema/records";
import { readJournal } from "../../src/store/journal";
import { ensureLayout, writeConfig, type StoreLayout } from "../../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel plan [ref]` (planning-partner F1): the planning briefing, in DD5's
 * order. Every case drives the REAL command against a real temp-dir store built
 * through the REAL roadmap verbs, so what is exercised is the whole read path —
 * store → derivations → rendered text — never a renderer fed hand-built facts.
 *
 * The five acceptance cases are pinned BYTE FOR BYTE, because a briefing is
 * read top-down by a fresh agent: which section comes first, what each line
 * says, and what an empty section says instead are the whole deliverable. Ids
 * and timestamps are read back off the store the fixture just wrote, so what
 * the goldens pin is the RENDERING and not the seeded env's arithmetic.
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

/** Drive a roadmap verb, expect success, and return everything it printed. */
async function ok(env: Env, root: string, args: string[], actor?: string): Promise<string[]> {
  const before = logs.length;
  const code = await roadmapCommand.run(args, env, root, actor);
  expect(errs.join("\n")).toBe("");
  expect(code).toBe(0);
  return logs.slice(before);
}

function lastId(printed: string[]): string {
  const id = printed[printed.length - 1]!;
  expect(id).toMatch(ID_PATTERN);
  return id;
}

/** Journal one note through `nahel log`; its non-core type warning is expected. */
async function note(env: Env, root: string, args: string[], actor: string): Promise<void> {
  const code = await logCommand.run(args, {
    env,
    cwd: root,
    actorOverride: actor,
    stdout: (text: string) => logs.push(text),
    stderr: (text: string) => errs.push(text),
  });
  expect(code).toBe(0);
  errs = [];
}

/** The read context `nahel plan` runs under — a frozen clock it must never read. */
function context(root: string): CommandContext {
  return {
    env: seededEnv({ now: "2026-08-03T09:00:00Z", tickSeconds: 0 }),
    cwd: root,
    stdout: (text: string) => logs.push(text),
    stderr: (text: string) => errs.push(text),
  };
}

/** Run the briefing, expect exit 0 and a silent stderr, and return the page. */
async function plan(root: string, args: string[] = []): Promise<string> {
  const before = logs.length;
  const code = await planCommand.run(args, context(root));
  expect(errs.join("\n")).toBe("");
  expect(code).toBe(0);
  return logs.slice(before).join("\n");
}

/** Run it expecting a refusal; returns what it wrote to stderr. */
async function planFails(root: string, args: string[]): Promise<string> {
  const before = errs.length;
  const code = await planCommand.run(args, context(root));
  expect(code).toBe(1);
  const written = errs.slice(before).join("\n");
  errs = [];
  return written;
}

async function journal(layout: StoreLayout): Promise<JournalEvent[]> {
  return Array.fromAsync(readJournal(layout));
}

/** The ticket id one act carries, read the way mutate() writes both payloads. */
function ticketOf(event: JournalEvent): string | undefined {
  const steps: unknown[] = [event.payload];
  const records = event.payload["records"];
  if (Array.isArray(records)) steps.push(...records);
  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue;
    const fields = step as Record<string, unknown>;
    if (fields["target"] !== "ticket") continue;
    const record = fields["record"];
    if (typeof record === "object" && record !== null) {
      const id = (record as Record<string, unknown>)["id"];
      if (typeof id === "string") return id;
    }
  }
  return undefined;
}

/** The one act of `type` that touched `ticket` — ambiguity is a fixture bug. */
function act(events: readonly JournalEvent[], type: string, ticket: string): JournalEvent {
  const found = events.filter((event) => event.type === type && ticketOf(event) === ticket);
  expect(found.length).toBe(1);
  return found[0]!;
}

/** Every file under a directory, path → bytes — the store's exact state. */
async function snapshotTree(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(path, await readFile(path, "utf8"));
  }
  return files;
}

/** A fresh initialized store; the config declares no governance (product: delegated). */
async function store(): Promise<{ root: string; layout: StoreLayout }> {
  const root = await makeTempDir("nahel-plan-");
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig());
  return { root, layout };
}

/**
 * A charted feature node with a since-window: the human charts it and cuts
 * three tickets, then an AGENT resolves one, closes one out of scope, cuts a
 * fourth, journals a `ticket=`-keyed research note, and raises a fog line. The
 * default reader is the store's human side (DD1), so exactly the agent's acts
 * are the debrief.
 */
async function chartedStore() {
  const { root, layout } = await store();
  const human = seededEnv({ seed: 3, now: "2026-08-01T09:00:00Z", tickSeconds: 1 });
  const node = lastId(
    await ok(
      human,
      root,
      ["node", "new", "feature", "payments-rails", "--horizon", "now", "--intent",
        "Take a payment without a queue."],
      "human:jim",
    ),
  );
  const map = lastId(
    await ok(
      human,
      root,
      ["map", "new", "--node", "payments-rails", "--destination",
        "a payment a fresh agent can take", "--fog", "how do we roll back a capture?"],
      "human:jim",
    ),
  );
  const ticket = async (type: string, question: string): Promise<string> =>
    lastId(
      await ok(
        human,
        root,
        ["ticket", "new", "--map", map, "--type", type, "--question", question],
        "human:jim",
      ),
    );
  const research = await ticket("research", "which processor do we own?");
  const grilling = await ticket("grilling", "do we hold card data at all?");
  const task = await ticket("task", "do we need a dunning job?");

  const agent = seededEnv({ seed: 11, now: "2026-08-02T09:00:00Z", tickSeconds: 1 });
  await ok(
    agent,
    root,
    ["ticket", "resolve", research, "--decision", "stripe, and nothing behind it"],
    "agent:codex",
  );
  await ok(
    agent,
    root,
    ["ticket", "close", task, "--reason", "a dunning job is beyond this destination",
      "--out-of-scope"],
    "agent:codex",
  );
  const chargebacks = lastId(
    await ok(
      agent,
      root,
      ["ticket", "new", "--map", map, "--type", "research", "--question",
        "what does a chargeback cost us?"],
      "agent:codex",
    ),
  );
  await note(
    agent,
    root,
    ["note", "--data", `ticket=${research}`, "--data", "text=stripe and adyen both settle T+2"],
    "agent:codex",
  );
  await ok(
    agent,
    root,
    ["map", "update", map, "--fog", "how do we roll back a capture?", "--fog",
      "who owns the dunning emails?"],
    "agent:codex",
  );
  return { root, layout, node, map, research, grilling, task, chargebacks };
}

/**
 * One product with a chart and one human-only ticket, plus an UNCHARTED feature
 * child — the bare single-product briefing and the no-map briefing over one
 * store, because they are the same store shape a real project has on day one.
 */
async function productStore() {
  const { root, layout } = await store();
  const env = seededEnv({ seed: 5, now: "2026-08-01T09:00:00Z", tickSeconds: 1 });
  const product = lastId(
    await ok(
      env,
      root,
      ["node", "new", "product", "paperbird", "--horizon", "now", "--intent",
        "A product that folds paper."],
      "human:jim",
    ),
  );
  const map = lastId(
    await ok(
      env,
      root,
      ["map", "new", "--node", "paperbird", "--destination",
        "one product a fresh agent can hold in its head", "--fog", "do we need a mobile app?",
        "--out-of-scope", "printing hardware"],
      "human:jim",
    ),
  );
  const ticket = lastId(
    await ok(
      env,
      root,
      ["ticket", "new", "--map", map, "--type", "grilling", "--question", "who is this for?",
        "--human-only"],
      "human:jim",
    ),
  );
  const feature = lastId(
    await ok(
      env,
      root,
      ["node", "new", "feature", "dunning-emails", "--horizon", "next", "--parent", product,
        "--intent", "Chase a failed payment."],
      "human:jim",
    ),
  );
  return { root, layout, product, map, ticket, feature };
}

/** The last six lines every briefing ends with: altitude, the pointer, governance. */
function tail(altitude: "feature definition" | "roadmap shaping"): string[] {
  const mark = (label: string): string =>
    label === altitude ? `${label} (this node)` : label;
  return [
    "",
    "altitude:",
    `  ${mark("feature definition")} — full map discipline: every decision is a ticket, resolved in one line`,
    `  ${mark("roadmap shaping")} — the node mutations ARE the record, plus one journaled session note`,
    "  ideation — bless an idea into a later-horizon node; park a reject as an out-of-scope line",
    "",
    "↳ nahel/workflows/plan.md  — the workflow that conducts this session",
    "",
    "governance:",
    "  product: delegated (default)",
    "  self-resolves here: research and task tickets; prototype tickets are STARTED, not awaited " +
      "(prototype-lane's verdict rules finish them). Grilling tickets too, with a rationale it can " +
      "defend later.",
    "  never: a [human-only] ticket — under an agent actor resolve, close and --clear-human-only " +
      "are all refused.",
  ];
}

describe("the focused briefing of a charted feature node (F1)", () => {
  test("the page is exactly these lines, in exactly this order", async () => {
    const fixture = await chartedStore();
    const events = await journal(fixture.layout);
    const baseline = act(events, CORE_EVENT_TYPES.ticketCreated, fixture.task);
    const resolved = act(events, CORE_EVENT_TYPES.ticketResolved, fixture.research);
    const closed = act(events, CORE_EVENT_TYPES.ticketClosed, fixture.task);
    const opened = act(events, CORE_EVENT_TYPES.ticketCreated, fixture.chargebacks);
    const noted = events.filter((event) => event.type === "note");
    expect(noted.length).toBe(1);
    // The frontier orders its tickets by map label then id, and hints at the
    // first one it listed — read off the ids the store generated.
    const open = [fixture.grilling, fixture.chargebacks].sort();
    const question = new Map([
      [fixture.grilling, ["grilling", "do we hold card data at all?"]],
      [fixture.chargebacks, ["research", "what does a chargeback cost us?"]],
    ]);

    const out = await plan(fixture.root, ["payments-rails"]);

    expect(out).toBe(
      [
        `plan payments-rails  feature  horizon=now  id=${fixture.node}`,
        "  destination=a payment a fresh agent can take",
        `  map=${fixture.map}`,
        "",
        `since your last session (after your last act here, ${baseline.ts}):`,
        `  ${resolved.ts}  resolved  ${fixture.research}  stripe, and nothing behind it  act=${resolved.id}`,
        `  ${closed.ts}  closed  ${fixture.task}  a dunning job is beyond this destination  act=${closed.id}`,
        `  ${opened.ts}  opened  ${fixture.chargebacks}  act=${opened.id}`,
        "  map  fog  + who owns the dunning emails?",
        `  ${noted[0]!.ts}  noted  ticket=${fixture.research}  act=${noted[0]!.id}`,
        "",
        "decisions so far (1):",
        `  ${fixture.research}  stripe, and nothing behind it`,
        "",
        "frontier of payments-rails",
        "",
        "tickets (2):",
        ...open.flatMap((id) => [
          `  ${id}  ${question.get(id)![0]}  map=payments-rails`,
          `      ${question.get(id)![1]}`,
        ]),
        "",
        "work items (0):",
        "  (none)",
        "",
        `↳ nahel roadmap ticket show ${open[0]}  — the question in full`,
        "",
        "not yet specified (2):",
        "  how do we roll back a capture?",
        "  who owns the dunning emails?",
        "",
        "out of scope (1):",
        `  a dunning job is beyond this destination  (${fixture.task})`,
        ...tail("feature definition"),
      ].join("\n"),
    );
  });

  test("--reader names the agent, and its own acts stop being news (DD1)", async () => {
    const fixture = await chartedStore();

    const asAgent = await plan(fixture.root, ["payments-rails", "--reader", "agent:codex"]);

    // The agent's last subject act was the map update, and nothing follows it.
    expect(asAgent).toContain("  nothing new since your last touch");
    expect(asAgent).not.toContain("stripe, and nothing behind it  act=");
    // Everything OUTSIDE the debrief is the same page — the reader moves the
    // window, never the briefing.
    expect(asAgent).toContain("decisions so far (1):");
    expect(asAgent).toContain("not yet specified (2):");
  });

  test("an unparseable --reader is refused with the usage, before anything is read", async () => {
    const fixture = await chartedStore();

    const written = await planFails(fixture.root, ["payments-rails", "--reader", "codex"]);

    expect(written).toContain("codex");
    expect(written).toContain("usage: nahel plan");
  });

  test("it journals nothing, mutates nothing, and two reads are byte-identical", async () => {
    const fixture = await chartedStore();
    const before = await snapshotTree(fixture.root);

    const first = await plan(fixture.root, ["payments-rails"]);
    const second = await plan(fixture.root, ["payments-rails"]);

    expect(second).toBe(first);
    expect(await snapshotTree(fixture.root)).toEqual(before);
  });

  test("the id spelling of the ref renders the same page as the slug", async () => {
    const fixture = await chartedStore();

    expect(await plan(fixture.root, [fixture.node])).toBe(
      await plan(fixture.root, ["payments-rails"]),
    );
  });
});

describe("the bare form (F1)", () => {
  test("a single-product store briefs the product node, and an empty window says so", async () => {
    const fixture = await productStore();
    const events = await journal(fixture.layout);
    const baseline = act(events, CORE_EVENT_TYPES.ticketCreated, fixture.ticket);

    const out = await plan(fixture.root);

    expect(out).toBe(
      [
        `plan paperbird  product  horizon=now  id=${fixture.product}`,
        "  destination=one product a fresh agent can hold in its head",
        `  map=${fixture.map}`,
        "",
        `since your last session (after your last act here, ${baseline.ts}):`,
        "  nothing new since your last touch",
        "",
        "decisions so far (0):",
        "  (none)",
        "",
        "frontier of paperbird",
        "",
        "tickets (1):",
        `  ${fixture.ticket}  grilling  map=paperbird  [human-only]`,
        "      who is this for?",
        "",
        "work items (0):",
        "  (none)",
        "",
        `↳ nahel roadmap ticket show ${fixture.ticket}  — the question in full`,
        "",
        "not yet specified (1):",
        "  do we need a mobile app?",
        "",
        "out of scope (1):",
        "  printing hardware",
        ...tail("roadmap shaping"),
      ].join("\n"),
    );
  });

  test("an intent-only edit is news: at roadmap altitude the prose IS the record (D2)", async () => {
    const fixture = await productStore();
    const events = await journal(fixture.layout);
    const baseline = act(events, CORE_EVENT_TYPES.ticketCreated, fixture.ticket);
    const agent = seededEnv({ seed: 21, now: "2026-08-02T09:00:00Z", tickSeconds: 1 });
    await ok(
      agent,
      fixture.root,
      ["node", "update", "paperbird", "--intent", "A product that folds paper, and charges for it."],
      "agent:codex",
    );

    const out = await plan(fixture.root);

    // `--intent` moves no frontmatter field whatsoever, so a debrief reading
    // frontmatter alone would render this store's real shaping work as silence.
    expect(out).toContain(
      `since your last session (after your last act here, ${baseline.ts}):\n  node  intent  changed\n`,
    );
    expect(out).not.toContain("nothing new since your last touch");
    // The prose stays where it lives; the line says only where to go look.
    expect(out).not.toContain("charges for it");
  });

  test("a multi-product store lists the products and asks which one", async () => {
    const fixture = await productStore();
    const env = seededEnv({ seed: 9, now: "2026-08-02T09:00:00Z", tickSeconds: 1 });
    const second = lastId(
      await ok(
        env,
        fixture.root,
        ["node", "new", "product", "stonebird", "--horizon", "later", "--intent",
          "A product that folds stone."],
        "human:jim",
      ),
    );

    const out = await plan(fixture.root);

    // Products list in the id order readRoadmapNodes returns; the HINT names
    // the alphabetically first one, which is stable against id churn.
    const listed = [
      { id: fixture.product, line: `  paperbird  product  horizon=now  id=${fixture.product}` },
      { id: second, line: `  stonebird  product  horizon=later  id=${second}` },
    ]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((entry) => entry.line);
    expect(out).toBe(
      [
        "products (2):",
        ...listed,
        "",
        "pick the one you are planning, or name a new one.",
        "",
        "↳ nahel plan paperbird  — that product's briefing",
        '↳ nahel roadmap node new product <slug> --horizon now --intent "<what this product is>"' +
          "  — name a new one",
      ].join("\n"),
    );
  });
});

describe("a node nothing charts yet (F1)", () => {
  test("the briefing says so, points at charting, and still renders every section", async () => {
    const fixture = await productStore();
    const events = await journal(fixture.layout);
    const created = events.filter(
      (event) =>
        event.type === CORE_EVENT_TYPES.roadmapNodeCreated &&
        JSON.stringify(event.payload).includes(fixture.feature),
    );
    expect(created.length).toBe(1);

    const out = await plan(fixture.root, ["dunning-emails"]);

    expect(out).toBe(
      [
        `plan dunning-emails  feature  horizon=next  id=${fixture.feature}`,
        "  no map yet — this node is not charted",
        '  ↳ nahel roadmap map new --node dunning-emails --destination "<where this is going>"' +
          "  — chart it",
        "  ↳ nahel/workflows/chart-map.md  — the charting session that fills it",
        "",
        `since your last session (after your last act here, ${created[0]!.ts}):`,
        "  nothing new since your last touch",
        "",
        "decisions so far (0):",
        "  (none)",
        "",
        "frontier of dunning-emails",
        "",
        "tickets (0):",
        "  (none)",
        "",
        "work items (0):",
        "  (none)",
        "",
        "↳ nahel roadmap  — back to the product level",
        "",
        "not yet specified (0):",
        "  (none)",
        "",
        "out of scope (0):",
        "  (none)",
        ...tail("feature definition"),
      ].join("\n"),
    );
  });
});

describe("an unknown ref (F1)", () => {
  test("is refused with the near-miss hint the roadmap verbs use, and the usage", async () => {
    const fixture = await productStore();

    const written = await planFails(fixture.root, ["dunning-email"]);

    expect(written).toBe(
      [
        '❌ "dunning-email" does not name a roadmap node — near misses: dunning-emails ' +
          "(`nahel roadmap` lists them all)",
        "usage: nahel plan [ref] [--reader <human|agent>:<id>]",
      ].join("\n"),
    );
  });

  test("a ref resembling nothing is refused with the full list as the answer", async () => {
    const fixture = await productStore();

    const written = await planFails(fixture.root, ["kzq"]);

    expect(written).toContain(
      '❌ "kzq" does not name a roadmap node — run `nahel roadmap` to list them',
    );
  });
});

describe("the verb is wired like its read siblings", () => {
  test("it is registered, described, and reachable from the command table", () => {
    const command = COMMANDS["plan"];
    expect(command).toBeDefined();
    expect(command!.description.length).toBeGreaterThan(0);
    expect(command!.description).toContain("plan");
  });

  test("an unknown flag is a usage error, not a crash", async () => {
    const fixture = await productStore();

    const written = await planFails(fixture.root, ["--definitely-not-a-flag"]);

    expect(written).toContain("usage: nahel plan");
  });

  test("more than one ref is refused, naming what it got", async () => {
    const fixture = await productStore();

    const written = await planFails(fixture.root, ["paperbird", "dunning-emails"]);

    expect(written).toContain("dunning-emails");
    expect(written).toContain("usage: nahel plan");
  });
});

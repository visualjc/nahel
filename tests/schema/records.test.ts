import { describe, expect, test } from "bun:test";
import type { ZodType } from "zod";
import { CORE_EVENT_TYPES } from "../../src/schema/events";
import { generateId } from "../../src/schema/id";
import {
  actorSchema,
  configSchema,
  distilledSchema,
  journalEventSchema,
  observationFrontmatterSchema,
  runSchema,
  workItemFrontmatterSchema,
  type WorkItemFrontmatter,
} from "../../src/schema/records";
import { fixedEnv } from "./fixed-env";

/**
 * Parse an expected-invalid value and return its issues as "path: message"
 * strings. Logs them so failing runs show exactly what the validator said —
 * the error text itself is part of the contract under test.
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

const NOW = "2026-07-16T12:00:00Z";

const validItem = {
  id: "0gz8r4cm",
  name: "schema-layer",
  type: "feature",
  status: "backlog",
  lane: "direct",
  depends_on: [],
  external_refs: [],
  created: NOW,
  updated: NOW,
};

const validRun = {
  id: "abcdefgh",
  item: "0gz8r4cm",
  actor: { kind: "agent", id: "claude-code" },
  lane: "direct",
  phase: "implementing",
  status: "active",
  started: NOW,
};

const validEvent = {
  id: "kqm3vx7t",
  ts: NOW,
  seq: 0,
  type: CORE_EVENT_TYPES.itemCreated,
  actor: { kind: "human", id: "jim" },
  payload: { name: "schema-layer" },
};

const validObservation = {
  id: "2n4p6q8r",
  created: NOW,
  tags: ["cli", "journal"],
  sources: ["kqm3vx7t"],
};

const validConfig = {
  knowledge: { product: "PRODUCT.md", context: "CONTEXT.md", adr: "docs/adr" },
  actor: { kind: "human", id: "jim" },
};

describe("schema/records — work item frontmatter", () => {
  test("accepts a minimal valid work item", () => {
    expectAccepted(workItemFrontmatterSchema, validItem, "item minimal");
  });

  test("accepts optional parent, claimed_by, refs, and dependencies", () => {
    expectAccepted(
      workItemFrontmatterSchema,
      {
        ...validItem,
        parent: "abcdefgh",
        claimed_by: "jim",
        depends_on: ["kqm3vx7t"],
        external_refs: [{ provider: "github", id: "2" }],
      },
      "item full",
    );
  });

  test("rejects a malformed id with a message naming the base32 format", () => {
    const issues = rejectionIssues(
      workItemFrontmatterSchema,
      { ...validItem, id: "NOT-VALID-ID" },
      "item bad id",
    );
    expect(issues.some((i) => i.startsWith("id:") && i.includes("base32"))).toBe(true);
  });

  test("rejects a non-slug name with a message naming the slug rule", () => {
    const issues = rejectionIssues(
      workItemFrontmatterSchema,
      { ...validItem, name: "Not A Slug!" },
      "item bad name",
    );
    expect(issues.some((i) => i.startsWith("name:") && i.includes("slug"))).toBe(true);
  });

  test("rejects an unknown type, listing the valid types", () => {
    const issues = rejectionIssues(
      workItemFrontmatterSchema,
      { ...validItem, type: "task" },
      "item bad type",
    );
    const typeIssue = issues.find((i) => i.startsWith("type:"));
    expect(typeIssue).toBeDefined();
    for (const valid of ["feature", "bug", "chore", "plan", "prototype", "qa"]) {
      expect(typeIssue).toContain(valid);
    }
  });

  test("rejects an unknown status, listing the valid statuses", () => {
    const issues = rejectionIssues(
      workItemFrontmatterSchema,
      { ...validItem, status: "todo" },
      "item bad status",
    );
    const statusIssue = issues.find((i) => i.startsWith("status:"));
    expect(statusIssue).toBeDefined();
    for (const valid of ["backlog", "in-progress", "blocked", "in-review", "done", "dropped"]) {
      expect(statusIssue).toContain(valid);
    }
  });

  test("rejects an unknown lane, listing the valid lanes", () => {
    const issues = rejectionIssues(
      workItemFrontmatterSchema,
      { ...validItem, lane: "yolo" },
      "item bad lane",
    );
    const laneIssue = issues.find((i) => i.startsWith("lane:"));
    expect(laneIssue).toBeDefined();
    for (const valid of ["direct", "epic-lite", "full"]) {
      expect(laneIssue).toContain(valid);
    }
  });

  test("rejects a malformed parent id, pointing at the parent field", () => {
    const issues = rejectionIssues(
      workItemFrontmatterSchema,
      { ...validItem, parent: "nope" },
      "item bad parent",
    );
    expect(issues.some((i) => i.startsWith("parent:"))).toBe(true);
  });

  test("rejects a malformed depends_on entry, pointing at the exact index", () => {
    const issues = rejectionIssues(
      workItemFrontmatterSchema,
      { ...validItem, depends_on: ["0gz8r4cm", "BAD"] },
      "item bad depends_on",
    );
    expect(issues.some((i) => i.startsWith("depends_on.1:"))).toBe(true);
  });

  test("rejects an external_ref missing its provider, pointing at the field", () => {
    const issues = rejectionIssues(
      workItemFrontmatterSchema,
      { ...validItem, external_refs: [{ id: "42" }] },
      "item bad external_refs",
    );
    expect(issues.some((i) => i.startsWith("external_refs.0.provider:"))).toBe(true);
  });

  test("rejects an empty claimed_by", () => {
    const issues = rejectionIssues(
      workItemFrontmatterSchema,
      { ...validItem, claimed_by: "" },
      "item empty claimed_by",
    );
    expect(issues.some((i) => i.startsWith("claimed_by:"))).toBe(true);
  });

  test("accepts an optional prd as a repo-relative path (ADR-0013: feature items reference the PRD by path)", () => {
    expectAccepted(
      workItemFrontmatterSchema,
      { ...validItem, prd: "docs/prds/phase-1-core-loop.md" },
      "item with prd",
    );
    const parsed = workItemFrontmatterSchema.parse({
      ...validItem,
      prd: "docs/prds/phase-1-core-loop.md",
    });
    expect(parsed.prd).toBe("docs/prds/phase-1-core-loop.md");
  });

  test("rejects an absolute prd path (POSIX and Windows forms), naming the repo-relative rule", () => {
    for (const absolute of ["/etc/prds/x.md", "C:\\prds\\x.md", "C:/prds/x.md", "\\\\host\\share\\x.md"]) {
      const issues = rejectionIssues(
        workItemFrontmatterSchema,
        { ...validItem, prd: absolute },
        `item absolute prd ${absolute}`,
      );
      expect(issues.some((i) => i.startsWith("prd:") && i.includes("repo-relative"))).toBe(true);
    }
  });

  test('rejects a prd path with a ".." segment (no traversal outside the repo)', () => {
    for (const traversal of ["../outside.md", "docs/../../etc/passwd", "docs/prds/..", "..\\outside.md"]) {
      const issues = rejectionIssues(
        workItemFrontmatterSchema,
        { ...validItem, prd: traversal },
        `item traversal prd ${traversal}`,
      );
      expect(issues.some((i) => i.startsWith("prd:") && i.includes(".."))).toBe(true);
    }
  });

  test("rejects an empty prd path (absent means no PRD; empty is a mistake)", () => {
    const issues = rejectionIssues(
      workItemFrontmatterSchema,
      { ...validItem, prd: "" },
      "item empty prd",
    );
    expect(issues.some((i) => i.startsWith("prd:"))).toBe(true);
  });

  test("accepts an optional investigation as a repo-relative path (F5: bug items reference their investigation doc by path)", () => {
    expectAccepted(
      workItemFrontmatterSchema,
      { ...validItem, investigation: "docs/investigations/0gz8r4cm.md" },
      "item with investigation",
    );
    const parsed = workItemFrontmatterSchema.parse({
      ...validItem,
      investigation: "docs/investigations/0gz8r4cm.md",
    });
    expect(parsed.investigation).toBe("docs/investigations/0gz8r4cm.md");
  });

  test("rejects an absolute investigation path (POSIX and Windows forms), naming the repo-relative rule", () => {
    for (const absolute of ["/etc/inv/x.md", "C:\\inv\\x.md", "C:/inv/x.md", "\\\\host\\share\\x.md"]) {
      const issues = rejectionIssues(
        workItemFrontmatterSchema,
        { ...validItem, investigation: absolute },
        `item absolute investigation ${absolute}`,
      );
      expect(issues.some((i) => i.startsWith("investigation:") && i.includes("repo-relative"))).toBe(true);
    }
  });

  test('rejects an investigation path with a ".." segment (no traversal outside the repo)', () => {
    for (const traversal of ["../outside.md", "docs/../../etc/passwd", "docs/investigations/..", "..\\outside.md"]) {
      const issues = rejectionIssues(
        workItemFrontmatterSchema,
        { ...validItem, investigation: traversal },
        `item traversal investigation ${traversal}`,
      );
      expect(issues.some((i) => i.startsWith("investigation:") && i.includes(".."))).toBe(true);
    }
  });

  test("rejects an empty investigation path (absent means no investigation; empty is a mistake)", () => {
    const issues = rejectionIssues(
      workItemFrontmatterSchema,
      { ...validItem, investigation: "" },
      "item empty investigation",
    );
    expect(issues.some((i) => i.startsWith("investigation:"))).toBe(true);
  });

  test("rejects a non-UTC created timestamp, naming the required format", () => {
    const issues = rejectionIssues(
      workItemFrontmatterSchema,
      { ...validItem, created: "2026-07-16T12:00:00+02:00" },
      "item non-utc created",
    );
    expect(
      issues.some((i) => i.startsWith("created:") && i.includes("YYYY-MM-DDTHH:MM:SSZ")),
    ).toBe(true);
  });

  test("rejects a millisecond-precision updated timestamp (repo rule: second precision)", () => {
    const issues = rejectionIssues(
      workItemFrontmatterSchema,
      { ...validItem, updated: "2026-07-16T12:00:00.123Z" },
      "item ms updated",
    );
    expect(issues.some((i) => i.startsWith("updated:"))).toBe(true);
  });

  test("rejects unknown frontmatter keys, naming the offending key (typo guard)", () => {
    const issues = rejectionIssues(
      workItemFrontmatterSchema,
      { ...validItem, statuss: "done" },
      "item unknown key",
    );
    expect(issues.some((i) => i.includes("statuss"))).toBe(true);
  });

  test("rejects a missing required field, pointing at it by name", () => {
    const { name: _omitted, ...withoutName } = validItem;
    const issues = rejectionIssues(
      workItemFrontmatterSchema,
      withoutName,
      "item missing name",
    );
    expect(issues.some((i) => i.startsWith("name:"))).toBe(true);
  });
});

describe("schema/records — run", () => {
  test("accepts an active run without ended, and an ended run with it", () => {
    expectAccepted(runSchema, validRun, "run active");
    expectAccepted(
      runSchema,
      { ...validRun, status: "ended", ended: "2026-07-16T13:00:00Z" },
      "run ended",
    );
  });

  test("rejects a run without an actor", () => {
    const { actor: _omitted, ...withoutActor } = validRun;
    const issues = rejectionIssues(runSchema, withoutActor, "run missing actor");
    expect(issues.some((i) => i.startsWith("actor:"))).toBe(true);
  });

  test("rejects an unknown run status, listing the valid ones", () => {
    const issues = rejectionIssues(
      runSchema,
      { ...validRun, status: "running" },
      "run bad status",
    );
    const statusIssue = issues.find((i) => i.startsWith("status:"));
    expect(statusIssue).toBeDefined();
    for (const valid of ["active", "paused", "ended"]) {
      expect(statusIssue).toContain(valid);
    }
  });

  test("rejects an empty phase (phase is a workflow-owned non-empty string)", () => {
    const issues = rejectionIssues(runSchema, { ...validRun, phase: "" }, "run empty phase");
    expect(issues.some((i) => i.startsWith("phase:"))).toBe(true);
  });

  test("rejects a malformed item ref", () => {
    const issues = rejectionIssues(
      runSchema,
      { ...validRun, item: "not-an-id" },
      "run bad item ref",
    );
    expect(issues.some((i) => i.startsWith("item:") && i.includes("base32"))).toBe(true);
  });

  test("rejects a malformed ended timestamp", () => {
    const issues = rejectionIssues(
      runSchema,
      { ...validRun, ended: "yesterday" },
      "run bad ended",
    );
    expect(issues.some((i) => i.startsWith("ended:"))).toBe(true);
  });
});

describe("schema/records — journal event", () => {
  test("accepts a valid event, with and without run/item refs", () => {
    expectAccepted(journalEventSchema, validEvent, "event minimal");
    expectAccepted(
      journalEventSchema,
      { ...validEvent, run: "abcdefgh", item: "0gz8r4cm" },
      "event with refs",
    );
  });

  test("rejects an event without an actor (actor is required on every event)", () => {
    const { actor: _omitted, ...withoutActor } = validEvent;
    const issues = rejectionIssues(
      journalEventSchema,
      withoutActor,
      "event missing actor",
    );
    expect(issues.some((i) => i.startsWith("actor:"))).toBe(true);
  });

  test("rejects an actor with an unknown kind, listing human|agent", () => {
    const issues = rejectionIssues(
      journalEventSchema,
      { ...validEvent, actor: { kind: "robot", id: "hal" } },
      "event bad actor kind",
    );
    const kindIssue = issues.find((i) => i.startsWith("actor.kind:"));
    expect(kindIssue).toBeDefined();
    expect(kindIssue).toContain("human");
    expect(kindIssue).toContain("agent");
  });

  test("rejects an actor with an empty id", () => {
    const issues = rejectionIssues(
      journalEventSchema,
      { ...validEvent, actor: { kind: "agent", id: "" } },
      "event empty actor id",
    );
    expect(issues.some((i) => i.startsWith("actor.id:"))).toBe(true);
  });

  test("rejects a negative or fractional seq (per-segment monotonic counter)", () => {
    const negative = rejectionIssues(
      journalEventSchema,
      { ...validEvent, seq: -1 },
      "event negative seq",
    );
    expect(negative.some((i) => i.startsWith("seq:"))).toBe(true);
    const fractional = rejectionIssues(
      journalEventSchema,
      { ...validEvent, seq: 1.5 },
      "event fractional seq",
    );
    expect(fractional.some((i) => i.startsWith("seq:"))).toBe(true);
  });

  test("rejects a malformed ts, naming the required format", () => {
    const issues = rejectionIssues(
      journalEventSchema,
      { ...validEvent, ts: "16/07/2026" },
      "event bad ts",
    );
    expect(issues.some((i) => i.startsWith("ts:") && i.includes("YYYY-MM-DDTHH:MM:SSZ"))).toBe(
      true,
    );
  });

  test("rejects a non-object payload", () => {
    const issues = rejectionIssues(
      journalEventSchema,
      { ...validEvent, payload: "not an object" },
      "event bad payload",
    );
    expect(issues.some((i) => i.startsWith("payload:"))).toBe(true);
  });

  test("rejects a malformed run ref", () => {
    const issues = rejectionIssues(
      journalEventSchema,
      { ...validEvent, run: "RUN#1" },
      "event bad run ref",
    );
    expect(issues.some((i) => i.startsWith("run:"))).toBe(true);
  });
});

describe("schema/records — observation frontmatter", () => {
  test("accepts a valid observation", () => {
    expectAccepted(observationFrontmatterSchema, validObservation, "observation valid");
  });

  test("rejects a malformed sources entry (provenance must be event ids)", () => {
    const issues = rejectionIssues(
      observationFrontmatterSchema,
      { ...validObservation, sources: ["kqm3vx7t", "event-42"] },
      "observation bad source",
    );
    expect(issues.some((i) => i.startsWith("sources.1:") && i.includes("base32"))).toBe(true);
  });

  test("rejects an empty tag", () => {
    const issues = rejectionIssues(
      observationFrontmatterSchema,
      { ...validObservation, tags: [""] },
      "observation empty tag",
    );
    expect(issues.some((i) => i.startsWith("tags.0:"))).toBe(true);
  });

  test("rejects a missing id", () => {
    const { id: _omitted, ...withoutId } = validObservation;
    const issues = rejectionIssues(
      observationFrontmatterSchema,
      withoutId,
      "observation missing id",
    );
    expect(issues.some((i) => i.startsWith("id:"))).toBe(true);
  });

  test("accepts an optional name slug (`nahel observe <slug>` writes it; Phase-0 records lack it)", () => {
    expectAccepted(
      observationFrontmatterSchema,
      { ...validObservation, name: "flaky-auth-test" },
      "observation with name",
    );
  });

  test("rejects a non-slug name", () => {
    const issues = rejectionIssues(
      observationFrontmatterSchema,
      { ...validObservation, name: "Not A Slug" },
      "observation bad name",
    );
    expect(issues.some((i) => i.startsWith("name:") && i.includes("slug"))).toBe(true);
  });

  test("accepts an optional item ref (F5: an observation about a work item, e.g. a repro waiver)", () => {
    expectAccepted(
      observationFrontmatterSchema,
      { ...validObservation, item: "0gz8r4cm" },
      "observation with item",
    );
    const parsed = observationFrontmatterSchema.parse({ ...validObservation, item: "0gz8r4cm" });
    expect(parsed.item).toBe("0gz8r4cm");
  });

  test("rejects a malformed item ref (item refs are nahel ids)", () => {
    const issues = rejectionIssues(
      observationFrontmatterSchema,
      { ...validObservation, item: "not-an-id" },
      "observation bad item ref",
    );
    expect(issues.some((i) => i.startsWith("item:") && i.includes("base32"))).toBe(true);
  });
});

describe("schema/records — config", () => {
  test("accepts a valid config (knowledge paths + actor entry)", () => {
    expectAccepted(configSchema, validConfig, "config valid");
    expectAccepted(
      configSchema,
      { ...validConfig, actor: { kind: "agent", id: "claude-code", session: "s1" } },
      "config with session",
    );
  });

  test("rejects a missing knowledge path, pointing at it", () => {
    const issues = rejectionIssues(
      configSchema,
      { ...validConfig, knowledge: { product: "PRODUCT.md", context: "CONTEXT.md" } },
      "config missing adr path",
    );
    expect(issues.some((i) => i.startsWith("knowledge.adr:"))).toBe(true);
  });

  test("rejects an actor entry with a bad kind", () => {
    const issues = rejectionIssues(
      configSchema,
      { ...validConfig, actor: { kind: "bot", id: "x" } },
      "config bad actor kind",
    );
    expect(issues.some((i) => i.startsWith("actor.kind:"))).toBe(true);
  });

  test("rejects unknown config keys, naming them", () => {
    const issues = rejectionIssues(
      configSchema,
      { ...validConfig, knowlege: {} },
      "config unknown key",
    );
    expect(issues.some((i) => i.includes("knowlege"))).toBe(true);
  });
});

describe("schema/records — run contract (F2.1, ADR-0014)", () => {
  const withContract = (contract: unknown) => ({ ...validConfig, contract });

  test("a config with no contract section stays valid (the section is optional)", () => {
    expectAccepted(configSchema, validConfig, "config no contract");
  });

  test("accepts a minimal contract (launch/seed/test commands)", () => {
    expectAccepted(
      configSchema,
      withContract({ launch: "bun run dev", seed: "bun run seed", test: "bun test" }),
      "contract minimal",
    );
  });

  test("accepts a full contract (healthcheck, ports, env var names)", () => {
    expectAccepted(
      configSchema,
      withContract({
        launch: "bun run dev",
        seed: "bun run seed",
        test: "bun test",
        healthcheck: "curl -fsS localhost:3000/health",
        ports: [3000, 5432],
        env: ["DATABASE_URL", "STRIPE_SECRET_KEY"],
      }),
      "contract full",
    );
  });

  test("rejects a contract missing a required command, pointing at it", () => {
    const issues = rejectionIssues(
      configSchema,
      withContract({ launch: "bun run dev", test: "bun test" }),
      "contract missing seed",
    );
    expect(issues.some((i) => i.startsWith("contract.seed:"))).toBe(true);
  });

  test("rejects a required command that is an empty string", () => {
    const issues = rejectionIssues(
      configSchema,
      withContract({ launch: "", seed: "s", test: "t" }),
      "contract empty launch",
    );
    expect(issues.some((i) => i.startsWith("contract.launch:"))).toBe(true);
  });

  test("rejects a non-integer port, pointing at the offending entry", () => {
    const issues = rejectionIssues(
      configSchema,
      withContract({ launch: "l", seed: "s", test: "t", ports: [3000, 8.5] }),
      "contract non-integer port",
    );
    expect(issues.some((i) => i.startsWith("contract.ports.1:"))).toBe(true);
  });

  test("rejects an env entry that is not a non-empty string, pointing at it", () => {
    const issues = rejectionIssues(
      configSchema,
      withContract({ launch: "l", seed: "s", test: "t", env: ["OK", ""] }),
      "contract empty env name",
    );
    expect(issues.some((i) => i.startsWith("contract.env.1:"))).toBe(true);
  });

  test("rejects an unknown contract key, naming it (strict object)", () => {
    const issues = rejectionIssues(
      configSchema,
      withContract({ launch: "l", seed: "s", test: "t", secrets: ["NOPE"] }),
      "contract unknown key",
    );
    expect(issues.some((i) => i.includes("secrets"))).toBe(true);
  });
});

describe("schema/records — responsibility routing (F3.1, ADR-0015)", () => {
  const withRouting = (routing: unknown) => ({ ...validConfig, routing });

  test("a config with no routing section stays valid (the section is optional)", () => {
    expectAccepted(configSchema, validConfig, "config no routing");
  });

  test("accepts a single responsibility with just an agent", () => {
    expectAccepted(
      configSchema,
      withRouting({ implementation: { agent: "claude-code" } }),
      "routing agent only",
    );
  });

  test("accepts every enum responsibility plus a default, agent and/or model", () => {
    expectAccepted(
      configSchema,
      withRouting({
        architecture: { agent: "codex", model: "gpt-5" },
        implementation: { model: "claude-opus-4" },
        review: { agent: "codex" },
        default: { agent: "claude-code", model: "claude-sonnet-4" },
      }),
      "routing full",
    );
  });

  test("rejects a routing entry that sets neither agent nor model", () => {
    const issues = rejectionIssues(
      configSchema,
      withRouting({ review: {} }),
      "routing entry empty",
    );
    expect(issues.some((i) => i.includes("agent") && i.includes("model"))).toBe(true);
  });

  test("rejects a non-enum responsibility key, naming it (unknown responsibilities rejected)", () => {
    const issues = rejectionIssues(
      configSchema,
      withRouting({ testing: { agent: "codex" } }),
      "routing non-enum key",
    );
    expect(issues.some((i) => i.includes("testing"))).toBe(true);
  });

  test("rejects an unknown key inside a routing entry (strict object)", () => {
    const issues = rejectionIssues(
      configSchema,
      withRouting({ implementation: { agent: "codex", provider: "openai" } }),
      "routing entry unknown key",
    );
    expect(issues.some((i) => i.includes("provider"))).toBe(true);
  });
});

describe("schema/records — compaction thresholds (F6.2)", () => {
  const withCompaction = (compaction: unknown) => ({ ...validConfig, compaction });

  test("a config with no compaction section stays valid (the section is optional)", () => {
    expectAccepted(configSchema, validConfig, "config no compaction");
  });

  test("accepts count and age thresholds, together or alone", () => {
    expectAccepted(
      configSchema,
      withCompaction({ max_events: 500, max_age_days: 14 }),
      "compaction both",
    );
    expectAccepted(configSchema, withCompaction({ max_events: 500 }), "compaction count only");
    expectAccepted(configSchema, withCompaction({ max_age_days: 14 }), "compaction age only");
    expectAccepted(configSchema, withCompaction({}), "compaction empty (defaults apply)");
  });

  test("rejects non-positive and fractional thresholds, naming the field", () => {
    for (const [value, label] of [
      [{ max_events: 0 }, "compaction zero events"],
      [{ max_events: 1.5 }, "compaction fractional events"],
      [{ max_age_days: -1 }, "compaction negative age"],
      [{ max_age_days: 2.5 }, "compaction fractional age"],
    ] as const) {
      const issues = rejectionIssues(configSchema, withCompaction(value), label);
      expect(issues.some((i) => i.startsWith("compaction."))).toBe(true);
    }
  });

  test("rejects unknown compaction keys (a typo is an error, not silent state)", () => {
    const issues = rejectionIssues(
      configSchema,
      withCompaction({ maxEvents: 10 }),
      "compaction unknown key",
    );
    expect(issues.some((i) => i.includes("maxEvents"))).toBe(true);
  });

  test("the retired validate.compaction_overdue_events key is rejected (moved to compaction.max_events)", () => {
    const issues = rejectionIssues(
      configSchema,
      { ...validConfig, validate: { compaction_overdue_events: 5 } },
      "config retired compaction key",
    );
    expect(issues.some((i) => i.includes("compaction_overdue_events"))).toBe(true);
  });
});

describe("schema/records — inception tier (F4.1)", () => {
  const withInception = (inception: unknown) => ({ ...validConfig, inception });

  test("a config with no inception section stays valid (the section is optional)", () => {
    expectAccepted(configSchema, validConfig, "config no inception");
  });

  test("accepts every tier — seed, standard, and the deferred-but-recordable full", () => {
    expectAccepted(configSchema, withInception({ tier: "seed" }), "inception seed");
    expectAccepted(configSchema, withInception({ tier: "standard" }), "inception standard");
    expectAccepted(configSchema, withInception({ tier: "full" }), "inception full");
  });

  test("rejects a non-enum tier, pointing at the field", () => {
    const issues = rejectionIssues(
      configSchema,
      withInception({ tier: "quick" }),
      "inception bad tier",
    );
    expect(issues.some((i) => i.startsWith("inception.tier:"))).toBe(true);
  });

  test("rejects an inception section without a tier — the tier IS the record", () => {
    const issues = rejectionIssues(configSchema, withInception({}), "inception empty");
    expect(issues.some((i) => i.startsWith("inception.tier:"))).toBe(true);
  });

  test("rejects unknown inception keys (a typo is an error, not silent state)", () => {
    const issues = rejectionIssues(
      configSchema,
      withInception({ tier: "seed", upgraded: true }),
      "inception unknown key",
    );
    expect(issues.some((i) => i.includes("upgraded"))).toBe(true);
  });
});

describe("schema/records — governance (F4, roadmap §7)", () => {
  const withGovernance = (governance: unknown) => ({ ...validConfig, governance });

  test("a config with no governance section stays valid (the section is optional)", () => {
    expectAccepted(configSchema, validConfig, "config no governance");
  });

  test("accepts human and delegated modes per area, mixed freely", () => {
    expectAccepted(
      configSchema,
      withGovernance({ product: "human", architecture: "human" }),
      "governance all human",
    );
    expectAccepted(
      configSchema,
      withGovernance({ product: "human", architecture: "delegated" }),
      "governance mixed",
    );
    expectAccepted(
      configSchema,
      withGovernance({ product: "delegated", architecture: "delegated" }),
      "governance all delegated",
    );
  });

  test("rejects a non-enum mode, pointing at the area", () => {
    const issues = rejectionIssues(
      configSchema,
      withGovernance({ product: "auto", architecture: "human" }),
      "governance bad mode",
    );
    expect(issues.some((i) => i.startsWith("governance.product:"))).toBe(true);
  });

  test("rejects a governance section that omits an area — both areas are declared or none", () => {
    const issues = rejectionIssues(
      configSchema,
      withGovernance({ product: "human" }),
      "governance missing architecture",
    );
    expect(issues.some((i) => i.startsWith("governance.architecture:"))).toBe(true);
  });

  test("rejects unknown governance areas (the vocabulary is a deliberate schema change)", () => {
    const issues = rejectionIssues(
      configSchema,
      withGovernance({ product: "human", architecture: "human", qa: "delegated" }),
      "governance unknown area",
    );
    expect(issues.some((i) => i.includes("qa"))).toBe(true);
  });
});

describe("schema/records — distilled segment list (F6, ADR-0012)", () => {
  test("accepts a list of archived segment filenames (and the empty list)", () => {
    expectAccepted(
      distilledSchema,
      ["run-abcdefgh.jsonl", "session-0gz8r4cm.jsonl"],
      "distilled valid",
    );
    expectAccepted(distilledSchema, [], "distilled empty");
  });

  test("rejects entries that are not journal segment filenames", () => {
    for (const [value, label] of [
      [["notes.md"], "distilled non-segment"],
      [["run-UPPER123.jsonl"], "distilled bad id"],
      [["../escape.jsonl"], "distilled traversal"],
      [[""], "distilled empty entry"],
    ] as const) {
      const issues = rejectionIssues(distilledSchema, value, label);
      expect(issues.some((i) => i.includes("segment"))).toBe(true);
    }
  });

  test("rejects a non-array shape (union semantics need a plain list)", () => {
    rejectionIssues(distilledSchema, { segments: [] }, "distilled non-array");
  });
});

describe("schema/records — actor", () => {
  test("session is optional but must be non-empty when present", () => {
    expectAccepted(actorSchema, { kind: "human", id: "jim" }, "actor no session");
    expectAccepted(
      actorSchema,
      { kind: "agent", id: "codex", session: "run-1" },
      "actor with session",
    );
    const issues = rejectionIssues(
      actorSchema,
      { kind: "agent", id: "codex", session: "" },
      "actor empty session",
    );
    expect(issues.some((i) => i.startsWith("session:"))).toBe(true);
  });
});

describe("schema/records — determinism through the injected Env", () => {
  test("identical fixed Envs build byte-identical validated records", () => {
    const build = (): WorkItemFrontmatter => {
      const env = fixedEnv({
        now: "2026-03-01T09:30:00Z",
        randoms: [0.03, 0.11, 0.42, 0.9, 0.66, 0.31, 0.77, 0.005],
      });
      return workItemFrontmatterSchema.parse({
        id: generateId(env),
        name: "deterministic-item",
        type: "chore",
        status: "backlog",
        lane: "direct",
        depends_on: [],
        external_refs: [],
        created: env.now(),
        updated: env.now(),
      });
    };
    const first = build();
    const second = build();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

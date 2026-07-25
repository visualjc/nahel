import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { configCommand, SETTABLE_CONFIG_SECTIONS } from "../../src/commands/config";
import { readMergeAuthority } from "../../src/governance/authority";
import type { JournalEvent } from "../../src/schema/records";
import { listSegments, readJournal } from "../../src/store/journal";
import { ensureLayout, readConfig, writeConfig, type StoreLayout } from "../../src/store/layout";
import { validateStore } from "../../src/validate";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel config set` (PRD F4): atomically replace exactly one OPTIONAL
 * top-level config section, validating the whole config against the schema
 * before any write, journaling the change write-ahead as `config.updated`.
 * This is the CLI path the inception and setup-routing workflows write
 * config through — agents never hand-edit `nahel/config`. Refusals write
 * nothing at all: the config bytes stay untouched and no event is journaled.
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

async function setup(configOverrides: Parameters<typeof makeConfig>[0] = {}) {
  const root = await makeTempDir("nahel-cmd-config-");
  dirs.push(root);
  const layout = await ensureLayout(root);
  await writeConfig(layout, makeConfig(configOverrides));
  const env = seededEnv({ tickSeconds: 1 });
  return { root, layout, env };
}

async function journalEvents(layout: StoreLayout): Promise<JournalEvent[]> {
  return Array.fromAsync(readJournal(layout));
}

async function configBytes(layout: StoreLayout): Promise<string> {
  return readFile(layout.configPath, "utf8");
}

describe("nahel config set — writing optional sections", () => {
  test("sets the inception tier: schema-valid on disk, journaled write-ahead, validate green", async () => {
    const { root, layout, env } = await setup();
    const code = await configCommand.run(["set", "inception", "--data", "tier=seed"], env, root);
    expect(errs.join("\n")).toBe("");
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("inception");

    // The recorded tier is committed, schema-validated state (F4 acceptance).
    expect((await readConfig(layout)).inception).toEqual({ tier: "seed" });
    const errors = (await validateStore(layout)).filter((f) => f.severity === "error");
    expect(errors).toEqual([]);

    const act = (await journalEvents(layout)).find((event) => event.type === "config.updated")!;
    expect(act).toBeDefined();
    expect(act.payload).toEqual({ section: "inception", value: { tier: "seed" } });
  });

  test("records the constitution signature beside the tier — what the F7 autonomy gate reads", async () => {
    const { root, layout, env } = await setup();
    // F7.2: "human-signed" must be mechanically verifiable, so the signature
    // is a schema-validated FIELD on the inception record, not a vibe about
    // what the constitution document says. The gate reads two things: this
    // field, and the actor of the config.updated act that wrote it — an
    // agent-set signature authorizes nothing (the F3.4 merge precedent).
    const code = await configCommand.run(
      ["set", "inception", "--data", "tier=standard", "--data", "constitution_signed_by=jim"],
      env,
      root,
    );
    expect(errs.join("\n")).toBe("");
    expect(code).toBe(0);
    expect((await readConfig(layout)).inception).toEqual({
      tier: "standard",
      constitution_signed_by: "jim",
    });
    const errors = (await validateStore(layout)).filter((f) => f.severity === "error");
    expect(errors).toEqual([]);

    // The act carries the signer's provenance: section, value, and the actor
    // the gate checks for kind `human`.
    const act = (await journalEvents(layout)).find((event) => event.type === "config.updated")!;
    expect(act.payload).toEqual({
      section: "inception",
      value: { tier: "standard", constitution_signed_by: "jim" },
    });
    expect(act.actor.kind).toBeDefined();

    // An empty signature is not a signature: the schema refuses it, and the
    // refusal leaves the previously recorded section untouched.
    errs = [];
    expect(
      await configCommand.run(
        ["set", "inception", "--data", "tier=standard", "--data", "constitution_signed_by="],
        env,
        root,
      ),
    ).toBe(1);
    expect(errs.join("\n")).toContain("constitution_signed_by");
    expect((await readConfig(layout)).inception).toEqual({
      tier: "standard",
      constitution_signed_by: "jim",
    });
  });

  test("sets governance from a JSON --data payload", async () => {
    const { root, layout, env } = await setup();
    const code = await configCommand.run(
      ["set", "governance", "--data", '{"product": "human", "architecture": "delegated"}'],
      env,
      root,
    );
    expect(code).toBe(0);
    expect((await readConfig(layout)).governance).toEqual({
      product: "human",
      architecture: "delegated",
    });
  });

  test("key=val entries JSON-parse values (numbers stay numbers) and merge left to right", async () => {
    const { root, layout, env } = await setup();
    const code = await configCommand.run(
      ["set", "compaction", "--data", "max_events=100", "--data", "max_age_days=14"],
      env,
      root,
    );
    expect(code).toBe(0);
    expect((await readConfig(layout)).compaction).toEqual({ max_events: 100, max_age_days: 14 });
  });

  test("replaces exactly the named section: other sections survive, the old section is gone entirely", async () => {
    const { root, layout, env } = await setup({
      contract: { launch: "bun run dev", seed: "bun run seed", test: "bun test" },
      routing: { review: { agent: "codex" }, default: { agent: "claude-code" } },
    });
    const code = await configCommand.run(
      ["set", "routing", "--data", '{"implementation": {"model": "claude-opus-4"}}'],
      env,
      root,
    );
    expect(code).toBe(0);
    const config = await readConfig(layout);
    // Whole-section replacement, not a merge: review/default are gone.
    expect(config.routing).toEqual({ implementation: { model: "claude-opus-4" } });
    // Untargeted sections are untouched.
    expect(config.contract).toEqual({
      launch: "bun run dev",
      seed: "bun run seed",
      test: "bun test",
    });
    expect(config.knowledge).toEqual(makeConfig().knowledge);
    expect(config.actor).toEqual(makeConfig().actor);
  });

  test("re-running the same set writes identical bytes but journals the ACT again (acts repeat honestly)", async () => {
    const { root, layout, env } = await setup();
    expect(await configCommand.run(["set", "inception", "--data", "tier=standard"], env, root)).toBe(0);
    const bytes = await configBytes(layout);
    const first = (await journalEvents(layout)).filter((e) => e.type === "config.updated");
    expect(first).toHaveLength(1);

    logs = [];
    expect(await configCommand.run(["set", "inception", "--data", "tier=standard"], env, root)).toBe(0);
    // The committed value is byte-identical — the write is idempotent…
    expect(await configBytes(layout)).toBe(bytes);
    // …but the journal records ACTS, not diffs: a byte-equal re-set is a second
    // act, with its own actor. Swallowing it would make provenance repair
    // (an agent-set section re-attributed to a human) a silent no-op.
    const second = (await journalEvents(layout)).filter((e) => e.type === "config.updated");
    expect(second).toHaveLength(2);
    expect(second[1]!.payload).toEqual({ section: "inception", value: { tier: "standard" } });
    expect(logs.join("\n")).toContain("inception");
  });

  test("a HUMAN re-setting the value an AGENT set repairs provenance — the validate fix actually works (F3.4)", async () => {
    const { root, layout, env } = await setup();

    // The agent's flip: schema-valid, committed, and inert — an agent cannot
    // grant the human's standing merge authorization.
    expect(
      await configCommand.run(
        ["set", "merge", "--data", "authority=on-approve"],
        env,
        root,
        "agent:claude-code",
      ),
    ).toBe(0);
    const inert = await readMergeAuthority(layout, await readConfig(layout));
    console.log("[agent-set]", inert);
    expect(inert.effective).toBe("human");
    expect(inert.defect).toBe("agent-set");
    expect(
      (await validateStore(layout)).filter((f) => f.check === "merge.unauthorized"),
    ).toHaveLength(1);

    // The exact repair `nahel validate` prescribes: a HUMAN re-runs the SAME
    // command with the SAME value. The config bytes do not change; the
    // authorizing act does.
    expect(
      await configCommand.run(
        ["set", "merge", "--data", "authority=on-approve"],
        env,
        root,
        "human:jim",
      ),
    ).toBe(0);
    const repaired = await readMergeAuthority(layout, await readConfig(layout));
    console.log("[human re-set]", repaired);
    expect(repaired.effective).toBe("on-approve");
    expect(repaired.defect).toBeUndefined();
    expect(repaired.setBy?.actor).toEqual({ kind: "human", id: "jim" });
    expect((await validateStore(layout)).filter((f) => f.check === "merge.unauthorized")).toEqual(
      [],
    );
  });

  test("sets the merge authority, journaling the actor whose flip authorizes it (F3.4)", async () => {
    const { root, layout, env } = await setup();
    const code = await configCommand.run(
      ["set", "merge", "--data", "authority=on-approve"],
      env,
      root,
      "human:jim",
    );
    expect(errs.join("\n")).toBe("");
    expect(code).toBe(0);
    expect((await readConfig(layout)).merge).toEqual({ authority: "on-approve" });

    // The standing authorization IS this event: its actor is the provenance
    // the review loop checks before merging anything.
    const act = (await journalEvents(layout)).find((event) => event.type === "config.updated")!;
    expect(act.payload).toEqual({ section: "merge", value: { authority: "on-approve" } });
    expect(act.actor).toEqual({ kind: "human", id: "jim" });

    const errors = (await validateStore(layout)).filter((f) => f.severity === "error");
    expect(errors).toEqual([]);
  });

  test("the set's own session closes and archives — no active segments linger", async () => {
    const { root, layout, env } = await setup();
    expect(await configCommand.run(["set", "inception", "--data", "tier=seed"], env, root)).toBe(0);
    expect((await listSegments(layout)).active).toEqual([]);
  });
});

describe("nahel config set — refusals (config untouched, nothing journaled)", () => {
  test("an invalid tier is a schema error naming the field; the config bytes stay untouched", async () => {
    const { root, layout, env } = await setup();
    const before = await configBytes(layout);
    const code = await configCommand.run(["set", "inception", "--data", "tier=quick"], env, root);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("inception.tier");
    expect(await configBytes(layout)).toBe(before);
    expect(await journalEvents(layout)).toEqual([]);
  });

  test("a malformed section payload (missing required key) is refused with the schema's reason", async () => {
    const { root, layout, env } = await setup();
    const before = await configBytes(layout);
    const code = await configCommand.run(
      ["set", "contract", "--data", '{"launch": "bun run dev", "test": "bun test"}'],
      env,
      root,
    );
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("contract.seed");
    expect(await configBytes(layout)).toBe(before);
    expect(await journalEvents(layout)).toEqual([]);
  });

  test("an unknown key inside a section payload is refused (strict schema, typo surfaces)", async () => {
    const { root, layout, env } = await setup();
    const code = await configCommand.run(
      ["set", "inception", "--data", "tier=seed", "--data", "upgraded=true"],
      env,
      root,
    );
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("upgraded");
    expect(await journalEvents(layout)).toEqual([]);
  });

  test("an unknown merge authority is refused — the enum is strict, config untouched", async () => {
    const { root, layout, env } = await setup();
    const before = await configBytes(layout);
    const code = await configCommand.run(
      ["set", "merge", "--data", "authority=auto"],
      env,
      root,
      "human:jim",
    );
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("merge.authority");
    expect(await configBytes(layout)).toBe(before);
    expect(await journalEvents(layout)).toEqual([]);
  });

  test("refuses an unknown section, listing the settable ones", async () => {
    const { root, layout, env } = await setup();
    const code = await configCommand.run(["set", "telemetry", "--data", "on=true"], env, root);
    expect(code).toBe(1);
    for (const section of SETTABLE_CONFIG_SECTIONS) {
      expect(errs.join("\n")).toContain(section);
    }
    expect(await journalEvents(layout)).toEqual([]);
  });

  test("refuses the core sections (knowledge, actor) outright", async () => {
    const { root, layout, env } = await setup();
    const before = await configBytes(layout);
    for (const section of ["knowledge", "actor"]) {
      errs = [];
      const code = await configCommand.run(
        ["set", section, "--data", '{"kind": "human", "id": "mallory"}'],
        env,
        root,
      );
      expect(code).toBe(1);
      expect(errs.join("\n")).toContain(section);
    }
    expect(await configBytes(layout)).toBe(before);
    expect(await journalEvents(layout)).toEqual([]);
  });

  test("no --data at all is a usage error (an empty replacement must be explicit: --data {})", async () => {
    const { root, env } = await setup();
    const code = await configCommand.run(["set", "compaction"], env, root);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("usage");
  });

  test("a missing or unknown subcommand is a usage error", async () => {
    const { root, env } = await setup();
    expect(await configCommand.run([], env, root)).toBe(1);
    expect(errs.join("\n")).toContain("usage");
    errs = [];
    expect(await configCommand.run(["get", "routing"], env, root)).toBe(1);
    expect(errs.join("\n")).toContain("usage");
  });
});

describe("canonical workflow docs driving config set (F4, F3.2)", () => {
  /** Read a shipped workflow doc and prove it valid per the canonical format. */
  async function shippedWorkflow(file: string) {
    const path = join(import.meta.dir, "../../nahel/workflows", file);
    const { readFrontmatterFile } = await import("../../src/store/frontmatter");
    const { parseWorkflowDoc } = await import("../../src/install/workflow");
    const { frontmatter, body } = await readFrontmatterFile(path);
    return { parsed: parseWorkflowDoc(file, frontmatter), body };
  }

  test("nahel/workflows/inception.md is a valid canonical doc driving the founding mechanics", async () => {
    const { parsed, body } = await shippedWorkflow("inception.md");
    expect(parsed.name).toBe("inception");
    expect(parsed.description.length).toBeGreaterThan(0);
    // The judgment lives in the doc; the mechanics are exactly this CLI.
    expect(body).toContain("nahel config set inception");
    expect(body).toContain("nahel config set governance");
    expect(body).toContain("nahel config set contract");
    expect(body).toContain("nahel item new");
    // F2.2 config semantics: the written default is {product: delegated,
    // architecture: human} — the doc's example must record exactly that, and
    // must no longer claim new projects start all-human.
    expect(body).toContain("--data product=delegated");
    expect(body).toContain("--data architecture=human");
    expect(body).not.toContain("almost always start all-human");
    // F7.2: the constitution sign-off is RECORDED, in the same `config set
    // inception` call as the tier — the section replaces wholesale, so a tier
    // write that omits the signature erases it — and the human runs that
    // command themselves, because the gate reads the act's actor.
    expect(body).toContain("--data constitution_signed_by=");
    expect(body).toContain("in the SAME command");
    // Tier vocabulary, brownfield mode, and the ratchet are stated in the doc.
    for (const term of ["seed", "standard", "full", "rownfield", "ratchet"]) {
      expect(body).toContain(term);
    }
  });

  test("inception.md asks about merge authority and writes it, with the sparingly guidance and the human-runs-it rule (F3.4)", async () => {
    const { body } = await shippedWorkflow("inception.md");
    // F3.4 setup surface: founding is where merge authority gets decided, or
    // it never gets decided at all and the project inherits a default nobody
    // chose. The command is the doc's, verbatim.
    expect(body).toContain("nahel config set merge --data authority=");
    expect(body).toContain("human");
    expect(body).toContain("on-approve");
    // The guidance the PRD requires every surface writing this flag to carry.
    expect(body).toContain("SPARINGLY");
    expect(body).toContain("small items, or changes QA testing covers well");
    // The default when the founder has no opinion — never inferred upward.
    expect(body.toLowerCase()).toContain("default");
    // Provenance: on-approve is the HUMAN's standing authorization, so an
    // agent-run set is inert — the doc must say so where it is written, or a
    // founding agent will helpfully set it and silently authorize nothing.
    expect(body).toContain("the HUMAN runs");
    expect(body).toContain("inert");
    expect(body).toContain("merge.unauthorized");
  });

  test("nahel/workflows/setup-routing.md is a valid canonical doc writing routing via the CLI", async () => {
    const { parsed, body } = await shippedWorkflow("setup-routing.md");
    expect(parsed.name).toBe("setup-routing");
    expect(parsed.description.length).toBeGreaterThan(0);
    expect(body).toContain("nahel config set routing");
    // Detection covers the known agent CLIs; semantics are advisory (ADR-0015).
    for (const cli of ["claude", "codex", "cursor-agent", "opencode"]) {
      expect(body).toContain(cli);
    }
    expect(body.toLowerCase()).toContain("advisory");
  });
});

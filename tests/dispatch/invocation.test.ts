import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeInvocation,
  DISPATCH_AGENT_DEFAULTS,
  DispatchRoutingError,
  ORIENTATION_COMMAND,
  resolveAgent,
  resolveReviewSlotRoute,
  resolveReviewSlots,
  resolveRoute,
  REVIEW_SLOT_CHAINS,
  UnknownAgentKindError,
} from "../../src/dispatch/invocation";
import { renderTaskDoc } from "../../src/dispatch/handoff";
import type { Routing } from "../../src/schema/records";
import {
  RESULT_DOC_CONTRACT,
  RESULT_DOC_STATUSES,
  resultDocRelativePath,
  taskDocRelativePath,
} from "../../src/store/result";

/**
 * Dispatch invocation composition (PRD F1.1–F1.3, ADR-0015/0016): the PURE
 * half of `nahel dispatch` — routing resolution, per-agent-CLI invocation
 * knowledge, and the composed argv/prompt. Zero I/O, zero LLM calls: every
 * function here is a deterministic function of committed config plus the
 * task args, which is what makes the recorded invocation provable.
 */

const ROUTING: Routing = {
  implementation: { agent: "claude", model: "claude-opus-5" },
  review: { agent: "codex", model: "gpt-5" },
  default: { agent: "cursor-agent", model: "auto" },
};

describe("shipped invocation defaults (F1.3 — real agent CLIs)", () => {
  test("claude runs headless with -p and takes --model", () => {
    expect(DISPATCH_AGENT_DEFAULTS.claude).toEqual({
      binary: "claude",
      args: ["-p"],
      model_flag: "--model",
    });
  });

  test("codex runs headless through its `exec` subcommand and takes --model", () => {
    expect(DISPATCH_AGENT_DEFAULTS.codex).toEqual({
      binary: "codex",
      args: ["exec"],
      model_flag: "--model",
    });
  });

  test("cursor-agent runs headless with -p and takes --model", () => {
    expect(DISPATCH_AGENT_DEFAULTS["cursor-agent"]).toEqual({
      binary: "cursor-agent",
      args: ["-p"],
      model_flag: "--model",
    });
  });

  test("every shipped default delivers the prompt as a trailing argument", () => {
    // The composer appends the prompt last for every kind; a default whose
    // CLI could not take a positional prompt would silently drop the pointer.
    for (const [kind, spec] of Object.entries(DISPATCH_AGENT_DEFAULTS)) {
      const composed = composeInvocation({
        responsibility: "implementation",
        agent: kind,
        model: undefined,
        spec,
        item: "mb6gxyk4",
        run: "zdbbkrgp",
      });
      expect(composed.args[composed.args.length - 1]).toBe(composed.prompt);
      expect(composed.prompt).toContain(taskDocRelativePath("zdbbkrgp"));
    }
  });
});

describe("routing resolution (F1.2 — responsibility first, then default)", () => {
  test("a responsibility-specific route wins over the default", () => {
    expect(resolveRoute(ROUTING, "implementation")).toEqual({
      responsibility: "implementation",
      agent: "claude",
      model: "claude-opus-5",
      via: "routing.implementation",
    });
  });

  test("with no responsibility-specific route, resolution falls back to the default", () => {
    const routing: Routing = { default: { agent: "cursor-agent", model: "auto" } };
    expect(resolveRoute(routing, "architecture")).toEqual({
      responsibility: "architecture",
      agent: "cursor-agent",
      model: "auto",
      via: "routing.default",
    });
  });

  test("a route with an agent but no model resolves with no model (the CLI's own default)", () => {
    const routing: Routing = { review: { agent: "codex" } };
    expect(resolveRoute(routing, "review")).toEqual({
      responsibility: "review",
      agent: "codex",
      model: undefined,
      via: "routing.review",
    });
  });

  test("neither a specific route nor a default fails loudly, naming the missing route and the exact fix", () => {
    const routing: Routing = { review: { agent: "codex" } };
    let error: unknown;
    try {
      resolveRoute(routing, "implementation");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DispatchRoutingError);
    const message = (error as Error).message;
    console.log("[no route]", message);
    expect(message).toContain("routing.implementation");
    expect(message).toContain("routing.default");
    expect(message).toContain("nahel config set routing --data");
    // `config set` REPLACES the whole section, so the offered fix must carry
    // the entries already configured — pasting it must not wipe review.
    expect(message).toContain('"review":{"agent":"codex"}');
    expect(message).toContain('"implementation"');
  });

  test("a repo with no routing section at all gets the same actionable refusal", () => {
    let error: unknown;
    try {
      resolveRoute(undefined, "review");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DispatchRoutingError);
    expect((error as Error).message).toContain("nahel config set routing --data");
  });

  test("a resolved route with a model but no agent refuses — there is nothing to spawn", () => {
    const routing: Routing = { implementation: { model: "claude-opus-5" } };
    let error: unknown;
    try {
      resolveRoute(routing, "implementation");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DispatchRoutingError);
    const message = (error as Error).message;
    console.log("[model-only route]", message);
    expect(message).toContain("routing.implementation");
    expect(message).toContain("agent");
    expect(message).toContain("nahel config set routing --data");
  });

  test("the offered fix is shell-safe: a hostile committed value cannot break out of its quotes", () => {
    // The refusal advertises a paste-ready command. Config is committed data an
    // agent may have written, so a model value containing a single quote must
    // not end the quoting and start a command.
    // A fresh marker path per run: the injected command's only observable
    // effect is creating it, so "was never created" is the security assertion.
    const marker = join(tmpdir(), `nahel-pwned-${Math.random().toString(36).slice(2)}`);
    rmSync(marker, { force: true });
    const hostile = `gpt-5'; touch ${marker}; echo '`;
    const routing: Routing = { review: { agent: "codex", model: hostile } };
    let message = "";
    try {
      resolveRoute(routing, "implementation");
    } catch (error) {
      message = (error as Error).message;
    }
    console.log("[hostile route fix]", message);

    // Extract exactly what the fix hands to the shell after `--data`.
    const dataArg = message.slice(message.indexOf("--data ") + "--data ".length);
    // A real shell must see ONE argument whose bytes are the JSON verbatim —
    // that is what "not injectable" means, and only a shell can prove it.
    const proc = Bun.spawnSync(["sh", "-c", `printf %s ${dataArg}`]);
    expect(proc.exitCode).toBe(0);
    const roundTripped = proc.stdout.toString();
    console.log("[round-tripped]", roundTripped);
    expect(JSON.parse(roundTripped)).toEqual({
      review: { agent: "codex", model: hostile },
      implementation: { agent: "<claude|codex|cursor-agent>", model: "<model>" },
    });
    // The injected command never ran (it would have created the marker).
    expect(existsSync(marker)).toBe(false);
  });

  test("resolution is deterministic — the same config resolves identically every time", () => {
    expect(resolveRoute(ROUTING, "review")).toEqual(resolveRoute(ROUTING, "review"));
  });
});

/**
 * The review loop's second slot as a DISPATCHABLE route (PRD F3.1). Slot 2 was
 * reviewable only in-session, which made the loop drivable by exactly one
 * vendor — `routing.review2`'s — and every other capable host had to park,
 * contradicting "any capable agent can be the runner". The slot keeps its
 * routing-key shape (ADR-0015: no fourth responsibility); what changes is that
 * the `review` responsibility can be dispatched THROUGH slot 2's chain.
 */
describe("review slot routes (F3.1 — slot 2 is dispatchable through the review responsibility)", () => {
  test("slot 2 resolves through review2 first, and reports the key that answered", () => {
    const routing: Routing = {
      implementation: { agent: "claude", model: "claude-opus-5" },
      review: { agent: "codex", model: "gpt-5" },
      review2: { agent: "cursor-agent", model: "auto" },
    };
    expect(resolveReviewSlotRoute(routing, 2)).toEqual({
      responsibility: "review",
      agent: "cursor-agent",
      model: "auto",
      via: "routing.review2",
    });
    // Slot 1 stays dispatch's own chain — same answer as resolveRoute.
    expect(resolveReviewSlotRoute(routing, 1)).toEqual(resolveRoute(routing, "review"));
  });

  test("with review2 unset, slot 2 falls through to implementation, then to default", () => {
    const noReview2: Routing = {
      implementation: { agent: "claude", model: "claude-opus-5" },
      review: { agent: "codex" },
    };
    expect(resolveReviewSlotRoute(noReview2, 2)).toEqual({
      responsibility: "review",
      agent: "claude",
      model: "claude-opus-5",
      via: "routing.implementation",
    });
    const defaultOnly: Routing = { review: { agent: "codex" }, default: { agent: "claude" } };
    expect(resolveReviewSlotRoute(defaultOnly, 2).via).toBe("routing.default");
  });

  test("the slot-2 chain is the SAME chain the same-vendor warning walks — one definition", () => {
    // A warning resolving slot 2 differently from the dispatch that fills it
    // would tell a project its pairing is fine and then dispatch the wrong
    // vendor (or vice versa). Both read REVIEW_SLOT_CHAINS.
    expect(REVIEW_SLOT_CHAINS[1]).toEqual(["review", "default"]);
    expect(REVIEW_SLOT_CHAINS[2]).toEqual(["review2", "implementation", "default"]);
    const routing: Routing = {
      implementation: { agent: "claude" },
      review: { agent: "codex" },
      review2: { agent: "cursor-agent" },
    };
    const slots = resolveReviewSlots(routing)!;
    expect(slots.slot1.agent).toBe(resolveReviewSlotRoute(routing, 1).agent);
    expect(slots.slot2.agent).toBe(resolveReviewSlotRoute(routing, 2).agent);
    expect(slots.slot2.via).toBe(resolveReviewSlotRoute(routing, 2).via);
  });

  test("a slot 2 no key answers refuses loudly, naming every key in its chain and the fix", () => {
    let error: unknown;
    try {
      resolveReviewSlotRoute({ review: { agent: "codex" } }, 2);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DispatchRoutingError);
    const message = (error as Error).message;
    console.log("[no slot-2 route]", message);
    expect(message).toContain("routing.review2");
    expect(message).toContain("routing.implementation");
    expect(message).toContain("routing.default");
    expect(message).toContain("nahel config set routing --data");
    // The offered fix proposes the review2 entry, keeping what is configured.
    expect(message).toContain('"review":{"agent":"codex"}');
    expect(message).toContain('"review2"');
  });

  test("an entry naming a model but no agent is skipped, not fatal — the chain keeps walking", () => {
    // resolveReviewSlots already treats an agentless entry as "answers
    // nothing" (a vendor IS an agent id); the dispatchable route must agree,
    // or a half-written review2 would break a loop the warning calls fine.
    const routing: Routing = {
      review2: { model: "auto" },
      implementation: { agent: "claude", model: "claude-opus-5" },
    };
    expect(resolveReviewSlotRoute(routing, 2).via).toBe("routing.implementation");
  });
});

describe("agent-kind resolution (F1.3 — config data with shipped defaults)", () => {
  test("a known kind with no config override resolves to the shipped default", () => {
    expect(resolveAgent("codex", undefined)).toEqual(DISPATCH_AGENT_DEFAULTS.codex);
  });

  test("a config entry replaces the shipped default wholesale (config set semantics)", () => {
    const spec = { binary: "/opt/homebrew/bin/claude", args: ["-p", "--dangerously-skip-permissions"] };
    expect(resolveAgent("claude", { claude: spec })).toEqual(spec);
  });

  test("an override for one kind leaves the other kinds on their shipped defaults", () => {
    const overrides = { claude: { binary: "stub", args: [] } };
    expect(resolveAgent("codex", overrides)).toEqual(DISPATCH_AGENT_DEFAULTS.codex);
  });

  test("an unknown agent kind is refused by dispatch itself, naming the known kinds", () => {
    let error: unknown;
    try {
      resolveAgent("opencode", undefined);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UnknownAgentKindError);
    const message = (error as Error).message;
    console.log("[unknown kind]", message);
    expect(message).toContain("opencode");
    expect(message).toContain("claude");
    expect(message).toContain("codex");
    expect(message).toContain("cursor-agent");
  });
});

describe("invocation composition (F1.1 — binary, model flag, actor env, orientation preamble)", () => {
  const compose = (overrides: Partial<Parameters<typeof composeInvocation>[0]> = {}) =>
    composeInvocation({
      responsibility: "implementation",
      agent: "claude",
      model: "claude-opus-5",
      spec: DISPATCH_AGENT_DEFAULTS.claude,
      ...overrides,
    });

  /** An item-scoped dispatch — the only shape that is ever actually spawned. */
  const dispatched = (overrides: Partial<Parameters<typeof composeInvocation>[0]> = {}) =>
    compose({ item: "mb6gxyk4", run: "zdbbkrgp", ...overrides });

  test("composes binary, base args, the model flag, and the prompt as the trailing arg", () => {
    const composed = compose();
    console.log("[composed]", composed.binary, composed.args.slice(0, 3));
    expect(composed.binary).toBe("claude");
    expect(composed.args.slice(0, 3)).toEqual(["-p", "--model", "claude-opus-5"]);
    expect(composed.args).toHaveLength(4);
  });

  test("carries the worker's own actor identity as NAHEL_ACTOR", () => {
    expect(compose().env).toEqual({ NAHEL_ACTOR: "agent:claude" });
  });

  test("a route with no model composes no model flag at all", () => {
    const composed = compose({ model: undefined });
    expect(composed.args).toHaveLength(2);
    expect(composed.args[0]).toBe("-p");
    expect(composed.args[1]).toBe(composed.prompt);
    expect(composed.args.join(" ")).not.toContain("--model");
  });

  test("a model with no model_flag on the agent spec refuses rather than silently dropping it", () => {
    let error: unknown;
    try {
      compose({ spec: { binary: "claude", args: [] } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DispatchRoutingError);
    console.log("[model, no flag]", (error as Error).message);
    expect((error as Error).message).toContain("model_flag");
  });

  test("the orientation preamble directs the worker to `nahel brief` AHEAD of the task pointer", () => {
    const prompt = dispatched().prompt;
    console.log("[prompt]\n" + prompt);
    const orientation = prompt.indexOf(ORIENTATION_COMMAND);
    const pointer = prompt.indexOf(taskDocRelativePath("zdbbkrgp"));
    expect(orientation).toBeGreaterThanOrEqual(0);
    expect(pointer).toBeGreaterThanOrEqual(0);
    expect(orientation).toBeLessThan(pointer);
  });

  test("the prompt is the trailing argument, so the recorded argv carries the whole contract", () => {
    const composed = compose();
    expect(composed.args[composed.args.length - 1]).toBe(composed.prompt);
  });

  test("the preamble names the responsibility and the worker's actor", () => {
    const prompt = compose().prompt;
    expect(prompt).toContain("implementation");
    expect(prompt).toContain("agent:claude");
  });

  test("with an item and run, the preamble names both so the worker can record progress", () => {
    const prompt = compose({ item: "mb6gxyk4", run: "zdbbkrgp" }).prompt;
    console.log("[prompt with item/run]\n" + prompt);
    expect(prompt).toContain("mb6gxyk4");
    expect(prompt).toContain("nahel run update zdbbkrgp");
  });

  test("without an item, the preamble mentions no item or run at all", () => {
    // The runless composition is the PROBE the command fires before touching
    // state (it is never spawned): preamble only, no run dir to point at.
    const prompt = compose().prompt;
    expect(prompt.toLowerCase()).not.toContain("work item:");
    expect(prompt).not.toContain("nahel run update");
    expect(prompt).not.toContain("task.md");
    expect(prompt).not.toContain("result.md");
  });

  test("composition is deterministic — identical inputs compose byte-identical invocations", () => {
    expect(JSON.stringify(dispatched())).toBe(JSON.stringify(dispatched()));
    // Byte-identity of the prompt itself, not merely a structural match.
    expect(dispatched().prompt).toBe(dispatched().prompt);
  });
});

/**
 * The pointer prompt (PRD F3): the task no longer travels in argv. The prompt
 * carries ids, two repo-relative paths, and the fixed result contract — never
 * task content. That is what makes its size bounded BY CONSTRUCTION, which is
 * the whole point: a multi-hundred-KB brief inlined into an agent CLI's command
 * line hung codex in the field (journal nt93edc0).
 */
describe("pointer prompt (F3 — the task travels as a document, not as argv)", () => {
  const RUN = "zdbbkrgp";
  const ITEM = "mb6gxyk4";
  const pointer = () =>
    composeInvocation({
      responsibility: "implementation",
      agent: "claude",
      model: "claude-opus-5",
      spec: DISPATCH_AGENT_DEFAULTS.claude,
      item: ITEM,
      run: RUN,
    });

  /**
   * Why a FIXED bound rather than "smaller than the task": the prompt has no
   * task input at all any more, so the only way it can grow is a future change
   * re-inlining content into it. 4096 bytes is comfortably above the composed
   * pointer (~1 KB) and far below anything an argv limit or a CLI's own prompt
   * handling would struggle with — it fails loudly if content creeps back in.
   */
  const PROMPT_BYTE_BOUND = 4096;

  test("the prompt names the run id and both repo-relative document paths", () => {
    const prompt = pointer().prompt;
    console.log("[pointer prompt]\n" + prompt);
    expect(prompt).toContain(RUN);
    expect(prompt).toContain(ITEM);
    expect(prompt).toContain(`nahel/runs/${RUN}/task.md`);
    expect(prompt).toContain(`nahel/runs/${RUN}/result.md`);
    // Rendered through the store's own path helpers, so prompt and store can
    // never disagree about where the documents live.
    expect(prompt).toContain(taskDocRelativePath(RUN));
    expect(prompt).toContain(resultDocRelativePath(RUN));
  });

  test("the prompt tells the worker to read the task document in full and follow it", () => {
    const prompt = pointer().prompt.toLowerCase();
    expect(prompt).toContain("read it in full");
    expect(prompt).toContain("follow it");
  });

  test("the prompt embeds the result-document contract verbatim, from its single source", () => {
    // Asserted through the imported const, never a retyped copy: the keys a
    // worker is told to write and the keys the parser demands are ONE string,
    // so they cannot drift (the anti-drift design of src/store/result.ts).
    const prompt = pointer().prompt;
    expect(prompt).toContain(RESULT_DOC_CONTRACT);
    for (const key of ["run", "item", "status", "summary"]) {
      expect(prompt).toContain(`${key}:`);
    }
    for (const status of RESULT_DOC_STATUSES) {
      expect(prompt).toContain(status);
    }
  });

  test("a multi-hundred-KB task leaves the prompt untouched and under the fixed byte bound", () => {
    // The pathological case from the PRD's F3 acceptance. The task exists —
    // 300 KB of it — but it lives in the handoff document, so the composed
    // invocation cannot even see it: same bytes as any other dispatch.
    const task = `${"x".repeat(300_000)}\n`;
    const doc = renderTaskDoc({
      run: RUN,
      item: ITEM,
      responsibility: "implementation",
      created: "2026-08-20T17:04:05Z",
      task,
    });
    expect(doc.length).toBeGreaterThan(300_000);
    const prompt = pointer().prompt;
    console.log(`[bounds] task doc=${doc.length}B prompt=${Buffer.byteLength(prompt)}B`);
    expect(prompt).toBe(pointer().prompt);
    expect(prompt).not.toContain("xxxxxxxxxx");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(PROMPT_BYTE_BOUND);
  });

  test("every spawned argv stays bounded — the prompt is its only variable-length part", () => {
    const composed = pointer();
    const argvBytes = composed.args.reduce((sum, arg) => sum + Buffer.byteLength(arg, "utf8"), 0);
    expect(argvBytes).toBeLessThan(PROMPT_BYTE_BOUND);
  });
});

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  composeInvocation,
  DISPATCH_AGENT_DEFAULTS,
  DispatchRoutingError,
  ORIENTATION_COMMAND,
  resolveAgent,
  resolveRoute,
  UnknownAgentKindError,
} from "../../src/dispatch/invocation";
import type { Routing } from "../../src/schema/records";

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
    // CLI could not take a positional prompt would silently drop the task.
    for (const [kind, spec] of Object.entries(DISPATCH_AGENT_DEFAULTS)) {
      const composed = composeInvocation({
        responsibility: "implementation",
        agent: kind,
        model: undefined,
        spec,
        task: "TASK-MARKER",
      });
      expect(composed.args[composed.args.length - 1]).toContain("TASK-MARKER");
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
    const routing: Routing = {
      review: { agent: "codex", model: "gpt-5'; touch /tmp/nahel-pwned; echo '" },
    };
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
      review: { agent: "codex", model: "gpt-5'; touch /tmp/nahel-pwned; echo '" },
      implementation: { agent: "<claude|codex|cursor-agent>", model: "<model>" },
    });
    // The injected command never ran (it would have created this file).
    expect(existsSync("/tmp/nahel-pwned")).toBe(false);
  });

  test("resolution is deterministic — the same config resolves identically every time", () => {
    expect(resolveRoute(ROUTING, "review")).toEqual(resolveRoute(ROUTING, "review"));
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
      task: "implement the widget",
      ...overrides,
    });

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

  test("the orientation preamble directs the worker to `nahel brief` AHEAD of the task prompt", () => {
    const prompt = compose().prompt;
    console.log("[prompt]\n" + prompt);
    const orientation = prompt.indexOf(ORIENTATION_COMMAND);
    const task = prompt.indexOf("implement the widget");
    expect(orientation).toBeGreaterThanOrEqual(0);
    expect(task).toBeGreaterThanOrEqual(0);
    expect(orientation).toBeLessThan(task);
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
    const prompt = compose().prompt;
    expect(prompt.toLowerCase()).not.toContain("work item:");
    expect(prompt).not.toContain("nahel run update");
  });

  test("composition is deterministic — identical inputs compose byte-identical invocations", () => {
    expect(JSON.stringify(compose({ item: "mb6gxyk4", run: "zdbbkrgp" }))).toBe(
      JSON.stringify(compose({ item: "mb6gxyk4", run: "zdbbkrgp" })),
    );
  });

  test("multi-word task args arrive as one prompt tail, in order", () => {
    const composed = compose({ task: "fix the flaky test in tests/store/rotate.test.ts" });
    expect(composed.prompt).toContain("fix the flaky test in tests/store/rotate.test.ts");
  });
});

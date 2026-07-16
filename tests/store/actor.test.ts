import { describe, expect, test } from "bun:test";
import { NAHEL_ACTOR_VAR, parseActorSpec, resolveActor } from "../../src/store/actor";

describe("parseActorSpec", () => {
  test("parses kind:id", () => {
    expect(parseActorSpec("agent:claude-code")).toEqual({
      kind: "agent",
      id: "claude-code",
    });
  });

  test("parses kind:id:session", () => {
    expect(parseActorSpec("human:jim:pairing-session")).toEqual({
      kind: "human",
      id: "jim",
      session: "pairing-session",
    });
  });

  test("rejects an unknown actor kind with the expected format in the message", () => {
    expect(() => parseActorSpec("robot:hal")).toThrow(/human|agent/);
  });

  test("rejects a spec without an id", () => {
    expect(() => parseActorSpec("agent:")).toThrow();
    expect(() => parseActorSpec("agent")).toThrow();
  });

  test("rejects a spec with too many segments", () => {
    expect(() => parseActorSpec("agent:a:b:c")).toThrow();
  });
});

describe("resolveActor", () => {
  const configActor = { kind: "agent", id: "claude-code" } as const;

  test("uses the config actor entry when no override is given", () => {
    expect(resolveActor(configActor, undefined)).toEqual(configActor);
  });

  test("NAHEL_ACTOR override wins over the config actor entry", () => {
    expect(resolveActor(configActor, "human:jim")).toEqual({ kind: "human", id: "jim" });
  });

  test("fails with an actionable message when neither source provides an actor", () => {
    expect(() => resolveActor(undefined, undefined)).toThrow(
      new RegExp(NAHEL_ACTOR_VAR),
    );
  });

  test("validates the config actor entry", () => {
    expect(() =>
      resolveActor({ kind: "agent", id: "" } as never, undefined),
    ).toThrow();
  });

  test("an invalid override fails even when the config actor is valid (no silent fallback)", () => {
    expect(() => resolveActor(configActor, "robot:hal")).toThrow();
  });
});

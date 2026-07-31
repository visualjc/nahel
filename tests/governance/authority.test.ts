import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { configCommand } from "../../src/commands/config";
import {
  foundingSignatureStatus,
  GOVERNANCE_DEFAULTS,
  MERGE_AUTHORITY_DEFAULT,
  mergeAuthorityStatus,
  readMergeAuthority,
  resolveGovernance,
  resolveMergeAuthority,
} from "../../src/governance/authority";
import { CONFIG_UPDATED_EVENT_TYPE } from "../../src/schema/events";
import type { Actor, JournalEvent } from "../../src/schema/records";
import { ensureLayout, readConfig, writeConfig } from "../../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * Governance + merge-authority resolution (PRD F2.2 config semantics, F3.4).
 * Two questions the rest of the codebase must never answer twice:
 *   1. What governance posture is in force? Absence means `delegated` on
 *      product (pushing forward is the default) and `human` on architecture.
 *   2. Is `merge: on-approve` actually authorized? Only when the journal
 *      proves a HUMAN actor made the config mutation that set it — a flag an
 *      agent set is inert and resolves back to `merge: human` (HC6 and
 *      ADR-0011 as amended 2026-07-25: the committed flip IS the human's
 *      standing authorization, so its provenance must be human).
 */

let dirs: string[] = [];
let logSpy: { mockRestore(): void };
let errSpy: { mockRestore(): void };
let output: string[] = [];

beforeEach(() => {
  output = [];
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    output.push(args.join(" "));
  });
  errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    output.push(args.join(" "));
  });
});

afterEach(async () => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

/** One `config.updated` event for the `merge` section, by the given actor. */
function mergeConfigEvent(
  id: string,
  actor: Actor,
  authority: string,
  seq: number,
): JournalEvent {
  return {
    id,
    ts: `2026-07-25T12:00:0${seq}Z`,
    seq,
    type: CONFIG_UPDATED_EVENT_TYPE,
    actor,
    payload: { section: "merge", value: { authority } },
  };
}

const HUMAN: Actor = { kind: "human", id: "jim" };
const AGENT: Actor = { kind: "agent", id: "claude-code" };

/** A recorded hands-off founding: the paragraph is the signed content (F9.5). */
const HANDS_OFF = {
  mode: "hands-off",
  paragraph: "Build a deterministic CLI for durable project state.",
} as const;

describe("governance resolution (PRD F2.2 config semantics)", () => {
  test("the canonical defaults are product=delegated, architecture=human", () => {
    // F2.2: "a project with no governance config behaves as delegated —
    // pushing forward is the default unless told not to"; architecture stays
    // human until the Phase 4 architect slice ships.
    expect(GOVERNANCE_DEFAULTS).toEqual({ product: "delegated", architecture: "human" });
  });

  test("no governance section at all: product delegated, architecture human, both marked defaulted", () => {
    expect(resolveGovernance(undefined)).toEqual({
      product: { mode: "delegated", defaulted: true },
      architecture: { mode: "human", defaulted: true },
    });
  });

  test("explicit values win over the defaults and are not marked defaulted", () => {
    expect(resolveGovernance({ product: "human", architecture: "delegated" })).toEqual({
      product: { mode: "human", defaulted: false },
      architecture: { mode: "delegated", defaulted: false },
    });
  });

  test("a half-declared posture resolves per AREA — the missing half takes its own default", () => {
    // The schema demands both areas, so this shape only reaches the resolver
    // from a caller holding a partial (an inception workflow mid-write, a
    // future half-section). The rule is per-key regardless of who asks.
    expect(resolveGovernance({ architecture: "delegated" })).toEqual({
      product: { mode: "delegated", defaulted: true },
      architecture: { mode: "delegated", defaulted: false },
    });
    expect(resolveGovernance({ product: "human" })).toEqual({
      product: { mode: "human", defaulted: false },
      architecture: { mode: "human", defaulted: true },
    });
  });
});

describe("merge authority resolution (PRD F3.4)", () => {
  test("absent config.merge resolves to human — the default everywhere", () => {
    expect(MERGE_AUTHORITY_DEFAULT).toBe("human");
    expect(resolveMergeAuthority(undefined)).toBe("human");
  });

  test("an explicit authority wins", () => {
    expect(resolveMergeAuthority({ authority: "on-approve" })).toBe("on-approve");
    expect(resolveMergeAuthority({ authority: "human" })).toBe("human");
  });
});

describe("merge authority provenance — on-approve counts only when a human set it", () => {
  test("no merge section: human, defaulted, no provenance question to ask", () => {
    expect(mergeAuthorityStatus(undefined, [])).toEqual({
      configured: "human",
      defaulted: true,
      effective: "human",
    });
  });

  test("explicit merge: human needs no provenance — nothing was delegated", () => {
    expect(mergeAuthorityStatus({ authority: "human" }, [])).toEqual({
      configured: "human",
      defaulted: false,
      effective: "human",
    });
  });

  test("on-approve set by a human actor is authorized, naming the authorizing event", () => {
    const event = mergeConfigEvent("aaaaaaa1", HUMAN, "on-approve", 1);
    const status = mergeAuthorityStatus({ authority: "on-approve" }, [event]);
    expect(status.effective).toBe("on-approve");
    expect(status.defect).toBeUndefined();
    expect(status.setBy).toEqual({ event: "aaaaaaa1", actor: HUMAN });
  });

  test("on-approve set by an AGENT actor is inert — effective authority falls back to human", () => {
    const event = mergeConfigEvent("aaaaaaa2", AGENT, "on-approve", 1);
    const status = mergeAuthorityStatus({ authority: "on-approve" }, [event]);
    expect(status.configured).toBe("on-approve");
    expect(status.effective).toBe("human");
    expect(status.defect).toBe("agent-set");
    expect(status.setBy).toEqual({ event: "aaaaaaa2", actor: AGENT });
  });

  test("on-approve with NO journaled config mutation is inert — provenance is unprovable", () => {
    // A hand-edited nahel/config (hard constraint 3 violated) or a config
    // whose journal never recorded the flip: unprovable is not authorized.
    const status = mergeAuthorityStatus({ authority: "on-approve" }, []);
    expect(status.effective).toBe("human");
    expect(status.defect).toBe("unrecorded");
    expect(status.setBy).toBeUndefined();
  });

  test("on-approve whose LATEST journaled merge mutation set human is inert (config drifted from the journal)", () => {
    const status = mergeAuthorityStatus({ authority: "on-approve" }, [
      mergeConfigEvent("aaaaaaa3", HUMAN, "on-approve", 1),
      mergeConfigEvent("aaaaaaa4", HUMAN, "human", 2),
    ]);
    expect(status.effective).toBe("human");
    expect(status.defect).toBe("unrecorded");
  });

  test("the LAST mutation governs: a human flip later re-set by an agent is inert again", () => {
    const status = mergeAuthorityStatus({ authority: "on-approve" }, [
      mergeConfigEvent("aaaaaaa5", HUMAN, "on-approve", 1),
      mergeConfigEvent("aaaaaaa6", AGENT, "on-approve", 2),
    ]);
    expect(status.effective).toBe("human");
    expect(status.defect).toBe("agent-set");
    expect(status.setBy?.event).toBe("aaaaaaa6");
  });

  test("the LAST mutation governs: an agent flip later re-set by a human IS authorized", () => {
    const status = mergeAuthorityStatus({ authority: "on-approve" }, [
      mergeConfigEvent("aaaaaaa7", AGENT, "on-approve", 1),
      mergeConfigEvent("aaaaaaa8", HUMAN, "on-approve", 2),
    ]);
    expect(status.effective).toBe("on-approve");
    expect(status.defect).toBeUndefined();
    expect(status.setBy?.event).toBe("aaaaaaa8");
  });

  test("config.updated events for OTHER sections never answer the merge question", () => {
    const unrelated: JournalEvent = {
      id: "aaaaaaa9",
      ts: "2026-07-25T12:00:00Z",
      seq: 0,
      type: CONFIG_UPDATED_EVENT_TYPE,
      actor: HUMAN,
      payload: { section: "governance", value: { product: "human", architecture: "human" } },
    };
    const status = mergeAuthorityStatus({ authority: "on-approve" }, [unrelated]);
    expect(status.effective).toBe("human");
    expect(status.defect).toBe("unrecorded");
  });

  test("two same-second setters that disagree are AMBIGUOUS — ordering cannot decide, so nothing is authorized", () => {
    // Same second, different sessions: every CLI invocation mints its own
    // segment, so both events carry seq 0 and only the random event id
    // separates them. An id lottery must never be able to enable auto-merge.
    const human = { ...mergeConfigEvent("zzzzzzzz", HUMAN, "on-approve", 0) };
    const agent = { ...mergeConfigEvent("aaaaaaaa", AGENT, "on-approve", 0) };
    expect(human.ts).toBe(agent.ts);

    for (const events of [
      [human, agent],
      [agent, human],
    ]) {
      const status = mergeAuthorityStatus({ authority: "on-approve" }, events);
      console.log("[same-second]", events.map((e) => e.id).join(","), status.defect);
      expect(status.configured).toBe("on-approve");
      expect(status.effective).toBe("human");
      expect(status.defect).toBe("ambiguous");
      // Both tied setters are named so a human can see what to break the tie against.
      expect(status.tied?.map((tie) => tie.event).sort()).toEqual(["aaaaaaaa", "zzzzzzzz"]);
    }
  });

  test("same-second setters that AGREE are not ambiguous — there is nothing to disagree about", () => {
    const first = mergeConfigEvent("bbbbbbb1", HUMAN, "on-approve", 0);
    const second = mergeConfigEvent("bbbbbbb2", HUMAN, "on-approve", 0);
    const status = mergeAuthorityStatus({ authority: "on-approve" }, [first, second]);
    expect(status.effective).toBe("on-approve");
    expect(status.defect).toBeUndefined();
  });

  test("same-second setters that agree on actor kind but disagree on VALUE are ambiguous", () => {
    const on = mergeConfigEvent("ccccccc1", HUMAN, "on-approve", 0);
    const off = mergeConfigEvent("ccccccc2", HUMAN, "human", 0);
    const status = mergeAuthorityStatus({ authority: "on-approve" }, [on, off]);
    expect(status.effective).toBe("human");
    expect(status.defect).toBe("ambiguous");
  });

  test("two same-second AGENT setters stay agent-set — consistent, just unauthorized", () => {
    const status = mergeAuthorityStatus({ authority: "on-approve" }, [
      mergeConfigEvent("ddddddd1", AGENT, "on-approve", 0),
      mergeConfigEvent("ddddddd2", AGENT, "on-approve", 0),
    ]);
    expect(status.effective).toBe("human");
    expect(status.defect).toBe("agent-set");
  });

  test("a strictly LATER human set breaks the tie — the fix validate prescribes resolves ambiguity", () => {
    const status = mergeAuthorityStatus({ authority: "on-approve" }, [
      mergeConfigEvent("eeeeeee1", HUMAN, "on-approve", 0),
      mergeConfigEvent("eeeeeee2", AGENT, "on-approve", 0),
      mergeConfigEvent("eeeeeee3", HUMAN, "on-approve", 1),
    ]);
    expect(status.effective).toBe("on-approve");
    expect(status.defect).toBeUndefined();
    expect(status.setBy?.event).toBe("eeeeeee3");
  });

  test("a forged non-config event carrying a merge payload proves nothing (type is the key)", () => {
    const forged: JournalEvent = {
      id: "aaaaaab1",
      ts: "2026-07-25T12:00:00Z",
      seq: 0,
      type: "note",
      actor: HUMAN,
      payload: { section: "merge", value: { authority: "on-approve" } },
    };
    const status = mergeAuthorityStatus({ authority: "on-approve" }, [forged]);
    expect(status.effective).toBe("human");
    expect(status.defect).toBe("unrecorded");
  });
});

/**
 * Founding signature provenance (PRD F9.5, nahel/workflows/inception.md):
 * "the human-attributed `config.updated` act that wrote the `founding`
 * section IS the paragraph's signature. An agent-run founding act signs
 * nothing." Only the paragraph carries authority — a `guided` founding
 * records which door was used and nothing more, so it needs no signature.
 */
describe("founding signature provenance — the paragraph is signed by the act that recorded it", () => {
  /**
   * One `config.updated` event for the `founding` section, by the given actor.
   * `paragraph` defaults to the one HANDS_OFF carries — an act signs the bytes
   * its OWN payload records, so a test that means "signed" must pass the same
   * text the config holds.
   */
  function foundingConfigEvent(
    id: string,
    actor: Actor,
    seq: number,
    paragraph: string = HANDS_OFF.paragraph,
  ): JournalEvent {
    return {
      id,
      ts: `2026-07-25T12:00:0${seq}Z`,
      seq,
      type: CONFIG_UPDATED_EVENT_TYPE,
      actor,
      payload: { section: "founding", value: { mode: "hands-off", paragraph } },
    };
  }

  test("no founding section: no paragraph, so no signature question exists", () => {
    expect(foundingSignatureStatus(undefined, [])).toBeUndefined();
  });

  test("a guided founding carries no paragraph — an agent may record the door it came through", () => {
    expect(
      foundingSignatureStatus({ mode: "guided" }, [
        foundingConfigEvent("fffffff1", AGENT, 0),
      ]),
    ).toBeUndefined();
  });

  test("a paragraph recorded by a HUMAN act is signed, naming the signing event", () => {
    const status = foundingSignatureStatus(HANDS_OFF, [foundingConfigEvent("fffffff2", HUMAN, 1)]);
    expect(status).toEqual({
      signed: true,
      recordedBy: { event: "fffffff2", actor: HUMAN },
    });
  });

  test("a paragraph recorded by an AGENT act signs nothing", () => {
    const status = foundingSignatureStatus(HANDS_OFF, [foundingConfigEvent("fffffff3", AGENT, 1)]);
    expect(status?.signed).toBe(false);
    expect(status?.defect).toBe("agent-recorded");
    expect(status?.recordedBy).toEqual({ event: "fffffff3", actor: AGENT });
  });

  test("a hand-edited paragraph no journaled act accounts for is unrecorded — unprovable is not signed", () => {
    const status = foundingSignatureStatus(HANDS_OFF, []);
    expect(status?.signed).toBe(false);
    expect(status?.defect).toBe("unrecorded");
    expect(status?.recordedBy).toBeUndefined();
  });

  test("same-second recorders of different actor kinds are ambiguous — a lottery never signs", () => {
    const status = foundingSignatureStatus(HANDS_OFF, [
      foundingConfigEvent("fffffff4", HUMAN, 0),
      foundingConfigEvent("fffffff5", AGENT, 0),
    ]);
    expect(status?.signed).toBe(false);
    expect(status?.defect).toBe("ambiguous");
    expect(status?.tied).toHaveLength(2);
  });

  test("a strictly LATER human act breaks the tie and signs", () => {
    const status = foundingSignatureStatus(HANDS_OFF, [
      foundingConfigEvent("fffffff6", AGENT, 0),
      foundingConfigEvent("fffffff7", HUMAN, 1),
    ]);
    expect(status?.signed).toBe(true);
    expect(status?.recordedBy?.event).toBe("fffffff7");
  });

  test("a forged non-config event carrying a founding payload signs nothing (type is the key)", () => {
    const forged: JournalEvent = {
      id: "fffffff8",
      ts: "2026-07-25T12:00:00Z",
      seq: 0,
      type: "note",
      actor: HUMAN,
      payload: { section: "founding", value: HANDS_OFF },
    };
    const status = foundingSignatureStatus(HANDS_OFF, [forged]);
    expect(status?.signed).toBe(false);
    expect(status?.defect).toBe("unrecorded");
  });

  /**
   * An act signs the bytes ITS OWN payload carries — never whatever the config
   * happens to hold later. Without that comparison a human act signing an old
   * paragraph would launder any later hand-edit of the text, which is the one
   * thing F9.5's signature exists to prevent.
   */
  test("a human act that recorded an EARLIER paragraph does not sign a later hand-edit", () => {
    const signedOld = foundingConfigEvent("fffffff9", HUMAN, 1, "The paragraph the human actually signed.");
    const status = foundingSignatureStatus(
      { mode: "hands-off", paragraph: "A different paragraph, edited in by hand afterwards." },
      [signedOld],
    );
    console.log("[founding, paragraph swapped under the signature]", status);
    expect(status?.signed).toBe(false);
    // A MISMATCH, not an absence: the act exists and its provenance is
    // knowable — it simply records other bytes. Collapsing this into
    // "unrecorded" would make every renderer claim no act exists at all.
    expect(status?.defect).toBe("paragraph-mismatch");
    expect(status?.recordedBy).toEqual({ event: "fffffff9", actor: HUMAN });
  });

  test("same-second HUMAN acts recording DIFFERENT paragraphs are ambiguous — the fail-safe is about the value too", () => {
    const status = foundingSignatureStatus(HANDS_OFF, [
      foundingConfigEvent("fffffffa", HUMAN, 0),
      foundingConfigEvent("fffffffb", HUMAN, 0, "A rival paragraph recorded in the same second."),
    ]);
    console.log("[founding, same-second disagreeing humans]", status);
    expect(status?.signed).toBe(false);
    expect(status?.defect).toBe("ambiguous");
    expect(status?.tied).toHaveLength(2);
  });

  test("same-second human acts recording the SAME paragraph carry no ambiguity — nothing to decide", () => {
    const status = foundingSignatureStatus(HANDS_OFF, [
      foundingConfigEvent("fffffffc", HUMAN, 0),
      foundingConfigEvent("fffffffd", HUMAN, 0),
    ]);
    expect(status?.signed).toBe(true);
    expect(status?.defect).toBeUndefined();
  });

  test("byte equality, not similarity: whitespace-only drift breaks the signature", () => {
    // F9.5 stores the paragraph verbatim and compares it verbatim — nothing
    // trims, reflows, or case-folds. A trailing space IS a different paragraph.
    const status = foundingSignatureStatus({ mode: "hands-off", paragraph: `${HANDS_OFF.paragraph} ` }, [
      foundingConfigEvent("fffffffe", HUMAN, 1),
    ]);
    expect(status?.signed).toBe(false);
    expect(status?.defect).toBe("paragraph-mismatch");
    expect(status?.recordedBy?.event).toBe("fffffffe");
  });

  test("`unrecorded` is reserved for a journal with NO founding act at all", () => {
    // The two states are different facts and lead to different repairs, so
    // they must never share a defect: nothing to find vs. found, but stale.
    const empty = foundingSignatureStatus(HANDS_OFF, []);
    expect(empty?.defect).toBe("unrecorded");
    expect(empty?.recordedBy).toBeUndefined();
  });

  test("a MISMATCHING agent act still reports as a mismatch, naming the agent that recorded it", () => {
    // Mismatch outranks actor kind: an act recording other bytes says nothing
    // about THIS paragraph, whoever made it — but the actor is still named.
    const status = foundingSignatureStatus(HANDS_OFF, [
      foundingConfigEvent("ffffffff", AGENT, 1, "Some other paragraph entirely."),
    ]);
    expect(status?.defect).toBe("paragraph-mismatch");
    expect(status?.recordedBy).toEqual({ event: "ffffffff", actor: AGENT });
  });
});

describe("readMergeAuthority — the store-facing answer, over the real write path", () => {
  async function setup() {
    const root = await makeTempDir("nahel-governance-");
    dirs.push(root);
    const layout = await ensureLayout(root);
    await writeConfig(layout, makeConfig()); // config actor: agent:claude-code
    return { root, layout, env: seededEnv({ tickSeconds: 1 }) };
  }

  test("a human running `nahel config set merge` authorizes on-approve", async () => {
    const { root, layout, env } = await setup();
    const code = await configCommand.run(
      ["set", "merge", "--data", "authority=on-approve"],
      env,
      root,
      "human:jim",
    );
    expect(output.join("\n")).not.toContain("❌");
    expect(code).toBe(0);

    const status = await readMergeAuthority(layout, await readConfig(layout));
    expect(status.configured).toBe("on-approve");
    expect(status.effective).toBe("on-approve");
    expect(status.defect).toBeUndefined();
    expect(status.setBy?.actor).toEqual({ kind: "human", id: "jim" });
  });

  test("an agent running the same command does NOT authorize it — the flag is inert", async () => {
    const { root, layout, env } = await setup();
    const code = await configCommand.run(
      ["set", "merge", "--data", "authority=on-approve"],
      env,
      root,
      "agent:opus-implementer",
    );
    expect(code).toBe(0);

    const status = await readMergeAuthority(layout, await readConfig(layout));
    expect(status.configured).toBe("on-approve");
    expect(status.effective).toBe("human");
    expect(status.defect).toBe("agent-set");
    expect(status.setBy?.actor).toEqual({ kind: "agent", id: "opus-implementer" });
  });

  test("a store that never set merge authority answers human, defaulted", async () => {
    const { root, layout, env } = await setup();
    await configCommand.run(["set", "inception", "--data", "tier=seed"], env, root, "human:jim");

    const status = await readMergeAuthority(layout, await readConfig(layout));
    expect(status).toEqual({ configured: "human", defaulted: true, effective: "human" });
  });
});

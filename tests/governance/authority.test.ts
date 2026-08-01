import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { configCommand } from "../../src/commands/config";
import {
  constitutionSignatureStatus,
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
    // human until the Phase 5 architect slice ships (Roles & governance,
    // renumbered 4→5 on 2026-08-01).
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

/**
 * The COMPLETE constitution-signature verdict (PRD F7.2, F9.5,
 * nahel/workflows/afk-run.md gate 1a). Two doors lead to a founded project and
 * the gate reads a different act behind each:
 *
 *   - hands-off — the human's single act is the founding paragraph, so the
 *     `inception` act may be agent-attributed; only the FIELD is asked of it.
 *   - guided or legacy — there is no paragraph, so the act that wrote the
 *     `inception` section carrying `constitution_signed_by` IS the signature.
 *
 * Both halves come from ONE function, so no caller reconstructs half the rule.
 */
describe("constitution signature verdict — both founding doors, one answer", () => {
  /** One `config.updated` event for the `inception` section, by the given actor. */
  function inceptionConfigEvent(
    id: string,
    actor: Actor,
    seq: number,
    value: Record<string, unknown> = { tier: "standard", constitution_signed_by: "jim" },
  ): JournalEvent {
    return {
      id,
      ts: `2026-07-25T12:00:0${seq}Z`,
      seq,
      type: CONFIG_UPDATED_EVENT_TYPE,
      actor,
      payload: { section: "inception", value },
    };
  }

  /** One `config.updated` event for the `founding` section, by the given actor. */
  function foundingConfigEvent(
    id: string,
    actor: Actor,
    seq: number,
    value: Record<string, unknown> = HANDS_OFF,
  ): JournalEvent {
    return {
      id,
      ts: `2026-07-25T12:00:0${seq}Z`,
      seq,
      type: CONFIG_UPDATED_EVENT_TYPE,
      actor,
      payload: { section: "founding", value },
    };
  }

  const SIGNED = { tier: "standard", constitution_signed_by: "jim" } as const;

  test("no inception section at all: absent — nothing records the tier, let alone a signer", () => {
    const status = constitutionSignatureStatus({}, []);
    console.log("[constitution, no inception section]", status);
    expect(status.founding).toBeUndefined();
    expect(status.inception).toEqual({ signed: false, defect: "absent" });
  });

  test("an inception section with no constitution_signed_by is unsigned — presence is the first question", () => {
    const status = constitutionSignatureStatus({ inception: { tier: "seed" } }, []);
    console.log("[constitution, tier without signer]", status.inception);
    expect(status.inception.signed).toBe(false);
    expect(status.inception.defect).toBe("unsigned");
  });

  test("a signer recorded by a HUMAN act is signed, naming the act", () => {
    const status = constitutionSignatureStatus({ inception: SIGNED }, [
      inceptionConfigEvent("11111111", HUMAN, 1),
    ]);
    expect(status.inception).toEqual({
      signed: true,
      recordedBy: { event: "11111111", actor: HUMAN },
    });
  });

  test("a signer an AGENT act transcribed signs nothing — the same rule merge authority applies", () => {
    const status = constitutionSignatureStatus({ inception: SIGNED }, [
      inceptionConfigEvent("22222222", AGENT, 1),
    ]);
    console.log("[constitution, agent-transcribed signer]", status.inception);
    expect(status.inception.signed).toBe(false);
    expect(status.inception.defect).toBe("agent-recorded");
    expect(status.inception.recordedBy).toEqual({ event: "22222222", actor: AGENT });
  });

  test("a hand-edited signer no journaled act accounts for is unrecorded", () => {
    const status = constitutionSignatureStatus({ inception: SIGNED }, []);
    expect(status.inception.signed).toBe(false);
    expect(status.inception.defect).toBe("unrecorded");
    expect(status.inception.recordedBy).toBeUndefined();
  });

  test("a latest act that recorded NO signer is unrecorded — an act signs what its own payload carries", () => {
    // The laundering shape: a human act recorded the tier alone, and the
    // signer field arrived later by hand. That act signed nothing.
    const status = constitutionSignatureStatus({ inception: SIGNED }, [
      inceptionConfigEvent("33333333", HUMAN, 1, { tier: "standard" }),
    ]);
    console.log("[constitution, tier-only act under a hand-added signer]", status.inception);
    expect(status.inception.signed).toBe(false);
    expect(status.inception.defect).toBe("unrecorded");
  });

  /**
   * The founding half's paragraph-mismatch lesson, applied here: an act signs
   * the VALUE its own payload recorded, never whatever config holds later.
   * Without that comparison a human act naming one signer would authenticate
   * any later hand-edit naming another — the laundering a signature exists to
   * prevent. Still never compared: the signer against the ACTOR's id.
   */
  test("a human act that recorded ANOTHER signer does not authenticate a later hand-edit", () => {
    const status = constitutionSignatureStatus(
      { inception: { tier: "standard", constitution_signed_by: "alice" } },
      [inceptionConfigEvent("aaaaaaa4", HUMAN, 1)], // this act recorded "jim"
    );
    console.log("[constitution, signer swapped under the act]", status.inception);
    expect(status.inception.signed).toBe(false);
    // A MISMATCH, not an absence: the act exists and is nameable — it simply
    // recorded another signer. Collapsing it into `unrecorded` would send the
    // reader hunting for an act that is right there.
    expect(status.inception.defect).toBe("signer-mismatch");
    expect(status.inception.recordedBy).toEqual({ event: "aaaaaaa4", actor: HUMAN });
  });

  test("a MISMATCHING agent act still reports as a mismatch, naming the agent that recorded it", () => {
    const status = constitutionSignatureStatus(
      { inception: { tier: "standard", constitution_signed_by: "alice" } },
      [inceptionConfigEvent("aaaaaaa5", AGENT, 1)],
    );
    expect(status.inception.defect).toBe("signer-mismatch");
    expect(status.inception.recordedBy).toEqual({ event: "aaaaaaa5", actor: AGENT });
  });

  test("the signer is compared to the ACT's value, never to the actor's id", () => {
    // A human whose actor id differs from the name they sign under is ordinary
    // in a legacy store (`human:jim` recording `jim.carter`). The act recorded
    // that value, so the act signs it.
    const status = constitutionSignatureStatus(
      { inception: { tier: "standard", constitution_signed_by: "jim.carter" } },
      [
        inceptionConfigEvent("aaaaaaa6", HUMAN, 1, {
          tier: "standard",
          constitution_signed_by: "jim.carter",
        }),
      ],
    );
    expect(status.inception.signed).toBe(true);
    expect(status.inception.defect).toBeUndefined();
  });

  test("same-second writers of different actor kinds are ambiguous — a lottery never signs", () => {
    const status = constitutionSignatureStatus({ inception: SIGNED }, [
      inceptionConfigEvent("44444444", HUMAN, 0),
      inceptionConfigEvent("55555555", AGENT, 0),
    ]);
    console.log("[constitution, same-second tie]", status.inception);
    expect(status.inception.signed).toBe(false);
    expect(status.inception.defect).toBe("ambiguous");
    expect(status.inception.tied).toHaveLength(2);
  });

  test("a strictly LATER human act breaks the tie and signs", () => {
    const status = constitutionSignatureStatus({ inception: SIGNED }, [
      inceptionConfigEvent("66666666", AGENT, 0),
      inceptionConfigEvent("77777777", HUMAN, 1),
    ]);
    expect(status.inception.signed).toBe(true);
    expect(status.inception.recordedBy?.event).toBe("77777777");
  });

  test("a forged non-config event carrying an inception payload signs nothing (type is the key)", () => {
    const forged: JournalEvent = {
      id: "88888888",
      ts: "2026-07-25T12:00:00Z",
      seq: 0,
      type: "note",
      actor: HUMAN,
      payload: { section: "inception", value: SIGNED },
    };
    const status = constitutionSignatureStatus({ inception: SIGNED }, [forged]);
    expect(status.inception.defect).toBe("unrecorded");
  });

  test("under a hands-off founding the inception act may be AGENT-attributed — the human's act was the paragraph", () => {
    // afk-run gate 1a: "the tier record itself may be agent-attributed (the
    // human was gone by then)". Only the FIELD is asked of it.
    const status = constitutionSignatureStatus({ founding: HANDS_OFF, inception: SIGNED }, [
      foundingConfigEvent("99999999", HUMAN, 1),
      inceptionConfigEvent("aaaaaaa1", AGENT, 2),
    ]);
    console.log("[constitution, hands-off with agent tier record]", status);
    expect(status.founding?.signed).toBe(true);
    expect(status.inception.signed).toBe(true);
    expect(status.inception.defect).toBeUndefined();
  });

  test("a hands-off founding still needs the FIELD — the paragraph does not record who signed", () => {
    const status = constitutionSignatureStatus(
      { founding: HANDS_OFF, inception: { tier: "standard" } },
      [foundingConfigEvent("aaaaaaa2", HUMAN, 1)],
    );
    console.log("[constitution, hands-off without the field]", status.inception);
    expect(status.founding?.signed).toBe(true);
    expect(status.inception.signed).toBe(false);
    expect(status.inception.defect).toBe("unsigned");
  });

  /**
   * The exemption belongs to the hands-off MODE, not to the mere presence of a
   * paragraph: the schema requires a paragraph of hands-off but permits one on
   * a GUIDED founding too, and a guided founding never spent the human's act
   * on it — the human was present the whole way and signs the tier record
   * themselves. Keying off the paragraph would hand any guided project a free
   * pass by adding one optional field.
   */
  test("a GUIDED founding that carries a paragraph does NOT exempt the inception act", () => {
    const status = constitutionSignatureStatus(
      { founding: { mode: "guided", paragraph: HANDS_OFF.paragraph }, inception: SIGNED },
      [inceptionConfigEvent("aaaaaaa7", AGENT, 2)],
    );
    console.log("[constitution, guided founding carrying a paragraph]", status.inception);
    expect(status.inception.signed).toBe(false);
    expect(status.inception.defect).toBe("agent-recorded");
  });

  /**
   * The exemption's own laundering path, one level up from the signer's: the
   * MODE config declares is editable text like any other field. A guided
   * founding a human genuinely recorded, hand-edited to `mode: hands-off`,
   * would otherwise announce the zero-return door — and exempt an
   * agent-recorded signature from the provenance rule — while the journal
   * records no such founding. Only the act's own recorded mode may engage it.
   */
  test("a founding hand-edited from guided to hands-off exempts nothing — the act recorded another door", () => {
    const status = constitutionSignatureStatus({ founding: HANDS_OFF, inception: SIGNED }, [
      // What the human actually did: a GUIDED founding, paragraph and all.
      foundingConfigEvent("aaaaaaa8", HUMAN, 1, {
        mode: "guided",
        paragraph: HANDS_OFF.paragraph,
      }),
      inceptionConfigEvent("aaaaaaa9", AGENT, 2),
    ]);
    console.log("[constitution, mode hand-edited to hands-off]", status);
    // The founding half names the hand-edit: the act recorded another mode.
    expect(status.founding?.signed).toBe(false);
    expect(status.founding?.defect).toBe("mode-mismatch");
    expect(status.founding?.recordedBy).toEqual({ event: "aaaaaaa8", actor: HUMAN });
    // ...and the inception half is judged on its own provenance after all.
    expect(status.inception.signed).toBe(false);
    expect(status.inception.defect).toBe("agent-recorded");
    expect(status.foundedHandsOff).toBe(false);
  });

  test("a hands-off founding the journal DOES record still exempts — the rule reads the act, not the file", () => {
    const status = constitutionSignatureStatus({ founding: HANDS_OFF, inception: SIGNED }, [
      foundingConfigEvent("aaaaaab1", HUMAN, 1),
      inceptionConfigEvent("aaaaaab2", AGENT, 2),
    ]);
    expect(status.founding?.signed).toBe(true);
    expect(status.inception.signed).toBe(true);
    expect(status.foundedHandsOff).toBe(true);
  });

  /**
   * The exemption's fail-safe, asserted in BOTH orders: two same-second acts
   * agreeing on who acted and on the paragraph, differing only in the MODE
   * they record, must not let event ordering decide which door the project
   * came through — the same lottery the actor-kind and paragraph fail-safes
   * already refuse. Whichever lands last, the answer is "undecidable".
   */
  for (const [first, second] of [
    ["hands-off", "guided"],
    ["guided", "hands-off"],
  ] as const) {
    test(`same-second acts differing only in MODE are ambiguous with ${second} recorded last`, () => {
      const status = constitutionSignatureStatus({ founding: HANDS_OFF, inception: SIGNED }, [
        foundingConfigEvent("bbbbbbb1", HUMAN, 0, {
          mode: first,
          paragraph: HANDS_OFF.paragraph,
        }),
        foundingConfigEvent("bbbbbbb2", HUMAN, 0, {
          mode: second,
          paragraph: HANDS_OFF.paragraph,
        }),
        inceptionConfigEvent("bbbbbbb3", AGENT, 1),
      ]);
      console.log(`[constitution, mode tie with ${second} last]`, status);
      expect(status.founding?.signed).toBe(false);
      expect(status.founding?.defect).toBe("ambiguous");
      expect(status.founding?.tied).toHaveLength(2);
      // No proven door, so the tier record is judged on its own provenance.
      expect(status.foundedHandsOff).toBe(false);
      expect(status.inception.defect).toBe("agent-recorded");
    });
  }

  test("a hands-off founding NO act records exempts nothing — unprovable is not a door", () => {
    const status = constitutionSignatureStatus({ founding: HANDS_OFF, inception: SIGNED }, [
      inceptionConfigEvent("aaaaaab3", AGENT, 2),
    ]);
    console.log("[constitution, hands-off with no founding act]", status);
    expect(status.foundedHandsOff).toBe(false);
    expect(status.inception.defect).toBe("agent-recorded");
  });

  test("the founding half is exactly foundingSignatureStatus — one rule, not two", () => {
    // The paragraph half must keep answering as it always did, including the
    // states only it has (paragraph-mismatch) and the guided silence.
    const events = [foundingConfigEvent("aaaaaaa3", AGENT, 1)];
    expect(constitutionSignatureStatus({ founding: HANDS_OFF }, events).founding).toEqual(
      foundingSignatureStatus(HANDS_OFF, events)!,
    );
    expect(constitutionSignatureStatus({ founding: { mode: "guided" } }, []).founding).toBeUndefined();
  });

  test("an absent config answers for both halves rather than throwing", () => {
    const status = constitutionSignatureStatus(undefined, []);
    expect(status.founding).toBeUndefined();
    expect(status.inception.defect).toBe("absent");
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

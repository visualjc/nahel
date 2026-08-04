import { describe, expect, test } from "bun:test";
import { PROTOTYPE_VARIANTS_CREATED_EVENT_TYPE } from "../../src/schema/events";
import type { JournalEvent } from "../../src/schema/records";
import type { PrototypeRefScan } from "../../src/store/prototype";
import { validate, type Finding, type ValidationInput } from "../../src/validate";
import { findingsFor } from "./helpers";

/**
 * Never-merge, enforced mechanically (PRD F5.2) — the `validate` half. These
 * are PURE checks over collected data: the git ref scan (what branches exist,
 * where their tips are, what the default branch contains) joined with the
 * journaled creation record (what each variant branched FROM). The join is
 * what makes the verdict exact: a freshly created variant sits at its base and
 * is trivially reachable from the default branch, while a MERGED one has a tip
 * past its base that the default branch now contains. Without the base, those
 * two are indistinguishable — which is why an unrecorded prototype branch is
 * reported as unjudgeable rather than guessed at.
 */

const BASE = "1111111111111111111111111111111111111111";
const TIP = "2222222222222222222222222222222222222222";

/** A journaled `prototype.variants-created` act recording each branch's base. */
function variantsCreatedEvent(
  variants: { branch: string; base: string }[],
): JournalEvent {
  return {
    id: "aaaaaaaa",
    ts: "2026-07-25T12:00:00Z",
    seq: 0,
    type: PROTOTYPE_VARIANTS_CREATED_EVENT_TYPE,
    actor: { kind: "agent", id: "claude-code" },
    payload: { slug: "speed-count", variants },
  };
}

/** Minimal validation input carrying only what the prototype checks read. */
function input(options: {
  prototypeRefs?: PrototypeRefScan;
  events?: JournalEvent[];
}): ValidationInput {
  return {
    configPath: "nahel/config",
    configText: [
      "knowledge:",
      "  product: PRODUCT.md",
      "  context: CONTEXT.md",
      "  adr: docs/adr",
      "actor:",
      "  kind: agent",
      "  id: claude-code",
      "",
    ].join("\n"),
    items: [],
    runs: [],
    observations: [],
    roadmapNodes: [],
    maps: [],
    tickets: [],
    segments:
      options.events === undefined
        ? []
        : [
            {
              name: "session-abcd1234.jsonl",
              path: "nahel/journal/session-abcd1234.jsonl",
              archived: false,
              events: options.events,
              malformed: [],
            },
          ],
    skillsManifestPath: "nahel/skills.yaml",
    skillsLockPath: "nahel/skills.lock",
    distilledDir: "nahel/journal/distilled",
    ...(options.prototypeRefs === undefined ? {} : { prototypeRefs: options.prototypeRefs }),
  };
}

function prototypeFindings(findings: Finding[]): Finding[] {
  return findings.filter((finding) => finding.check.startsWith("prototype."));
}

describe("prototype.merged — a prototype ref that reached the default branch (F5.2)", () => {
  test("a variant whose tip moved past its base and is now contained by main is an ERROR", () => {
    const findings = validate(
      input({
        prototypeRefs: {
          defaultBranch: "main",
          branches: [
            {
              branch: "prototype/speed-count/variant-1",
              tip: TIP,
              ancestorOfDefault: true,
              copiedToDefault: [],
            },
          ],
          remoteRefs: [],
        },
        events: [
          variantsCreatedEvent([{ branch: "prototype/speed-count/variant-1", base: BASE }]),
        ],
      }),
    );
    const merged = findingsFor(findings, "prototype.merged");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.severity).toBe("error");
    expect(merged[0]!.message).toContain("prototype/speed-count/variant-1");
    expect(merged[0]!.message).toContain("main");
    expect(merged[0]!.fix).toBeDefined();
  });

  test("a freshly created variant still AT its base is clean — no false alarm on creation", () => {
    const findings = validate(
      input({
        prototypeRefs: {
          defaultBranch: "main",
          branches: [
            {
              branch: "prototype/speed-count/variant-1",
              tip: BASE,
              ancestorOfDefault: true,
              copiedToDefault: [],
            },
          ],
          remoteRefs: [],
        },
        events: [
          variantsCreatedEvent([{ branch: "prototype/speed-count/variant-1", base: BASE }]),
        ],
      }),
    );
    expect(prototypeFindings(findings)).toEqual([]);
  });

  test("an active variant, ahead of main and unreachable from it, is clean", () => {
    const findings = validate(
      input({
        prototypeRefs: {
          defaultBranch: "main",
          branches: [
            {
              branch: "prototype/speed-count/variant-1",
              tip: TIP,
              ancestorOfDefault: false,
              copiedToDefault: [],
            },
          ],
          remoteRefs: [],
        },
        events: [
          variantsCreatedEvent([{ branch: "prototype/speed-count/variant-1", base: BASE }]),
        ],
      }),
    );
    expect(prototypeFindings(findings)).toEqual([]);
  });
});

describe("prototype.merged — merge-base drift: merged at T1, branch advanced to T2 (F5.2)", () => {
  const T1 = "3333333333333333333333333333333333333333";

  test("a moved merge-base with a clean tip and no copies is an ERROR — the shape the other signals miss", () => {
    const findings = prototypeFindings(
      validate(
        input({
          prototypeRefs: {
            defaultBranch: "main",
            branches: [
              {
                branch: "prototype/speed-count/variant-1",
                tip: TIP,
                ancestorOfDefault: false,
                copiedToDefault: [],
                mergeBaseWithDefault: T1,
              },
            ],
            remoteRefs: [],
          },
          events: [
            variantsCreatedEvent([
              { branch: "prototype/speed-count/variant-1", base: BASE },
            ]),
          ],
        }),
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.check).toBe("prototype.merged");
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toContain("merge-base");
    expect(findings[0]!.message).toContain(T1);
  });

  test("a merge-base still AT the recorded base is clean, and an ancestry-merged branch reports ONCE", () => {
    const clean = prototypeFindings(
      validate(
        input({
          prototypeRefs: {
            defaultBranch: "main",
            branches: [
              {
                branch: "prototype/speed-count/variant-1",
                tip: TIP,
                ancestorOfDefault: false,
                copiedToDefault: [],
                mergeBaseWithDefault: BASE,
              },
            ],
            remoteRefs: [],
          },
          events: [
            variantsCreatedEvent([
              { branch: "prototype/speed-count/variant-1", base: BASE },
            ]),
          ],
        }),
      ),
    );
    expect(clean).toHaveLength(0);

    const merged = prototypeFindings(
      validate(
        input({
          prototypeRefs: {
            defaultBranch: "main",
            branches: [
              {
                branch: "prototype/speed-count/variant-1",
                tip: TIP,
                ancestorOfDefault: true,
                copiedToDefault: [],
                mergeBaseWithDefault: TIP,
              },
            ],
            remoteRefs: [],
          },
          events: [
            variantsCreatedEvent([
              { branch: "prototype/speed-count/variant-1", base: BASE },
            ]),
          ],
        }),
      ),
    );
    expect(merged.filter((f) => f.check === "prototype.merged")).toHaveLength(1);
  });
});

describe("prototype.merged — code copied across by cherry-pick, not by ancestry (F5.2)", () => {
  test("a branch whose commits exist in main by PATCH-ID is an error naming the copy path", () => {
    // The lane's rule 2 forbids a cherry-pick by name, but the ancestry check
    // cannot see one: the copy is a NEW commit on main, and the prototype
    // branch is not an ancestor of anything. Patch-id equivalence is what
    // closes that door.
    const findings = validate(
      input({
        prototypeRefs: {
          defaultBranch: "main",
          branches: [
            {
              branch: "prototype/speed-count/variant-1",
              tip: TIP,
              ancestorOfDefault: false,
              copiedToDefault: [TIP],
            },
          ],
          remoteRefs: [],
        },
        events: [variantsCreatedEvent([{ branch: "prototype/speed-count/variant-1", base: BASE }])],
      }),
    );
    const merged = findingsFor(findings, "prototype.merged");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.severity).toBe("error");
    expect(merged[0]!.message).toContain("prototype/speed-count/variant-1");
    expect(merged[0]!.message).toContain("main");
    expect(merged[0]!.message).toContain(TIP);
    // The copy path is NAMED, so the reader knows what to look for and why
    // ancestry said nothing.
    expect(merged[0]!.message).toContain("cherry-pick");
    expect(merged[0]!.fix).toBeDefined();
  });

  test("a merged-by-ancestry branch reports ONCE, not twice", () => {
    const findings = validate(
      input({
        prototypeRefs: {
          defaultBranch: "main",
          branches: [
            {
              branch: "prototype/speed-count/variant-1",
              tip: TIP,
              ancestorOfDefault: true,
              copiedToDefault: [],
            },
          ],
          remoteRefs: [],
        },
        events: [variantsCreatedEvent([{ branch: "prototype/speed-count/variant-1", base: BASE }])],
      }),
    );
    expect(findingsFor(findings, "prototype.merged")).toHaveLength(1);
  });

  test("an unrecorded branch with copied commits still fires — the copy needs no base to be judged", () => {
    // Unlike ancestry, patch-id equivalence does not need the creation base:
    // commits of this branch ARE in main, whoever created it. The unrecorded
    // warning still stands alongside, since the branch remains unjudgeable
    // for the ancestry half.
    const findings = validate(
      input({
        prototypeRefs: {
          defaultBranch: "main",
          branches: [
            {
              branch: "prototype/hand-made/variant-1",
              tip: TIP,
              ancestorOfDefault: false,
              copiedToDefault: [TIP],
            },
          ],
          remoteRefs: [],
        },
      }),
    );
    expect(findingsFor(findings, "prototype.merged")).toHaveLength(1);
    expect(findingsFor(findings, "prototype.unrecorded")).toHaveLength(1);
  });

  test("an active variant with no copies stays clean — neither signal fires on honest exploration", () => {
    const findings = validate(
      input({
        prototypeRefs: {
          defaultBranch: "main",
          branches: [
            {
              branch: "prototype/speed-count/variant-1",
              tip: TIP,
              ancestorOfDefault: false,
              copiedToDefault: [],
            },
          ],
          remoteRefs: [],
        },
        events: [variantsCreatedEvent([{ branch: "prototype/speed-count/variant-1", base: BASE }])],
      }),
    );
    expect(prototypeFindings(findings)).toEqual([]);
  });
});

describe("prototype.pushed — a prototype ref that can reach a PR (F5.2)", () => {
  test("a remote-tracking prototype ref is an ERROR: pushing is the PR's precondition", () => {
    const findings = validate(
      input({
        prototypeRefs: {
          defaultBranch: "main",
          branches: [],
          remoteRefs: ["origin/prototype/speed-count/variant-1"],
        },
      }),
    );
    const pushed = findingsFor(findings, "prototype.pushed");
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.severity).toBe("error");
    expect(pushed[0]!.message).toContain("origin/prototype/speed-count/variant-1");
    expect(pushed[0]!.message).toContain("never merges");
  });
});

describe("prototype.unrecorded — honest about what it cannot judge (F5.2)", () => {
  test("a prototype-named branch with no journaled creation record warns instead of guessing", () => {
    const findings = validate(
      input({
        prototypeRefs: {
          defaultBranch: "main",
          branches: [
            {
              branch: "prototype/hand-made/variant-1",
              tip: BASE,
              ancestorOfDefault: true,
              copiedToDefault: [],
            },
          ],
          remoteRefs: [],
        },
      }),
    );
    const unrecorded = findingsFor(findings, "prototype.unrecorded");
    expect(unrecorded).toHaveLength(1);
    expect(unrecorded[0]!.severity).toBe("warning");
    expect(unrecorded[0]!.message).toContain("prototype/hand-made/variant-1");
    expect(unrecorded[0]!.fix).toContain("nahel prototype start");
    // It never doubles as a merged claim — unprovable is not proven.
    expect(findingsFor(findings, "prototype.merged")).toEqual([]);
  });
});

describe("prototype.scan-failed — never-merge could not be judged at all (HC6)", () => {
  /**
   * A scan that ABORTED inside a real repo is not "there is no repo here":
   * prototype refs may be sitting in it, unjudged. Silence would let
   * `nahel validate` exit 0 — indistinguishable from a verified-clean repo —
   * which is exactly the invisible failure HC6/ADR-0011 forbids.
   */
  test("an aborted scan is an ERROR carrying the reason, and invents no verdicts", () => {
    const findings = validate(
      input({
        prototypeRefs: {
          branches: [],
          remoteRefs: [],
          error:
            "git cherry refs/heads/main refs/heads/prototype/speed-count/variant-1 failed in " +
            "/repo: output exceeded nahel's 200-byte capture cap",
          scanFailed: true,
        },
      }),
    );
    const scanFailed = findingsFor(findings, "prototype.scan-failed");
    expect(scanFailed).toHaveLength(1);
    expect(scanFailed[0]!.severity).toBe("error");
    // The operator learns WHY the check could not run, in git's own words.
    expect(scanFailed[0]!.message).toContain("capture cap");
    expect(scanFailed[0]!.message).toContain("git cherry");
    expect(scanFailed[0]!.fix).toBeDefined();
    // Nothing else is judged: no merged/pushed/unrecorded verdict it never saw.
    expect(prototypeFindings(findings).map((finding) => finding.check)).toEqual([
      "prototype.scan-failed",
    ]);
  });
});

describe("the prototype checks stay silent when there is nothing to judge", () => {
  test("no ref scan at all (git unavailable, or a non-repo checkout) produces no prototype findings", () => {
    expect(prototypeFindings(validate(input({})))).toEqual([]);
    expect(
      prototypeFindings(
        validate(
          input({
            prototypeRefs: { branches: [], remoteRefs: [], error: "not a git repository" },
          }),
        ),
      ),
    ).toEqual([]);
  });

  test("a repo with no prototype refs produces no prototype findings", () => {
    expect(
      prototypeFindings(
        validate(input({ prototypeRefs: { defaultBranch: "main", branches: [], remoteRefs: [] } })),
      ),
    ).toEqual([]);
  });

  test("without a resolvable default branch the merged check is skipped, not guessed", () => {
    const findings = validate(
      input({
        prototypeRefs: {
          branches: [
            {
              branch: "prototype/speed-count/variant-1",
              tip: TIP,
              ancestorOfDefault: false,
              copiedToDefault: [],
            },
          ],
          remoteRefs: [],
        },
        events: [
          variantsCreatedEvent([{ branch: "prototype/speed-count/variant-1", base: BASE }]),
        ],
      }),
    );
    expect(findingsFor(findings, "prototype.merged")).toEqual([]);
  });
});

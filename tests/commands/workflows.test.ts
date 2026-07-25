import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseWorkflowDoc } from "../../src/install/workflow";
import { readFrontmatterFile } from "../../src/store/frontmatter";

/**
 * The feature-lane canonical workflow docs (PRD F1): prd-new, prd-parse,
 * epic-decompose, task-lifecycle. These tests prove each shipped doc is a
 * valid canonical workflow (frontmatter parses, name matches the file stem)
 * AND that its body drives exactly the CLI mechanics the lane depends on —
 * the docs are the product here, and a doc that drifted from the CLI would
 * instruct agents to run commands that do not exist.
 */

/** Read a shipped workflow doc and prove it valid per the canonical format. */
async function shippedWorkflow(file: string) {
  const path = join(import.meta.dir, "../../nahel/workflows", file);
  const { frontmatter, body } = await readFrontmatterFile(path);
  return { parsed: parseWorkflowDoc(file, frontmatter), body };
}

describe("feature-lane canonical workflow docs (F1)", () => {
  test("prd-new.md: grilling interview, statusless PRD in docs/prds/, deliverable recorded via --prd", async () => {
    const { parsed, body } = await shippedWorkflow("prd-new.md");
    expect(parsed.name).toBe("prd-new");
    expect(parsed.description.length).toBeGreaterThan(0);
    // Mechanics: the plan item is CLI-owned; the PRD is prose.
    expect(body).toContain("nahel item new plan");
    expect(body).toContain("--prd docs/prds/");
    // Real timestamps, never estimated (datetime rule).
    expect(body).toContain('date -u +"%Y-%m-%dT%H:%M:%SZ"');
    // ADR-0013: the PRD carries NO status field; the plan item owns the gate,
    // and the workflow stops at in-review — approval (done) is the human's.
    expect(body).toContain("NO status field");
    expect(body).toContain("--status in-review");
    expect(body).toContain("done");
    // Interview quality bar: the grill covers the load-bearing sections.
    for (const section of ["Goal", "Non-goals", "acceptance criteria", "Exit test", "Open questions"]) {
      expect(body).toContain(section);
    }
    // F7.3: the grilling skill dependency carries an inline fallback, and the
    // doc has a degraded-environment fallback; actor identity is stated.
    expect(body).toContain("grilling");
    expect(body).toContain("Fallback");
    expect(body).toContain("NAHEL_ACTOR");
  });

  test("prd-parse.md: approval-gated, creates the parent feature via the CLI with the lane heuristics", async () => {
    const { parsed, body } = await shippedWorkflow("prd-parse.md");
    expect(parsed.name).toBe("prd-parse");
    expect(parsed.description.length).toBeGreaterThan(0);
    // Precondition: the human approved — the plan item flipped to done.
    expect(body).toContain("done");
    expect(body).toContain("STOP");
    // Mechanics: parent feature item referencing the PRD by path, journaled.
    expect(body).toContain("nahel item new feature");
    expect(body).toContain("--prd docs/prds/");
    expect(body).toContain("nahel log note");
    // Lane heuristics are stated, per the lane vocabulary.
    for (const lane of ["direct", "epic-lite", "full"]) {
      expect(body).toContain(lane);
    }
    expect(body).toContain("Fallback");
    expect(body).toContain("NAHEL_ACTOR");
  });

  test("epic-decompose.md: session-sized, independently-verifiable children on a real-order DAG", async () => {
    const { parsed, body } = await shippedWorkflow("epic-decompose.md");
    expect(parsed.name).toBe("epic-decompose");
    expect(parsed.description.length).toBeGreaterThan(0);
    // Mechanics: children via --parent, ordering via --depends-on, sanity via status.
    expect(body).toContain("nahel item new");
    expect(body).toContain("--parent");
    expect(body).toContain("--depends-on");
    expect(body).toContain("nahel status");
    // Discipline ported from ccpm's epic-decompose.
    expect(body).toContain("one focused session");
    expect(body).toContain("independently verifiable");
    expect(body).toContain("DAG");
    expect(body).toContain("truly blocking");
    expect(body).toContain("Fallback");
    expect(body).toContain("NAHEL_ACTOR");
  });

  test("bug-lane.md: diagnosis-first — investigation doc, red-before-fix hard rule, waiver only after failed repro, root cause distilled", async () => {
    const { parsed, body } = await shippedWorkflow("bug-lane.md");
    expect(parsed.name).toBe("bug-lane");
    expect(parsed.description.length).toBeGreaterThan(0);
    // Mechanics compose task-lifecycle, never repeat it.
    expect(body).toContain("task-lifecycle");
    // F5.1: the durable investigation document, recorded on the item by path.
    expect(body).toContain("docs/investigations/");
    expect(body).toContain("--investigation");
    for (const section of ["symptoms", "repro status", "hypotheses", "root cause"]) {
      expect(body.toLowerCase()).toContain(section);
    }
    // F5.2 hard rule (acceptance: no done without repro-or-waiver): the
    // failing repro test comes before ANY fix — the tdd red-first posture.
    expect(body).toContain("HARD RULE");
    expect(body).toContain("failing repro test");
    expect(body).toContain("red");
    // Diagnosis discipline: pinned diagnosing-bugs skill with inline fallback.
    expect(body).toContain("diagnosing-bugs");
    expect(body).toContain("reproduce");
    expect(body).toContain("isolate");
    expect(body).toContain("one at a time");
    // F5.3 waiver path: an observation, tagged, item-referenced, valid ONLY
    // with documented failed repro attempts, provenance to the journal, and
    // restated in the PR body — never silently skipped.
    expect(body).toContain("nahel observe");
    expect(body).toContain("repro-waiver");
    expect(body).toContain("--item");
    expect(body).toContain("ONLY");
    expect(body).toContain("failed repro attempts");
    expect(body).toContain("sources");
    expect(body).toContain("PR body");
    // F5.4 close: root cause distilled with provenance; run ended honestly;
    // done stays the human's to grant.
    expect(body).toContain("nahel run end");
    expect(body).toContain("--status in-review");
    expect(body).toContain("done");
    expect(body).toContain("Fallback");
    expect(body).toContain("NAHEL_ACTOR");
  });

  test("task-lifecycle.md: the leaf loop — status flips, run phases, journaled findings, the claim rule", async () => {
    const { parsed, body } = await shippedWorkflow("task-lifecycle.md");
    expect(parsed.name).toBe("task-lifecycle");
    expect(parsed.description.length).toBeGreaterThan(0);
    // Mechanics: the full CLI loop.
    expect(body).toContain("--status in-progress");
    expect(body).toContain("nahel run start");
    expect(body).toContain("nahel run update");
    expect(body).toContain("--phase");
    expect(body).toContain("nahel run end");
    expect(body).toContain("success");
    expect(body).toContain("failure");
    expect(body).toContain("--status in-review");
    expect(body).toContain("--status blocked");
    expect(body).toContain("nahel log note");
    // done is granted by the human after merge/acceptance, never self-granted.
    expect(body).toContain("done");
    // TDD posture: red first, assertions never weakened.
    expect(body).toContain("red");
    expect(body).toContain("weaken");
    // The claim rule: stop and surface, never work around.
    expect(body).toContain("claim");
    expect(body).toContain("STOP");
    expect(body).toContain("Fallback");
    expect(body).toContain("NAHEL_ACTOR");
  });
});

/**
 * The AFK runner loop (Phase 2 PRD F2 + F7, ADR-0016). `nahel dispatch` owns
 * the mechanics; THIS document owns every judgment call — the autonomy gate,
 * scope discovery, lane picks, the delegated-approval consensus, wave
 * ordering, review timing, parking, and the draft PR per epic. Each test below
 * pins a load-bearing line: prose an editor could soften without noticing is
 * exactly the prose a runner would skip, and a skipped line here is a run that
 * dispatches on an unfinished dependency, fakes an approval, or asks a human
 * mid-run.
 */
describe("afk-run canonical workflow doc (F2, F7)", () => {
  test("valid canonical doc whose kickoff is the autonomy gate: each artifact refuses by name (F7.1, F7.2)", async () => {
    const { parsed, body } = await shippedWorkflow("afk-run.md");
    expect(parsed.name).toBe("afk-run");
    expect(parsed.description.length).toBeGreaterThan(0);

    // F7.1: three prerequisites, each refusing independently BY NAME and
    // naming the workflow that produces the missing artifact.
    expect(body).toContain("no human-signed constitution");
    expect(body).toContain("no passing run contract");
    expect(body).toContain("no recorded inception tier");
    expect(body).toContain("nahel/workflows/inception.md");

    // F7.2: the signature is a deterministic read of recorded state — the
    // schema-validated field plus the human provenance of the act that set
    // it — never a judgment call about what the constitution document says.
    expect(body).toContain("constitution_signed_by");
    expect(body).toContain("nahel doctor");
    expect(body).toContain("An agent-attributed signature is not a signature");
    expect(body).toContain("reads recorded state only");
    expect(body).toContain("deterministic");
    // F7.3: interactive work stays ungated.
    expect(body).toContain("Interactive work is ungated");
  });

  test("scope discovery and lane picks run through the CLI, with the reasoning journaled (F2.1, F2.2)", async () => {
    const { body } = await shippedWorkflow("afk-run.md");
    // F2.1: the kickoff line is resolved against recorded state — brief,
    // backlog, constitution — and missing items are CREATED through the CLI.
    expect(body).toContain("nahel brief");
    expect(body).toContain("nahel status");
    expect(body).toContain("nahel item new");
    expect(body).toContain("kickoff");
    // F2.2: a lane pick without a journaled reason is not a lane pick.
    expect(body).toContain("nahel item update <item-id> --lane");
    expect(body).toContain("nahel log note");
    for (const lane of ["direct", "epic-lite", "full"]) {
      expect(body).toContain(lane);
    }
  });

  test("Full lane: AFK authoring journals every assumption and the delegated approval carries F2.2's provenance shape", async () => {
    const { body } = await shippedWorkflow("afk-run.md");
    // AFK authoring mode: the interview is replaced by evidence + a journaled
    // assumption trail. A park or an approval with no trail is invalid.
    expect(body).toContain("AFK authoring mode");
    expect(body).toContain('--data summary="assumption:');
    expect(body).toContain("docs/prds/");

    // The gate is governed by config, resolved from the brief, never asked.
    expect(body).toContain("governance.product");
    expect(body).toContain("delegated");

    // The provenance shape the acceptance criterion demands: a proposal and a
    // verification, separately actor-attributed to DIFFERENT vendors, bound to
    // the SAME PRD revision, and a decision event linking both.
    expect(body).toContain("git hash-object docs/prds/");
    expect(body).toContain("--data revision=<hash>");
    expect(body).toContain("--data assumptions=");
    expect(body).toContain("nahel dispatch review --item <plan-id>");
    expect(body).toContain("--data verifies=<proposal-event-id>");
    expect(body).toContain("--data proposal=<proposal-event-id>");
    expect(body).toContain("--data verification=<verification-event-id>");
    expect(body).toContain("cross-vendor");
    expect(body).toContain("A verification you write yourself proves nothing");

    // Park triggers, each named: vendor disagreement, constitution conflict,
    // a seed tier — and the human-governance gate parks with assumptions up.
    expect(body).toContain("verdict=disagree");
    expect(body).toContain("constitution conflict");
    expect(body).toContain("`seed`");
    // The delegated flip covers plan-item approval ONLY.
    expect(body).toContain("nahel item update <plan-id> --status done");
    expect(body).toContain("Leaf-item `done` stays human-only");
    expect(body).toContain("Constitution amendments are never delegable");
    // Continuation happens in the same run.
    expect(body).toContain("nahel/workflows/prd-parse.md");
    expect(body).toContain("nahel/workflows/epic-decompose.md");
  });

  test("wave ordering is completion-then-dispatch, and every worker is spawned by nahel dispatch (F2.3)", async () => {
    const { body } = await shippedWorkflow("afk-run.md");
    // The bar: agent-reachable completion of EVERY declared dependency,
    // proven from the journal — run ended success AND status in-review (or
    // done, where a human already flipped it). `done` is deliberately not it.
    expect(body).toContain("COMPLETION-THEN-DISPATCH");
    expect(body).toContain("depends_on");
    expect(body).toContain("ended `success`");
    expect(body).toContain("`in-review`");
    expect(body).toContain("is NOT the bar");
    expect(body).toContain("nahel progress --item <dependency-id>");
    // Routing is enforced by the CLI; hand-spawning is forbidden in prose too.
    expect(body).toContain("nahel dispatch implementation --item <item-id>");
    expect(body).toContain("Never invoke an agent CLI yourself");
    expect(body).toContain("responsibility");
  });

  test("review is invoked, not duplicated; parks are journaled decisions the brief surfaces (F2.4)", async () => {
    const { body } = await shippedWorkflow("afk-run.md");
    // F2.4/F3: the review loop owns reviewing AND merge mechanics.
    expect(body).toContain("nahel/workflows/review-loop.md");
    expect(body).toContain("do not merge anything yourself");
    // Never ask mid-run: an unanswerable question becomes a park.
    expect(body).toContain("never ask mid-run");
    expect(body).toContain("nahel item update <item-id> --status blocked");
    expect(body).toContain('--data summary="parked:');
    expect(body).toContain("pending human decisions");
  });

  test("one trail-carrying draft PR per epic, opened only after verify-by-driving (F2.5, F4)", async () => {
    const { body } = await shippedWorkflow("afk-run.md");
    expect(body).toContain("ONE draft PR per epic");
    expect(body).toContain("never one combined PR");
    expect(body).toContain("gh pr create --draft");
    // The body carries the trail: waves, reviews, driving evidence, waivers.
    for (const trail of ["waves", "review dispositions", "verify-by-driving evidence", "waiver"]) {
      expect(body).toContain(trail);
    }
    // Merge authority is honored, never exercised here.
    expect(body).toContain("merge: human");
    expect(body).toContain("merge: on-approve");
    // The verify-by-driving invariant binds every lane, and parks when the
    // host cannot drive — no PR without evidence or a parked state.
    expect(body).toContain("verified by driving:");
    expect(body).toContain("every lane");
    expect(body).toContain("cannot drive");
    expect(body).toContain("nahel run start <item-id>");
  });

  test("checkpoint discipline holds at every boundary, with no process killing (F6 hooks)", async () => {
    const { body } = await shippedWorkflow("afk-run.md");
    expect(body).toContain("checkpoint check");
    expect(body).toContain("before every dispatch");
    expect(body).toContain("before every PR open");
    expect(body).toContain("STAND DOWN");
    expect(body).toContain("Never kill a worker");
    expect(body).toContain("nahel handback");
    expect(body).toContain("paused run");
  });

  test("agent-neutral and conversation-drivable, with a degraded-environment fallback", async () => {
    const { body } = await shippedWorkflow("afk-run.md");
    expect(body).toContain("NAHEL_ACTOR");
    expect(body).toContain("pure conversation");
    expect(body).toContain("Fallback");
    // Executable by a non-Claude host: no host-specific tooling anywhere.
    for (const claudeism of ["Claude", "Codex", "Task tool", "subagent", "slash command"]) {
      expect(body).not.toContain(claudeism);
    }
  });
});

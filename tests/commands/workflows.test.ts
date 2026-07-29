import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseWorkflowDoc } from "../../src/install/workflow";
import { readFrontmatterFile } from "../../src/store/frontmatter";
import { MUTATION_PAYLOAD_KEYS } from "../../src/store/mutate";

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

  test("gate 1b admits an honest greenfield: a healthcheck-only failure WITH the journaled obligation (F7.1, F9.3)", async () => {
    const { body } = await shippedWorkflow("afk-run.md");
    const gate = body.slice(
      body.indexOf("b. **A passing run contract"),
      body.indexOf("c. **A recorded inception tier"),
    );
    expect(gate.length).toBeGreaterThan(0);
    // The contradiction this fixes: inception (F9.3) records `standard` on an
    // empty repo with the doctor proof DEFERRED as a journaled obligation, so
    // a gate demanding exit 0 outright means an honest greenfield can never
    // start an AFK run at all. The gate takes EITHER branch.
    expect(gate).toContain("EITHER");
    expect(gate).toContain("first-scaffold obligation");
    expect(gate).toContain("nahel progress");
    // Only the env/healthcheck exits are deferrable — those are the ones the
    // obligation is about (nothing to prove yet on an empty repo).
    expect(gate).toContain("Exit 3");
    expect(gate).toContain("Exit 4");
    // A missing or malformed contract still refuses outright: the obligation
    // defers the PROOF, never the contract itself.
    expect(gate).toContain("Exit 2 refuses");
    expect(gate).toContain("never the contract itself");
    // The gate and the verify step point at each other, so the deferral is
    // discharged rather than forgiven.
    expect(gate).toContain("step 9a");
    const step = verifyStep(body);
    expect(step).toContain("first-scaffold obligation");
    expect(step).toContain("gate 1b");
    expect(step).toContain("discharge");
  });

  test("the exit path is ordered verify → PR → review, so the loop always has a PR to annotate (F4)", async () => {
    const { body } = await shippedWorkflow("afk-run.md");
    // review-loop's mechanics (`gh pr edit`, `gh pr ready`, `gh pr merge`) all
    // need an EXISTING PR, and F4 forbids opening one before the changed flow
    // was driven. Only one order satisfies both: verify, open, review.
    const verifyAt = body.indexOf("9. Verify by driving");
    const prAt = body.indexOf("10. Open ONE draft PR");
    const reviewAt = body.indexOf("11. Review.");
    expect(verifyAt).toBeGreaterThan(0);
    expect(prAt).toBeGreaterThan(verifyAt);
    expect(reviewAt).toBeGreaterThan(prAt);

    // The review step says which PR it is reviewing, so the dependency is
    // stated rather than left to a runner to infer.
    const reviewStep = body.slice(reviewAt, body.indexOf("12. Park anything"));
    expect(reviewStep).toContain("step 10");
    expect(reviewStep).toContain("gh pr edit");

    // The trail list stays on the PR-open step; review rounds append to the
    // body afterwards — the PRs #13–#18 pattern the loop's step 10 codifies.
    const prStep = body.slice(prAt, reviewAt);
    expect(prStep).toContain("review dispositions");
    expect(prStep).toContain("step 11");
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

  test("the delegated-approval decision record uses fixed --data keys and summary prefixes an auditor can grep (F2.2)", async () => {
    const { body } = await shippedWorkflow("afk-run.md");
    // The three events a human auditing a delegated approval reads back are
    // only findable if their shapes are FIXED. The Phase 1 docs (prd-new,
    // prd-parse) name these same strings as what to look for, so a summary
    // reworded here silently breaks an audit trail two other docs promise.
    expect(body).toContain('summary="PRD proposed for delegated approval:');
    expect(body).toContain("--data prd=docs/prds/<slug>.md");
    expect(body).toContain("summary='PRD verification:");
    expect(body).toContain("--data verdict=<agree|disagree>");
    expect(body).toContain('summary="delegated approval (governance.product=delegated):');
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

  test("the gate reads a hands-off founding's signature from the human act that recorded it (F9.5)", async () => {
    const { body } = await shippedWorkflow("afk-run.md");
    // A hands-off founding costs the human exactly one act (the init/kickoff
    // that recorded the paragraph) — so the gate's human-provenance check has
    // to look at THAT act, or "zero return visits" would mean "never runs AFK".
    // The rule itself is unchanged: an agent-attributed act signs nothing.
    expect(body).toContain("founding");
    expect(body).toContain("mode: hands-off");
    expect(body).toContain("the tier record itself may be agent-attributed");
    expect(body).toContain("An agent-attributed signature is not a signature");
  });

  test("the signed constitution is checked before EVERY implementation dispatch, on every lane (F9.5)", async () => {
    const { body } = await shippedWorkflow("afk-run.md");
    const dispatchStep = body.slice(
      body.indexOf("8. Dispatch the worker"),
      body.indexOf("9. Verify by driving"),
    );
    expect(dispatchStep.length).toBeGreaterThan(0);
    // Not only at the Full-lane approval gate: a one-line direct-lane chore
    // gets the same check, and a contradiction parks instead of dispatching.
    expect(dispatchStep).toContain("contradict");
    expect(dispatchStep).toContain("every lane");
    expect(dispatchStep).toContain("park");
    // Under a hands-off founding the signed content is the paragraph, and the
    // agent's own elaboration cannot authorize contradicting it.
    expect(dispatchStep).toContain("paragraph");
    expect(dispatchStep).toContain("nahel/workflows/inception.md");
  });

  /**
   * F4 — verify-by-driving. The invariant that most wants to rot: it is the
   * slowest step, the one a runner can convince itself the tests already
   * cover, and the only one whose absence a green PR does not reveal. These
   * tests pin the lane universality, the grep-able evidence shape, and the
   * park-instead-of-skip outcome to exact prose.
   */
  const verifyStep = (body: string) =>
    body.slice(body.indexOf("9. Verify by driving"), body.indexOf("10. Open ONE draft PR"));

  test("verify-by-driving binds EVERY lane — direct included, least ceremony still drives or parks (F4.1)", async () => {
    const { body } = await shippedWorkflow("afk-run.md");
    const step = verifyStep(body);
    expect(step.length).toBeGreaterThan(0);
    // The per-lane statement, not a happy-path aside: the lane scales
    // ceremony, never this. A `direct` one-liner is named explicitly because
    // it is the lane a runner would talk itself out of driving.
    expect(step).toContain("EVERY lane");
    expect(step).toContain("`direct`-lane one-liner verifies exactly like a `full`-lane epic");
    expect(step).toContain("Least ceremony still drives, or parks");
    // Tests are not driving — the substitution the invariant exists to refuse.
    expect(step).toContain("Tests passing is not driving");
    // F4.1's three mechanics, in order: contract satisfied, app launched per
    // the contract, THE CHANGED FLOW exercised with the host's tooling.
    expect(step).toContain("nahel doctor");
    expect(step).toContain("exits 0");
    expect(step).toContain("launch");
    expect(step).toContain("seed");
    expect(step).toContain("CHANGED flow");
  });

  test("driving evidence has a fixed --data shape tying flow, tooling, run and verifying actor (F4.2)", async () => {
    const { body } = await shippedWorkflow("afk-run.md");
    const step = verifyStep(body);
    // Evidence rides a run of the runner's own — the worker's dispatch run
    // closed when it exited, and evidence tied to no run is unattributable.
    expect(step).toContain("nahel run start <item-id>");
    expect(step).toContain("nahel run update <run-id> --phase verify");
    expect(step).toContain("nahel run end <run-id> success");
    // Fixed keys, same discipline as step 6's delegated-approval record, so a
    // human audits the claim by grepping rather than by re-running it.
    expect(step).toContain('summary="verified by driving:');
    expect(step).toContain("--data flow=");
    expect(step).toContain("--data tooling=");
    expect(step).toContain("--data lane=<direct|epic-lite|full>");
    expect(step).toContain("--item <item-id> --run <run-id>");
    // Attribution and audit-without-re-running are stated, not implied.
    expect(step).toContain("VERIFYING ACTOR");
    expect(step).toContain("NAHEL_ACTOR");
    expect(step).toContain("WITHOUT re-running");
    // A flow driven and observed to fail is a finding, never a PR.
    expect(step).toContain("failure");
    expect(step).toContain("never open the PR on a flow you watched fail");
  });

  test("a host that cannot drive parks with an actionable reason — never a silent skip (F4.3)", async () => {
    const { body } = await shippedWorkflow("afk-run.md");
    const step = verifyStep(body);
    // The three triggers the PRD names, each recognizable to a runner.
    expect(step).toContain("no driving tooling");
    expect(step).toContain("headless transport");
    expect(step).toContain("incomplete contract env");
    // The park is a real park: blocked status + reason, per step 12.
    expect(step).toContain("nahel item update <item-id> --status blocked");
    expect(step).toContain('summary="parked: cannot verify by driving');
    expect(step).toContain("--data park=cannot-drive");
    // Evidence-or-park is exhaustive: there is no third outcome.
    expect(step).toContain("silent skip");
    expect(step).toContain("EITHER journaled driving evidence OR a park");
  });

  test("the PR body links each item's driving evidence, and an undriven epic gets no PR (F4.2, F4.3)", async () => {
    const { body } = await shippedWorkflow("afk-run.md");
    const prStep = body.slice(body.indexOf("10. Open ONE draft PR"), body.indexOf("11. Review."));
    expect(prStep.length).toBeGreaterThan(0);
    // The PR step's trail list must name the driving evidence and cite it by
    // event id — a PR body that only asserts verification is unauditable.
    expect(prStep).toContain("verify-by-driving evidence from step 9");
    expect(prStep).toContain("journal event ids");
    expect(prStep).toContain("verifying actor");
    // The AC's teeth: no evidence and no park means no PR.
    expect(prStep).toContain("does not get a PR");
  });

  /**
   * F6 — intervention. A human reaching into a running AFK loop is the one
   * moment where "the agent kept going" is a safety failure, not a virtue.
   * These tests pin the checkpoint boundaries, the stand-down mechanics, the
   * no-kill rule with the exact commands claim enforcement actually permits,
   * and resumption from state alone.
   */
  const checkpointStep = (body: string) =>
    body.slice(body.indexOf("3. The checkpoint check"), body.indexOf("4. Discover scope"));

  test("the checkpoint check runs before EVERY dispatch, phase transition and PR open (F6.1)", async () => {
    const { body } = await shippedWorkflow("afk-run.md");
    const step = checkpointStep(body);
    expect(step.length).toBeGreaterThan(0);
    // All three boundaries named in the definition itself.
    expect(step).toContain("before every dispatch");
    expect(step).toContain("phase transition");
    expect(step).toContain("before every PR open");
    // Checking once at the top of a run is the failure mode; say so.
    expect(step).toContain("Checking once at the top of the run is not checking");
    // And the steps that own those boundaries each point back at it, so the
    // rule cannot be honored in the abstract and skipped in the concrete.
    // Sliced marker-to-next-marker: a reference in step 8 must not satisfy
    // the assertion for step 7.
    const markers = [
      "7. Order the work into waves",
      "8. Dispatch the worker",
      "9. Verify by driving",
      "10. Open ONE draft PR",
      "11. Review.",
      "12. Park anything",
    ];
    const offsets = markers.map((marker) => {
      const at = body.indexOf(marker);
      expect(at).toBeGreaterThan(0);
      return at;
    });
    // Markers appear in document order, or the slices below are meaningless.
    for (let i = 1; i < offsets.length; i += 1) expect(offsets[i]!).toBeGreaterThan(offsets[i - 1]!);
    for (let i = 0; i < markers.length - 1; i += 1) {
      expect(body.slice(offsets[i]!, offsets[i + 1]!)).toContain("checkpoint check (step 3)");
    }
  });

  test("a claim triggers clean stand-down while the run continues elsewhere (F6.1)", async () => {
    const { body } = await shippedWorkflow("afk-run.md");
    const step = checkpointStep(body);
    // Subtree coverage: an ancestor's claim binds the child.
    expect(step).toContain("any ancestor's");
    expect(step).toContain("whole subtree");
    // "Clean" is spelled out: nothing further started AND nothing already
    // started finished, no PR, no provoked refusals.
    expect(step).toContain("start nothing further on it, finish nothing already started on it");
    expect(step).toContain("open no PR for it");
    // Journaled with a grep-able shape naming the checkpoint and the claim.
    expect(step).toContain('summary="stood down at checkpoint: claimed by <claimant>"');
    expect(step).toContain("--data checkpoint=<dispatch|phase|pr-open>");
    expect(step).toContain("--data claim=");
    // The run does not end: other items carry on.
    expect(step).toContain("a claim on one item never ends the run");
    // A paused run stops dispatching from the pause onward — zero, not one more.
    expect(step).toContain("zero further dispatches");
    expect(step).toContain("run.paused");
  });

  test("no process killing: the worker exits naturally and the RUNNER journals it, claim-exempt (F6.2)", async () => {
    const { body } = await shippedWorkflow("afk-run.md");
    const step = checkpointStep(body);
    expect(step).toContain("Never kill a worker");
    expect(step).toContain("no kill, no terminate, no interrupt mid-write");
    expect(step).toContain("NATURAL exit");
    // The mechanics, matching what the store actually enforces: `nahel run
    // end` is refused under a claim (mutate()'s claim check), while notes are
    // claim-exempt — so the runner journals, and never forces the run closed.
    expect(step).toContain("`nahel run end` on it is refused");
    expect(step).toContain("notes are claim-exempt");
    expect(step).toContain("nahel log note --item <item-id> --run <run-id>");
    expect(step).toContain('summary="worker exited naturally under claim:');
    expect(step).toContain("--data exit=");
    expect(step).toContain("--data output=");
    // The claimed run stays paused/claimed — the preserved state IS the proof.
    expect(step).toContain("stays `paused` and claimed rather than force-ended");
    // The recorded output is for the human, not for building on.
    expect(step).toContain("never merged, never built on");
  });

  test("handback resumes from state alone, including the human's changes (F6.3)", async () => {
    const { body } = await shippedWorkflow("afk-run.md");
    const step = checkpointStep(body);
    // The human's verb, and the event that carries the delta.
    expect(step).toContain("nahel handback");
    expect(step).toContain("item.handback");
    // Deterministic evidence the store actually records on that event.
    expect(step).toContain("commits since the claim baseline");
    expect(step).toContain("diff summary");
    // No prior-session memory required — the whole point of F6.3.
    expect(step).toContain("nahel progress --item <item-id>");
    expect(step).toContain("NO memory of the claim");
    // Re-reading changes what gets dispatched next, or the resume is theatre.
    expect(step).toContain("Re-read before you re-dispatch");
    expect(step).toContain("not what you remember");
  });
});

/**
 * The review loop (Phase 2 PRD F3), codifying what PRs #13–#18 proved:
 * two cross-vendor reviewers, findings validated against HEAD before they may
 * be fixed, red-first fixes, a hard three-round cap, and — owned here and
 * nowhere else — the merge decision. afk-run invokes this doc (its step 11) and
 * deliberately does not restate any of it, so a line softened here is a rule
 * that exists nowhere: a loop that counts two same-vendor reviews as two, that
 * fixes a stale finding blind, that grinds past the cap instead of parking, or
 * that merges a PR the recorded authority says a human must merge.
 */
describe("review-loop canonical workflow doc (F3)", () => {
  test("two reviewer slots, both named by config; same-vendor is refused, never counted (F3.1)", async () => {
    const { parsed, body } = await shippedWorkflow("review-loop.md");
    expect(parsed.name).toBe("review-loop");
    expect(parsed.description.length).toBeGreaterThan(0);

    // Both slots resolve from the committed routing map, not from preference.
    expect(body).toContain("routing.review");
    expect(body).toContain("routing.default");
    expect(body).toContain("routing.implementation");
    expect(body).toContain("cross-vendor");

    // Slot 1 is DISPATCHED, which is what attributes its verdict to its own
    // vendor; a list written on a reviewer's behalf is one reviewer, not two.
    expect(body).toContain("nahel dispatch review --item <item-id>");
    expect(body).toContain("its own `NAHEL_ACTOR`");
    expect(body).toContain("--data verdict=<approve|request-changes>");
    // Slot 2 reviews independently — before it can be anchored by slot 1.
    expect(body).toContain("BEFORE you read slot 1's findings");

    // The refusal: cross-vendor is the bar, and a single-vendor project fails
    // it — including the fall-through case where `review` is simply unset.
    expect(body).toContain("two same-vendor reviews are not two reviewers");
    expect(body).toContain("REFUSE");
    expect(body).toContain("nahel/workflows/setup-routing.md");
  });

  test("slot 2 resolves from routing.review2 when the map sets it, and falls back when it does not (F3.1)", async () => {
    const { body } = await shippedWorkflow("review-loop.md");
    // The committed second slot: a config key (not a fourth responsibility —
    // ADR-0015's enum still carries one `review`), which is what makes the
    // pairing checkable before the loop runs rather than only at runtime.
    expect(body).toContain("routing.review2");
    expect(body).toContain("routing.review-same-vendor");
    expect(body).toContain("nahel validate");
    expect(body).toContain("not a fourth responsibility");
    // The fallback keeps every map written before review2 existed working.
    expect(body).toContain("With `routing.review2` unset");
    expect(body).toContain("routing.implementation");
    expect(body).toContain("routing.default");
  });

  test("any capable vendor can drive: slot 2 is filled in-session or DISPATCHED (F3.1)", async () => {
    const { body } = await shippedWorkflow("review-loop.md");
    // Pinning slot 2 to "the driver reviews it itself" made the loop drivable
    // by exactly one vendor — routing.review2's — and every other capable host
    // had to park. Both fills are legitimate; which one applies is mechanical.
    expect(body).toContain("nahel dispatch review --slot 2 --item <item-id>");
    expect(body).toContain("in-session");
    // The rule that picks between them, and the enum discipline that survives:
    // `--slot` is a flag on the review responsibility, not a new one.
    expect(body).toContain("your vendor IS");
    expect(body).toContain("not a fourth responsibility");
    expect(body).toContain("nahel dispatch review2` is refused");
    // Parking is now reserved for a slot nothing can fill — never for "the
    // driver is the wrong vendor".
    expect(body).toContain("no longer a park");
  });

  test("every finding is validated against HEAD; stale ones are dismissed with a note, never fixed blind (F3.2)", async () => {
    const { body } = await shippedWorkflow("review-loop.md");
    // The round is bound to an exact revision, so "stale" is decidable.
    expect(body).toContain("git rev-parse HEAD");
    expect(body).toContain("git diff <sha>..HEAD");
    // Live vs stale, and the journaled dismissal that replaces a blind fix.
    expect(body).toContain("STALE");
    expect(body).toContain("no longer exists at HEAD");
    expect(body).toContain("--data disposition=dismissed-stale");
    expect(body).toContain("Never fix a finding blind");
  });

  test("accepted findings are fixed red-first, re-reviewed, and capped at three rounds (F3.3)", async () => {
    const { body } = await shippedWorkflow("review-loop.md");
    // Red-first where testable, with the TDD posture's non-negotiable.
    expect(body).toContain("red-first");
    expect(body).toContain("--phase red");
    expect(body).toContain("Never weaken an existing assertion");
    // The cap: three rounds, counted per item, journaled so it survives a
    // fresh session — and re-review means BOTH slots read the new HEAD.
    expect(body).toContain("THREE rounds");
    expect(body).toContain("review round <n> of 3");
    expect(body).toContain("nahel progress --item <item-id>");
    // Cap reached parks with the loop history — never merges over objections,
    // never stalls the caller's other work.
    expect(body).toContain("reached its 3-round cap");
    expect(body).toContain("nahel item update <item-id> --status blocked");
    expect(body).toContain("Never merge over objections");
    expect(body).toContain("never let a cap-reached park stall the rest of the run");
  });

  test("merge authority: refused under human, provenance-gated under on-approve, used sparingly (F3.4)", async () => {
    const { body } = await shippedWorkflow("review-loop.md");
    // Authority is READ from the brief's resolved surface, never inferred from
    // the config file's text or from an approval count.
    expect(body).toContain("nahel brief");
    expect(body).toContain("merge: human");
    expect(body).toContain("regardless of how many approvals it carries");
    // A validly human-authorized flag merges — and journals who authorized it:
    // the standing config act plus both reviewers' sign-offs.
    expect(body).toContain("merge: on-approve");
    expect(body).toContain("gh pr merge");
    expect(body).toContain("--data authorized_by=<event-id>");
    // An agent-set (or unprovable, or ambiguous) flag is inert: behave as
    // `merge: human`, park, and expect validate's warning by name.
    expect(body).toContain("inert");
    expect(body).toContain("agent-set");
    expect(body).toContain("merge.unauthorized");
    expect(body).toContain("nahel validate");
    // The use-sparingly guidance the PRD requires this doc to carry.
    expect(body).toContain("SPARINGLY — small items, or changes QA testing covers well");
    // Merging is not accepting: `done` on a leaf stays the human's.
    expect(body).toContain("Leaf-item `done` stays human-only");
  });

  test("a sign-off HEAD that is no longer current is stale — no merge on unreviewed commits (F3.3, F3.4)", async () => {
    const { body } = await shippedWorkflow("review-loop.md");
    const mergeStep = body.slice(
      body.indexOf("9. The merge decision"),
      body.indexOf("10. Write the trail"),
    );
    expect(mergeStep.length).toBeGreaterThan(0);
    // Both verdicts at the same HEAD is necessary but not sufficient: nothing
    // said that HEAD was still current when the merge is actually performed,
    // so a push landing between sign-off and merge shipped unreviewed commits
    // under two approvals of something else.
    expect(mergeStep).toContain("git rev-parse HEAD");
    expect(mergeStep).toContain("sign-off HEAD");
    expect(mergeStep).toContain("stale");
    // The remedy is the loop's own: another round, or the cap's park.
    expect(mergeStep).toContain("another round");
    expect(mergeStep).toContain("cap");
    expect(mergeStep).toContain("do not merge");
  });

  test("both reviewers reconcile into one journaled disposition list the PR body carries (F3.1, F3.3)", async () => {
    const { body } = await shippedWorkflow("review-loop.md");
    expect(body).toContain("ONE disposition list");
    for (const disposition of ["accepted", "dismissed-stale", "dismissed-disagreed", "deferred"]) {
      expect(body).toContain(disposition);
    }
    expect(body).toContain("--data finding=<finding-event-id>");
    // The PR body is the trail afk-run's step 10 opens and this loop appends
    // to, round by round — the PRs #13–#18 pattern.
    expect(body).toContain("gh pr edit");
    expect(body).toContain("rounds, findings, dispositions, and verdicts");
    expect(body).toContain("nahel/workflows/afk-run.md");
    expect(body).toContain("its step 10");
  });

  test("agent-neutral and conversation-drivable, with a degraded-environment fallback", async () => {
    const { body } = await shippedWorkflow("review-loop.md");
    expect(body).toContain("NAHEL_ACTOR");
    expect(body).toContain("pure conversation");
    expect(body).toContain("Fallback");
    // Executable by any host: no vendor-specific tooling named anywhere.
    for (const claudeism of ["Claude", "Codex", "Task tool", "subagent", "slash command"]) {
      expect(body).not.toContain(claudeism);
    }
  });
});

/**
 * The governance qualifier the Phase 2 PRD scopes into F2.2: the Phase 1 docs
 * state approval as "the human's decision" unconditionally, which is now only
 * true under `governance.product: human`. These tests pin the qualifier, its
 * hard boundary (plan-item approval ONLY), and the decision-event trail an
 * auditor greps for — a doc that keeps the old absolute sentence would have a
 * delegated runner either park work it is authorized to approve, or worse,
 * read the exception as covering a leaf item's `done`.
 */
describe("governance qualifiers on the Phase 1 approval docs (F2.2)", () => {
  test("prd-new.md: approval is human-owned under `human`, delegable under `delegated` per afk-run step 6", async () => {
    const { body } = await shippedWorkflow("prd-new.md");
    // The qualifier: the setting decides, and the brief is where it is read.
    expect(body).toContain("governance.product");
    expect(body).toContain("nahel brief");
    // Under `human` the Phase 1 rule is untouched.
    expect(body).toContain("Nothing about this step changes");
    // Under `delegated` the consensus procedure is REFERENCED, never restated:
    // one definition, in afk-run, so the two can never drift apart.
    expect(body).toContain("cross-vendor consensus");
    expect(body).toContain("nahel/workflows/afk-run.md` step 6");
    expect(body).toContain("never improvise a shorter one here");
    // The boundary: plan-item approval only.
    expect(body).toContain("PLAN-ITEM approval and nothing else");
    expect(body).toContain("leaf-item `done` stays human-only");
    expect(body.toLowerCase()).toContain("constitution amendments are never delegable");
    // The audit trail, named by the exact strings afk-run journals.
    expect(body).toContain("nahel progress --item");
    expect(body).toContain("PRD proposed for delegated approval");
    expect(body).toContain("delegated approval (governance.product=delegated)");
    expect(body).toContain("verifies");
    expect(body).toContain("is not an approval");
  });

  test("prd-parse.md: the gate is unchanged, but whose flip it is depends on governance.product", async () => {
    const { body } = await shippedWorkflow("prd-parse.md");
    expect(body).toContain("governance.product");
    expect(body).toContain("unchanged");
    expect(body).toContain("cross-vendor consensus");
    expect(body).toContain("nahel/workflows/afk-run.md` step 6");
    expect(body).toContain("plan-item approval only");
    // The gate itself never softens: `done`, or STOP.
    expect(body).toContain("STOP");
    // The audit trail, so a delegated `done` can be checked rather than trusted.
    expect(body).toContain("nahel progress --item <plan-id>");
    expect(body).toContain("PRD proposed for delegated approval");
    expect(body).toContain("delegated approval (governance.product=delegated)");
    expect(body).toContain("is not an approval");
  });

  test("prd-parse.md: the delegated audit checks the verdict, the CURRENT hash and the assumption trail", async () => {
    const { body } = await shippedWorkflow("prd-parse.md");
    // "The trail is present" is far too weak a gate: a `disagree` verdict, a
    // verification bound to a revision the PRD has since moved past, or a
    // proposal citing an assumption trail that is not in the journal all
    // accompany an agent-set `done` perfectly well.
    expect(body).toContain("verdict=agree");
    expect(body).toContain("git hash-object docs/prds/<slug>.md");
    // Re-hashed AT PARSE TIME, not read off the event: a moved hash means the
    // approved bytes are not the bytes about to be decomposed.
    expect(body).toContain("re-hash");
    expect(body).toContain("moved");
    expect(body).toContain("assumption");
    // The consequence is a refusal AND a park, not a silent stop: the item
    // has to be visible to the human whose gate was skipped.
    expect(body).toContain("refuse to parse");
    expect(body).toContain("nahel item update <plan-id> --status blocked");
    expect(body).toContain('summary="parked:');
  });

  test("task-lifecycle.md: leaf-item `done` stays human-only, auto-merge and delegated governance notwithstanding", async () => {
    const { body } = await shippedWorkflow("task-lifecycle.md");
    expect(body).toContain("even when the PR auto-merged under `merge: on-approve`");
    expect(body).toContain("governance.product: delegated");
    expect(body).toContain("plan-item approval only");
    expect(body).toContain("nahel/workflows/afk-run.md` step 6");
  });

  test("bug-lane.md: leaf-item `done` stays human-only, auto-merge and delegated governance notwithstanding", async () => {
    const { body } = await shippedWorkflow("bug-lane.md");
    expect(body).toContain("even when the PR auto-merged under `merge: on-approve`");
    expect(body).toContain("governance.product: delegated");
    expect(body).toContain("plan-item approval only");
    expect(body).toContain("nahel/workflows/afk-run.md` step 6");
  });
});

/**
 * Knowledge-first inception (Phase 2 PRD F9). The Phase 1 doc mined the
 * codebase on brownfield and asked blank questions everywhere else; F9 makes
 * mining UNIVERSAL and the interview confirm-and-correct, adds the up-front
 * mode capture (guided grill vs a single hands-off paragraph), and states the
 * authority boundary that keeps an agent-drafted constitution constitutional:
 * only the human's paragraph is signed content. These tests pin the promises
 * the doc makes — a softened line here is a founding that quietly records a
 * tier it did not earn, or an agent writing constitution.
 */
describe("knowledge-first inception (F9)", () => {
  test("mode-and-input capture is the FIRST step: a meta-question, asked before mining (F9.4)", async () => {
    const { body } = await shippedWorkflow("inception.md");
    // The question itself, in the founder's words.
    expect(body.toLowerCase()).toContain("grill session (guided)");
    expect(body).toContain("give me a paragraph and I figure it out (hands-off)");
    expect(body).toContain("meta-question");
    // Both doors (hard constraint 5): the CLI shortcut and the plain command.
    expect(body).toContain('nahel init --hands-off "');
    expect(body).toContain("nahel config set founding");
    expect(body).toContain("--data mode=hands-off");
    // Ordering is the requirement, not just presence: mode before mining,
    // mining before any content question.
    const modeAt = body.indexOf("Mode and input");
    const mineAt = body.indexOf("Mine first");
    expect(modeAt).toBeGreaterThan(-1);
    expect(mineAt).toBeGreaterThan(modeAt);
  });

  test("scaffolding is the FIRST mechanical act on a bare repo, in BOTH modes (F9.4)", async () => {
    const { body } = await shippedWorkflow("inception.md");
    const modeSection = body.slice(
      body.indexOf("## Step 0 — Mode and input capture"),
      body.indexOf("## Pick the tier"),
    );
    expect(modeSection.length).toBeGreaterThan(0);
    // The bug this pins: guided mode recorded `config set founding` and
    // research notes before any `nahel init`, so on a bare repo every command
    // fails — there is no store to record into. The meta-question may be
    // ASKED first; nothing is RECORDED until the store exists.
    expect(modeSection).toContain("nahel init");
    expect(modeSection).toContain("BOTH modes");
    expect(modeSection).toContain("no store");
    // Ordering, not just presence: the scaffold instruction precedes the
    // first recording command in the section.
    const initAt = modeSection.indexOf("nahel init");
    const recordAt = modeSection.indexOf("nahel config set founding");
    expect(initAt).toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(initAt);
    // Hands-off on a bare repo scaffolds AND records in the human's one act,
    // so it is the init rather than a step before it.
    expect(modeSection).toContain('nahel init --hands-off "');
    expect(modeSection).toContain("scaffolds and records");
  });

  test("the draft manifest proves the complete draft set predated the first answer (F9.2)", async () => {
    const { body } = await shippedWorkflow("inception.md");
    // F9's AC needs the ORDER to be provable from the journal, not asserted in
    // prose: one event, before the interview, hashing every drafted artifact.
    expect(body).toContain("draft manifest:");
    expect(body).toContain("before the first interview response");
    expect(body).toContain("git hash-object");
    expect(body).toContain("git hash-object --stdin");
    expect(body).toContain("--data manifest=");
    // Drafting events are distinct from sign-off: the signature stays the
    // human's own `config set inception` act, and no note substitutes for it.
    expect(body).toContain("never sign-off");
    expect(body).toContain("nahel config set inception");
    // The manifest is journaled before the interview AND before the hands-off
    // verification — same event, both modes.
    const manifestAt = body.indexOf("draft manifest:");
    const interviewAt = body.indexOf("The interview is then confirm-and-correct");
    const verifyAt = body.indexOf("### Verify the elaboration");
    expect(manifestAt).toBeGreaterThan(-1);
    expect(interviewAt).toBeGreaterThan(manifestAt);
    expect(verifyAt).toBeGreaterThan(manifestAt);
  });

  test("hands-off verification is bound to a plan item that exists BEFORE the dispatch (F9.5)", async () => {
    const { body } = await shippedWorkflow("inception.md");
    const section = body.slice(
      body.indexOf("### Verify the elaboration"),
      body.indexOf("### When the paragraph is not enough"),
    );
    expect(section.length).toBeGreaterThan(0);
    // `nahel dispatch` has required --item since wave 1, so the itemless
    // dispatch this section used to write was refused outright — the
    // elaboration could never be verified as documented.
    expect(section).toContain("nahel dispatch review --item <plan-id>");
    expect(section).toContain("requires `--item`");
    // The item is the founding's own first plan item, created as part of the
    // artifact set (the initial decomposition) BEFORE this verification.
    expect(section).toContain("nahel item new plan");
    expect(section).toContain("initial decomposition");
    const createAt = section.indexOf("nahel item new plan");
    const dispatchAt = section.indexOf("nahel dispatch review --item");
    expect(createAt).toBeGreaterThan(-1);
    expect(dispatchAt).toBeGreaterThan(createAt);
    // All three provenance events ride that item, or the trail is unattached.
    expect(section).toContain("nahel log note --item <plan-id>");
  });

  test("the elaboration consensus binds ONE manifest hash over the COMPLETE founded set (F9.5)", async () => {
    const { body } = await shippedWorkflow("inception.md");
    const section = body.slice(
      body.indexOf("### Verify the elaboration"),
      body.indexOf("### When the paragraph is not enough"),
    );
    // The gap this closes: hashing PRODUCT/CONTEXT/ADRs alone left governance,
    // routing, the contract and the decomposition free to change without
    // invalidating the consensus F9.5 binds to the COMPLETE artifact set.
    expect(section).toContain("nahel/config");
    expect(section).toContain("nahel/items/");
    expect(section).toContain("governance");
    expect(section).toContain("routing");
    expect(section).toContain("contract");
    expect(section).toContain("decomposition");
    // ONE hash, over a canonical (sorted) manifest — not a pile of hashes.
    expect(section).toContain("sort");
    expect(section).toContain("manifest-hash");
    expect(section).toContain("hashed once");
    // And that one hash is the revision on all three events.
    expect(section).toContain("--data revision=<manifest-hash>");
    const revisions = section.split("--data revision=<manifest-hash>").length - 1;
    expect(revisions).toBeGreaterThanOrEqual(3);
    // A hash that moved since the proposal is unverified — re-run before deciding.
    expect(section).toContain("Re-run the manifest");
  });

  test("one workflow, two interaction modes — no separate mining workflow (F9 review nit 4)", async () => {
    const { body } = await shippedWorkflow("inception.md");
    expect(body).toContain("interaction mode");
    expect(body).toContain("no separate mining workflow");
    expect(body).toContain("same mining");
  });

  test("mining is universal and provable: greenfield mines knowledge + web, sources journaled (F9.1)", async () => {
    const { body } = await shippedWorkflow("inception.md");
    expect(body).toContain("MINE FIRST");
    expect(body.toLowerCase()).toContain("brownfield");
    expect(body.toLowerCase()).toContain("greenfield");
    // Greenfield sources: the agent's own domain knowledge and the web, with
    // the citation trail journaled — or the web's absence journaled instead.
    expect(body).toContain('nahel log note --data summary="research sources:');
    expect(body).toContain("web unavailable");
    // The complete standard-tier artifact set is DRAFTED before any content
    // question, and the interview is confirm-and-correct in every mode.
    expect(body).toContain("complete standard-tier artifact set");
    expect(body).toContain("before any content question");
    expect(body).toContain("confirm-and-correct");
    for (const artifact of [
      "constitution",
      "governance",
      "glossary",
      "ADR",
      "routing",
      "decomposition",
      "run contract",
    ]) {
      expect(body).toContain(artifact);
    }
    // Drafting is not founding: only recorded state founds a project.
    expect(body).toContain("A draft is not a founding");
  });

  test("hands-off: the paragraph is the ONLY signed content, verbatim; elaboration is unconfirmed (F9.5)", async () => {
    const { body } = await shippedWorkflow("inception.md");
    expect(body).toContain("no return visit");
    expect(body).toContain("VERBATIM");
    expect(body).toContain("only human-signed content");
    expect(body).toContain("UNCONFIRMED");
    expect(body).toContain("never constitutional text");
    // Parkable assumptions, promotable later by the human's signature.
    expect(body).toContain("parkable assumption");
    expect(body).toContain("promote");
    // The document structure states the boundary — including the amendment
    // note the constitution itself carries (F9 review nit 1) and the ADR.
    expect(body).toContain("Amendment note");
    expect(body).toContain("docs/adr/0008");
    // The two frozen headings brief extracts must survive the marking.
    expect(body).toContain("## Goal");
    expect(body).toContain("## Hard constraints");
    expect(body).toContain("nahel brief");
  });

  test("hands-off elaboration is verified with afk-run step 6's cross-vendor provenance shape (F9.5)", async () => {
    const { body } = await shippedWorkflow("inception.md");
    expect(body).toContain("nahel/workflows/afk-run.md` step 6");
    expect(body).toContain("git hash-object");
    expect(body).toContain("nahel dispatch review");
    expect(body).toContain("DIFFERENT vendor");
    expect(body).toContain("--data revision=");
    expect(body).toContain("--data verification=");
    // Bound to the founded artifact-set revision, and failing closed.
    expect(body).toContain("founded artifact set");
    expect(body).toContain("A verification you write yourself proves nothing");
  });

  test("a constitutionally insufficient paragraph refuses standard and parks (F9.5)", async () => {
    const { body } = await shippedWorkflow("inception.md");
    expect(body).toContain("no coherent goal");
    expect(body).toContain("REFUSE to record `standard`");
    expect(body).toContain("--status blocked");
    expect(body).toContain("parked:");
    // Never paper over the gap — an invented goal is agent-authored
    // constitution, exactly what the boundary forbids.
    expect(body).toContain("Never invent the goal");
  });

  test("hands-off records delegated product governance, and the paragraph gates every dispatch (F9.5)", async () => {
    const { body } = await shippedWorkflow("inception.md");
    expect(body).toContain("--data product=delegated");
    expect(body).toContain("before every implementation dispatch");
    expect(body).toContain("on every lane");
    // The lab proof rides on the hands-off founding: a Full-lane drafted PRD
    // and a direct-lane one-liner get the identical check (review nit 2).
    expect(body).toContain("Full-lane");
    expect(body).toContain("direct-lane");
    expect(body).toContain("nahel/workflows/afk-run.md` step 8");
    expect(body).toContain("the run can never override");
  });

  test("hands-off signature provenance is the human-attributed founding act, deterministic to check (F9.5)", async () => {
    const { body } = await shippedWorkflow("inception.md");
    expect(body).toContain("config.updated");
    expect(body).toContain("An agent-run founding act signs nothing");
    expect(body).toContain("nahel progress");
    // The tier record still carries the signature field the gate reads first.
    expect(body).toContain("--data constitution_signed_by=");
  });

  test("tier honesty: standard means RECORDED, with the empty-repo doctor proof journaled as an obligation (F9.3)", async () => {
    const { body } = await shippedWorkflow("inception.md");
    expect(body).toContain("Tier honesty");
    expect(body).toContain("recorded, not drafted");
    expect(body).toContain("first-scaffold obligation");
    expect(body).toContain("nahel doctor");
    expect(body).toContain("verify-by-driving");
    expect(body).toContain("nahel/workflows/afk-run.md` step 9a");
    // A cut-short NEW founding records seed; a re-founding never lowers a
    // committed tier (the ratchet, kept from Phase 1).
    expect(body).toContain("cut short");
    expect(body).toContain("records `seed`");
    expect(body).toContain("only ratchets up");
  });

  test("ADR-0008 carries the dated hands-off addendum on constitution composition", async () => {
    const path = join(import.meta.dir, "../../docs/adr/0008-constitution-vs-legislation.md");
    const text = await Bun.file(path).text();
    expect(text).toContain("Addendum");
    expect(text).toContain("2026-07-25");
    expect(text).toContain("hands-off");
    expect(text).toContain("verbatim");
    expect(text).toContain("UNCONFIRMED");
    expect(text).toContain("never constitutional text");
    expect(text).toContain("by signing");
    expect(text).toContain("nahel/workflows/inception.md");
  });
});

describe("prototype-lane canonical workflow doc (F5)", () => {
  test("variants → explore: the CLI spawns the workspaces, ceremony is stripped by name (F5.1)", async () => {
    const { parsed, body } = await shippedWorkflow("prototype-lane.md");
    expect(parsed.name).toBe("prototype-lane");
    expect(parsed.description.length).toBeGreaterThan(0);

    // The lane is the TYPE's, and the spawn is one deterministic CLI call.
    expect(body).toContain("nahel item new prototype");
    expect(body).toContain("nahel prototype start <item-id> --variants");
    expect(body).toContain("--approach");
    // Each variant gets its own workspace and its own approach statement.
    expect(body).toContain("prototype/<slug>/variant-<n>");
    expect(body).toContain("docs/prototypes/<slug>/variant-<n>.md");
    // Ceremony stripped — named explicitly so nobody re-adds it out of habit.
    expect(body).toContain("no TDD");
    expect(body).toContain("no review loop");
    expect(body).toContain("no consensus");
  });

  test("the never-merge invariant is stated AND pinned to its mechanism (F5.2)", async () => {
    const { body } = await shippedWorkflow("prototype-lane.md");
    expect(body).toContain("never merges");
    // Both mechanical seams, by name — prose alone does not satisfy F5.2.
    expect(body).toContain("`in-review`");
    expect(body).toContain("`done`");
    expect(body).toContain("prototype.merge-refused");
    expect(body).toContain("nahel validate");
    expect(body).toContain("prototype.merged");
    expect(body).toContain("prototype.pushed");
    // No PR, no push — the workflow states the human-side half of the rule.
    expect(body).toContain("Never open a PR");
    expect(body).toContain("dropped");
  });

  test("the never-merge check states BOTH its signals and its one honest blind spot (F5.2)", async () => {
    const { body } = await shippedWorkflow("prototype-lane.md");
    // Ancestry alone cannot see a cherry-pick — the copy path rule 2 names
    // explicitly — so patch-id equivalence is the second signal.
    expect(body).toContain("cherry-pick");
    expect(body).toContain("patch");
    expect(body).toContain("git cherry");
    // And the residual is stated rather than papered over: a squash merge
    // rewrites the patch, so neither signal sees it. A doc that implied full
    // coverage would make the never-push rule feel optional.
    expect(body).toContain("squash");
    expect(body).toContain("cannot see");
    expect(body).toContain("never push");
  });

  test("judge → promote: mini-PRD onto the plan lane, approval per governance (F5.3)", async () => {
    const { body } = await shippedWorkflow("prototype-lane.md");
    expect(body).toContain("nahel prototype promote <variant-item-id>");
    expect(body).toContain("nahel/workflows/prd-new.md");
    expect(body).toContain("nahel/workflows/prd-parse.md");
    expect(body).toContain("governance.product");
    // Delegated consensus and the human gate are afk-run's mechanics, referenced.
    expect(body).toContain("nahel/workflows/afk-run.md");
    expect(body).toContain("reference-only");
    // The prototype code stays out of the promoted feature's diff.
    expect(body).toContain("Never copy");
  });

  test("promotion refuses on a seed-tier project, naming the upgrade (F5.4)", async () => {
    const { body } = await shippedWorkflow("prototype-lane.md");
    expect(body).toContain("seed");
    expect(body).toContain("upgrade inception first");
    expect(body).toContain("nahel/workflows/inception.md");
    expect(body).toContain("standard");
  });

  test("disposal is journaled for every variant, winner included (F5.3)", async () => {
    const { body } = await shippedWorkflow("prototype-lane.md");
    expect(body).toContain("nahel prototype dispose <variant-item-id>");
    expect(body).toContain("--reason");
    expect(body).toContain("--force");
  });

  test("the degraded fallback keeps the invariant when the CLI is unavailable", async () => {
    const { body } = await shippedWorkflow("prototype-lane.md");
    expect(body).toContain("Fallback (degraded environment)");
    expect(body).toContain("NO");
    expect(body).toContain("never merges");
  });
});

/**
 * The QA lane (Phase 3 PRD F1–F4). One canonical doc built in four stages:
 * charter from recorded criteria, sweep the running app, file findings as
 * typed items, ratchet the valuable checks into the canonical test command.
 *
 * The doc is the product here, and its two failure modes are both invisible
 * in a green suite: prose an editor softens (a budget that becomes "as much
 * as time allows", an exclusion that stops needing a reason) and prose that
 * quietly binds the lane to one app. These tests pin the load-bearing lines
 * verbatim and prove the lane stays target-agnostic.
 */

/**
 * Slice one qa-lane section. Sections are addressed by heading TITLE, never by
 * number: the doc is built stage by stage and the trailing sections renumber
 * as earlier ones land. `until` bounds a `###` subsection, whose end the
 * default `\n## ` scan would overshoot.
 */
function qaSection(body: string, title: string, until?: string): string {
  const at = body.indexOf(title);
  if (at < 0) return "";
  const end =
    until === undefined ? body.indexOf("\n## ", at) : body.indexOf(until, at + title.length);
  return body.slice(at, end < 0 ? body.length : end);
}

describe("qa-lane canonical workflow doc — charter stage (F1)", () => {
  test("valid canonical doc whose preamble names the actor, the lifecycle it composes, and the no-hand-edit rule", async () => {
    const { parsed, body } = await shippedWorkflow("qa-lane.md");
    expect(parsed.name).toBe("qa-lane");
    expect(parsed.description.length).toBeGreaterThan(0);
    expect(parsed.args).toBe("<target hint or item id>");
    // The actor reminder rides the preamble, like every other lane doc: an
    // unattributed sweep is a sweep nobody can hold to its evidence.
    const actorAt = body.indexOf("NAHEL_ACTOR");
    expect(actorAt).toBeGreaterThan(-1);
    expect(actorAt).toBeLessThan(body.indexOf("## 1."));
    // Lifecycle mechanics are composed, never restated.
    expect(body).toContain("nahel/workflows/task-lifecycle.md");
    expect(body).toContain("never hand-edit anything under");
    // The two boundaries the whole lane rests on.
    expect(body).toContain("QA finds; QA never fixes");
    expect(body).toContain("QA never gates a merge");
  });

  test("the lane is target-agnostic and host-neutral — no lab app, no keys, no vendor tooling", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const lower = body.toLowerCase();
    // A workflow that named a particular lab app — or worse, knew where its
    // expected results were written down — would test that app and grade
    // nothing. Everything this lane checks comes from the TARGET's own store.
    for (const leak of ["answer key", "answer-key", "pop-quiz", "pop quiz", "planted bug"]) {
      expect(lower).not.toContain(leak);
    }
    for (const hostism of ["Claude", "Codex", "Task tool", "subagent", "slash command"]) {
      expect(body).not.toContain(hostism);
    }
    expect(body).toContain("target-agnostic");
  });

  test("own the work: a `qa` item and a run record, both through the CLI (F1 acceptance)", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const step = qaSection(body, "Own the work");
    expect(step.length).toBeGreaterThan(0);
    expect(step).toContain("nahel item new qa");
    expect(step).toContain("nahel item update <item-id> --status in-progress");
    expect(step).toContain("nahel run start <item-id>");
    expect(step).toContain("nahel run update <run-id> --phase charter");
    // An existing qa item is opened, never twinned; the resolution is journaled.
    expect(step).toContain("nahel status");
    expect(step).toContain("nahel log note");
    expect(step).toContain("qa scope:");
    // Which store the run belongs to is not left to inference.
    expect(step).toContain("TARGET repo's root");
  });

  test("the charter is DERIVED from the three recorded sources, never invented (F1)", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const step = qaSection(body, "Charter — the test plan comes from recorded criteria");
    expect(step.length).toBeGreaterThan(0);
    expect(step).toContain("DERIVE");
    // a. recorded acceptance criteria, reached through each item's --prd path.
    expect(step).toContain("acceptance criteria");
    expect(step).toContain("prd=docs/prds/");
    // b. the constitution's hard constraints, read from the brief's extract.
    expect(step).toContain("hard constraints");
    expect(step).toContain("nahel brief");
    // c. every open bug is a regression check, its repro lifted from the
    // investigation document the bug lane already wrote.
    expect(step).toContain("open `bug` item");
    expect(step).toContain("regression check");
    expect(step).toContain("investigation=docs/");
  });

  test("a PRD-less brownfield target charters from the knowledge layer and SAYS SO (F1 acceptance)", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const step = qaSection(body, "Charter — the test plan comes from recorded criteria");
    expect(step).toContain("Brownfield fallback");
    expect(step).toContain("PRODUCT.md");
    expect(step).toContain("CONTEXT.md");
    // The label is the requirement: a reader must know the plan rests on
    // inference rather than on criteria the project committed to.
    expect(step).toContain("LABEL this basis");
    expect(step).toContain("Never present an inferred case as a traced one");
  });

  test("every hard constraint is classified driveable or process-rule, exclusions justified (F1)", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const section = qaSection(
      body,
      "### Driveable, or a process rule",
      "### Write the charter",
    );
    expect(section.length).toBeGreaterThan(0);
    expect(section).toContain("DRIVEABLE");
    expect(section).toContain("process-rule");
    expect(section).toContain("EXCLUDED");
    expect(section).toContain("one-line reason");
    // The worked example the PRD names, so the classification is recognizable
    // rather than a category an agent has to invent a boundary for.
    expect(section).toContain("append-only history is a repo property, not app behavior");
    // The teeth: dropping the awkward constraints silently is the failure this
    // classification exists to make impossible.
    expect(section).toContain("An excluded constraint with no stated reason is an omission");
  });

  test("the charter document generalizes the proven shape and lives in the TARGET repo (F1)", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const section = qaSection(body, "### Write the charter", "### The coverage map");
    expect(section.length).toBeGreaterThan(0);
    expect(section).toContain("docs/qa/qa-plan.md");
    expect(section).toContain("TARGET repo");
    // The sections the hand-built 2026-07-23 plan proved out.
    for (const part of [
      "Purpose",
      "Preconditions",
      "Run artifacts",
      "Cases",
      "Exploratory section",
      "Coverage map",
      "Exclusions",
    ]) {
      expect(section).toContain(part);
    }
    // Numbered cases carrying steps, an expected result fixed BEFORE the
    // sweep, and the recorded thing each one traces to.
    expect(section).toContain("QA-01");
    expect(section).toContain("expected result");
    expect(section).toContain("what it traces to");
    expect(section).toContain("an expectation");
    // Preconditions come from the run contract; artifacts have a fixed layout;
    // timestamps are real (datetime rule), never estimated.
    expect(section).toContain("nahel doctor");
    expect(section).toContain("launch");
    expect(section).toContain("seed");
    expect(section).toContain("docs/qa-runs/<UTC-timestamp>/");
    expect(section).toContain('date -u +"%Y-%m-%dT%H:%M:%SZ"');
    // An untraceable case is exploratory by definition — never retro-fitted
    // to a criterion invented to justify it.
    expect(section).toContain("exploratory BY DEFINITION");
    expect(section).toContain("Do not invent a criterion");
  });

  test("the coverage map states the scripted-vs-judgment split in one table (F1)", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const section = qaSection(body, "### The coverage map", "### The exploration budget");
    expect(section.length).toBeGreaterThan(0);
    expect(section).toContain("| Ground | Committed scripts | Charter cases | Exploratory |");
    // Every cell filled or explicitly empty: an unfilled cell reads as covered.
    expect(section).toContain("A blank cell is a claim nobody made");
  });

  test("the exploration budget is a fixed formula, stated in the doc and reported when hit (F1)", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const section = qaSection(body, "### The exploration budget");
    expect(section.length).toBeGreaterThan(0);
    // The formula settles the PRD's former open question; softened into "as
    // much as time allows" it would settle nothing.
    expect(section).toContain("the larger of 30 probes or one probe per charter case");
    expect(section).toContain("never silently");
    // Charter generation is journaled on the QA run (F1 acceptance).
    expect(section).toContain("nahel log note --item <item-id> --run <run-id>");
    expect(section).toContain("charter generated:");
    expect(section).toContain("--data basis=<recorded-criteria|knowledge-docs>");
  });

  test("the degraded-environment fallback keeps the discipline when the CLI is gone", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    expect(body).toContain("Fallback (degraded environment)");
    expect(body).toContain("NO");
  });
});

describe("qa-lane canonical workflow doc — sweep stage (F2)", () => {
  test("the sweep is gated on a green contract and launches the app the contract describes (F2)", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const step = qaSection(body, "Sweep — drive the app, journal the evidence");
    expect(step.length).toBeGreaterThan(0);
    expect(step).toContain("nahel run update <run-id> --phase sweep");
    // The existing autonomy gate applies: a contract that does not hold means
    // every result recorded would be about the environment, not the app.
    expect(step).toContain("nahel doctor` must exit 0 before a sweep starts");
    expect(step).toContain("not the app the project describes");
    // Launch through the contract, drive the real interface — the Phase 2
    // verify-by-driving substitutions, refused again here.
    expect(step).toContain("contract's `launch` command");
    expect(step).toContain("`seed`");
    expect(step).toContain("REAL interface");
    expect(step).toContain("Tests passing is not driving");
    // Charter first, then the budgeted exploration from F1.
    expect(step).toContain("in charter order");
    expect(step).toContain("then budgeted exploration");
  });

  test("four event types, no others — with the wild shapes reproduced verbatim (F2 acceptance)", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const section = qaSection(body, "### The event vocabulary", "### Evidence or park");
    expect(section.length).toBeGreaterThan(0);

    // Per-case PASS and per-case FAIL keep the names and payload keys the
    // first sweeps in the wild already wrote (2026-07-23). Renaming them
    // would orphan every event already in a target's journal.
    expect(section).toContain("nahel log qa.result --item <item-id> --run <run-id>");
    expect(section).toContain("--data case=QA-<nn>");
    expect(section).toContain("--data result=pass");
    expect(section).toContain("nahel log qa.finding --item <item-id> --run <run-id>");
    expect(section).toContain("--data bug=<bug-item-id>");
    expect(section).toContain("2026-07-23");
    expect(section).toContain("VERBATIM");
    expect(section).toContain("not renameable");
    // The open-extension model stands: the specifics ride extra keys.
    expect(section).toContain("Extra observation keys are free");

    // The new per-probe type, carrying what was tried and whether it defects.
    expect(section).toContain("nahel log qa.probe --item <item-id> --run <run-id>");
    expect(section).toContain("--data probe=");
    expect(section).toContain("--data observed=");
    expect(section).toContain("--data defect=<yes|no>");

    // The new whole-sweep type, scoped so brief can never confuse per-case
    // with per-sweep: exactly one, and the only type brief's QA line reads.
    expect(section).toContain("qa.sweep-completed");
    expect(section).toContain("exactly ONE per sweep");
    expect(section).toContain("`nahel brief` reads ONLY this type");
    expect(section).toContain("never write two");

    // The link direction is stated, or `bug` can only be filled by a later
    // correction: file the item first, then journal the finding.
    expect(section).toContain("file the item first");
  });

  test("evidence or park — every charter case ends in one of three journaled states (F2 acceptance)", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const section = qaSection(body, "### Evidence or park", "### The branch and the PR");
    expect(section.length).toBeGreaterThan(0);
    expect(section).toContain("Zero silent omissions");
    expect(section).toContain("--data park=cannot-drive");
    expect(section).toContain("--data case=QA-<nn>");
    // The two substitutions a tiring sweep reaches for, refused by name.
    expect(section).toContain("is not a result");
    expect(section).toContain("is a park, not a skip");
    // A sweep that cannot start parks the ITEM rather than reporting nothing.
    expect(section).toContain("nahel item update <item-id> --status blocked");
  });

  test("all sweep work lands on a qa/ branch and closes as a draft PR — never the default branch (F2)", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const section = qaSection(body, "### The branch and the PR");
    expect(section.length).toBeGreaterThan(0);
    expect(section).toContain("git checkout -b qa/<UTC-timestamp>");
    expect(section).toContain("gh pr create --draft");
    expect(section).toContain("never a direct commit to the default branch");
    // Merge authority is the target's, exercised by the review loop, not here.
    expect(section).toContain("nahel/workflows/review-loop.md");
    // The AC's teeth: a sweep of a clean repo leaves the default branch alone.
    expect(section).toContain("leaves the default branch untouched");
  });

  test("the close writes the report, then exactly one summary event, then ends the run honestly (F2)", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const step = qaSection(body, "Close the sweep");
    expect(step.length).toBeGreaterThan(0);
    // The report is readable without the journal, and links every failure to
    // the item it filed (F3), so nothing lives only in prose.
    expect(step).toContain("docs/qa-runs/<timestamp>/report.md");
    expect(step).toContain("commit SHA");
    expect(step).toContain("budget");
    expect(step).toContain("LINKED to the item it filed");
    // One event, last, with the counts final.
    expect(step).toContain("nahel log qa.sweep-completed --item <item-id> --run <run-id>");
    expect(step).toContain("--data cases_run=<n>");
    expect(step).toContain("--data probes=<n>");
    expect(step).toContain("--data findings_filed=");
    expect(step).toContain("--data report=docs/qa-runs/<timestamp>/report.md");
    expect(step).toContain("after the findings are filed");
    // Finding defects is the job, so a sweep with failures still ends success;
    // `failure` is reserved for a sweep that could not do the job at all.
    expect(step).toContain("nahel run end <run-id> success");
    expect(step).toContain("nahel item update <item-id> --status in-review");
    expect(step).toContain("still ends `success`");
    expect(step).toContain("`done` is not yours to grant");
  });

  test("the document runs charter → sweep → close, in that order", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const charterAt = body.indexOf("Charter — the test plan comes from recorded criteria");
    const sweepAt = body.indexOf("Sweep — drive the app, journal the evidence");
    const closeAt = body.indexOf("Close the sweep");
    expect(charterAt).toBeGreaterThan(0);
    expect(sweepAt).toBeGreaterThan(charterAt);
    expect(closeAt).toBeGreaterThan(sweepAt);
  });
});

describe("qa-lane canonical workflow doc — findings stage (F3)", () => {
  test("every defect finding becomes an item in the SAME run — nothing lives only in the report (F3)", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const step = qaSection(body, "Findings — every defect becomes a typed item");
    expect(step.length).toBeGreaterThan(0);
    expect(step).toContain("only in a report");
    expect(step).toContain("SAME run");
    // The findings step runs before the close, so the summary's counts and the
    // report's links are about items that already exist.
    const findingsAt = body.indexOf("Findings — every defect becomes a typed item");
    expect(findingsAt).toBeGreaterThan(body.indexOf("Sweep — drive the app"));
    expect(body.indexOf("Close the sweep")).toBeGreaterThan(findingsAt);
  });

  test("duplicates are checked BEFORE filing; a re-found bug gets a note, never a twin (F3)", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const step = qaSection(body, "Findings — every defect becomes a typed item");
    expect(step).toContain("nahel status");
    expect(step).toContain("nahel recall");
    expect(step).toContain("nahel log note --item <existing-bug-id> --run <run-id>");
    expect(step).toContain("re-found during qa sweep");
    expect(step).toContain("a NOTE, not a twin");
  });

  test("a product question files as a human-flagged chore, never as a bug (F3)", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const step = qaSection(body, "Findings — every defect becomes a typed item");
    // The split: a defect contradicts something RECORDED. Where nothing
    // records the intended behavior, guessing it invents a requirement.
    expect(step).toContain("nahel item new chore");
    expect(step).toContain("question for the human");
    expect(step).toContain("--data question=product-behavior");
    expect(step).toContain("guessing the intended behavior");
    // A question does not stall the sweep.
    expect(step).toContain("the sweep carries on");
  });

  test("the bug carries an investigation stub a fresh agent can reproduce from ALONE (F3 acceptance)", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const step = qaSection(body, "Findings — every defect becomes a typed item");
    expect(step).toContain(
      "nahel item new bug <slug> direct --investigation docs/investigations/<slug>.md",
    );
    // The three parts the PRD requires, each named.
    expect(step).toContain("Repro steps");
    expect(step).toContain("Expected vs observed");
    expect(step).toContain("Environment");
    expect(step).toContain("from the stub ALONE");
    // The bar for "exact", stated as a refusal rather than an adjective.
    expect(step).toContain("is not a repro");
    // The bug lane picks it up from there; QA does not fix it.
    expect(step).toContain("nahel/workflows/bug-lane.md");
  });

  test("severity is a note, not new schema (F3)", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const step = qaSection(body, "Findings — every defect becomes a typed item");
    expect(step).toContain("--data severity=<blocker|major|minor>");
    expect(step).toContain("never new schema");
  });

  test("provenance: the QA run id rides the bug item's trail, readable back (F3 acceptance)", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const step = qaSection(body, "Findings — every defect becomes a typed item");
    expect(step).toContain("--data qa_run=<run-id>");
    expect(step).toContain("--data finding=<qa.finding-event-id>");
    expect(step).toContain("nahel progress --item <bug-id>");
    // The teeth: an untraceable bug item cannot be scored against the sweep.
    expect(step).toContain("cannot be traced to the sweep that found it");
  });
});

describe("qa-lane canonical workflow doc — ratchet stage (F4)", () => {
  test("ratchet scripts join the run contract's canonical test command — never a side suite (F4)", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const step = qaSection(body, "Ratchet — exploration hardens into committed scripts");
    expect(step.length).toBeGreaterThan(0);
    expect(step).toContain("run contract's `test` command");
    expect(step).toContain("no side suites");
    expect(step).toContain("remember to run");
    // A side suite met in the wild is folded in, not left beside the gate.
    expect(step).toContain("FOLD IT IN");
    expect(step).toContain("nahel config set contract");
    // Scripts are deterministic and committed on the sweep's own branch.
    expect(step).toContain("qa/` branch");
    expect(step).toContain("deterministic");
  });

  test("the suite only grows: never deleted, never weakened, never skipped by a QA run (F4)", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const step = qaSection(body, "Ratchet — exploration hardens into committed scripts");
    expect(step).toContain("The suite only grows");
    expect(step).toContain("never deleted, never weakened");
    // The three excuses, refused by name — this is the rule most likely to be
    // softened by a sweep that wants a green run.
    expect(step).toContain("not to make a sweep green");
    expect(step).toContain("human-reviewed PR path");
    // A committed script that now fails is a finding, not a maintenance chore.
    expect(step).toContain("that is a FINDING");
  });

  test("found-but-unfixed bugs are armed with expected-fail markers, and QA never fixes them (F4)", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const step = qaSection(body, "Ratchet — exploration hardens into committed scripts");
    // Red-first without holding everyone else's work hostage to a red suite.
    expect(step).toContain("expected-failure marker");
    expect(step).toContain("bug <bug-item-id>");
    expect(step).toContain("suite stays green");
    // The handoff: the bug lane fixes it, and flipping the marker is part of
    // THAT fix — after which the script guards the recurrence forever.
    expect(step).toContain("QA never fixes the bug");
    expect(step).toContain("nahel/workflows/bug-lane.md");
    expect(step).toContain("flipping the marker");
    expect(step).toContain("guards the recurrence");
    // The graduation is journaled, naming what landed and what is armed.
    expect(step).toContain("--data scripts=");
    expect(step).toContain("--data expected_fail=");
  });

  test("later sweeps run committed scripts FIRST, in an order the journal proves (F4 acceptance)", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const sweep = qaSection(body, "Sweep — drive the app, journal the evidence");
    // The order lives where a sweep actually reads it, not only in the ratchet
    // section: scripts, then charter, then explore.
    expect(sweep).toContain("ratchet scripts");
    expect(sweep).toContain("in charter order");
    expect(sweep).toContain("then budgeted exploration");
    // And it is journaled, because dispatch order asserted in prose proves
    // nothing about what a given sweep actually did.
    expect(sweep).toContain("--data phase=scripts-first");
    const step = qaSection(body, "Ratchet — exploration hardens into committed scripts");
    expect(step).toContain("provable from the journal");
    expect(step).toContain("earlier than its first `qa.result`");
    expect(step).toContain("is NOT re-explored");
  });

  test("the completed document runs charter → sweep → findings → ratchet → close", async () => {
    const { body } = await shippedWorkflow("qa-lane.md");
    const offsets = [
      "Charter — the test plan comes from recorded criteria",
      "Sweep — drive the app, journal the evidence",
      "Findings — every defect becomes a typed item",
      "Ratchet — exploration hardens into committed scripts",
      "Close the sweep",
    ].map((title) => {
      const at = body.indexOf(title);
      expect(at).toBeGreaterThan(0);
      return at;
    });
    for (let i = 1; i < offsets.length; i += 1) expect(offsets[i]!).toBeGreaterThan(offsets[i - 1]!);
  });
});

/**
 * The docs are the product, so every CLI example they carry must be one the
 * CLI accepts. `nahel log` bans MUTATION_PAYLOAD_KEYS (`target`, `record`,
 * `body` — src/store/mutate.ts) from `--data`, so a doc instructing
 * `nahel log note --data body="..."` sends every follower into a hard exit 1
 * (bug rgm43hvc: task-lifecycle, prd-parse, and epic-decompose all did).
 * This sweep is driven off MUTATION_PAYLOAD_KEYS itself, so a key added to
 * the reservation later fails any doc still teaching it. `nahel observe`
 * lines are deliberately out of scope — observe REQUIRES `body`.
 */
describe("shipped workflow docs vs `nahel log` reserved payload keys (rgm43hvc)", () => {
  test("no `nahel log` example in any shipped doc uses a reserved mutation payload key", async () => {
    const dir = join(import.meta.dir, "../../nahel/workflows");
    const files = (await readdir(dir)).filter((file) => file.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);

    let scanned = 0;
    const violations: string[] = [];
    for (const file of files) {
      const { body } = await readFrontmatterFile(join(dir, file));
      // Join backslash-continued lines first, so a reserved key on a
      // continuation line of a multi-line invocation is still caught.
      for (const line of body.replace(/\\\n\s*/g, " ").split("\n")) {
        if (!line.includes("nahel log")) continue;
        scanned++;
        for (const key of MUTATION_PAYLOAD_KEYS) {
          if (line.includes(`--data ${key}=`)) {
            violations.push(`${file}: reserved --data key ${JSON.stringify(key)} in: ${line.trim()}`);
          }
        }
      }
    }
    // The sweep must have real coverage — the lane docs all carry examples.
    expect(scanned).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});

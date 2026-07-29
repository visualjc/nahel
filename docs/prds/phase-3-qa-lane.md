---
name: phase-3-qa-lane
created: 2026-07-29T04:48:00Z
updated: 2026-07-29T04:48:00Z
---

# Phase 3 — QA Lane

## Goal

Nahel builds software without a human in the loop (Phase 2); it must also
**test** that software the way a human QA engineer would — by planning what to
check, driving the real running app, filing what it finds as proper bugs, and
leaving behind scripted tests so the same ground never has to be re-explored
by hand. Today only the verify-by-driving invariant exists, and it exercises
the *changed flow only*: nothing sweeps the rest of the app, nothing turns
exploration into durable scripts, and findings become bug items only when an
agent thinks to file them.

Phase 3 makes QA a first-class lane: a canonical workflow that generates a
test plan (charter) from recorded acceptance criteria, an exploratory pass
that drives the launched app beyond the happy path, automatic conversion of
findings into typed bug items with captured repro steps, and a
deterministic-script **ratchet** — the committed e2e suite only ever grows.

The lane is developed against a **keyed benchmark app**: a small game
("pop-quiz", a timed trivia app) founded via the Phase 2 hands-off flow and
seeded with deliberately planted bugs across known categories. The answer key
lives in the *nahel* repo, never in the target repo, so the sweep cannot read
its own test answers. This gives QA-lane development what the exit test alone
cannot: an honest score (found / missed / false alarm) against ground truth.
The dummy app flatters no one — the phase's exit bar still runs against a
real app.

Hard constraints inherited unchanged: the CLI stays deterministic (HC1) — all
QA judgment lives in workflow docs executed by agents; the CLI only records
state. Quality invariants are never silently skipped (HC6).

## Non-goals

- **No new CLI verb.** The lane runs on existing primitives: `qa` work items
  (the type already exists), runs, journal events, `nahel log`. If a gap
  forces a verb, that is a finding for a follow-up item, not scope here.
- **No CI integration.** Committed e2e scripts run under the repo's own test
  command; wiring them into GitHub Actions or any CI system is out.
- **No visual-regression, load, performance, or accessibility tooling.**
  Exploratory judgment may *note* such problems as findings, but no
  screenshot-diffing or lighthouse-style machinery ships.
- **No coverage metrics.** The ratchet is "the suite only grows", not a
  percentage target.
- **QA does not gate merges.** Findings inform; merge authority is untouched
  (governance config as amended 2026-07-25).
- **No Phase 4 pull-forward.** No role charters, no architect gates, no
  `nahel digest`.
- **The benchmark app is not a product.** pop-quiz gets no PRD ceremony, no
  feature roadmap, no polish beyond what bug-planting needs; it is lab
  equipment.

## Functional requirements

### F1 — qa-lane workflow: charter from recorded criteria

A canonical workflow doc `nahel/workflows/qa-lane.md` (same frontmatter
format as every lane) that an agent loads to run a QA pass. Step one is
**charter generation**: derive the test plan from what the store already
records — the target's PRD acceptance criteria when a PRD exists (via each
item's `--prd` path), the constitution's hard constraints (each constraint
becomes at least one probe), and open bug items (each an explicit regression
check). Brownfield targets with no PRDs charter from the knowledge layer
(PRODUCT.md / CONTEXT.md) plus the app's visible surfaces, and say so.

The charter is written to `docs/qa/qa-plan.md` in the **target** repo —
generalizing the hand-built 2026-07-23 speed-count plan (purpose,
preconditions, numbered cases with steps + expected result, run-artifact
layout `docs/qa-runs/<UTC-timestamp>/`). The charter names, for every case,
which recorded criterion/constraint/bug it traces to — an untraceable case is
exploratory by definition and lives in the exploratory section.

**Acceptance criteria:**
- Workflow doc exists, passes the workflow-format doc tests, and is
  installed by the existing shim generator like every other workflow.
- On a target with recorded acceptance criteria, the generated qa-plan.md
  contains at least one traced case per criterion of the features in scope,
  one per constitutional hard constraint, and one per open bug item.
- On a PRD-less brownfield target the charter is generated from knowledge
  docs and explicitly labels its basis.
- The QA pass itself is a `qa`-type work item with a run record; charter
  generation is journaled on that run.

### F2 — exploratory sweep: drive the app, journal the evidence

The workflow's second stage launches the target via its run contract
(`launch`/`seed`, `nahel doctor` green first — the existing autonomy gate
applies) and **drives it**: every charter case executed against the running
app, then time-boxed free exploration beyond the charter (edge inputs,
sequence breaks, reload/persistence probes, empty/overflow states). Driving
means the real interface — browser for web apps, CLI/API calls for services —
not unit tests.

Every case execution and exploratory probe is journaled as a typed event on
the QA run: `qa.case` (charter case id, pass/fail, evidence summary) and
`qa.probe` (what was tried, what happened). The run's report lands in
`docs/qa-runs/<timestamp>/report.md` in the target repo. Evidence discipline
follows the Phase 2 verify-by-driving rules: evidence-or-park, no third
option; a case that cannot be driven is parked with the reason, never
skipped silently.

**Acceptance criteria:**
- A completed sweep's journal shows one `qa.case` event per charter case
  (pass, fail, or parked-with-reason — zero silent omissions) and at least
  one `qa.probe` beyond the charter.
- The report exists, links every failed case to its finding (F3), and the
  run record ends with the sweep's outcome.
- `qa.case` / `qa.probe` / `qa.finding` / `qa.result` are documented event
  types with a defined payload shape (documented vocabulary, not a schema
  straitjacket: the journal's open-extension model stands, and the two
  already used in the wild — `qa.finding`, `qa.result` from the 2026-07-23
  speed-count runs — are grandfathered into the vocabulary unchanged).

### F3 — findings become typed bug items, automatically

Every failed case and every exploratory finding that indicates a defect is
converted, in the same run, into a `bug` work item through the CLI: name,
`--investigation` stub containing the captured repro steps (exact actions,
expected vs observed, environment), and a journal note linking the finding
event to the item. Duplicate protection is judgment work the workflow spells
out: check open bug items (`nahel status`, `nahel recall`) before filing;
a re-found known bug gets a note on the existing item, not a twin.

Severity is recorded as a note, not new schema. A finding that is a product
*question* rather than a defect (intended behavior unclear) files as a
`chore` item flagged for the human instead of a bug.

**Acceptance criteria:**
- After a sweep with failures, every failed charter case resolves to either
  a new bug item (with investigation stub + repro), a note on an existing
  bug item, or a human-flagged question item — demonstrably zero findings
  that exist only in the report.
- Bug items created by QA carry the QA run id in their journal trail
  (provable provenance from finding to filing).
- The repro in the investigation stub is sufficient for the bug lane: a
  fresh agent can reproduce the failure from the stub alone (proven at
  least once in the phase exit).

### F4 — the ratchet: exploration hardens into committed scripts

Checks that prove valuable graduate into **deterministic e2e scripts**
committed to the target repo, runnable under the repo's own test tooling
(the run contract's `test` command or a named script beside it — the
speed-count precedent is `scripts/qa/*.test.mjs` run by `node --test`). The
ratchet rules, stated in the workflow and enforced by review:

- A script, once committed, is never deleted or weakened by a QA run —
  the suite only grows (amendment goes through the normal human-reviewed
  PR path like any code change).
- Every planted-bug class the benchmark proves the sweep can catch, and
  every real bug QA files, gets a script that would catch its recurrence
  *once the bug is fixed* (red-first discipline: the script demonstrates
  the failure while the bug lives, and passes after the fix).
- Later sweeps run the committed scripts FIRST (cheap, deterministic),
  then charter, then explore — re-exploration is for new ground, not
  covered ground.

**Acceptance criteria:**
- After the benchmark phase, the pop-quiz repo contains committed passing
  e2e scripts traceable to planted-bug classes.
- A second sweep of the same target demonstrably runs scripts before
  exploration (journal order proves it) and does not re-explore
  script-covered ground.
- No QA run in the phase ever deleted or weakened an existing test —
  checkable from the target repos' git history.

### F5 — the keyed benchmark: pop-quiz and the answer key

The benchmark instrument that grades the lane:

- **pop-quiz** is founded at `~/projects/personal/pop-quiz` via
  `nahel init --hands-off "<paragraph>"` — the first real greenfield
  exercise of Phase 2 F9 — then built to a working state: timed multiple-
  choice trivia rounds, scoring with a streak bonus, a per-question
  countdown, local high-score persistence. Plain web stack, run contract
  recorded, tests green, launchable.
- **Planted bugs**: at least 8 deliberate defects spanning at least 5
  classes — calculation (wrong score math), state/sequence (breaks after a
  specific action order), persistence (data lost on reload), timing (race
  around the countdown), boundary (first/last/empty cases), and UI-truth
  (display disagrees with state). Each planted in a separate commit on a
  private branch shape that leaves the working tree looking innocent (no
  `// BUG` markers, no suspicious names).
- **The answer key** lives in the NAHEL repo at
  `docs/qa-answer-keys/pop-quiz.md`: per bug — class, exact location,
  trigger steps, expected-vs-buggy behavior. The pop-quiz repo carries no
  reference to it. QA sweeps of pop-quiz run with no access to the nahel
  repo's docs (the sweep operates in the target repo; the workflow states
  the no-key rule explicitly).
- **Grading**: after a sweep, the orchestrator (not the sweep agent)
  scores found / missed / false-alarm against the key and journals the
  scorecard on the nahel repo's phase trail. The development bar: a sweep
  finds **≥ 6 of 8 planted bugs across ≥ 4 classes with ≤ 2 false alarms**,
  without the key. Below the bar → improve the workflow, re-run; the
  scorecards accumulate as the lane's measured history.

**Acceptance criteria:**
- pop-quiz exists, founded hands-off (founding paragraph + provenance
  recorded per F9 rules), doctor green, tests green, app drivable.
- The answer key exists in the nahel repo only; `rg`-provably no key
  content or reference in pop-quiz.
- At least one journaled scorecard meets the bar above.
- The hands-off founding's rough edges are filed as nahel items (the
  benchmark doubles as F9's field test).

### F6 — afk-run integration: when QA runs

The QA lane is invocable two ways, and only two:

- **Standalone**: a kickoff like "QA sweep project X" creates a `qa` item
  and runs the lane directly — the shape the phase exit test uses.
- **Post-merge sweep step in afk-run**: after an epic/feature merges, the
  afk-run workflow MAY schedule a QA item covering the merged surface
  (judgment call, journaled either way). QA never blocks a PR from
  opening — verify-by-driving remains the pre-PR bar; the QA lane is
  broader and slower and runs after.

`nahel brief` surfaces open `qa` items and the latest sweep result per
project (one line each) so a fresh agent knows the QA state on arrival.

**Acceptance criteria:**
- afk-run.md names the post-merge QA decision point and its journaled
  judgment; task-lifecycle stays untouched.
- A standalone kickoff runs charter → sweep → findings → ratchet without
  touching afk-run.
- `nahel brief` output includes the QA surface (doc-tested like other
  brief sections).

## Exit test (the phase bar)

Two halves, both required:

1. **Benchmark (graded)**: a QA sweep of pop-quiz — no answer-key access —
   meets the F5 bar (≥6/8 planted bugs, ≥4 classes, ≤2 false alarms), with
   the full trail: charter traced to recorded criteria, journaled cases and
   probes, auto-filed bug items with repros, committed ratchet scripts.
2. **Real app (the roadmap's bar)**: a QA sweep of an existing real app
   (speed-count-game once its current work settles, or another real lab)
   produces committed passing e2e tests plus at least one genuine bug item
   with a captured repro that a fresh agent reproduces from the stub alone.

## Open questions

1. **Sweep time-box** — the exploratory stage needs a budget (wall-clock or
   probe-count) so a sweep terminates predictably. Proposal: charter cases
   unbounded (they're finite), free exploration capped at the larger of 30
   probes or one probe per charter case; committee may set a better number.
2. **Real-app half timing** — speed-count-game is mid-flight (codex on PR
   #19/#23 aftermath). The real-app sweep waits until that settles or picks
   a different target; decision deferred to execution, journaled when made.

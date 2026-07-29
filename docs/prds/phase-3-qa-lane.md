---
name: phase-3-qa-lane
created: 2026-07-29T04:48:00Z
updated: 2026-07-29T05:10:00Z
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
- **No CI-system integration.** No GitHub Actions or other CI wiring ships.
  The never-weaken invariant is honored where these repos actually enforce
  it: ratchet scripts MUST join the run contract's canonical `test` command
  (F4) — the gate every run and every review already executes — not sit
  beside it.
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

Not every recorded rule is driveable, and the charter says so instead of
gaming it: each constitutional constraint is classified **driveable**
(becomes a probe) or **process-rule** (excluded, with the one-line reason —
e.g. "append-only history is a repo property, not app behavior"). The
charter ends with a **coverage map**: which ground is covered by committed
scripts, which by charter cases, which left to exploratory judgment — the
scripted-vs-judgment split the roadmap asks for, stated in one table.

The exploration budget is fixed here (settling the former open question):
free exploration runs the larger of **30 probes or one probe per charter
case**, journaled individually; hitting the budget is stated in the report,
never silently.

**Acceptance criteria:**
- Workflow doc exists, passes the workflow-format doc tests, and is
  installed by the existing shim generator like every other workflow.
- On a target with recorded acceptance criteria, the generated qa-plan.md
  contains at least one traced case per criterion of the features in scope,
  one per DRIVEABLE constitutional constraint (process-rules excluded with
  reasons), one per open bug item, and the coverage map.
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
the QA run. The vocabulary honors the 2026-07-23 speed-count precedent
exactly — per-case events keep their existing names and shapes:

- `qa.result` — a charter case that PASSED (per-case, as used in the wild).
- `qa.finding` — a charter case that failed or an exploratory discovery
  indicating a defect (per-case, as used in the wild).
- `qa.probe` — new: one exploratory probe beyond the charter (what was
  tried, what happened, defect or not).
- `qa.sweep-completed` — new: exactly one per sweep, the whole-sweep
  summary (cases run/passed/failed/parked, probes, findings filed, report
  path). `nahel brief` reads ONLY this type for its QA line (F6), so the
  per-case/per-sweep scopes can never be confused.

The run's report lands in `docs/qa-runs/<timestamp>/report.md` in the
target repo. Evidence discipline follows the Phase 2 verify-by-driving
rules: evidence-or-park, no third option; a case that cannot be driven is
parked with the reason, never skipped silently.

**Sweep artifacts follow the normal code path**: each sweep works on a
`qa/<timestamp>` branch in the target repo — charter updates, run reports,
and ratchet scripts committed there — and closes by opening a draft PR
under the target's merge authority, exactly like any other lane's output.
No QA run commits directly to the default branch.

**Acceptance criteria:**
- A completed sweep's journal shows one `qa.result` or `qa.finding` or
  parked-with-reason note per charter case (zero silent omissions), the
  budgeted `qa.probe` events (F1's exploration budget), and exactly one
  `qa.sweep-completed`.
- The report exists, links every failed case to its finding item (F3), and
  the run record ends with the sweep's outcome.
- All four types are documented vocabulary with defined payload shapes
  (the journal's open-extension model stands; the grandfathered shapes are
  reproduced verbatim in the doc).
- The sweep's changes exist only on its `qa/` branch + draft PR — a sweep
  of a clean repo leaves the default branch untouched.

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

- Ratchet scripts are wired into the run contract's canonical `test`
  command — the gate every run, review, and verify-by-driving pass already
  executes — never a side suite someone must remember to run.
- A script, once merged, is never deleted or weakened by a QA run — the
  suite only grows (amendment goes through the normal human-reviewed PR
  path like any code change).
- **Red-first without a red suite**: a script for a found-but-UNFIXED bug
  is committed on the sweep's `qa/` branch as an expected-failure (the
  test framework's expected-fail marker, referencing the bug item id), so
  the suite stays green while the repro is executable; fixing the bug (bug
  lane's job, not QA's) flips the marker as part of the fix — the script
  then guards the recurrence forever. QA never fixes bugs; it arms the
  test that proves the fix.
- Later sweeps run the committed scripts FIRST (cheap, deterministic),
  then charter, then explore — re-exploration is for new ground, not
  covered ground.

**Acceptance criteria:**
- After the benchmark phase, the pop-quiz repo's canonical test command
  runs committed e2e scripts traceable to planted-bug classes (green for
  fixed/absent bugs, expected-fail markers for open ones).
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
- **Planted bugs**: exactly **8 graded defects** (the key's inventory is
  the definitive list) spanning at least 5 of these classes — calculation
  (wrong score math), state/sequence (breaks after a specific action
  order), persistence (data lost on reload), timing (race around the
  countdown), boundary (first/last/empty cases), UI-truth (display
  disagrees with state). Every planted bug must be reachable through the
  app's normal interface and independent (finding one must not mask
  another).
- **Blinding is enforced, not assumed** (committee round 1):
  - Planting is **squashed**: the bugs enter the repo inside ordinary
    feature-shaped commits (or one squashed history rewrite before any
    sweep), so `git log`/`git diff` reveal no bug-shaped commits. No
    `// BUG` markers, no suspicious names.
  - The answer key lives ONLY in the nahel repo at
    `docs/qa-answer-keys/pop-quiz.md`; the pop-quiz repo carries
    `rg`-provably no key content or reference.
  - Each graded sweep runs as a **fresh agent** whose instructions scope
    it to the target repo and state the no-key rule; it receives no prior
    scorecards, prior findings, or nahel-repo paths. The orchestrator
    checks the sweep's transcript/journal for key access before grading —
    a sweep that touched the key is void, not scored.
  - **Overfitting guard**: iterating the workflow against the same 8 bugs
    trains to the key. Therefore the final graded run uses a **frozen
    workflow** (no edits after the run starts) — and the phase exit's
    real-app half is itself the holdout no key can leak into.
- **Grading and the retry rule**: the orchestrator (never the sweep agent)
  scores each filed finding against the key. A finding MATCHES a key entry
  when it identifies the same faulty behavior with a repro that triggers
  it — file/line precision is not required. A filed defect matching no key
  entry is a **false alarm** unless the orchestrator verifies it as a real
  unplanted bug (then it scores as a bonus find and gets filed upstream —
  lab equipment has real bugs too). Duplicates of one key entry count
  once. The bar: **≥ 6 of 8 planted bugs, ≥ 4 classes, ≤ 2 false alarms —
  met on at least 2 of 3 predeclared fresh sweeps under the frozen
  workflow** (one lucky pass proves luck, not the lane). Development
  sweeps before the frozen round are unlimited and all scorecards are
  journaled — the measured history of the lane getting better.

**Acceptance criteria:**
- pop-quiz exists, founded hands-off (founding paragraph + provenance
  recorded per F9 rules), doctor green, tests green, app drivable.
- The answer key exists in the nahel repo only; `rg`-provably no key
  content or reference in pop-quiz; planted-bug commits are
  indistinguishable in shape from feature commits.
- The frozen-workflow graded round meets the bar on ≥ 2 of 3 predeclared
  fresh sweeps, each scorecard journaled with per-bug found/missed and
  every false alarm dispositioned.
- The hands-off founding's rough edges are filed as nahel items (the
  benchmark doubles as F9's field test).

### F6 — afk-run integration: when QA runs

The QA lane is invocable two ways, and only two:

- **Standalone**: a kickoff like "QA sweep project X" creates a `qa` item
  and runs the lane directly — the shape the phase exit test uses.
- **Scheduled from afk-run, durable through the backlog**: under the
  default `merge: human` the runner ends BEFORE the merge, so "after the
  merge, sweep" cannot be a live step. Instead, at PR-open time the
  afk-run workflow MAY file a backlog `qa` item ("sweep <surface> once
  PR #N merges", depends_on the feature item) — a durable schedule any
  later runner or kickoff picks up once the merge lands. Under
  `merge: on-approve` the same item may be picked up by the same runner
  after its auto-merge. Judgment call either way, journaled either way.
  QA never blocks a PR from opening — verify-by-driving remains the
  pre-PR bar; the QA lane is broader and slower and runs after.

`nahel brief` surfaces open `qa` items and the latest `qa.sweep-completed`
per project (one line each) so a fresh agent knows the QA state on arrival.

**Acceptance criteria:**
- afk-run.md names the PR-open-time QA scheduling decision and its
  journaled judgment, covering both merge modes; task-lifecycle stays
  untouched.
- A standalone kickoff runs charter → sweep → findings → ratchet without
  touching afk-run.
- `nahel brief` output includes the QA surface, read from
  `qa.sweep-completed` events only (doc-tested like other brief sections).

## Exit test (the phase bar)

Two halves, both required:

1. **Benchmark (graded)**: the frozen-workflow round on pop-quiz meets the
   F5 bar (≥6/8 planted bugs, ≥4 classes, ≤2 false alarms, on ≥2 of 3
   predeclared fresh sweeps), with the full trail: charter traced to
   recorded criteria, journaled cases and probes, auto-filed bug items with
   repros, ratchet scripts in the canonical test command.
2. **Real app (the roadmap's bar, and the holdout)**: a QA sweep of an
   existing real app (speed-count-game once its current work settles, or
   another real lab) produces committed passing e2e tests plus at least one
   genuine bug item with a captured repro that a fresh agent reproduces
   from the stub alone. No key exists here — this half is the overfitting
   check the benchmark cannot be.

## Open questions

1. **Real-app half timing** — speed-count-game is mid-flight (codex on PR
   #19/#23 aftermath). The real-app sweep waits until that settles or picks
   a different target; decision deferred to execution, journaled when made.

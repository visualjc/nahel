---
name: qa-lane
description: Run a QA pass on a target project — charter the plan from the criteria the project already records, then sweep, file, and ratchet what the sweep finds
args: "<target hint or item id>"
---

# Workflow: qa-lane

Load and follow this workflow to run a QA pass over a target project. QA here
is what a human QA engineer does: decide what to check, drive the real running
app, file what turns up as proper work items, and leave behind scripts so the
same ground never has to be walked by hand twice.

The lane is **target-agnostic**. Everything it checks is derived from what the
target project itself records — its PRDs, its constitution, its open bugs, its
knowledge documents — so the same procedure works on a project you have never
seen before. You are testing the target's app; nothing outside the target repo
is evidence about it, and nothing you already believe about the app counts as
a result.

**QA finds; QA never fixes.** A defect this lane discovers leaves as a bug
item carrying a repro, not as a patch — a sweep that fixes what it found has
skipped a diagnosis and hidden its own evidence. And **QA never gates a merge**:
findings inform, and merge authority stays the target's own
(`nahel/workflows/review-loop.md`).

The lifecycle mechanics — status flips, the run, journaled findings, the claim
rule — are `nahel/workflows/task-lifecycle.md`'s; follow it alongside this
one. Every state change is a CLI call; never hand-edit anything under
`nahel/`.

Before any `nahel` command: if you are an agent, set
`NAHEL_ACTOR=agent:<your-id>` so every journal event carries your identity.

## 1. Own the work

A QA pass is a work item like any other, and it carries a run — an unjournaled
sweep is a sweep nobody can audit.

Resolve the argument first. An item id names an existing `qa` item: open it
(`nahel status`) rather than creating a twin. A target hint — "sweep the
checkout flow" — creates one:

    nahel item new qa <target-slug>-sweep direct
    nahel item update <item-id> --status in-progress
    nahel run start <item-id>
    nahel run update <run-id> --phase charter

Then journal what the hint resolved to, so the charter's scope is auditable
against what was actually asked:

    nahel log note --item <item-id> --run <run-id> \
      --data summary="qa scope: <the hint, verbatim> resolves to <surfaces in scope>; excluded <what> because <why>"

Run every command from the TARGET repo's root. Its store holds the criteria
you charter from, and its journal is where this run belongs.

## 2. Charter — the test plan comes from recorded criteria

You do not invent a test plan. You DERIVE it from what the target already
records, so every case traces to something the project committed to and a
human can check the plan against the promises rather than against your taste.

Read the three sources, in this order.

a. **Recorded acceptance criteria.** `nahel status` lists the items, and an
   item carrying a PRD renders `prd=docs/prds/<slug>.md`. Read the PRD of
   every feature in scope and lift its acceptance criteria: each criterion of
   a feature in scope earns at least one case.

       nahel status
       nahel brief

b. **The constitution's hard constraints.** `nahel brief` renders the
   constitution extract, and its hard constraints bind the app. Classify each
   one (below); every DRIVEABLE constraint earns at least one case.

c. **Open bug items.** Every open `bug` item is a regression check — the
   defect a project already knows about is the one most likely to come back.
   A bug carrying `investigation=docs/investigations/<id>.md` already has its
   repro written down: lift it into the case rather than rediscovering it.

**Brownfield fallback.** A target that records no PRDs charters from the
knowledge layer instead — `PRODUCT.md` and `CONTEXT.md`, which `nahel brief`
points at — plus the app's visible surfaces, walked once before the charter is
written. Such a charter must LABEL this basis in its Purpose section
("chartered from knowledge documents and observed surfaces: this project
records no PRDs"), because a reader has to know the plan rests on inference.
Never present an inferred case as a traced one.

### Driveable, or a process rule — classify, never game

Not every recorded rule is checkable by driving an app, and a charter that
quietly drops the awkward ones is a charter grading itself. Classify EVERY
hard constraint, and carry the classification into the charter:

- **DRIVEABLE** — the constraint describes behavior an interface can be made
  to exhibit. It becomes at least one probe.
- **process-rule** — the constraint is about the repository, the workflow, or
  the team rather than about the running app. It is EXCLUDED, with a
  one-line reason naming why driving cannot reach it. For example:

      append-only history is a repo property, not app behavior

An excluded constraint with no stated reason is an omission, not a
classification. Those reasons are what a human reads to decide whether the
sweep's silence on a constraint was honest; write them to be read.

### Write the charter

The charter is a document in the TARGET repo at `docs/qa/qa-plan.md`. It is
durable and repeatable: later sweeps re-read and extend it rather than
starting over, which is what makes a second sweep cheaper than the first.

Its shape:

1. **Purpose** — what this plan covers, what it deliberately leaves to
   automated tests, and, on a brownfield target, the basis label above.
2. **Preconditions** — what must hold before a sweep starts, read from the run
   contract rather than invented: `nahel doctor` exits 0, the contract's
   `test` command passes, then the contract's `launch` command brings the app
   up (with `seed` where the contract defines one).
3. **Run artifacts** — the layout every sweep writes into:

       docs/qa-runs/<UTC-timestamp>/
         report.md

   The timestamp is real, never estimated:

       date -u +"%Y-%m-%dT%H:%M:%SZ"

4. **Cases** — numbered `QA-01`, `QA-02`, … in one table with three columns:
   setup and actions, expected result, and what it traces to (the acceptance
   criterion, the hard constraint, or the bug item id). Steps must be exact
   enough for a different agent to execute them without asking what you meant,
   and the expected result is fixed BEFORE the sweep runs — an expectation
   written after the observation is not an expectation.
5. **Exploratory section** — a case that traces to nothing recorded is
   exploratory BY DEFINITION. It gets no QA-number and no row in the traced
   table; it lives here, as ground worth wandering. Do not invent a criterion
   to justify it.
6. **Coverage map** — the table below.
7. **Exclusions and known gaps** — what this plan does not cover and why,
   carrying every process-rule exclusion with its one-line reason.

### The coverage map

The charter ends with a coverage map: one table saying which ground is held by
which instrument. This is the scripted-versus-judgment split, stated instead
of assumed.

    | Ground | Committed scripts | Charter cases | Exploratory |
    | --- | --- | --- | --- |
    | <surface or criterion> | <script path, or —> | <QA-ids, or —> | <what is left to judgment, or —> |

Every row names ground; every cell is either filled or an explicit `—`.
A blank cell is a claim nobody made, and it reads as coverage.

### The exploration budget

Exploration beyond the charter is budgeted, and the budget is fixed here so no
sweep can quietly decide it explored enough. The budget is
**the larger of 30 probes or one probe per charter case**.
State that number in the charter and again in the sweep's report. A sweep that
stops because it hit the budget says so in the report — never silently, since
a budget hit with ground left over is exactly what tells the next sweep where
to start.

Commit the charter, then journal its generation on this run:

    nahel log note --item <item-id> --run <run-id> \
      --data summary="charter generated: <n> traced cases, <n> exploratory, budget <n> probes" \
      --data charter=docs/qa/qa-plan.md \
      --data basis=<recorded-criteria|knowledge-docs>

## 3. Sweep — drive the app, journal the evidence

    nahel run update <run-id> --phase sweep

**The gate.** `nahel doctor` must exit 0 before a sweep starts — the same
autonomy gate every AFK run passes (`nahel/workflows/afk-run.md`). A contract
that does not hold on this machine means the app you are about to drive is
not the app the project describes, and every result you recorded would be
about your environment instead of about the software. Anything other than
exit 0 parks the sweep (below), naming the unset environment variables or the
failing healthcheck that doctor listed.

**Launch.** Bring the app up with the run contract's `launch` command, and
`seed` it where the contract defines one. Then drive the REAL interface: a
browser for a web application, the app's own CLI or HTTP calls for a service.
Tests passing is not driving; a page that renders is not a flow; re-reading
the code is not driving at all.

**The order is fixed**: every charter case in charter order,
then budgeted exploration. Exploration is the expensive part; it goes last,
against ground the charter left open — edge inputs, sequence breaks, reload
and persistence probes, empty and overflow states.

### The event vocabulary

Every case and every probe is journaled on this run as a typed event. Four
types, and no others — a vocabulary that drifts is an onboarding brief that
lies to the next session.

- **`qa.result`** — one charter case that PASSED. Per case.

      nahel log qa.result --item <item-id> --run <run-id> \
        --data case=QA-<nn> \
        --data result=pass \
        --data <observation>=<what you saw that proves it>

- **`qa.finding`** — one charter case that FAILED, or an exploratory
  discovery indicating a defect. Per case.

      nahel log qa.finding --item <item-id> --run <run-id> \
        --data case=QA-<nn> \
        --data result=<fail|pass_with_known_issue> \
        --data bug=<bug-item-id> \
        --data <observation>=<what you saw>

  `bug` carries the item step 4 files for this finding, so file the item first
  and journal the finding second — a link added by a later correction is a
  link a reader has to go looking for.

- The `case`, `result` and `bug` keys, and both type names above, are the
  shapes the first QA sweeps in the wild already wrote on 2026-07-23. They are
  reproduced here VERBATIM and are not renameable: renaming one orphans every
  event already sitting in a target's journal. Extra observation keys are free
  — the journal's extension model is open — and are where the specifics belong
  (the seed used, the session id, the computed value, the URL driven).

- **`qa.probe`** — one exploratory probe beyond the charter: what you tried,
  what happened, and whether it indicates a defect.

      nahel log qa.probe --item <item-id> --run <run-id> \
        --data probe="<what you tried>" \
        --data observed="<what happened>" \
        --data defect=<yes|no>

- **`qa.sweep-completed`** — the whole-sweep summary, written once at the
  close (step 6). There is exactly ONE per sweep, and
  `nahel brief` reads ONLY this type for its QA line —
  so a per-case event must never carry this type,
  and a sweep must never write two — per-case and per-sweep are different
  scopes, and keeping them in different types is what lets a fresh session
  read one line and know where QA stands.

### Evidence or park — there is no third outcome

Every charter case ends in exactly one of three journaled states: a
`qa.result`, a `qa.finding`, or a park carrying its reason.
Zero silent omissions.
A case you could not drive — the surface does not exist yet, this
host has no tooling that reaches it, a precondition the contract does not
provide — is parked, named, and counted:

    nahel log note --item <item-id> --run <run-id> \
      --data summary="parked case QA-<nn>: <why it could not be driven, and what you tried>" \
      --data case=QA-<nn> \
      --data park=cannot-drive

"It looked fine" is not a result. "I ran out of budget" is a park, not a skip.

If the sweep as a whole cannot start — doctor is not green, or the app will
not launch — park the ITEM and stop, rather than reporting a sweep that never
drove anything:

    nahel item update <item-id> --status blocked
    nahel log note --item <item-id> --run <run-id> \
      --data summary="parked: cannot sweep — <which precondition failed, and what you tried>" \
      --data park=cannot-drive

### The branch and the PR

Every artifact a sweep produces — the charter, the run report, the scripts —
lives on the sweep's own branch in the TARGET repo, created before the first
commit:

    git checkout -b qa/<UTC-timestamp>

The sweep closes by opening a DRAFT PR, exactly like any other lane's output:

    gh pr create --draft --title "qa/<timestamp>: sweep of <surfaces>" --body-file <file>

Its body carries the trail: the charter's basis, cases run / passed / failed /
parked, probes run and whether the budget was hit, every finding with the item
it filed, and the report path. This path is
never a direct commit to the default branch,
and never a merge of your own: merge authority belongs to the target
and is exercised by `nahel/workflows/review-loop.md`. A sweep of a clean repo
leaves the default branch untouched.

## 4. Close the sweep

Write the report, then the one event that summarizes the whole thing.

**The report** lands at `docs/qa-runs/<timestamp>/report.md` in the target
repo and records: the commit SHA swept, the UTC time, how the app was launched
and which surface was driven, the preflight results, the per-case status with
the observation that justifies each one, every probe and whether the
exploration budget was hit, every finding LINKED to the item it filed
(step 4), the exclusions, and the overall verdict. Write it to be read without
the journal.

**The one summary event:**

    nahel log qa.sweep-completed --item <item-id> --run <run-id> \
      --data cases_run=<n> \
      --data passed=<n> \
      --data failed=<n> \
      --data parked=<n> \
      --data probes=<n> \
      --data budget_hit=<yes|no> \
      --data findings_filed='["<item-id>", ...]' \
      --data report=docs/qa-runs/<timestamp>/report.md

Exactly one, written last — after the findings are filed, because the counts
have to be final. A summary written mid-sweep summarizes a sweep that had not
happened yet.

Then end honestly and hand the item to review:

    nahel run end <run-id> success
    nahel item update <item-id> --status in-review

A sweep that found defects still ends `success` — finding them is the job, and
an outcome that punished discovery would teach the next sweep to look less
hard. `failure` is for a sweep that could not do the job: the app never came
up, or the charter could not be driven. `done` is not yours to grant; it comes
at the human's word, like every leaf item's.

Fallback (degraded environment): if the `nahel` CLI is unavailable, the
charter itself may still be written — it is prose derived from documents you
can read — but make NO item, run, or journal mutations, and say which ones are
pending so a CLI-equipped session can record them. A charter whose sources you
could not read is not a charter: without `nahel status` and `nahel brief`,
state that the criteria are unavailable rather than inventing cases to fill
the gap. Do NOT sweep without the CLI: an undriveable case, a finding, and a
probe are all evidence, and evidence that lands nowhere is evidence nobody
will ever act on. If the host cannot drive the app at all, park rather than
substituting a test run for a sweep.

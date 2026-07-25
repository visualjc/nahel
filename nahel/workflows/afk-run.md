---
name: afk-run
description: Run a project AFK — autonomy gate, scope discovery, lane picks, dispatched waves, review, and one verified draft PR per epic, with zero human turns
args: "<kickoff line>"
---

# Workflow: afk-run

Load and follow this workflow to run a project AFK: one kickoff line in, one
verified draft PR per epic out, with ZERO human turns in between. Any capable
agent can be the runner. The mechanics are CLI calls — `nahel dispatch` spawns
every worker, `nahel item` / `nahel run` / `nahel log` record every state
change; every judgment is yours (ADR-0016). Reading state files is fine;
mutating them by hand is not. Never hand-edit anything under `nahel/`.

Every step below is a shell command or a paragraph of judgment, so the whole
run is drivable by pure conversation — no host-agent feature is required, and
nothing here is specific to one vendor's tooling.

Before any `nahel` command: if you are an agent, set
`NAHEL_ACTOR=agent:<your-id>` so every journal event carries your identity.
That id is also your VENDOR identity: the cross-vendor rules below compare it
against the agent a route names.

THE RULE THAT MAKES A RUN AFK — **never ask mid-run**. A question asked into an
empty room stalls everything. Any decision you are not authorized to make
becomes a PARK (step 12): a journaled reason plus a `blocked` status the brief
surfaces, and the run continues elsewhere.

The claim rule, unchanged from task-lifecycle: a mutation refused because a
claim covers the item is the human's word that this work is theirs. Stand down
on it (step 3); never work around a claim.

1. Gate the run — the autonomy gate. An AFK run is refused unless all three
   artifacts below are recorded. Check them in order; on the first failure
   STOP, state the refusal naming the missing artifact and the workflow that
   produces it, and run nothing else. Interactive work is ungated: this gate
   binds AFK runs only.

   a. **A human-signed constitution.** Read `nahel/config`: its `inception`
      section must carry `constitution_signed_by`, and the `config.updated`
      act that wrote that section must be attributed to a HUMAN actor —
      `nahel progress` renders every event with its actor and payload:

          nahel progress | grep config.updated

      An agent-attributed signature is not a signature (the same rule merge
      authority applies to `merge: on-approve`): treat it as unsigned.
      Refusal: "no human-signed constitution — run the inception workflow
      (`nahel/workflows/inception.md`) and have the human record the
      signature themselves." Never infer a signature from prose in the
      constitution document; the gate reads recorded state only.

   b. **A passing run contract:**

          nahel doctor

      Exit 0 proceeds. Exit 2 refuses: "no passing run contract — the
      `contract` section is missing; run the inception workflow
      (`nahel/workflows/inception.md`)". Exit 3 refuses naming the unset env
      vars doctor listed (they belong in this machine's gitignored env file);
      exit 4 refuses naming the failing healthcheck. A run that cannot prove
      the app runs cannot verify by driving (step 10), so this is a gate, not
      a warning.

   c. **A recorded inception tier:** `nahel/config`'s `inception` section
      must carry `tier`. Refusal: "no recorded inception tier — run the
      inception workflow (`nahel/workflows/inception.md`)". The tier is load
      bearing later too: a `seed` project never gets delegated approval
      (step 6).

   The verdict is deterministic — identical repo state yields the identical
   verdict on any machine, and no step of it is a judgment call. If you find
   yourself weighing whether a constitution "feels" signed, the answer is no.

2. Journal the kickoff line verbatim, before interpreting it:

       nahel log note --data summary="afk-run kickoff: <the kickoff line, verbatim>"

   The line is the run's charter; the trail must show what was asked, not only
   what you decided it meant.

3. The checkpoint check. Run it before every dispatch (step 8), before every
   phase transition on an item, and before every PR open (step 11):

       nahel status

   - A claim on the item — its own, or any ancestor's, since claims cover the
     whole subtree — means STAND DOWN on that item: start nothing further on
     it, journal the stand-down, and continue the run on other items.

         nahel log note --item <item-id> --data summary="stood down at checkpoint: claimed by <claimant>"

   - A paused run means dispatch nothing further for it from the pause onward.
   - **Never kill a worker.** Intervention is state-level. A worker already in
     flight on a claimed item runs to its own natural exit; because the claim
     freezes that run against the worker's own mutations, YOU journal its exit
     and its final output, then abandon the output. No kill, no terminate, no
     interrupt mid-write.
   - Resuming after a handback needs no memory of the previous session: the
     `nahel handback` event carries what changed while the human held the
     claim, so re-read `nahel progress --item <item-id>` and continue from
     state alone — including the human's edits.

4. Discover scope. Resolve the kickoff line against recorded state, never
   against your assumptions:

       nahel brief
       nahel status

   Read the constitution extract the brief renders (binding), the backlog it
   lists, and the recent journal. Then:

   - Map the line onto EXISTING items wherever they already cover it —
     a duplicate backlog item is scope discovery failing.
   - Create what is genuinely missing, through the CLI:

         nahel item new <type> <slug> <lane>

   - Journal what the line resolved to, and what you deliberately left out:

         nahel log note --data summary="scope: <kickoff line> resolves to <ids/slugs>; excluded <what> because <why>"

   - Work that contradicts the constitution is out of scope at any size: park
     it (step 12) instead of building it.

5. Pick a lane per item and journal the reason — the reason is the deliverable
   here, not the label:

       nahel item update <item-id> --lane <direct|epic-lite|full>
       nahel log note --item <item-id> --data summary="lane <lane>: <why this lane, and why not the one below it>"

   The heuristics are prd-parse's, unchanged: `direct` — one focused change,
   no decomposition; `epic-lite` — one coherent feature, a few session-sized
   deliverables; `full` — multi-deliverable or cross-cutting, needing real
   decomposition. Take the lightest lane the work actually fits: ceremony you
   cannot defend in the journal is ceremony you should not have bought. A
   `full` pick goes through step 6 before anything is implemented.

6. Full lane: author the PRD in **AFK authoring mode**, then clear the approval
   gate. prd-new's grilling interview needs a human and you must not ask one —
   so draft from evidence and journal what the interview would have settled.

   a. Own the work through a plan item (prd-new's mechanics):

          nahel item new plan <slug> direct
          nahel item update <plan-id> --status in-progress

   b. Draft `docs/prds/<slug>.md` from project evidence ONLY: the
      constitution, the brief, the backlog, the journal, and the code. Its
      frontmatter carries `name`, `created`, `updated` and NO status field
      (ADR-0013); timestamps come from the system, never estimated:

          date -u +"%Y-%m-%dT%H:%M:%SZ"

   c. Journal EVERY assumption the interview would have resolved — one event
      per assumption, each stating what you assumed and what changes if it is
      wrong:

          nahel log note --item <plan-id> --data summary="assumption: <what you assumed> — <what changes if it is wrong>"

      Keep the event ids. The approval below cites them, and an approval or a
      park with no assumption trail is invalid — the trail is what the
      interview was traded for.

   d. Record the deliverable and hand the item to the gate:

          nahel item update <plan-id> --prd docs/prds/<slug>.md
          nahel item update <plan-id> --status in-review

   e. Resolve the gate by the project's governance, which `nahel brief` shows
      under "governance & merge authority" (a project that declared none reads
      `product: delegated (default)`):

      - **`governance.product: human`** — PARK at the gate (step 12) with the
        assumption trail named in the park reason, and carry the rest of the
        run on. Do not parse, decompose, or implement it: prd-parse refuses an
        unapproved PRD. The human's flip resumes it in a later run.
      - **`governance.product: delegated`** — obtain cross-vendor consensus
        (f), then continue in THIS run.

   f. Delegated approval. Park immediately, without attempting consensus, when
      the recorded inception tier is `seed` — delegated governance demands
      `standard` or above (the tier ratchet).

      i. Bind the proposal to an exact PRD revision:

             git hash-object docs/prds/<slug>.md

      ii. Journal the proposal under YOUR actor, citing the assumption trail:

             nahel log note --item <plan-id> \
               --data summary="PRD proposed for delegated approval: docs/prds/<slug>.md" \
               --data prd=docs/prds/<slug>.md \
               --data revision=<hash> \
               --data assumptions='["<assumption-event-id>", ...]'

      iii. Dispatch the verification to a DIFFERENT vendor — the agent routing
           assigns to `review`. If that route resolves to your own vendor,
           consensus is impossible: park, because a same-vendor self-check is
           not cross-vendor review.

             nahel dispatch review --item <plan-id> -- "Verify docs/prds/<slug>.md at revision <hash>, independently. Read the constitution, the backlog (nahel status), and the assumption events <assumption-event-ids> cited by proposal event <proposal-event-id>. Judge whether the PRD conflicts with the constitution, whether it fits the backlog, and whether each assumption is safe to build on. Then journal your verdict yourself, under your own actor: nahel log note --item <plan-id> --data summary='PRD verification: <agree|disagree> — <the constitution check you performed and what it found>' --data revision=<hash> --data verifies=<proposal-event-id> --data verdict=<agree|disagree>"

           The worker journals its own event under its own `NAHEL_ACTOR`,
           which is what makes the two attributions independent.
           A verification you write yourself proves nothing — one runner's
           note is not a consensus, and the gate treats it as unverified.

      iv. Read the verification back (`nahel progress --item <plan-id>`) and
          PARK on any of: `verdict=disagree` (vendor disagreement), any
          constitution conflict the verification raises, a missing
          verification (the dispatch failed, or the worker journaled nothing),
          or a PRD whose hash moved since the proposal — re-run
          `git hash-object` before deciding, because a revision that changed
          under the verification is unverified.

      v. Record the decision, linking the two events it rests on, then flip the
         plan item under that delegated authority:

             nahel log note --item <plan-id> \
               --data summary="delegated approval (governance.product=delegated): proposed by <your actor>, verified by <verifier actor>" \
               --data revision=<hash> \
               --data proposal=<proposal-event-id> \
               --data verification=<verification-event-id>
             nahel item update <plan-id> --status done

         The delegation covers PLAN-ITEM APPROVAL and nothing else.
         Leaf-item `done` stays human-only (task-lifecycle) — including items
         whose PR merged under `merge: on-approve`.
         Constitution amendments are never delegable, under any governance
         setting.

   g. Continue in the same run: prd-parse (`nahel/workflows/prd-parse.md`)
      creates the feature item from the approved PRD, then epic-decompose
      (`nahel/workflows/epic-decompose.md`) splits it into dependency-ordered
      children. Those children join the wave ordering in step 7.

7. Order the work into waves from the `depends_on` edges — `nahel status`
   renders the tree, `nahel validate` proves the graph is a DAG. Every item
   with no unmet dependency is dispatchable now; run them in parallel only as
   far as you can actually supervise.

   **COMPLETION-THEN-DISPATCH** — the bar an AFK run may never lower.
   Dispatch an item only after EVERY declared dependency has reached journaled
   agent-reachable completion: its run ended `success` AND its status is
   `in-review` (or `done`, where a human already flipped it). Prove it from
   the journal before dispatching:

       nahel progress --item <dependency-id>

   `done` on its own is NOT the bar: `done` is human-only (task-lifecycle),
   and waiting for it would deadlock a zero-turn run. Dispatch ORDER proves
   nothing either — what proves it is the dependency's completion events
   sitting earlier in the journal than the dependent item's dispatch.

   A dependency whose run ended `failure`, or that sits `blocked`, is not
   complete: park the dependent item (step 12) naming that dependency, and
   move on to what is dispatchable.

8. Dispatch the worker. Run the checkpoint check (step 3) first, then:

       nahel dispatch implementation --item <item-id> -- <the task, stated so a fresh agent can execute it>

   - EVERY worker is spawned this way. Never invoke an agent CLI yourself:
     dispatch resolves the routing map, composes the invocation with the
     worker's own actor identity and the `nahel brief` orientation preamble,
     spawns it, and journals the run. Hand-spawning bypasses routing and
     leaves a worker in the trail that nobody authorized.
   - Route by responsibility, not by preference: `implementation` for the work
     itself, `review` for reviewing it, `architecture` for design judgment. An
     unrouted responsibility falls back to the configured default; with
     neither, dispatch exits non-zero naming the `nahel config set` command
     that fixes it — a setup failure, so park and say so rather than working
     around it.
   - The task text tells the worker which lane workflow to follow
     (`nahel/workflows/task-lifecycle.md`, or `nahel/workflows/bug-lane.md`
     for a bug) and what "done" means for this item.
   - Dispatch exits 0 only when the worker exited 0; either way the invocation
     and the outcome are journaled. A non-zero worker does not end the run:
     read the item's journal and either re-dispatch with what you learned, or
     park it.

9. Review. When an item's worker reports completion (its run ended, its status
   is `in-review`), invoke the review loop —
   `nahel/workflows/review-loop.md` — on its epic's PR-bound work. That
   workflow owns the reviewing: two independent cross-vendor reviewers,
   findings validated against HEAD, red-first fixes, the iteration cap, and
   ALL merge mechanics including merge authority. Do not restate its rules
   here, and do not merge anything yourself.

   Yours is the timing only: review when a coherent slice is complete — not
   per commit, not once at the very end — and stop when the loop signs off or
   parks. A cap-reached park is the loop's decision: honor it, and keep the
   rest of the run moving.

10. Verify by driving, before any PR opens — every lane, no exception, no
    silent skip (hard constraint 6, ADR-0011). A `direct`-lane one-liner
    verifies exactly like a `full`-lane epic.

    a. Satisfy the run contract on this machine: `nahel doctor` exits 0.
    b. Launch the app with the contract's `launch` command (and `seed` where
       the contract defines one).
    c. Exercise the CHANGED flow end to end with whatever driving tooling the
       host has — browser automation, the app's own CLI, an HTTP client.
       Tests passing is not driving.
    d. Journal the evidence on a run of your own — the worker's dispatch run
       closed when it exited, and evidence tied to no run is evidence tied to
       nothing:

           nahel run start <item-id>
           nahel run update <run-id> --phase verify
           nahel log note --item <item-id> --run <run-id> \
             --data summary="verified by driving: <what you drove, step by step> — <what you observed>"
           nahel run end <run-id> success

       Write it so a human can audit the claim without re-running it.
    e. If the host cannot drive — no driving tooling, a headless transport, an
       incomplete contract env — PARK the item (step 12) with that reason. A
       PR never opens with neither driving evidence nor a parked state.

11. Open ONE draft PR per epic, on that epic's branch (`epic/<slug>`, per
    task-lifecycle's git discipline). Run the checkpoint check (step 3) first.
    A run that touched two epics opens two PRs — never one combined PR,
    however convenient the diff.

        gh pr create --draft --title "<epic>: <what it delivers>" --body-file <file>

    The body carries the run trail, so the PR is auditable without the
    journal: the kickoff line; the waves and their order; each item's lane and
    why; review dispositions from step 9; the verify-by-driving evidence from
    step 10, quoted and citing its journal event ids; every waiver in force
    (repro waivers — `nahel brief` surfaces them) stated plainly; and every
    park with its reason.

    Merging is not this workflow's act. Under `merge: human` the PR waits for
    the human; under a validly activated `merge: on-approve` the review loop
    may merge on sign-off. Either way the invariant here is one trail-carrying
    PR per epic.

12. Park anything you are not authorized to decide — this is how an AFK run
    ends a question without asking one:

        nahel item update <item-id> --status blocked
        nahel log note --item <item-id> --data summary="parked: <what is needed, why the run cannot decide it, and what you already tried>"

    Both halves are required. `blocked` is what makes the park visible —
    `nahel brief` lists blocked items under "pending human decisions", so the
    next session sees it without reading the journal — and the reason is what
    makes it actionable. A park with no reason is a dead end; a reason with no
    `blocked` status is invisible.

    Park, never ask, on: a `governance.product: human` approval gate; vendor
    disagreement, a constitution conflict, or a `seed` tier under delegated
    approval; a dependency that failed or is blocked; a host that cannot
    drive; a review loop at its cap; a claim standing over the work; a missing
    route or an unusable run contract; and anything that would contradict the
    constitution.

13. Stop when nothing is dispatchable — every discovered item is `in-review`,
    `done`, parked, or claimed — and close the run honestly:

        nahel log note --data summary="afk-run complete: <PRs opened>, <items parked and why>, <what a next run should pick up>"

    Then say the same thing to whoever reads the session. The proof of a good
    run is that a fresh session with no memory can reconstruct it from
    `nahel brief` and `nahel progress` alone.

Fallback (degraded environment): if the `nahel` CLI is unavailable, do NOT run
AFK. The autonomy gate cannot be checked, no worker can be dispatched under
routing, and no park can be recorded — an AFK run without the CLI is an
unrecorded run. Report the kickoff line, the scope you would have discovered,
and that the run is blocked on the CLI; make no state mutations until it is
back. If the host cannot drive the app, step 10 already covers it: the
affected items park rather than the run continuing blind. If no PR tooling is
available, stop before step 11 with the branch pushed and say the PR is
pending — an epic without its trail-carrying PR is unfinished work, not a
delivered run.

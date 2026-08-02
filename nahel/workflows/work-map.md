---
name: work-map
description: Work one decision ticket off a map — claim it, answer it with the right surface, record the decision, graduate the fog
args: "<node-slug-or-id>"
---

# Workflow: work-map

Load and follow this workflow to move a wayfinder map forward by **one
ticket**. One session, one ticket, one decision: a session that resolves
four tickets has usually answered three of them with the momentum of the
first. Every state change below is a CLI call; never hand-edit anything
under `nahel/`.

Before any `nahel` command: if you are an agent, set
`NAHEL_ACTOR=agent:<your-id>` so every journal event carries your identity.

1. Look at the map and pick a takeable ticket:

       nahel roadmap map show <node-slug>

   Takeable means `open`, with no claimant, and every blocking ticket already
   `resolved` or `closed`. Blocking is **advisory**: you may deliberately take
   a blocked ticket when you judge the dependency soft — say so in the
   decision when you do, so the next reader knows it was a choice.

2. Claim it, so other sessions skip it:

       nahel roadmap ticket claim <ticket-id>

   This is advisory assignment, NOT `nahel intervene claim`'s freeze: it
   records who is working the question and locks nothing. If the ticket is
   already claimed the command refuses, naming the holder — pick another, or
   release theirs if that session is plainly gone.

3. Answer it with the surface its **type** names:

   - `research` — read the code, the journal, the docs, the web when
     available. Cite what you found in the decision, and journal sources with
     `nahel log note --data summary="<source>"` as you go.
   - `prototype` — run `nahel/workflows/prototype-lane.md`. The variants are
     throwaway; what comes back is the answer, not the code.
   - `grilling` — interview the human with the pinned `grilling` skill (its
     fallback: name every branch, never answer for them). When the question is
     about vocabulary or the shape of the domain, use `domain-modeling`
     instead — the decision it produces belongs in the glossary too.
   - `task` — just do it, then record what doing it settled.

   Read the map's other decisions first: `nahel roadmap map show <node-slug>`
   lists them, and `nahel recall <terms>` finds the reasoning behind any of
   them. A decision that contradicts an earlier one is a finding, not a typo.

4. Record the decision. This is the act the whole workflow exists for:

       nahel roadmap ticket resolve <ticket-id> --decision "<the decision, in one line>"

   One command does four things: it journals the decision, flips the ticket,
   writes the map's index line, and distills an **observation** so
   `nahel recall <terms>` finds the decision forever. Write the one-liner as
   the answer, not the topic — "we own the fly.io deploy and nothing
   downstream of it", never "deploy target decided".

   If the question is not going to be answered, close it instead — and say
   WHICH of the two reasons it is, because they are different facts and only
   one of them belongs in Out of scope. Neither ever becomes a decision:

       nahel roadmap ticket close <ticket-id> --out-of-scope \
         --reason "<why this is beyond the destination>"

       nahel roadmap ticket close <ticket-id> --invalidated-by <ticket-or-event-id> \
         --reason "<which decision answered it out of existence>"

   `--out-of-scope` adds the reason to the map's **Out of scope** section:
   ruled beyond the destination, and it never graduates. `--invalidated-by`
   records the decision that killed the question on the ticket, and the map
   shows it beside Decisions so far — a question another decision answered was
   never beyond the destination, so filing it under Out of scope would be
   false, and would turn the one section that bounds the map into a graveyard
   nobody trusts.

   If you are stopping without an answer, hand it back:

       nahel roadmap ticket release <ticket-id>

5. Let the fog graduate. A fog line the decision sharpened into a real
   question becomes a ticket, and the fog section is re-stated without it:

       nahel roadmap ticket new --map <node-slug> --type <type> --question "<the question, now sharp>"
       nahel roadmap map update <node-slug> --fog "<every fog line that is still foggy>"

   New fog is a good outcome too: an answer that opens two questions has told
   you something. Add them the same way.

6. Distill the ticket once the decision reads back without it:

       nahel recall <a few words from the decision>
       nahel roadmap ticket distill <ticket-id>

   `distill` empties the ticket's body **through the CLI** — never with an
   editor, which `nahel validate` reports as a finding. Check `recall` first:
   the body may go only because the decision, and the question it answered,
   already live in the journal and in the observation.

7. Confirm the shape and leave the map readable:

       nahel roadmap map show <node-slug>
       nahel validate

Fallback (degraded environment): if the `nahel` CLI is unavailable, the
research or interview may proceed — but make NO ticket, map, or journal
mutations; report the decision you reached and which ticket it answers so a
CLI-equipped session can record it. An unrecorded decision is a decision the
next session will make again, differently.

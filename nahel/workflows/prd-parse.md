---
name: prd-parse
description: Turn an approved PRD into a parent feature work item that references it by path
args: "<slug>"
---

# Workflow: prd-parse

Load and follow this workflow to turn an APPROVED PRD into the feature
work item that will deliver it. The judgment is scope and lane; the
mechanics are exactly the CLI calls below. Never hand-edit anything under
`nahel/`.

Before any `nahel` command: if you are an agent, set
`NAHEL_ACTOR=agent:<your-id>` so every journal event carries your identity.

1. Check the gate. Find the plan item whose `prd` field names
   `docs/prds/<slug>.md` (`nahel status` shows `prd=` on item lines). Its
   status must be `done` — the human's approval flip (ADR-0013). If it is
   not, STOP and say so: parsing an unapproved PRD skips the human gate.

2. Read the PRD end to end, then verify its scope against the actual code:
   what already exists, which surfaces the requirements touch, the real
   size of what remains. Scope is what you verified, not what the PRD
   assumes.

3. Choose the lane from that verified scope:
   - `direct` — one focused change, a handful of files, no decomposition
     needed. Rare for anything worth a PRD; say why if you pick it.
   - `epic-lite` — one coherent feature, a few session-sized deliverables,
     light ordering.
   - `full` — multi-deliverable or cross-cutting; needs real decomposition
     with dependency ordering.

4. Create the parent feature item — it prints its generated id:

       nahel item new feature <slug> <lane> --prd docs/prds/<slug>.md

5. Journal the link so the trail survives compaction:

       nahel log note --item <feature-id> \
         --data body="Parses docs/prds/<slug>.md (authored by plan item <plan-id>)"

6. Next: `direct` goes straight to the task-lifecycle workflow;
   `epic-lite` and `full` go to epic-decompose first.

Fallback (degraded environment): if the `nahel` CLI is unavailable, read
the PRD and report the lane you would choose, but create nothing — items
and journal entries are CLI-maintained state. Record the pending mechanics
so a CLI-equipped session can perform them.

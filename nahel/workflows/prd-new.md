---
name: prd-new
description: Author a PRD through a grilling interview and record it as the plan item's deliverable
args: "<slug>"
---

# Workflow: prd-new

Load and follow this workflow to author a PRD. A PRD is a knowledge
document, not state: it lives in `docs/prds/`, and its draft→approved
lifecycle lives exclusively on the plan work item that authors it
(ADR-0013) — the PRD file itself never carries a status field. The
interview and the writing are judgment work; every state mutation goes
through the CLI. Never hand-edit anything under `nahel/`.

Before any `nahel` command: if you are an agent, set
`NAHEL_ACTOR=agent:<your-id>` so every journal event carries your identity.

1. Own the work. Find the `plan` item this PRD belongs to (`nahel status`),
   or create one, then start it:

       nahel item new plan <slug> direct
       nahel item update <id> --status in-progress

   The slug names the document: `docs/prds/<slug>.md`.

2. Interview — grill, don't transcribe. Use the pinned grilling skill when
   installed; without it, apply its core inline: ONE question at a time,
   never compound, follow up on every vague answer until it is concrete
   enough to refuse work with, and stop only when you could defend the plan
   to a skeptic. Cover, in order:
   - **Goal** — the problem and why now; one paragraph the human signs off on.
   - **Non-goals** — what is explicitly NOT being built. An empty list means
     the interview is not finished.
   - **Functional requirements** — each with acceptance criteria a test
     could check. A requirement without a provable "done" needs more
     interview.
   - **Exit test** — the end-to-end proof the whole feature works.
   - **Open questions** — only genuinely open ones. A question the interview
     could have answered is an interview failure, not an open question.

3. Write `docs/prds/<slug>.md`. Frontmatter carries exactly `name`,
   `created`, and `updated` — NO status field (ADR-0013). Timestamps come
   from the system, never estimated:

       date -u +"%Y-%m-%dT%H:%M:%SZ"

   Body: goal, non-goals, functional requirements with acceptance criteria,
   exit test, open questions. No placeholder text anywhere — an empty
   section means the interview resumes.

4. Record the deliverable on the plan item and hand it to the human:

       nahel item update <id> --prd docs/prds/<slug>.md
       nahel item update <id> --status in-review

5. STOP at the gate. Approval is the human's decision, recorded as the plan
   item's status flip to `done` — through the CLI, at their explicit word.
   Do not parse the PRD into feature items; that is the prd-parse workflow,
   and it waits for the flip.

Fallback (degraded environment): if the `nahel` CLI is unavailable, hold
the interview and draft the PRD anyway — it is a knowledge document, not
CLI-maintained state — but make NO item mutations; record which mutations
remain so a CLI-equipped session can finish. If the grilling skill is not
installed, the inline posture in step 2 is its fallback: the interview
happens at full strength regardless.

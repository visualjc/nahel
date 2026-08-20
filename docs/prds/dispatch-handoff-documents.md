---
name: dispatch-handoff-documents
created: 2026-08-20T16:21:23Z
updated: 2026-08-20T16:36:57Z
---

# PRD — dispatch handoff documents

Map-fed PRD (workflow prd-new step 2a): every settled section below cites the
map ticket that decided it (map z5atxgw6 on roadmap node
dispatch-handoff-documents / c3ax3k2f). Rationale lives with the tickets and
in the journal (`nahel recall handoff`); this document points, it does not
re-argue. Design origin: journal event f4v1wt9m (approved direction,
2026-07-28); field evidence: journal event nt93edc0 (mega-prompt codex
dispatch hung, pointer-prompt re-dispatch ran healthy, 2026-08-19).

## Goal

`nahel dispatch` passes a worker's task as one giant trailing argv argument
today (`composeInvocation`, src/dispatch/invocation.ts): orientation preamble
plus the entire task text travel inside the spawned CLI's command line. Large
briefs reproduce a proven failure — codex hangs on oversized argv — and the
journal records prompt content instead of durable paths. After this feature, a
dispatch of any size travels as a **pointer prompt** plus a **run-dir handoff
document**, the worker's output comes back as a **result document** with a
parseable contract, and the journal records **paths, not content**.

## Non-goals

- **Prune/GC tooling for distilled run dirs** — retention is decided
  (committed, distill-then-prune; ticket fpwwf6za) but the pruning mechanism
  stays on the map as fog; nothing here deletes run dirs.
- **Retrofitting existing run dirs** — old runs keep their current shape;
  validation applies the result contract only where a result.md exists.
- **Enforcing that external workers write result.md** — worker compliance is
  workflow-prose-governed in this slice; dispatch reports absence but does not
  fail the run for it.
- **A `--context-ref` flag or any CLI-managed reference wiring** — round
  chaining is an authoring convention (ticket jc5x1hs7), canonized in prose.
- **Changing agent CLI specs or routing** — the invocation table, model
  flags, and preflight are untouched except for what the prompt contains.

## Functional requirements

### F1 — dispatch writes the handoff document (ticket 2ds7zgc4)

`nahel dispatch` writes the full task to `nahel/runs/<run-id>/task.md` after
`startRun` creates the run record, before spawning the worker. The document
carries frontmatter (`run`, `item`, `responsibility`, `created`) and the task
body verbatim; the orientation contract stays in the prompt (F3), not in the
document.

Acceptance: dispatching with a task produces `nahel/runs/<run-id>/task.md`
whose frontmatter names the run and item and whose body is byte-identical to
the task input; composition stays deterministic (same inputs → same document).

### F2 — `--task-file` input (ticket 2ds7zgc4)

`nahel dispatch <responsibility> --item <id> --task-file <path>` reads the
task body from a file instead of argv. Exactly one of trailing-argv task or
`--task-file` must be given; both or neither is a usage error. The file is
read once and copied into task.md — the run dir copy is the record, the
source file is the caller's own business afterward.

Acceptance: `--task-file` produces the same task.md and pointer prompt as the
equivalent argv dispatch; conflicting/missing task sources are refused before
any state change (misrouted-dispatch-is-inert contract holds).

### F3 — pointer prompt replaces the inline task (ticket 2ds7zgc4)

`composeInvocation` no longer inlines the task. The spawned prompt is the
orientation preamble (unchanged contract: actor line, `nahel brief` first,
CLI-only mutation, item and run ids) plus a pointer block: read
`nahel/runs/<run-id>/task.md` (repo-relative path) and follow it; write your
result to `nahel/runs/<run-id>/result.md` in the result format (F4), whose
contract the prompt states inline — the required frontmatter keys (`run`,
`item`, `status: success | failure | partial`, `summary`) and free markdown
body — so a worker following only the prompt produces a conforming result
(codex verification finding, 2026-08-20). The prompt's size stays bounded by
construction — it contains ids, paths, and the fixed contract lines, never
task content.

Acceptance: for a task of any size the spawned argv's final argument stays
under a small fixed bound (asserted in tests with a pathological multi-hundred-KB
task); the prompt names both paths and the run id; a worker following only the
prompt finds everything else on disk.

### F4 — result.md contract (ticket 4hfjsa0x)

A result document is frontmatter + free prose: required keys `run`, `item`,
`status` (enum: `success | failure | partial`), `summary` (one line); the
body is unconstrained markdown. A zod schema and parse function live in the
store layer beside the other frontmatter schemas. `nahel validate` checks
every `nahel/runs/*/result.md` that exists against the schema; a missing
result.md is not a finding (non-goal: worker enforcement). After the worker
exits, dispatch journals whether result.md appeared (F5) — presence is
recorded, never required.

Acceptance: a conforming result.md parses to a typed record; each missing
required key and a bad status enum are distinct validate findings naming the
run dir; a run dir without result.md produces no finding.

### F5 — the journal records paths, not content (tickets 2ds7zgc4, fpwwf6za)

The dispatch start event records the task document's repo-relative path and
the pointer prompt (small by construction) instead of the full task text. The
dispatch end event additionally records the result document's path when the
worker left one. Run dirs remain committed store state (retention lifecycle:
distill-then-prune, decided on ticket fpwwf6za — mechanism out of scope).

Acceptance: after a dispatch, the journaled start event carries
`task_doc=nahel/runs/<run-id>/task.md` and no full task content; the end
event carries `result_doc=…` exactly when the file exists.

### F6 — workflow prose canonizes the pattern (ticket cszwav57)

In the same change, EVERY canonical workflow doc that shows a dispatch with
inline task content — at HEAD that is afk-run.md, review-loop.md (steps 3a/3b
inline full review briefs), and inception.md (the hands-off verification
dispatch) — says it once, plainly: task context travels through the run-dir
handoff document; never inline a large brief into an agent CLI invocation;
round N's task.md references round N-1's result.md by repo-relative path
(ticket jc5x1hs7: fresh task.md per round, reference-don't-duplicate).
plan-frontier.md's cross-agent grill spawns its second agent OUTSIDE
`nahel dispatch` (no run, no run dir), so it carries the principle without
the run-dir paths: a grill brief longer than a few sentences travels as a
handoff document at a caller-chosen path handed over via a pointer prompt.
Ticket cszwav57 resolves with this change and never before it.

Acceptance: `grep -n 'nahel dispatch' nahel/workflows/*.md` shows no
invocation whose trailing task is a multi-sentence inline brief — every
example dispatches a pointer to a task document; each touched doc names the
pattern and the path convention; `nahel install` regenerates shims cleanly.

## Exit test

An end-to-end bun test drives the real CLI against a scratch store with a
stub agent binary: dispatch a task large enough that inlining it would have
produced a multi-hundred-KB argv. Prove: (1) the spawned argv's final
argument is the bounded pointer prompt, (2) `nahel/runs/<run-id>/task.md`
holds the full task with correct frontmatter, (3) the stub worker — reading
only its prompt — locates task.md and writes a conforming result.md, (4) the
journal's start/end events carry the two paths and no task content, (5)
`nahel validate` passes with the new run dir present and flags a deliberately
malformed result.md.

## Open questions

None — map-fed path; the cut check sorted every open line: prune tooling,
worker-compliance enforcement, and reference-wiring flags fell outside this
delta (recorded under Non-goals; they stay on map z5atxgw6), and everything
inside was already resolved by tickets 2ds7zgc4, fpwwf6za, 4hfjsa0x,
jc5x1hs7.

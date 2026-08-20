# Review brief — epic/dispatch-handoff (round 1)

You are one of two independent reviewers for the epic branch
`epic/dispatch-handoff` at HEAD 3fce9ec (base: main at 21ef12b). Review
independently and adversarially; do not assume the other reviewer exists.

## What shipped

PRD: `docs/prds/dispatch-handoff-documents.md` (read it first — F1–F6 and the
exit test are the contract). Implementation commits, in order: 6a502a3
(result-doc schema/paths), 933e85c (pointer prompt), 64c8251 (dispatch writes
task.md, --task-file, journal paths), 10e6481 (validate run.result-doc check),
f6046a5 (workflow prose canonization + shim regeneration), d497a71 (e2e exit
test).

## How to review

Read the diff: `git diff main...epic/dispatch-handoff` (source under `src/`
and `tests/`, prose under `nahel/workflows/`). Check:

1. **Correctness against the PRD** — does each functional requirement's
   acceptance criterion actually hold in the code, not just in the tests'
   claims? Look for gaps between test assertions and the PRD's language.
2. **Contract regressions** — dispatch's "misrouted dispatch is inert"
   guarantee (all refusals before any state change), write-ahead journaling
   order, the purity rules (no fs in commands outside the store layer, no
   ambient clock), atomicity of writes.
3. **Security/robustness** — path handling for run ids in the new doc paths
   (traversal), prompt injection surface of the pointer prompt, the
   --task-file read (what if the path is a directory, a huge file, unreadable
   mid-read).
4. **Edge cases** — spawn failure after task.md written; result.md that is a
   directory; concurrent dispatches; a run id that fails validation.
5. **Prose canonization** — do the workflow-doc edits contradict any other
   passage in those docs that still assumes inline dispatch?

## Report format

Each finding as one line: `<path>:<line> — <what is wrong and why it
matters> [severity: blocker|major|minor|nit]`. Then exactly one final line:
`VERDICT: approve | request-changes — <one sentence>`.

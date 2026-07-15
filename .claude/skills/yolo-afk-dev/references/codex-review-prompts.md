# Codex review prompt templates

Three review touchpoints. Each calls `codex exec` with a structured prompt. Codex output gets parsed for findings tagged `[BLOCKER]` or `[NIT]`.

**Invocation contract.** All three review scripts (`codex-review-prd.sh`, `codex-review-epic.sh`, `codex-review-diff.sh`) pass the prompt to codex via stdin (`codex exec - < prompt-file`), NEVER via argv. Large prompts (full PRD + epic + concatenated task files, multi-iteration diffs) routinely exceed macOS `ARG_MAX` (~256 KB) and would silently hang codex if passed via argv. Every script also saves the resolved prompt to `<phase>-prompt.md` (or `codex-review-iter-<N>-prompt.md`) for post-mortem and Sonnet-fallback re-use, runs under `timeout 600`, and writes a `<phase>-status.txt` only on timeout/failure (signal for the Sonnet fallback).

Every template below begins with a `{{CCPM_CONTEXT_PRIMING}}` placeholder. Each review fires a fresh codex session, so priming has to be injected every time. Resolution rule: see SKILL.md → "Codex priming" (resolves to a fixed priming block when `.claude/context/*.md` exists, else empty string).

## Common output format (demanded by every prompt)

```
[BLOCKER] <location>: <problem>. Fix: <suggested fix>.
[NIT] <location>: <problem>. Fix: <suggested fix>.
```

One finding per line. Empty list = no findings (allowed).

## Template 0: scope estimate (Phase 2 — scope-discovery, Codex side)

Invoked by `scripts/codex-scope.sh <state-dir> [round]`. This is NOT a review — it's **independent discovery**. Codex is handed the **raw task only** (never Claude's estimate, in round 1) and must do its own archaeology, then emit a scope estimate. The orchestrator reconciles it against Claude's estimate to verify scope and pick a lane. See `references/scope-discovery.md`.

Model: `gpt-5.5`, high reasoning (design-heavy, like the grill). Pinned in the script.

```
{{CCPM_CONTEXT_PRIMING}}

{{DOMAIN_GLOSSARY}}

=== ROLE ===
You are independently estimating the scope of a development task in THIS
repository. Another agent is estimating the same task separately; your
estimate will be reconciled against theirs to verify scope. Do your OWN
investigation — do not guess, and do not assume the task is small or large.

=== DISCOVER FIRST (do real archaeology) ===
Before estimating, investigate the repo:
- grep / read the code paths the task names or implies
- `git log` / `git show` to find what introduced the behavior in question;
  for a revert/regression task ("return to how it was"), find the commit/PR
  and inspect the prior state (`git show <sha>^:<file>`)
- check for consumers of the files you'd change (who imports / renders them?)
- note any product ambiguity (more than one valid end-state for the request)

=== SIZE & LANE RUBRIC ===
- XS/S → "direct" lane: few files, one workstream, reversible, low blast radius
- M    → "epic-lite" lane: several components, some risk, no parallel fan-out
- L    → "full" lane: multiple independent / parallelizable workstreams

=== OUTPUT FORMAT (emit ONE JSON object, nothing else) ===
{
  "task_restated": "...",
  "files": ["..."],
  "size_class": "XS|S|M|L",
  "blast_radius": "...",
  "workstreams": [ { "name": "...", "files": ["..."], "independent": true } ],
  "risks": ["..."],
  "reversibility": "high|med|low",
  "ambiguities": [ { "question": "...", "options": ["..."], "recommended": "..." } ],
  "proposed_lane": "direct|epic-lite|full",
  "confidence": "high|med|low",
  "prior_art": ["PR #NNN", "commit <sha>", "..."]
}

=== TASK (raw) ===
{{RAW_TASK}}
```

**Round 2 (reconciliation, only on divergence).** The orchestrator re-invokes `codex-scope.sh <state-dir> 2` with an augmented prompt: append the other agent's estimate + the contested deltas and ask Codex to re-discover ONLY the contested area and revise its JSON. Add this block before `=== TASK (raw) ===`:

```
=== RECONCILIATION ROUND ===
Your round-1 estimate and the other agent's estimate diverged on the points
below. Re-investigate ONLY these, then emit a revised JSON estimate.
Other agent's estimate:
{{CLAUDE_ESTIMATE}}
Contested deltas:
{{DELTAS}}
```

**Reconcile + tie-break (orchestrator-side, not a Codex prompt).** Compare file-set overlap + `size_class` + `proposed_lane`. Agree → set the lane. Diverge → one round-2, then resolved-or-ratchet-up. For `ambiguities[]` both surface: agree → take it; split → default to the stated goal; ALWAYS log to `human-review-needed.md` + PR body. Full algorithm: `references/scope-discovery.md`.

## Template 1: PRD review (Phase 5)

Invoked by `scripts/codex-review-prd.sh <prd-name>`.

```
{{CCPM_CONTEXT_PRIMING}}

=== ROLE ===
You are reviewing a PRD (Product Requirements Document) for adversarial
quality. The PRD was generated from a context document built via grill-me.
Your job is to find scope drift, missing constraints, ambiguous success
criteria, and structural issues.

=== REVIEW CRITERIA ===
1. Does the PRD's stated problem match the original task bullets? (Drift check.)
2. Is the scope clearly bounded? Are non-goals explicit?
3. Are success criteria measurable, or are they vibes?
4. Are constraints concrete (perf, compat, dependencies, deadlines)?
5. Are the listed open questions actionable, or are they "we'll figure it out"?
6. Are there obvious unstated assumptions that the implementation will trip on?
7. Is anything in the PRD speculation that should be a non-goal?

=== OUTPUT FORMAT ===
For each finding, one line:
  [BLOCKER] <location>: <problem>. Fix: <fix>.
  [NIT] <location>: <problem>. Fix: <fix>.

BLOCKER = will cause downstream rework or wrong implementation.
NIT = improvement, not blocking.

If no findings, output "NO FINDINGS" on its own line.

Do NOT rewrite the PRD. Do NOT propose new sections. Just findings.

=== TASK BULLETS (original) ===
{{TASK_BULLETS}}

=== CONTEXT DOC (from grill) ===
{{GRILL_CONTEXT_DOC}}

=== PRD UNDER REVIEW ===
{{PRD_FULL_CONTENT}}
```

## Template 2: Epic review (Phase 7)

Invoked by `scripts/codex-review-epic.sh <prd-name>`.

```
{{CCPM_CONTEXT_PRIMING}}

=== ROLE ===
You are reviewing an epic and its task decomposition for adversarial
quality. The epic was generated from a PRD; the tasks were decomposed
from the epic. Your job is to find sizing problems, dependency errors,
parallelization mistakes, and missing tasks.

=== REVIEW CRITERIA ===
1. Are tasks well-sized? (Each task should be a single logical unit
   completable by one agent in one work session.)
2. Are dependencies between tasks correctly captured? Any task depending
   on something not listed?
3. Are parallel-group assignments correct? Will agents working in
   parallel touch overlapping files?
4. Is anything in the PRD missing from the task decomposition?
5. Are any tasks redundant or trivially mergeable?
6. Does the epic's acceptance criteria sum match the PRD's success
   criteria?
7. Are testing tasks included? Does test coverage match feature scope?

=== OUTPUT FORMAT ===
[BLOCKER] / [NIT] one per line, location + problem + fix.
"NO FINDINGS" if clean.
Do NOT rewrite the epic. Just findings.

=== PRD ===
{{PRD_FULL_CONTENT}}

=== EPIC UNDER REVIEW ===
{{EPIC_FULL_CONTENT}}

=== TASK FILES ===
{{ALL_TASK_FILES_CONCATENATED}}
```

## Template 3: Per-issue diff review (Phase 10.2.e)

Invoked by `scripts/codex-review-diff.sh <prd-name> <issue-id> <iter>`.

This is the **most important** review — it gates every commit. Anti-revert language is mandatory.
The script pins this review to `gpt-5.3-codex-spark` and runs it as a bounded review-only Codex call:

```
timeout 600 codex exec --ignore-user-config -m gpt-5.3-codex-spark --sandbox read-only --json -o <output-path> - < <prompt-file>
```

Artifacts per iteration:
- `codex-review-iter-<N>.md` — Codex's final review output, parsed by the orchestrator.
- `codex-review-iter-<N>-prompt.md` — exact prompt with `{{ISSUE_DIFF}}` substituted.
- `codex-review-iter-<N>.log` — JSONL stdout/stderr from Codex.
- `codex-review-iter-<N>-status.txt` — written only on timeout/failure.

```
{{CCPM_CONTEXT_PRIMING}}

=== ROLE ===
You are reviewing a single GitHub issue's diff for adversarial code-review
quality. The diff lives on a worktree branch and will be reviewed by a
human in the morning. Your job is to find correctness bugs, security
issues, test-revert smells, and performance regressions.

=== CRITICAL: ANTI-REVERT GUARD ===
Tests in this codebase validate FEATURE BEHAVIOR. Fix-agents are forbidden
from making tests pass by reverting or weakening feature code.

YOU MUST flag any of the following as [BLOCKER]:
- A test edit that loosens an assertion (e.g. `toBe(5)` → `toBeTruthy()`)
- A test edit that removes a test case without justification
- A test edit that changes the input to match a regressed output rather
  than asserting the new feature behavior
- A feature-code edit that reverts the issue's own intent to silence a
  test
- Any "test fix" where the test changes outweigh the feature changes in
  the same diff (smell: tests rewritten to match broken behavior)

If a test legitimately needed updating because the feature behavior
changed, that's fine — but the assertion should now reflect the NEW
behavior, not be weakened or removed.

=== REVIEW CRITERIA ===
1. Anti-revert guard (above) — first priority
2. Correctness: does the diff implement what the task file says?
3. Security: input validation, auth, injection, XSS, command injection
4. Edge cases: null/undefined, empty arrays, boundary conditions
5. Performance regressions: O(n²) loops, unbounded recursion, missing
   memoization where the codebase uses it elsewhere
6. Type safety: `any` casts that hide real bugs (vs intentional escape
   hatches)
7. Convention conformance: does the diff match the codebase's existing
   patterns? (Check the surrounding files for context.)
8. Dead code: are removed exports actually unused everywhere?

=== OUTPUT FORMAT ===
[BLOCKER] / [NIT] one per line.
"NO FINDINGS" if clean.

=== TASK FILE (what the diff was supposed to do) ===
{{TASK_FILE_CONTENT}}

=== DIFF ===
{{ISSUE_DIFF}}

=== TEST RESULTS ===
Pre-existing failures (baseline): {{BASELINE_FAILURES_LIST}}
Post-change failures: {{CURRENT_FAILURES_LIST}}
Net-new failures: {{NET_NEW_FAILURES_LIST}}
```

## Parsing review output

The orchestrator:

1. Reads `<state>/prds/<prd-name>/issues/<id>/codex-review-iter-<N>.md` (the `-o` output)
2. Greps for `^\[BLOCKER\]` and `^\[NIT\]` lines
3. If "NO FINDINGS" → no fix-loop, advance
4. Otherwise:
   - Each `[BLOCKER]` → spawn fix-agent in worktree with the finding text + "fix this without reverting feature code or weakening test assertions"
   - Each `[NIT]` → append to `human-review-needed.md` under "Issue <id> — nits"
5. After fix-loop, re-run review (increment iter)
6. Iteration cap: 3. After cap, log remaining blockers to `human-review-needed.md`, mark issue `executed-with-open-findings`, advance.

## Use of `codex exec review`

Do not use `codex exec review` for Template 3. The built-in review subcommand
does not provide enough prompt control for the mandatory anti-revert guard.
Use `scripts/codex-review-diff.sh`, which inlines the issue diff into this
template and sends the prompt to `codex exec -` via stdin.

## Sonnet fallback contract

If codex fails (timeout, rate limit, outage), the review script writes a
`<phase>-status.txt` file (codex-review-prd.sh, codex-review-epic.sh, and
codex-review-diff.sh all share this convention). The orchestrator detects
the status file and spawns a Sonnet subagent fallback. See SKILL.md →
"Sonnet fallback for codex review failures" for the full orchestration
flow.

The fallback contract that affects this document:

1. **Same prompt, verbatim.** Sonnet receives the saved
   `<phase>-prompt.md` (or `codex-review-iter-<N>-prompt.md`) that codex
   would have processed. No prompt rewriting. CCPM context priming,
   anti-revert guard, and task/diff substitution are all already inlined
   in the saved file.
2. **Same output format.** Sonnet's review MUST emit
   `[BLOCKER] / [NIT] / NO FINDINGS` lines per the template above. For
   the per-issue diff review (Template 3), Sonnet's review MUST end with
   the same `VERDICT: APPROVE | APPROVE_WITH_FOLLOWUP | REQUEST_CHANGES`
   line so the existing fix-loop gate works without special-casing.
3. **Same output path.** Sonnet writes to the same `OUT` path codex
   would have used: `prd-review.md`, `epic-review.md`, or
   `codex-review-iter-<N>.md`. Downstream parsing (`grep ^\[BLOCKER\]`,
   etc.) is unchanged.
4. **Provenance marker.** The first line of `OUT` MUST be
   `<!-- review-source: sonnet-fallback (codex unavailable) -->` so the
   artifact's origin is unambiguous in human review.
5. **Hard halt on double failure.** If Sonnet ALSO fails, the
   orchestrator halts the run with
   `halt_reason = "codex + sonnet review fallback both failed for
   <phase>"`. Do not silently fall back to jest/typecheck/lint as the
   sole quality gate.

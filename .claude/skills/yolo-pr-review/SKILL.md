---
name: yolo-pr-review
description: 100% AFK agentic PR review-and-fix loop. Merges base, runs parallel reviewers (Claude code-analyzer + Codex CLI + human-reviewer reconciliation), cross-validates findings against HEAD, posts a unified PR review (approve / request changes when reviewing others' PRs, comment-only when self-authored), and—if the user authored the PR—optionally implements fixes and re-loops up to N iterations. Use when the user says "yolo review PR", "AFK review", "agentic review loop", or invokes /yolo-pr-review.
---

# yolo-pr-review — AFK agentic PR review/fix loop

You are orchestrating a multi-phase, multi-iteration PR review pipeline that runs autonomously via `ScheduleWakeup`/`/loop`. The user is AFK. Your job: deliver a thoroughly-validated PR review (and, on self-authored PRs, fixes for blockers) without supervision.

## Invocation

```
/yolo-pr-review [<pr-url-or-number>] [--reviewers=claude,codex,...] [--max-iterations=N] [--policy=alpha|strict] [--resume]
```

### Argument parsing

1. **PR target** (smart parse, in order):
   - Match `https://github.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)/pull/(?P<num>\d+)` → use as-is
   - Match `^\d+$` → treat as PR number in current repo (`gh repo view --json owner,name`)
   - No arg → `gh pr view --json number,url,headRefName` on current branch's open PR
   - None of the above → error: "No PR specified and no open PR for current branch."

2. **Flags** (all optional):
   - `--reviewers=` comma-list. Default `claude,codex`. `claude` is mandatory and cannot be removed.
   - `--max-iterations=N` integer. Default `3` (or repo config).
   - `--policy=alpha|strict` — default `alpha` (or repo config).
   - `--resume` — skip the "archive prior done|blocked run" step; take over an existing state file regardless of state.

3. **Precedence**: CLI flag > `<repo>/.claude/yolo-review.config.md` > built-in default.

## Phase 0 — bootstrap (runs inline on first invocation)

Before scheduling any `/loop` ticks, do these synchronously:

### 0.1 Resolve PR + author + mode

```bash
gh pr view <N> --repo <owner>/<repo> --json author,baseRefName,headRefName,headRepository,headRepositoryOwner,isCrossRepository,number,url,title
gh api user --jq .login
```

- `mode = full` if `pr.author.login == current_user`
- `mode = review_only` otherwise (no Phase 5; review submitted via `gh pr review --approve` or `gh pr review --request-changes` per consensus)

### 0.2 Resolve repo root

```bash
git rev-parse --show-toplevel
```

If invocation cwd isn't inside a git repo for this PR's head repository, error with: "Run /yolo-pr-review from inside the target repo (or a worktree of it)."

### 0.3 Resolve config

Read `<repo-root>/.claude/yolo-review.config.md` if present. Frontmatter shape:

```yaml
---
policy: alpha | strict
max_iterations: <int>
reviewers: [claude, codex, ...]
push_remote: <name>            # default: detect
test_cmd: "<cmd>"
typecheck_cmd: "<cmd>"
ccpm_context_dir: <path>
prd_root: <path>
domain_docs: <path>            # autodetected; CONTEXT.md / CONTEXT-MAP.md root
understand_dir: <path>         # autodetected; .understand-anything/
base_branch: <name>
---
```

Apply CLI flag overrides on top. Anything still unset → autodetect:

| Field | Heuristic |
|---|---|
| `test_cmd` | `Taskfile.yaml` w/ `test:unit` task → `task test:unit`; else `package.json` `"test"` script → `pnpm test`; else `foundry.toml` → `forge test`; else `pyproject.toml` → `pytest`; else skip with warning |
| `typecheck_cmd` | `package.json` `"typecheck"` script → `pnpm typecheck`; else `tsconfig.json` → `pnpm exec tsc --noEmit`; else skip |
| `push_remote` | Always derived from `gh pr view --json isCrossRepository,headRepositoryOwner` at push time — never assumed |
| `ccpm_context_dir` | `.claude/context/*.md` exists → use it; else skip the context-reading step in reviewer prompts |
| `prd_root` | `docs/prds/` → `.claude/epics/` → `.claude/prds/`; else skip |
| `domain_docs` | `CONTEXT.md` or `CONTEXT-MAP.md` at repo root exists → use it (+ `docs/adr/`); else skip the glossary-reading step in reviewer prompts |
| `understand_dir` | `.understand-anything/` exists → use it for `/understand-diff`; else skip |
| `base_branch` | `gh pr view <N> --json baseRefName -q .baseRefName` |

### 0.4 Resolve worktree

```bash
git worktree list --porcelain
```

- If PR head branch is checked out in some worktree AND that worktree has clean status (`git -C <wt> status --porcelain` empty) → reuse it.
- Else create `<repo-parent>/<repo-name>-pr<N>/` via `git worktree add <path> <pr-head-branch>` (fetch the branch from the right remote first).

Set `WORKTREE_PATH` for the rest of the run.

### 0.5 Initialize / archive state file

State file: `<repo-root>/.claude/runs/pr<N>-yolo-review.md`

- If file exists and `--resume` flag → take over (read state, continue).
- If file exists and `state ∈ {done, blocked}` → archive: `mv <file> <file-dir>/pr<N>-yolo-review.$(date -u +%Y%m%dT%H%M%SZ).md`. Then create fresh.
- If file exists and `state` is in-progress → take over (resume from current state).
- If file does not exist → create fresh.

Fresh frontmatter:
```yaml
---
state: merge_pending
iteration: 1
max_iterations: <resolved>
consensus: pending
mode: <full|review_only>
policy: <alpha|strict>
reviewers_configured: [...]
push_remote: <resolved>
test_cmd: "<resolved>"
typecheck_cmd: "<resolved>"
last_action: <ISO-8601 UTC>
notes: bootstrap complete
---

# PR #<N> yolo-review run

Plan: ~/.claude/skills/yolo-pr-review/SKILL.md
PR: <url>
Head: <head-repo>/<head-branch>
Base: <base-branch> (<base-repo>)
Worktree: <path>
Mode: <full|review_only>
Policy: <alpha|strict>

## Iteration log

### Iter 1 (started <ISO>)
- [ ] Phase 1: merge_pending
- [ ] Phase 2: review_pending
- [ ] Phase 3: validate_pending
- [ ] Phase 4: post_pending
- [ ] Phase 5: fixes_pending (if applicable)
```

### 0.6 Run Phase 1 inline

Phase 1 is the highest-latency phase (merge + typecheck + test). Run it now while the user is at the keyboard so they see progress. After Phase 1 succeeds, schedule the loop.

### 0.7 Schedule the loop

Call `ScheduleWakeup` with:
- `delaySeconds: 60` (kick off review_pending quickly)
- `prompt`: literal `/yolo-pr-review <N> --resume`
- `reason`: "kicking off review_pending phase for PR <N>"

Send a `PushNotification` with: "yolo-pr-review on PR #<N> bootstrapped. Phase 1 done. Loop running. Will notify on terminal state."

End the bootstrap turn.

## Loop body — one phase per `/loop` tick

When invoked with `--resume` (which `ScheduleWakeup` does on every wakeup), read the state file frontmatter and dispatch:

### State `merge_pending` → Phase 1

1. Detect push remote afresh: `gh pr view <N> --json isCrossRepository,headRepositoryOwner -q '{cross: .isCrossRepository, owner: .headRepositoryOwner.login}'`. Map to local remote name by checking `git remote -v`. Never hardcode "origin" or "team."
2. `cd <WORKTREE_PATH>`
3. `git fetch <base-remote> <base-branch>` (base-remote = the upstream/team remote, where main lives)
4. `git merge <base-remote>/<base-branch> --no-ff`
5. **Conflicts**: For each file with conflict markers, spawn a Claude reasoning subagent (Agent tool, `subagent_type: code-analyzer` or `general-purpose`):

   ```
   Resolve a 3-way merge conflict in <file>.
   
   Inputs:
   - Conflicted file content (with markers)
   - PR head commits touching this file: <git log --oneline merge-base..HEAD -- <file>>
   - Base branch commits touching this file: <git log --oneline merge-base..<base-remote>/<base-branch> -- <file>>
   - PR description: <gh pr view body>
   - Epic doc (if applicable): <prd_root>/<...>
   
   Determine the intent of each side. Output JSON:
   {
     "resolution": "<full file content with no conflict markers>",
     "confidence": "high|medium|low",
     "rationale": "<why this preserves both intents OR why our intent wins>"
   }
   
   Bias: If both sides encode the same intent and one's implementation is strictly better (env-aware vs hardcoded, etc.), take the better impl. If intents conflict, our (PR head) intent wins. If you cannot confidently classify intent, output low confidence.
   ```

   - `confidence: high` → write resolution to file, `git add <file>`
   - `confidence: medium|low` → set `state: blocked`, write rationale to `notes`, send PushNotification with reason, end turn (no ScheduleWakeup)

6. After all conflicts resolved: `<typecheck_cmd>` then `<test_cmd>`. Failure → `state: blocked`.
7. `git commit -m "chore: merge <base-branch> into <pr-head-branch>"` (Conventional Commits, NO AI attribution per `feedback_no_claude_in_commits`)
8. `git push <push-remote> <pr-head-branch>`
9. Update state: `state: review_pending`, increment iteration log checkbox, `last_action: <ISO>`. ScheduleWakeup `/yolo-pr-review <N> --resume` with `delaySeconds: 90`, reason "starting review phase".

### State `review_pending` → Phase 2

Spawn three concurrent fetches in **a single message with parallel tool calls**:

**(a) Claude code-analyzer subagent** — always.

`Agent` tool, `subagent_type: code-analyzer`, `run_in_background: true`. Prompt:

```
You are an independent code reviewer for PR #<N> on <owner>/<repo>.

Step 1: If <ccpm_context_dir> is set and exists, read all *.md files in it for project conventions and behavioral guardrails.
Step 1b: If <domain_docs> is set, read CONTEXT.md + CONTEXT-MAP.md (root) and any docs/adr/ entries the diff touches. This is the project's ubiquitous language and recorded decisions — treat them as authoritative on intent and naming.
Step 2: gh pr diff <N> --repo <owner>/<repo>
Step 3: gh pr view <N> --repo <owner>/<repo> --json body -q .body
Step 4: If <prd_root> is set, look for an epic doc referenced in the PR body and read it.
Step 5: If <understand_dir> is set, run /understand-diff on this PR's diff to surface affected components and domain impact, and /understand-chat for any flow you need to understand. Staleness: if <understand_dir>/meta.json gitCommitHash differs from HEAD, treat graph output as approximate and prefer the diff + CONTEXT.md (hand-maintained, always trusted) where they conflict.

For EVERY potential finding, before flagging:
- Open the actual file at HEAD via Read tool
- Confirm the line/symbol/behavior matches your claim
- If it doesn't match, drop the finding silently
- Cite the exact code excerpt as evidence

Domain conformance (when <domain_docs> is set): flag changes that introduce or rename a domain term without updating the owning CONTEXT.md, use a discouraged synonym the glossary lists under _Avoid_, or contradict a recorded ADR. Severity: important (not blocker) unless the violation also breaks correctness.

Operational/devops observations (CI/deploy config, secrets/infra *provisioning*, monitoring/alerting hookups, ops-framed scaling) are fine to surface, but keep them terse — one line each, no padding. They will be routed to a non-gating section, so do not inflate them or let them crowd out code findings. (Note: a *logic* bug in a deploy YAML, retry/rate-limit code, or env-consumption/validation is a CODE finding, not operational.)

Output (return as the final message AND attempt to write to /tmp/<task>-claude-review.json — main thread will save your inline output if write fails):

{
  "verdict": "APPROVE|APPROVE_WITH_FOLLOWUP|REQUEST_CHANGES",
  "findings": [
    {
      "severity": "blocker|important|nit|question",
      "file": "<path>",
      "line": <N>,
      "summary": "<one sentence>",
      "fix": "<concrete action>",
      "evidence": "<exact code excerpt at that line>"
    }
  ]
}

Verdict rule: any blocker → REQUEST_CHANGES. Else if ≥1 important or ≥1 nit → APPROVE_WITH_FOLLOWUP. Else → APPROVE.

Verdict semantics:
- **APPROVE** — clean. No findings. Merge confidently.
- **APPROVE_WITH_FOLLOWUP** — mergeable, but findings worth addressing in this PR or a follow-up. Non-blocking.
- **REQUEST_CHANGES** — has at least one blocker. Do not merge as-is.
```

**(b) Codex CLI** — only if `codex` is on `$PATH` and `codex` is in `reviewers_configured`.

We do NOT use `codex exec review --base <ref>`. That subcommand provides a built-in review system prompt but is mutually exclusive with `[PROMPT]`, which means we cannot inject CCPM project context priming. We trade Codex's built-in review scaffolding for full prompt control + priming. See lesson #1.

`Bash` tool, `run_in_background: true`:
```bash
cd <WORKTREE_PATH> && \
  gh pr diff <N> --repo <owner>/<repo> > /tmp/<task>-pr-diff.patch && \
  CODEX_PROMPT=/tmp/<task>-codex-prompt.md && \
  CODEX_OUT=/tmp/<task>-codex-review.md && \
  CODEX_LOG=/tmp/<task>-codex-review.log && \
  CODEX_STATUS=/tmp/<task>-codex-status.txt && \
  rm -f "$CODEX_OUT" "$CODEX_LOG" "$CODEX_STATUS" && \
  cat > "$CODEX_PROMPT" <<'PROMPT'
<PRIMING>

=== ROLE ===
You are an independent code reviewer for PR #<N> on <owner>/<repo>. Review the diff at /tmp/<task>-pr-diff.patch (read it first; it is the source of truth for what changed). Use the project context loaded above to judge convention conformance and product intent.

=== REVIEW CRITERIA ===
1. Correctness: does the diff do what the PR title/description claims?
2. Anti-revert smell: any test edit that loosens an assertion, removes a case, or changes input to match regressed output rather than asserting the new behavior?
3. Security: input validation, auth, injection, XSS, command injection.
4. Edge cases: null/undefined, empty arrays, boundary conditions.
5. Performance regressions: O(n²) loops, unbounded recursion, missing memoization where the codebase uses it elsewhere.
6. Type safety: `any` casts hiding real bugs vs intentional escape hatches.
7. Convention conformance: match the codebase's existing patterns (use the project context).
8. Dead code: removed exports actually unused everywhere?

Operational/devops observations (CI/deploy config, secrets/infra *provisioning*, monitoring hookups, ops-framed scaling) are fine to surface but keep terse — one line each, no padding; they route to a non-gating section. A *logic* bug in a deploy YAML, retry/rate-limit code, or env-consumption/validation is a CODE finding, not operational.

=== OUTPUT FORMAT ===
For each finding, one line:
  [BLOCKER] <file>:<line> — <one-sentence problem>. Fix: <action>.
  [IMPORTANT] <file>:<line> — <one-sentence problem>. Fix: <action>.
  [NIT] <file>:<line> — <one-sentence problem>. Fix: <action>.

If no findings: a single line "NO FINDINGS".

End with a verdict line:
VERDICT: APPROVE | APPROVE_WITH_FOLLOWUP | REQUEST_CHANGES

Verdict rule: any [BLOCKER] → REQUEST_CHANGES. Else any [IMPORTANT] or [NIT] → APPROVE_WITH_FOLLOWUP. Else → APPROVE.
PROMPT
  timeout 600 codex exec \
    --ignore-user-config \
    -m gpt-5.6-luna \
    --dangerously-bypass-approvals-and-sandbox \
    --json \
    -o "$CODEX_OUT" \
    - \
    < "$CODEX_PROMPT" > "$CODEX_LOG" 2>&1
  CODEX_EXIT=$?
  if [ "$CODEX_EXIT" -ne 0 ]; then
    rm -f "$CODEX_OUT"
    if [ "$CODEX_EXIT" -eq 124 ]; then
      printf 'codex_timeout seconds=600 log=%s prompt=%s\n' "$CODEX_LOG" "$CODEX_PROMPT" > "$CODEX_STATUS"
    else
      printf 'codex_failed exit=%s log=%s prompt=%s\n' "$CODEX_EXIT" "$CODEX_LOG" "$CODEX_PROMPT" > "$CODEX_STATUS"
    fi
  fi
```

Use `--ignore-user-config` for the background Codex reviewer so it does not inherit interactive-only Codex settings such as notifier hooks, plugin/app configuration, or a high-reasoning default model. The reviewer pins `gpt-5.6-luna` explicitly for a fast code-review pass. Auth still comes from `CODEX_HOME`; project rules still load unless `--ignore-rules` is explicitly added for a one-off diagnostic.

`<PRIMING>` resolves at orchestrator prompt-build time:
- If `<ccpm_context_dir>` is set (autodetected to `.claude/context` per Phase 0.3) AND that dir contains `*.md` files → substitute the standard priming block:
  ```
  === PROJECT CONTEXT (READ FIRST) ===
  Before responding, read every file under .claude/context/*.md in the
  current repo to load project conventions, architecture, and recent
  state. These files are authoritative project context maintained by
  the CCPM workflow. Treat them as ground truth on stack, naming, build
  commands, and product direction. Acknowledge implicitly by reflecting
  that context in your output — do not echo or summarize them.
  ```
- Else substitute empty string.

The priming block is additionally appended with domain lines when the
corresponding artifacts exist (each independently; concatenate after the
CCPM block, or stand alone if no CCPM context):
- If `<domain_docs>` is set → append:
  ```
  === DOMAIN GLOSSARY (READ FIRST) ===
  Read CONTEXT.md and CONTEXT-MAP.md at the repo root, plus any docs/adr/
  entries relevant to the changed files. This is the project's ubiquitous
  language and recorded decisions — judge naming and intent against it, and
  flag terms used in the diff that conflict with the glossary or an ADR.
  ```
- If `<understand_dir>` is set → append:
  ```
  === KNOWLEDGE GRAPH ===
  A knowledge graph lives at .understand-anything/ — read domain-graph.json
  for the business-domain map and knowledge-graph.json for file/function
  structure when you need to understand how a changed flow works. (You
  cannot run the /understand-* skills; read the JSON artifacts directly.)
  ```

If `codex` not on PATH: skip silently, log to `notes`. Phase 4 will surface "Codex unavailable" in the comment.

Phase 3 (validation) parses Codex output by grepping `^\[BLOCKER\]`, `^\[IMPORTANT\]`, `^\[NIT\]` lines plus the trailing `VERDICT:` line. Anti-revert smell findings count as blockers.

**(c) Human reviewer fetch** — always, every iteration.

```bash
gh api repos/<owner>/<repo>/pulls/<N>/comments              # line-level inline review comments
gh pr view <N> --repo <owner>/<repo> --json reviews          # review-level (APPROVE/CHANGES_REQUESTED + body)
gh pr view <N> --repo <owner>/<repo> --json comments         # conversation thread
```

**Filter out the skill's own prior comments**: drop any comment whose body starts with `## Agentic review iter` or `## Agentic review —`. Otherwise we'd recursively review our own output.

After all three fetches return / both background reviewers complete, update state: `state: validate_pending`, ScheduleWakeup with `delaySeconds: 90`. If both reviewers are still running when the tick budget expires, ScheduleWakeup with `delaySeconds: 60` and re-poll. If `/tmp/<task>-codex-status.txt` exists, treat Codex as finished but unavailable for this iteration; do not keep polling it.

### State `validate_pending` → Phase 3

Read all reviewer outputs:
- Claude: `/tmp/<task>-claude-review.json`
- Codex (if ran and `/tmp/<task>-codex-review.md` exists): `/tmp/<task>-codex-review.md`
- Codex failure status (if present): `/tmp/<task>-codex-status.txt`; record this under `Reviewers skipped` with the log path, but do not parse it as a PR finding.
- Human reviewers: gh fetched JSON above

For EVERY finding (agentic + human), classify against HEAD by Reading the actual file. Severity classification:

| Class | Definition |
|---|---|
| ACCURATE-BLOCKER | factual + breaks shipped behavior, AC, or correctness |
| ACCURATE-IMPORTANT | factual + cleanup or correctness gap, non-blocking |
| ACCURATE-NIT | factual + style/micro |
| INACCURATE | code at HEAD doesn't match the claim — drop |

**Code vs operational axis (orthogonal to severity).** Tag every ACCURATE finding `CODE` or `OPERATIONAL` by the **fix-location rule**: a finding is `OPERATIONAL` when its fix lives OUTSIDE the code in this PR — a dashboard, secrets store (Doppler / Vercel env *provisioning*), deploy/infra state, or team process. It's `CODE` when the fix is an edit to the logic/config-as-code in the diff.

Worked edge cases (apply verbatim):
- Retry / rate-limit *logic* in the diff → `CODE`.
- Env *consumption* — t3 env shapes, correct defaults, validation → `CODE`.
- "Make sure Doppler/Vercel actually hold this var" → `OPERATIONAL`.
- A correctness bug *in* a deploy YAML (`github.ref` vs `github.sha`, concurrency-group collapse) → `CODE`, because the fix is an in-diff edit.

`OPERATIONAL` findings are HEAD-verified identically (INACCURATE → drop), but they are routed to the operational section (Phase 4) and **excluded from severity gating** — they never enter the consensus rule below regardless of the severity a reviewer assigned. Per-reviewer verdicts from Phase 2 are advisory; this Phase 3 reclassification + the code-only consensus is authoritative.

Human-reviewer findings additionally tagged:
- ALREADY-FIXED — was a real issue but a prior iter fix already addressed it. Mark resolved in PR comment.
- DUP-AGENTIC — same finding as a current-iter agentic finding. Credit "both flagged."
- NEW — not surfaced by agentic reviewers. Add to current-iter bucket.

Verification rule (per `feedback_verify_xp_partner_claims`): reviewers — even good ones — cite wrong line numbers, wrong symbol names, dead-code paths. Drop or correct silently. The skill's job is to make the PR comment empirically true, not to pass through reviewer output verbatim.

Consensus rule (compute over **CODE findings only**; `OPERATIONAL` findings never enter this table — they never gate, never downgrade a verdict):

| Policy | BLOCKER | IMPORTANT | NIT only | Clean |
|---|---|---|---|---|
| `alpha` | request_changes | approve_with_followup | approve_with_followup | approve |
| `strict` | request_changes | request_changes | approve_with_followup | approve |

Phase 4 ALWAYS posts a comment regardless of verdict (audit trail of "the review ran"). APPROVE gets a positive comment.

Consensus enum: `pending | approve | approve_with_followup | request_changes`. Use these literal lowercase strings in the state file `consensus:` field.

Write `/tmp/<task>-validation-iter<N>.md`:
```markdown
# PR #<N> — Iter <N> Validation Log

HEAD validated: <git rev-parse HEAD>
Reviewers ran: <list>
Reviewers skipped: <list with reasons>
Policy: <alpha|strict>

[If iter > 1]
## Iter-<N-1> fixes verified
| Finding | Status | Verifier |
|---|---|---|
| ... | RESOLVED | claude — <evidence> |

## New iter-<N> findings

### BLOCKERS (<count>)
**B-i<N>-1 — <summary>** _(claude | codex | both | <human-handle>)_
- File: <path>:<line>
- Verified: <quote of code at that line>
- Fix: <action>

### IMPORTANT (<count>)
...

### NITS (<count>)
...

### OPERATIONAL (not gating) (<count>)
**O-i<N>-1 — <summary>** _(claude | codex | both | <human-handle>)_
- File: <path>:<line>
- Verified: <quote of code at that line>
- Fix: <action>

## Dropped
- <reviewer>: <claim> — <why dropped>

## Consensus
- BLOCKERS: <count> — consensus = <verdict>
```

Update state: `state: post_pending`, `consensus: <verdict>`. ScheduleWakeup with `delaySeconds: 60`.

### State `post_pending` → Phase 4

Build comment body at `/tmp/<task>-comment-iter<N>.md`:

```markdown
## Agentic review iter <N> — Claude (code-analyzer)<+ Codex CLI><+ <other reviewers>>

Verdict: **<APPROVE | APPROVE WITH FOLLOW-UP | REQUEST CHANGES>** (consensus across <K> reviewer sources, validated against HEAD `<sha>`)

[If iter > 1 AND any iter-<N-1> findings]
### Iter-<N-1> fixes verified resolved
| Finding | Status |
|---|---|
| <summary> | ✅ resolved — <evidence> |

[If consensus = request_changes]
### Blockers (<count>)
- `<file>:<line>` — <summary>. Fix: <action>. _(claude | codex | both | @<human-handle>)_

### Important (<count>)<[under alpha policy: flag, not gating]>
- `<file>:<line>` — ...

### Nits (<count>)<[under alpha policy: not blocking]>
- `<file>:<line>` — ...

[If any]
### Informational (not blocking)
- ...

[If any]
### Dropped (didn't match HEAD)
- <reviewer>: <claim> — <why dropped>

[If any operational findings — always shown when ≥1, regardless of verdict]
### Operational / DevOps considerations (not blocking)
- `<file>:<line>` — <summary>. Fix: <action>. _(claude | codex | both | @<human-handle>)_

---
Iteration <N>/<max>. Mode: <full|review_only>. Policy: <alpha|strict>. Reviewers ran: <list>. Skipped: <list with reason>.
Artifacts: `/tmp/<task>-{codex-review.md, claude-review.json, validation-iter<N>.md}`.
```

**Tone rules** (per `feedback_pr_comment_tone`):
- No thanks-for-the-review openers.
- No editorial wrap-ups.
- Lead with substance.
- Terse.

**No GitHub issue numbers** (per `feedback_pr_body_no_issue_numbers`) when target repo is upstream/team — internal noise to reviewers.

Post:

```bash
# mode=full (self-author) — GH blocks --approve/--request-changes for the PR's own author
gh pr comment <N> --repo <owner>/<repo> --body-file /tmp/<task>-comment-iter<N>.md

# mode=review_only (other-author) — submit a real GH review matching consensus
case "$consensus" in
  approve|approve_with_followup)
    gh pr review <N> --repo <owner>/<repo> --approve --body-file /tmp/<task>-comment-iter<N>.md
    ;;
  request_changes)
    gh pr review <N> --repo <owner>/<repo> --request-changes --body-file /tmp/<task>-comment-iter<N>.md
    ;;
esac
```

Self-author always uses `gh pr comment` (a regular conversation comment) — GH 422s on `--approve` / `--request-changes` when the reviewer is the PR's own author. Other-author submits one review per iter via `--approve` or `--request-changes`. The body of that review is the full agentic-review report (header `## Agentic review iter <N> ...` + verdict line + findings sections + footer). The verdict line in the body still differentiates `approve` vs `approve_with_followup` for the human reader, even though GH state is `APPROVED` for both.

Determine next state:
- `mode == review_only` → `state: done`
- `consensus ∈ {approve, approve_with_followup}` → `state: done`
- `consensus == request_changes` AND `mode == full` → `state: fixes_pending`

If `done`: send PushNotification with rich one-liner (see Terminal handler), do NOT ScheduleWakeup. End turn.

Else: ScheduleWakeup `delaySeconds: 90`, reason "starting fix pass for iter <N>".

### State `fixes_pending` → Phase 5

Only reachable in `mode=full` with `consensus=request_changes`. Operates on the validated **CODE blocker** list only — `OPERATIONAL` findings never gate, so they never enter the fix pass.

1. Spawn `Plan` subagent with the validated blocker list:

   ```
   Generate an ordered fix plan for these PR review blockers. Each fix should be atomic (single concern per commit) and include:
   - File path + line
   - Current code (problem) and proposed code (fix)
   - Conventional Commits message: fix(<scope>): <terse> — NO AI attribution
   - typecheck/test commands relevant to the fix's scope
   
   Blockers: <list from validation log>
   
   Output to /tmp/<task>-fix-plan-iter<N>.md
   ```

2. Apply fixes one at a time:
   - Edit file
   - Run `<typecheck_cmd>`. Failure → `state: blocked`, log failure, end turn.
   - Run targeted `<test_cmd>` if available. Failure → `state: blocked`, log, end turn.
   - `git add <file>`
   - `git commit -m "fix(<scope>): <terse>"` — Conventional Commits, NO AI attribution.

3. Re-verify push remote (PR head can move): `gh pr view <N> --json isCrossRepository,headRepositoryOwner`. Push: `git push <push-remote> <pr-head-branch>`.

4. Sleep 8–15 seconds (GitHub recomputes mergeability async).

5. Query: `gh pr view <N> --json mergeable,mergeStateStatus,headRefOid`.
   - `mergeable == "CONFLICTING"` → next state `merge_pending` (Phase 1 will handle the new conflict).
   - Else → next state `review_pending` (loop back, fresh review of post-fix HEAD).

6. Increment `iteration`. If `iteration > max_iterations` → `state: blocked` with `notes: "iter cap reached, unresolved findings logged in /tmp/<task>-validation-iter<N>.md"`.

7. ScheduleWakeup `delaySeconds: 90`, reason "next iteration after fix push".

### Terminal states

`state: done` or `state: blocked` → end turn without ScheduleWakeup. Send PushNotification with rich one-liner:

| Outcome | Notification body |
|---|---|
| done + approve + full | "PR #<N> approved (self-comment posted). <iters> iters, <fix-count> fix commits." |
| done + approve_with_followup + full | "PR #<N> approve-with-follow-up (self-comment posted): <X> important + <Y> nits. <iters> iters." |
| done + approve + review_only | "PR #<N> approved on GitHub. <iters> iters." |
| done + approve_with_followup + review_only | "PR #<N> approved on GitHub w/ follow-up: <X> important + <Y> nits. <iters> iters." |
| done + request_changes + review_only | "PR #<N> changes requested on GitHub: <X> blockers. <iters> iters." |
| blocked | "PR #<N> blocked: <notes>. State at <state-file-path>." |

## Lessons learned (guardrails — read before each phase)

1. **Codex review uses plain `codex exec` with the diff inlined, NOT `codex exec review --base`.** The `review` subcommand provides a built-in review system prompt but `--base` is mutually exclusive with `[PROMPT]`, which blocks CCPM context priming. We trade the built-in scaffolding for full prompt control + project-context priming. See Phase 2(b) for the prompt template; the priming block is the standard `=== PROJECT CONTEXT (READ FIRST) ===` shape used by yolo-afk-dev.
2. **Push remote varies per PR.** Author's fork (often `origin`) for cross-repo PRs, upstream for same-repo PRs. Always `gh pr view --json isCrossRepository,headRepositoryOwner` before pushing — even mid-loop, even after a previous successful push.
3. **`gh pr view --json mergeable` is async.** Sleep 8–15s after `git push` before re-querying or you'll see the stale `headRefOid`.
4. **`code-analyzer` subagents have no Write tool.** Request inline JSON output as the final message AND attempt write to `/tmp/...json`. Save the inline version from the main thread if the file isn't there.
5. **Reviewer count/symbol claims are often wrong.** Always Read+verify the actual file at HEAD before flagging in the PR comment. Drop mismatches silently. Don't paraphrase reviewer claims as facts.
6. **Human reviewer comments arrive mid-loop.** Fetch all 3 sources at the start of every Phase 2 — not just iter 1. Reconcile each as already-fixed / dup / new.
7. **Filter the skill's own prior comments.** Match `## Agentic review iter` or `## Agentic review —` body prefixes when fetching human comments to avoid recursion.
8. **Cache-aware ScheduleWakeup.** 90–270s stays in 5-min cache; 1200–1800s for genuine waits past cache. Avoid 300s — worst-of-both.
9. **PushNotification on every terminal state.** User is AFK by definition. Surfacing the outcome is the point.
10. **Conventional Commits, no AI attribution** (per `feedback_no_claude_in_commits`). Never add `Co-Authored-By: Claude` or similar to commits or PR bodies.
11. **Validate before posting.** Phase 3 is not optional. Posting unvalidated reviewer claims is worse than not reviewing.
12. **Re-verify push remote on every push** — not just first time. PR head can move (e.g., user pushed manually mid-loop).
13. **GH review state must match consensus.** In `review_only` mode, post one real review per iter via `gh pr review --approve` (consensus=`approve` | `approve_with_followup`) or `gh pr review --request-changes` (consensus=`request_changes`) — never `--comment`. The body of the review contains the full agentic-review report; no separate detail-comment + link-back. Self-author can't use `--approve`/`--request-changes` (GH 422), so self-author always falls back to `gh pr comment`.

## Memory references

These behavioral memories should be honored throughout the loop:

- `feedback_no_claude_in_commits` — never add AI attribution
- `feedback_pr_comment_tone` — terse, no thanks-for-review, no editorial wrap-ups
- `feedback_pr_body_no_issue_numbers` — no issue numbers in upstream-targeted PR bodies/comments
- `feedback_pr_push_target` — verify head remote before push
- `feedback_verify_xp_partner_claims` — grep/read actual code to verify reviewer claims
- `feedback_branch_for_changes` — never push to main
- `feedback_repo_check_commands` — use repo-native test/typecheck commands (e.g., just-flip uses `pnpm typecheck` / `pnpm test`)
- `feedback_show_plan_in_chat` — when surfacing plan content, paste inline not as a pointer

## Reused infra

- `Agent` subagent_type=`code-analyzer` for reviewers + conflict resolvers
- `Agent` subagent_type=`Plan` for fix planning
- `codex exec review --base <ref> --dangerously-bypass-approvals-and-sandbox -o <out>` — built-in Codex review
- `gh pr comment` (self-author) / `gh pr review --approve` | `gh pr review --request-changes` (other-author, per consensus)
- `ScheduleWakeup` with the prompt `/yolo-pr-review <N> --resume` to continue the loop
- `PushNotification` for terminal alerts
- `BashOutput` / `TaskList` for polling background reviewer completion

## File map

- **Skill**: `~/.claude/skills/yolo-pr-review/SKILL.md` (this file)
- **Per-repo config (optional)**: `<repo-root>/.claude/yolo-review.config.md`
- **Runtime state (per PR)**: `<repo-root>/.claude/runs/pr<N>-yolo-review.md`
- **Archived runs**: `<repo-root>/.claude/runs/pr<N>-yolo-review.<ISO-ts>.md`
- **Ephemeral artifacts**: `/tmp/pr<N>-yolo-review-{codex-review.md,claude-review.json,validation-iter<N>.md,fix-plan-iter<N>.md,comment-iter<N>.md}`

`<task>` token used in artifact paths = `pr<N>-yolo-review` for uniqueness across parallel runs on different PRs.

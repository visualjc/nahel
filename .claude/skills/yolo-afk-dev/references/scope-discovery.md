# Scope discovery & the Codex-consensus gate

This is the front-door phase that makes yolo-afk-dev **task-size-adaptive** and
**autonomous when the human is unavailable**. It runs right after `init` and
before `classify`.

It does two jobs:

1. **Produce a *verified* scope estimate** — not an assumed one. The orchestrator
   (Claude) and a fresh Codex session each discover scope **independently**, then
   reconcile. Agreement → proceed at the matched ceremony lane. Divergence → one
   bounded second round, then ratchet up.
2. **Pick the ceremony lane** (Direct / Epic-lite / Full) from that verified
   scope, so a 3-file change doesn't get a full PRD→epic→GitHub-issues pipeline.

## Why this exists (the panic it fixes)

Before this phase, every run took the same heavy pipeline. For a small task that
pipeline is disproportionate — and when the orchestrator noticed the
disproportion, it had no *in-skill, agent-collaborative* way to resolve the doubt,
so it fell back to asking the human (`AskUserQuestion`). That defeats the purpose:
the human is AFK.

The fix: when the orchestrator is tempted to stop and ask the human — about scope,
tool-fit, "this seems disproportionate," or product ambiguity — it **consults
Codex instead** and proceeds on consensus. The human is replaced by an
independent second agent, not by a blocking prompt. See "The consensus gate
replaces human escalation" below.

## The consensus gate replaces human escalation

**Kickoff is blanket authorization.** During a run the orchestrator NEVER calls
`AskUserQuestion` or otherwise blocks on the human. This explicitly overrides the
general "confirm outward-facing / expensive actions" instinct for the duration of
the run. Every such impulse routes to Codex consensus.

The only three human touchpoints, all non-blocking or terminal:

- **`human-review-needed.md`** — async log for load-bearing unknowns. The run does
  NOT stop.
- **The draft PR** — the after-the-fact review surface, where "I wasn't there" gets
  resolved *after* the work (including any flagged ambiguity defaults).
- **Hard halt** — ONLY on infra the agents can't resolve: codex CLI down, gh
  unauth, disk full, state corruption, concurrent human edit, **undecidable target
  repo / target missing deps**. Never on a judgment call.

**Resolvable by consensus (decide, then proceed):** scope, lane, tool-fit, "is
this disproportionate," implementation approach, and product-ambiguity end-state
(tie-break below).

**Async-logged to `human-review-needed.md` (best guess + flag, proceed anyway):**
genuinely load-bearing and hard-to-unwind — financial math, contract/security
semantics, data-integrity / migrations. Logged and flagged in the PR body. Still
NOT blocked.

## Step A — Claude discovers (rich human-facing toolkit)

Turn a possibly-vague task ("logos now there, bad, should be colors") into a
concrete scope. Use the human-facing understanding skills — this is the digging a
human would otherwise do by hand:

1. **`claude-mem` search** (`/claude-mem:mem-search` or the `search` MCP tool) —
   "what introduced this? did we touch this area before?" Often the fastest path
   to the originating PR / commit. Capture the hit IDs / PR numbers as `prior_art`.
2. **`understand-chat` / `understand-explain`** — if `.understand-anything/` exists,
   ask how the flow/component works and what's affected. Staleness check: compare
   `.understand-anything/meta.json` `gitCommitHash` to HEAD; if they differ, treat
   graph answers as approximate and prefer code / `CONTEXT.md`.
3. **`CONTEXT.md` / `CONTEXT-MAP.md` + `docs/adr/*.md` grep** — ubiquitous-language
   terms and load-bearing decisions for the area. Use `CONTEXT-MAP.md` to pick the
   bounded context.
4. **Git archaeology** — `git log -- <files>`, `git show <pr-merge>`, `git show
   <sha>^:<file>` to establish the "before" state when the task is a revert /
   regression ("return to how it was").

Emit a **scope estimate** (schema below).

## Step B — Codex discovers independently

Run `scripts/codex-scope.sh <state-dir>`. It fires a fresh `codex exec`
(`gpt-5.5`, high reasoning — discovery is design-heavy, like the grill, not a quick
review), primed with `{{CCPM_CONTEXT_PRIMING}}` + `{{DOMAIN_GLOSSARY}}`, handed the
**raw task only — NOT Claude's estimate**, told to do its own archaeology (grep,
read, `git log`/`show`) and emit the same schema.

The tooling asymmetry is the point: Claude uses claude-mem / understand-chat /
CONTEXT docs; Codex uses raw repo tools. Different methods → genuinely independent
estimates, not an echo. A Codex that just rubber-stamps Claude's number is
worthless; withholding Claude's estimate forces real independent work.

## Scope-estimate schema (both agents emit)

```json
{
  "task_restated": "one-sentence restatement of the work",
  "files": ["path/a.tsx", "path/b.ts"],
  "size_class": "XS|S|M|L",
  "blast_radius": "who/what else depends on these files",
  "workstreams": [
    { "name": "...", "files": ["..."], "independent": true }
  ],
  "risks": ["..."],
  "reversibility": "high|med|low",
  "ambiguities": [
    { "question": "...", "options": ["...", "..."], "recommended": "..." }
  ],
  "proposed_lane": "direct|epic-lite|full",
  "confidence": "high|med|low",
  "prior_art": ["claude-mem #4259", "PR #374", "commit 1fd227f6"]
}
```

Both estimates are saved to `<state-dir>/scope/`:
`claude-scope.json`, `codex-scope.md` (+ prompt/log/status per the script).

## Step C — Reconcile (the actual gate)

Compare the two estimates on three axes:

1. **File-set overlap** — Jaccard-ish: do the file lists substantially agree? A
   consumer Codex found that Claude missed (or vice-versa) is the signal scope is
   wrong.
2. **`size_class`** — same bucket?
3. **`proposed_lane`** — same lane?

**Agreement** (file lists substantially overlap AND same lane) → set
`state.lane`, `state.scope`, proceed into that lane.

**Divergence** (file-set delta, or lanes straddle a boundary) → run **one** bounded
second round:

- Show each agent the OTHER's estimate + the contested deltas ("Codex flagged
  `X.tsx` as a consumer you didn't list — is it in scope?"). Each re-discovers
  ONLY the contested area and revises.
- Re-reconcile. **Resolved** → take the verified lane. **Still unresolved or still
  straddling a boundary** → **ratchet to the higher lane** (divergence means scope
  is uncertain; buy more ceremony, don't gamble surgical).

The second round is capped at exactly one extra pass — never loop. After it, the
lane is decided (verified or ratcheted) and the run proceeds. **No human stop at
any point.**

## Product-ambiguity tie-break

When both agents verify scope but the task is product-ambiguous — conflicting valid
end-states (e.g. "return to before #374" = names-only cards, vs. "should be colors"
= wire in swatches):

1. Claude and Codex each argue which end-state better serves the **stated intent**.
2. **Agree** → take it.
3. **Split** → default to **maximizing the stated goal** over the literal mechanism
   (the user said "colors," so prefer showing colors), UNLESS the other reading is
   materially safer / more reversible and the goal is genuinely unclear.
4. ALWAYS: log the alternative + chosen reasoning to `human-review-needed.md` AND
   call it out prominently in the draft-PR body. The draft PR is where the human
   flips it in review.

## Lanes

The verified scope picks one lane. **Invariant across all lanes:** independent
dual-discovery (this phase), Codex review of the plan and/or diff, and adversarial
verification are ALWAYS ON — including Direct. Lower ceremony drops *bookkeeping*
(PRDs, epics, GitHub-issue fan-out), never *cross-checking*. "Lightweight" still
means "Claude proposes, Codex independently verifies, they agree, it goes forward."

| Lane | Trigger | Runs | Skips |
|---|---|---|---|
| **Direct** | XS/S, ≤1 workstream, reversible, low blast radius | lightweight plan → implement **inline** (no worktrees) → Codex diff review + adversarial verify → ONE draft PR | PRD authoring, epic decompose, GitHub-issue fan-out, `classify` |
| **Epic-lite** | M, several components, some risk, few workstreams | short plan doc → single `epic/<name>` branch (no issue fan-out) → Codex plan review + Codex diff review → ONE draft PR | GitHub-issue fan-out, parallel worktree agents |
| **Full** | L, multiple independent / parallelizable workstreams | the full pipeline: `classify` → grill → PRD → epic → issues → parallel agents → review → PR | — |

Lane-specific phase sequences are documented in `references/pipeline.md` → "Lane
execution paths."

## Repo resolution (handled here, as a fact — not a stop)

The skill runs on cwd, but a task may target a different sibling repo (e.g.
invoked from `flip-contracts` while the work is in `just-flip`). Resolve the target
repo during discovery:

- **Target == cwd** → proceed normally.
- **Target != cwd, target is a discoverable sibling WITH required deps** (git +
  ccpm skill + codex reachable) → **`cd` into the target repo**, log the re-root to
  `progress.md`, proceed. It's discoverable, so don't stop.
- **Target undecidable** (can't confidently determine which repo) OR **target lacks
  deps** → **hard halt immediately** with a clear reason. This is the one legit
  front-door stop, because it's undecidable infra, not a judgment call.
- **Task genuinely spans repos** → keep the **one-repo-per-run** invariant: pick the
  primary target, note the cross-repo dependencies in `human-review-needed.md` + PR
  body, do NOT auto-spawn the sibling work.

Repo resolution is cheap and happens early (startup checklist) so the state dir
lands in the correct repo; the full scope estimate then runs in that repo.

## State written by this phase

```json
"lane": "direct|epic-lite|full",
"target_repo": "/abs/path/to/resolved/repo",
"scope": {
  "consensus": "agreed|second-round-resolved|ratcheted",
  "size_class": "XS|S|M|L",
  "files": ["..."],
  "ambiguities_resolved": [ { "question": "...", "chosen": "...", "logged": true } ],
  "claude_estimate_path": "scope/claude-scope.json",
  "codex_estimate_path": "scope/codex-scope.md"
}
```

Then transition: Direct/Epic-lite → their lane path (skip `classify`); Full →
`classify`.

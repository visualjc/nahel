---
name: phase-2-afk-engine
created: 2026-07-25T15:47:29Z
updated: 2026-07-25T18:42:08Z
---

# Phase 2 — AFK engine

> PRD authored by plan item `phase-2-prd` (`b95x0sar`). Lifecycle (draft→approved) lives on that work item, never here (ADR-0013). Grounded in `docs/roadmap.md` Phase 2, PRODUCT.md, ADR-0015/0016, the 2026-07-24 scoping session (journal note `h0b28h4s`), and the Phase 1 exit-test empirics (PRs #13–#18).

## Overview / goal

Phase 1 proved the core loop interactively: a human-orchestrated host session shipped four reviewed PRs on the lab project, but every judgment call — scoping, lane picks, review timing, acceptance — flowed through Jim's chat turns. Phase 2 makes that host session autonomous: a one-line kickoff at 9am becomes a verified-by-driving draft PR by evening with zero human turns, from desktop or a remote transport.

Per ADR-0016 the engine is a hybrid. A new deterministic CLI verb, `nahel dispatch`, owns the mechanics — resolve the routing map, compose the agent-CLI invocation, spawn, record the run. The loop and all judgment live in a canonical `afk-run` workflow executed by any capable host agent; the CLI never decides, only executes decided dispatches. The review loop codifies the cross-vendor pattern that shipped PRs #13–#18. Scope also pulls forward the distribution slice of Phase 5 that the 2026-07-23 codex dogfood gap proved blocking: a compiled binary on PATH, the codex shim target, and the init AGENTS.md merge — without these, non-Claude agents cannot even discover nahel, and cross-tool autonomy is fiction.

Deliverables: `nahel dispatch` with routing enforcement, the `afk-run` and `review-loop` canonical workflows, the `plan` type wired into autonomous runs, the `prototype` lane with mechanical never-merge enforcement, the verify-by-driving invariant, checkpoint-respecting intervention, the autonomy gate, knowledge-first inception, and the distribution pull-forward. The lab is **speed-count-game**.

On the roadmap's "plan + prototype types": the `plan` type itself shipped in Phase 1 (F1.1 — a plan item authors a PRD and parks at human approval). Phase 2's remaining half is wiring it into the autonomous loop: a Full-lane AFK item authors its PRD from project evidence and — per the project's `governance.product` setting — either obtains delegated cross-vendor approval and keeps going (default) or parks at the human gate; it never asks mid-run (F2.2). Nothing about the plan type is dropped; what was left of it lands here.

## Non-goals

- **QA lane** — Phase 3. Verify-by-driving here exercises the changed flow only; no charters, no ratchet, no exploratory sweeps.
- **Roles & governance** — Phase 4, with one slice pulled forward: `governance.product` delegated PRD approval (F2.2, Jim-directed 2026-07-25). Everything else waits — no role charters, no architect gates, no `nahel digest`, and `governance.architecture` stays human.
- **Provider mirrors** — Phase 5. `external_refs` continue to be carried, never synced.
- **Shim targets beyond codex** — opencode, cursor-agent, pi, Gemini CLI stay Phase 5. Only the codex target is pulled forward (it is today's second vendor and the proven dogfood gap).
- **Tool-skills (`kind: tool`), docs site, public-release hardening** — Phase 5.
- **Any UI** — Phase 6. Parked items and pending decisions surface via `brief`/`status`, not an inbox.
- **Host scheduling/restart** — a long-lived host session is required for an AFK run; keeping that session alive (cron, launchd, remote transports) is a transport concern outside nahel state (ADR-0016).
- **Semantic anything in the CLI** — dispatch composes and records; it never plans, scores, or retries on judgment (hard constraint 1).

## Functional requirements

### F1 — `nahel dispatch` (deterministic mechanics)

Per ADR-0016: dispatch owns invocation mechanics and nothing else.

- **F1.1** `nahel dispatch <responsibility> …` resolves the routing map (ADR-0015 `routing` section) for the named responsibility to an `{agent, model}` pair, composes the correct agent-CLI invocation — binary, model flags, `NAHEL_ACTOR=agent:<id>` env, and an **orientation preamble directing the worker to run `nahel brief` before acting on its task** (orientation is part of the mechanical contract, not workflow prose that can be forgotten) — spawns it, and records the run (run record + journal events) through existing store mutations.
- **F1.2** Routing **enforcement** lands here (ADR-0015's Phase 2 half): resolution is responsibility-specific route first, then the configured default (ADR-0015's fallback chain). A dispatch that resolves through **neither** fails loudly with the exact config fix; no silent fallback to "whatever agent is handy."
- **F1.3** Per-agent-CLI invocation knowledge (how to pass a model flag to claude vs codex vs cursor-agent) is config-driven data, not scattered workflow prose; unknown agent kinds fail with a schema error.
- **F1.4** Process-spawning joins the store layer's exclusive-privilege allowlist deliberately (baseline/healthcheck/skills precedent); purity tests extend to cover it.

**Acceptance criteria**

- [ ] Given a committed routing map, `nahel dispatch implementation --item <id> -- <task args>` spawns the mapped agent CLI with the mapped model and a correctly attributed run record; the journal shows the dispatch and the spawned agent's own mutations under its own actor id.
- [ ] The composed invocation recorded with the dispatch contains the `nahel brief` orientation preamble **ahead of the task prompt** — provable by inspecting the journaled dispatch record, and absent (or trailing) it the criterion fails (F1.1).
- [ ] With no responsibility-specific route but a configured default, dispatch resolves to the default; with neither, dispatch exits non-zero naming the missing route and the `nahel config set` command that fixes it.
- [ ] A dispatch invocation-config entry with an unknown agent kind is rejected as a schema error by `validate` and by dispatch itself (F1.3).
- [ ] Dispatch makes zero LLM calls and needs zero API keys itself; determinism suite passes with dispatch in the allowlist.

### F2 — `afk-run` canonical workflow (the judgment loop)

The yolo-afk-dev engine rebuilt on nahel state, as prose executed by a host agent — any capable agent can be the runner.

- **F2.1** Scope discovery: the runner resolves a one-line kickoff ("add X to project Y") against the brief, backlog, and constitution into concrete work items, creating them through the CLI where they don't exist.
- **F2.2** Lane selection per item (Direct / Epic-lite / Full) with the reasoning journaled. Full lane authors the PRD in **AFK authoring mode** — prd-new's grilling interview needs a human, so the runner instead drafts from project evidence (brief, constitution, backlog, journal, code) and **journals every assumption the interview would have resolved**. What happens at the approval gate is governed by per-project config `governance.product` (the roadmap §7 delegated-legislation model, product slice pulled forward from Phase 4 at Jim's 2026-07-25 direction):
  - **`delegated` (default):** the runner obtains **cross-vendor consensus** on the drafted PRD — an independent second-vendor verification against the constitution, backlog, and the journaled assumptions — records the approval as an append-only, journaled decision naming both vendors, flips the plan item through the CLI under that delegated authority, and proceeds to parse→decompose→implementation in the same run. Vendor disagreement, any constitution conflict, or a `seed` inception tier (the Phase 1 tier ratchet: delegated governance demands `standard`+) **parks** instead.
  - **`human`:** the runner parks the item at the approval gate (ADR-0013) with the assumptions surfaced; parse→decompose→implementation run only after the human flips the plan item (prd-parse refuses an unapproved PRD, unchanged from Phase 1).
  Constitution amendments are never delegable under either setting. **Config semantics:** inception's governance step changes its written default to `{product: delegated, architecture: human}` (updating `inception.md`'s "start all-human" guidance — Jim's 2026-07-25 direction inverts it for the product half), and a project with **no** governance config behaves as `delegated` — pushing forward is the default unless told not to; `governance: human` is the explicit brake. In scope with this requirement: the Phase 1 `prd-new` and `prd-parse` docs' "approval is the human's word" steps gain the governance qualifier (delegated **plan-item approval** is the roadmap-§7 exception; ADR-0013 is untouched — it fixes where the lifecycle lives, not who flips it). The exception covers plan-item approval ONLY: leaf-item `done` in task-lifecycle and bug-lane stays human-only — explicitly including items whose PR auto-merged under `merge: on-approve` — exactly as the wave-ordering criterion assumes. This is the Phase 2 half of the roadmap's `plan` type.
- **F2.3** Wave ordering from `depends_on` edges; workers spawned via `nahel dispatch` per the routing map — the runner never hand-picks an agent in violation of routing (F1.2 enforces).
- **F2.4** The runner decides when to invoke the review loop (F3), when to stop, and when to park; every park is a journaled decision with a reason, surfaced by `brief`.
- **F2.5** Draft-PR-per-epic: each epic's branch **opens** a draft PR whose body carries the run trail (waves, reviews, verify-by-driving evidence, waivers). Under `merge: human` it stays a draft awaiting the human; under a validly activated `merge: on-approve` (F3.4) it may subsequently merge on reviewer sign-off — the invariant is one PR per epic carrying the trail, not that the run ends with it unmerged.

**Acceptance criteria**

- [ ] A single kickoff line on the lab project produces journaled scope discovery, lane picks with reasons, dispatched workers, and a draft PR with zero human turns between kickoff and PR — including a Full-lane item under `governance.product: delegated` (consensus-approved mid-run). Under `governance.product: human`, Full-lane items park at the gate instead (next criterion) and do not count against this one.
- [ ] Under `governance.product: delegated`, a Full-lane item's approval is provable from the journal alone, and a single runner-authored note cannot fake it: the proposal and the verification are **separately actor-attributed events from different vendors**, both bound to the **same PRD revision** (content hash or commit), the verification cites the assumption trail and the constitution check it performed, the decision event links the proposal and verification events it rests on, and the parse→decompose continuation happens in the same AFK run (F2.2).
- [ ] Each delegated park trigger works: vendor disagreement parks, a constitution conflict parks, and a `seed` inception tier parks regardless of config (F2.2).
- [ ] A repo with no governance config behaves as `delegated`; a fresh inception writes `{product: delegated, architecture: human}` explicitly (F2.2).
- [ ] With a `depends_on` chain among the discovered items, the journal proves completion-then-dispatch: each item's dispatch event appears strictly after every declared dependency's journaled **agent-reachable completion** — its run ended in success and its status reached `in-review` (or `done`, where the human already flipped it). `done` itself is human-only (task-lifecycle) and is deliberately NOT the bar — requiring it would deadlock zero-turn runs. Dispatch order alone is not the proof; the dependency's completion events precede it in the journal (F2.3).
- [ ] Under `governance.product: human`, a Full-lane kickoff produces a plan item that parks in `in-review` at the approval gate with its authored PRD recorded as the deliverable (status on the item, never the PRD — ADR-0013) **and the journaled assumptions AFK authoring substituted for the interview** — a park (or delegated approval) with no assumption trail fails this criterion — while the rest of the run proceeds (F2.2).
- [ ] A kickoff that resolves to two epics opens two trail-carrying PRs, one per epic — not one combined PR (F2.5). Whether either subsequently merges is F3.4's authority question, not this criterion's.
- [ ] The workflow doc passes the canonical format; `nahel install` generates its shim; the run is drivable by pure conversation (hard constraint 5).
- [ ] A second host agent (codex) can execute the same workflow document against the same state without Claude-specific instructions.

### F3 — Review loop workflow

yolo-pr-review rebuilt as a canonical workflow, codifying the pattern proven on PRs #13–#18.

- **F3.1** Two cross-vendor reviewers review the PR independently; findings are reconciled into one disposition list. The config surface names **both** reviewers (the exact shape — a reviewer list under the `review` responsibility or a second review slot — is an F1/F3 design call within ADR-0015's enum discipline); "second vendor is config, not architecture," but cross-vendor is the bar: the workflow refuses to count two same-vendor reviews as satisfying it.
- **F3.2** Every finding is validated against HEAD before fixing — findings against stale diffs are dismissed with a note, not fixed blind.
- **F3.3** Fix/re-loop: accepted findings are fixed red-first where testable; the loop re-reviews after fixes, capped at **3 iterations**; cap-reached parks the item for human review, never merges over objections, never stalls the rest of the run.
- **F3.4** Merge authority is per-project config: `merge: human` (default) — the PR waits; `merge: on-approve` (opt-in) — reviewer sign-off merges, journaling who authorized it. The config lives in the schema-validated `nahel/config`; the workflow refuses to merge under `human` regardless of approvals. `on-approve` is legitimate under HC6 and ADR-0011 **as amended 2026-07-25 (Jim-signed, resolving this PRD's former open question 4)**: the committed config flip is the human's standing authorization — **so the flip's provenance must be human**: the workflow verifies from the journal that the `merge: on-approve` config mutation was made by a `human` actor; a flag set by an agent actor is not an authorization — the workflow treats it as `merge: human`, parks the merge decision, and `validate` warns. Guidance carried by the workflow doc and setup surfaces: use **sparingly** — small items, or changes QA testing covers well; `merge: human` stays the default everywhere.

**Acceptance criteria**

- [ ] A seeded-defect PR on the lab project produces two independent reviewer findings lists from two different vendors, a reconciled disposition, red-first fixes, and sign-off within the cap — with the full trail in the PR body and journal.
- [ ] A config that resolves both review slots to the same vendor is refused by the workflow (and flagged by `validate`) rather than counted as two reviewers.
- [ ] A seeded stale finding — one whose cited code no longer exists at HEAD — is dismissed with a journaled note, not fixed (F3.2).
- [ ] With `merge: human`, a fully approved PR remains unmerged and parks as a pending human decision.
- [ ] With `merge: on-approve` configured **by a human actor** (journal provenance), the same fully approved state merges and the journal records who authorized it (the reviewers' sign-offs and the human-attributed standing config authorization); the workflow surfaces the use-sparingly guidance when the setup workflow writes the flag.
- [ ] With `merge: on-approve` whose config mutation is agent-attributed in the journal, a fully approved PR does **not** merge — the workflow behaves as `merge: human`, the merge decision parks, and `validate` warns about the unauthorized flag (F3.4).
- [ ] An artificial cap-breach (finding that keeps regressing) parks the item with the loop history journaled; the run continues on other items.

### F4 — Verify-by-driving invariant

Every AFK run must prove the change works by driving the app before its draft PR opens. No lane skips it (hard constraint 6).

- **F4.1** The runner satisfies the run contract (`nahel doctor` passes), launches the app per the contract, and exercises the changed flow using the host's browser/driving tooling.
- **F4.2** Evidence is journaled: what was driven, what was observed, tied to the run — enough for a human to audit the claim without re-running.
- **F4.3** When the host cannot drive (no browser tooling, headless transport, contract env incomplete), the item **parks** with the reason journaled — never a silent skip, never a PR without either evidence or a parked state.

**Acceptance criteria**

- [ ] A lab feature's draft PR body links journaled driving evidence for the changed flow; the journal ties the evidence to the run and the verifying actor.
- [ ] The invariant holds per lane, not per workflow-happy-path: a **Direct-lane** item (least ceremony) also produces driving evidence or parks — exercised in the lab alongside the Full-lane run; the `afk-run` doc states the invariant for every lane.
- [ ] Deleting the browser tooling from the host (or breaking the contract env) causes the same run to park the item at the verify step with an actionable reason — the PR is not opened.

### F5 — Prototype lane

The `prototype` work-item type becomes real (roadmap decision 5).

- **F5.1** `--variants N`: N parallel worktrees, each seeded with a mini-PRD (approach statement) and a running throwaway implementation; ceremony stripped — no TDD, no review loop, no consensus.
- **F5.2** **Never-merge is enforced mechanically**, not by prose: prototype branches/worktrees are marked such that the CLI refuses to record a merge-bound state for them and `validate` flags any prototype ref that reaches a PR or the default branch.
- **F5.3** Promotion path: a winning variant's mini-PRD graduates via the plan lane — mini-PRD → plan item authors the full PRD → **approval on the plan item (journaled, never skipped), granted per the project's `governance.product` setting** (F2.2: delegated cross-vendor consensus by default, the human gate under `governance: human` — the same gate, same rules, same park triggers) → parse into the feature lane — with the prototype worktree as reference-only; the losing variants' disposal is journaled.
- **F5.4** The Phase 1 tier ratchet (F4.3 there) gets its promotion half enforced here: promoting a prototype demands the recorded inception tier meets the ratchet bar (`standard` or above); promotion on a `seed`-tier project refuses with "upgrade inception first."

**Acceptance criteria**

- [ ] `--variants 2` on the lab yields two worktrees, two mini-PRDs, two runnable throwaways, and zero review/TDD ceremony in their journals.
- [ ] Never-merge is enforced **mechanically**: the CLI refuses to record a merge-bound state for a prototype ref and `validate` flags any prototype ref reaching a PR or the default branch — workflow prose alone does not satisfy this criterion; the refusal is journaled.
- [ ] A promoted variant walks the decided path end-to-end once in the lab: mini-PRD → plan item → full PRD (referencing the mini-PRD) → journaled approval on the plan item per `governance.product` (delegated consensus decision record, or the human flip under `governance: human`) → parsed feature item entering the feature lane — parse before the approval event is refused, and the prototype code is verifiably absent from the promoted feature's diff. The losing variant's disposal is journaled.
- [ ] Promotion on a `seed`-tier project refuses, naming the inception upgrade; the same promotion proceeds once the recorded tier is `standard` or above (F5.4).

### F6 — Intervention: checkpoint-respect

Phase 0's pause/claim/handback ops get honored by the engine (roadmap decision 10, grilled decision H).

- **F6.1** The runner checks claims/pauses at every checkpoint boundary: before each dispatch, each phase transition, and each PR open. A claimed item triggers clean stand-down — finish nothing further on it, journal the stand-down, continue the run elsewhere.
- **F6.2** No process killing: intervention is state-level; in-flight worker output on a claimed item is journaled then abandoned, not SIGKILLed mid-write.
- **F6.3** Handback resumes from state alone: the runner re-reads the item's journal (including human changes made while claimed) and continues without needing the prior session's memory.

**Acceptance criteria**

- [ ] Claiming an item mid-run causes the runner to stand down on it at the next checkpoint (journaled) while other items proceed to completion.
- [ ] A **paused** run dispatches nothing further from the pause onward; the journal shows the pause event followed by zero dispatch events until resume.
- [ ] No-process-killing is provable from the journal: the in-flight worker on a claimed item runs to its own natural exit, with no kill/terminate event anywhere in the trail (F6.2). Because a claim freezes the covered run against agent mutations (glossary claim semantics — the worker cannot end its own run record post-claim), the **runner** journals the worker's natural exit and final output as events on its own authority, and the claimed run record stays preserved as paused/claimed rather than force-ended.
- [ ] After handback with a human-made edit, the next dispatch on that item reflects the human's change — proven by the worker's output honoring it.

### F7 — Autonomy gate enforcement

Phase 1 recorded the inception tier and run contract; Phase 2's lanes read them (Phase 1 F4.4 pays off).

- **F7.1** `afk-run` hard-blocks at kickoff without: a human-signed constitution, a passing-shape run contract, and a recorded inception tier — the refusal names exactly which artifact is missing and the workflow that produces it ("run inception first").
- **F7.2** "Human-signed" is a **deterministic check**, not a vibe: the gate reads the schema-validated representation the inception workflow records (the human-signature field on the inception record in `nahel/config`, per Phase 1 F4) — if Phase 1's recorded shape is insufficient to verify this mechanically, extending it is in this requirement's scope.
- **F7.3** Interactive work remains ungated (unchanged from Phase 1).

**Acceptance criteria**

- [ ] Each gate prerequisite refuses independently and by name: a repo missing (only) the constitution signature, (only) the run contract, and (only) the inception tier each refuse naming that artifact; with all three present the run proceeds.
- [ ] The constitution check is deterministic — the same repo state produces the same gate verdict on any machine, with no judgment call in the gate itself.

### F8 — Distribution pull-forward (discoverability)

The 2026-07-23 codex dogfood gap (journal `qnk166em`): a codex session could not discover nahel at all. Three fixes pulled forward from Phase 5, minimally scoped:

- **F8.1** Compiled binary: `bun build --compile` artifacts for macOS/Linux plus an install path that lands `nahel` on PATH (script or documented one-liner); the machine-local `~/.local/bin` wrapper hack retires.
- **F8.2** Codex shim target: `nahel install --agent codex` generates `~/.codex/prompts/` (or repo-level equivalent) shims pointing at the canonical workflows, same generator discipline as the claude target.
- **F8.3** init AGENTS.md merge: `nahel init` on a repo with an existing AGENTS.md appends/merges the nahel orientation section instead of silently skipping — closes backlog item `init-should-offer-agents-md-merge` (`pjcgrgx1`).

**Acceptance criteria**

- [ ] A fresh machine (or clean PATH) can install the compiled binary with one documented command and run `nahel brief` in the lab repo.
- [ ] A bare codex session on the lab repo can discover and invoke nahel workflows via its shims + AGENTS.md alone — no hand-appended sections, no wrapper scripts.
- [ ] The AGENTS.md merge preserves every pre-existing byte of the user's file outside the nahel-owned section, and re-running `nahel init` is idempotent — the section appears exactly once, byte-identical across re-runs (F8.3).
- [ ] `nahel install --agent claude,codex` is idempotent; re-runs are byte-identical absent workflow changes.

### F9 — Knowledge-first inception (greenfield mining)

The Phase 1 inception workflow's "mine first, interview second" posture (F4.2 there, brownfield) generalizes to every founding: the agent drafts from **all sources available** before the human is asked anything. Brownfield mines the codebase; greenfield mines the **agent's domain knowledge and the web**. One workflow, one posture — no separate mode.

- **F9.1** `inception.md` gains the knowledge-first rule: for a greenfield founding, the agent researches the domain (its own knowledge, web when available — sources journaled, or the web's unavailability noted) and drafts the **complete standard-tier artifact set as `inception.md` defines it** — constitution (goal, domain facts, hard constraints, non-goals), governance config, glossary seed, seeded founding ADRs, the routing map (setup-routing), an actionable initial decomposition, and the run contract — before the interview begins.
- **F9.2** In **guided** founding the interview is confirm-and-correct, never blank-page: the human reads the drafts, corrects them, and signs off. The sign-off is the constitution signature (constitution stays human-owned; only its drafting is delegated). Time-to-found targets minutes of human attention, not hours.
- **F9.4** **Founding mode is an explicit up-front choice** (Jim-directed 2026-07-25): mode-and-input capture — "grill session (guided), or give me a paragraph and I figure it out (hands-off)?" — happens **before mining begins** and is a meta-question, not a content question; the knowledge-first ordering (complete drafts before any *content* question) holds in both modes. As the shortcut form, `nahel init --hands-off "<paragraph>"` records the mode and the paragraph as ordinary deterministic state (the CLI stores the choice; the inception workflow acts on it). Both doors per hard constraint 5; naming of the flag is cosmetic and swappable.
- **F9.5** **Hands-off founding** needs no return visit, and stays constitutional via an explicit **authority boundary**: the constitution's human-signed content is the paragraph, verbatim (the journaled, human-attributed init/kickoff act is the signature) — and **nothing the agent writes ever becomes constitutional text**. The elaborated domain facts, constraints, and non-goals live below the constitution as agent-drafted knowledge, explicitly marked unconfirmed: AFK work may rely on them as parkable assumptions, never treat them as un-overridable, and the human may promote them into the constitution later by signing. The elaboration is verified with the same cross-vendor consensus provenance as F2.2 (consensus authorizes legislation-layer content only). If the paragraph alone is constitutionally insufficient — no coherent goal or success criterion can be derived from it — the founding **refuses to record `standard` and parks for the human** instead of papering over the gap. `governance.product` records `delegated`. The signed paragraph is checked **before every implementation dispatch, on every lane** — any work that would contradict it parks; the one human instruction is the one thing the run can never override.
- **F9.3** The recorded tier is honest, with one **explicit amendment to the standard-tier definition for empty repos**: every artifact must be complete, but the run contract's `nahel doctor` proof cannot precede the app it checks — so a greenfield founding records `standard` with the doctor-proof recorded as a journaled first-scaffold obligation, which the AFK run must discharge (doctor exit 0) before any verify-by-driving PR opens (F4 already blocks there). A **new** founding the human cuts short records `seed`, with the ratchet's consequences (no delegated approval, no prototype promotion) applying as usual; re-running inception on an already-founded project can only ratchet the tier **up** — a cut-short re-founding never lowers the committed tier (`inception.md`'s existing rule).

**Acceptance criteria**

- [ ] A one-line project idea on an empty repo yields, via knowledge-first inception, a human-confirmed standard-tier founding with the **complete F9.1 artifact set recorded in founded state** (constitution signed, governance config, glossary seed, seeded founding ADRs, routing map, actionable initial decomposition, run contract) — drafts alone do not satisfy this — with the human's involvement limited to the confirm-and-correct interview, and an `afk-run` kickoff on that repo passes the F7 autonomy gate immediately afterward.
- [ ] The mining is provable, not just the timing: the journal carries the research-source citations (or the web-unavailable note) and shows the complete draft set recorded **before the first interview response**; the human's sign-off event is distinguishable from the drafting events.
- [ ] On an empty repo the founding records `standard` with the journaled doctor-proof obligation; the AFK run discharges it (doctor exit 0, journaled) before its first verify-by-driving PR, and a run that never discharges it opens no PR (F9.3 + F4).
- [ ] A new founding cut short before the artifact set is complete records `seed`, and the delegated-approval and promotion gates refuse accordingly; a cut-short re-founding of a `standard` project leaves the recorded tier at `standard`.
- [ ] A hands-off founding from a paragraph reaches founded state **recording `standard`** with **zero human turns after the init/kickoff act**: the paragraph appears verbatim as the constitution's only signed content with human-attributed journal provenance, the elaborated knowledge is marked unconfirmed (none of it constitutional); the **complete F9.1 artifact set is recorded in founded state** (drafts alone fail, doctor-proof may remain the F9.3 obligation); the elaboration's verification has the **same provenance shape as F2.2's delegated approval** — separately actor-attributed proposal and verification events from different vendors, bound to the same founded artifact-set revision (content hash or commit), the verification citing the assumption trail and the constitution check, and a decision event linking them (a single-vendor self-note fails); and `governance.product` records `delegated` (F9.4/F9.5).
- [ ] A failed or incomplete elaboration verification — or a constitutionally insufficient paragraph — leaves the founding at `seed` (or parked), with delegated approval and promotion blocked accordingly; it never silently records `standard` (F9.5).
- [ ] A work item whose direction contradicts the signed paragraph parks **before its implementation dispatch, on any lane** — exercised in the lab on the hands-off-founded empty repo of the AC above (the signed paragraph is that founding's), on both a Full-lane drafted PRD and a non-Full-lane item (F9.5).

## Exit test

Run in the lab (**speed-count-game**), full bar per the scoping session:

1. At ~9am, a **one-line kickoff** ("add X to speed-count-game") is issued to a host agent — once from **desktop**, once from a **remote transport** (separate runs, same bar). Under the default `governance.product: delegated`, any lane can reach code — a Full-lane pick proceeds through journaled cross-vendor approval. (Only under `governance: human` would a Full-lane pick park at the gate without exercising the test; the lab runs delegated.)
2. By evening, each run has produced a **verified-by-driving draft PR**: scope discovered, lanes picked, workers dispatched per routing, review loop passed (or parked with trail), driving evidence journaled and linked from the PR body.
3. **Zero human turns** between kickoff and draft PR. Every human decision the run wanted is parked, not asked.
4. The trail is auditable from state alone: a fresh session (any tool) explains from `nahel brief` + journal what was built, why, what was verified, and what is parked.

Pass = both transports, judged by Jim. Failure anywhere feeds the backlog before the phase closes.

## Dependencies / ordering

- **F8 first** (distribution): F2's "codex as runner" criterion and the remote-transport exit test both presuppose discoverability; it is also the smallest slice and de-risks everything cross-tool.
- **F1 (dispatch) before F2** (afk-run): the loop dispatches through the verb; building the loop on hand-spawning would immediately violate F1.2.
- **F3 (review loop)** can land in parallel with F2 after F1 — it is invoked by the loop but exercisable standalone on a manual PR.
- **F7 (gate)** with F2's kickoff step; **F6 (intervention)** threads through F2's checkpoints as they are built, not bolted on after.
- **F4 (verify-by-driving)** before the first full-lane lab run; **F5 (prototype)** last — it shares the worktree machinery but nothing depends on it.

## Open questions

1. **`epic-oneshot` retirement** — flagged during Phase 1 (journal `xfkr09sy`) as semantically weakened and a Phase 2 deletion candidate. Whether it dies here or gets rebuilt atop `afk-run` should be decided when F2 lands and shows whether anything still needs it; a direct-lane chore either way, not scoped as an F-requirement.
2. **Remote transport choice for the exit test** — the bar requires *a* remote transport (Claude Code remote, OpenClaw, Hermes…); which one is exercised depends on what is set up on Jim's infrastructure by phase end. The invariant is transport-agnostic; the test needs one real instance.
3. ~~Dispatch invocation-config shape~~ — **resolved 2026-07-25** while building F1: a shipped table keyed by a fixed agent-kind enum (`claude | codex | cursor-agent`), each entry replaceable wholesale through an additive `config.dispatch` section, prompt always the trailing argument. Unknown kinds are a schema error from `validate` and from dispatch. Recorded as the ADR-0016 addendum.
4. ~~Hard constraint 6 amendment for `merge: on-approve`~~ — **resolved 2026-07-25**: Jim approved the amendment (chat, journaled on `b95x0sar`); HC6 and ADR-0011 now permit `on-approve` as a human-granted standing authorization, with use-sparingly guidance (F3.4).

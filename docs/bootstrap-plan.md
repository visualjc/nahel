# Nahel Bootstrap Plan — from empty folder to self-improving, AFK-first

Companion to [nahel-roadmap.md](nahel-roadmap.md). This is the *meta*-plan: how we build the thing that builds things, using ccpm + yolo-afk-dev as temporary scaffolding until Nahel can manage itself.

## Directory & repo layout

```
~/projects/personal/
├── ccpm/                    # existing — reference + this planning doc; no new work here
├── nahel/                   # THE product repo (git + GitHub from day one)
└── nahel-labs/              # parent folder for NEW dogfood projects (each its own git repo)
    ├── poker-outs-trainer/  # greenfield lab
    └── scratch-*/           # seed-tier throwaway prototypes

~/projects/speed-count-game/ # existing brownfield lab — stays where it lives
```

- **Nahel is a sibling repo**, not a subfolder of ccpm. ccpm stays untouched as reference.
- **Labs are real separate repos** (not an `examples/` folder in nahel) because Nahel's whole thesis is per-repo state + git as transport — dogfooding inside a monorepo would never exercise inception, briefing, mirrors, or cross-repo AFK runs honestly. speed-count-game deliberately stays at its existing path — Nahel must not care where a repo lives.
- GitHub: `nahel` public from first commit under `visualjc` (portfolio pressure = hygiene pressure). Labs start private under `visualjc`; any lab worth showing publicly gets promoted to the **Native Interactive, LLC** org.

## The labs (chosen to exercise different tiers and lanes)

| Lab | Inception tier | What it exercises |
|---|---|---|
| **speed-count-game** (existing Next.js blackjack speed-count trainer at `~/projects/speed-count-game` — real code + git history, empty PRDs) | full, **brownfield** | mine-first inception (draft constitution/architecture from code, human corrects), feature lane, QA lane (browser driving), later: delegated governance. Domain facts: speed-counting rules |
| **poker-outs-trainer** (new: enter a Texas Hold'em hand, practice combinatorics — counting outs vs. opponents' ranges) | standard/full, **greenfield** | interview-first inception, plan lane (virtual PO drafts the PRDs), feature + QA lanes. Domain facts: outs/range combinatorics |
| **scratch projects** (disposable ideas, created as needed) | seed | 5-minute inception, prototype lane with N variants, never-merge invariant |
| *(nahel itself)* | full | deterministic-CLI development, TDD, bug lane — no separate CLI-utility lab needed; nahel is that lab |

Labs are chosen so every lane and tier in the roadmap gets exercised by something real — including one brownfield and one greenfield founding. Every friction found in a lab becomes a typed work item in nahel — that's the self-improvement loop.

## Stages

### Stage A — Scaffold + self-inception (interactive, ~1 session with Claude)
Human-in-the-loop because the constitution is human-owned by our own rules.

1. `mkdir ~/projects/personal/nahel` → `git init` → `bun init` → GitHub repo → move roadmap in as `docs/roadmap.md`.
2. Install **ccpm + yolo-skills into the nahel repo** (temporary scaffolding — see "Scaffolding rules" below).
3. Manual inception on Nahel itself (grill-with-docs, but transcribing — the grilling already happened):
   - `PRODUCT.md` constitution: goal, non-goals ("not a two-way sync product", "CLI never calls an LLM"), hard constraints.
   - ADRs 0001–000N transcribed from the roadmap's locked decisions (TS-on-Bun, state-in-repo, mirrors-not-peers, deterministic CLI, prompts/program split, …).
   - `CONTEXT.md` seed glossary (work item, journal event, observation, brief, lane, gate, claim…).
   - Run contract: `bun test` + invoking the CLI itself.
4. README stub with thesis + ccpm (MIT) and Sanderson attribution lines.

**Exit**: nahel repo exists, founded, pushed; ccpm commands work inside it.

### Stage B — Plan Phase 0 via ccpm, build via yolo-afk-dev (the AFK begins)
1. Interactive (~1 session): `/pm:prd-new nahel-core` — PRD for roadmap Phase 0 (state schema v1 + CLI: `init`, `log`, `status`, `brief`, `validate`, shim generator for Claude Code). The schema design itself gets a short domain-modeling pass with the human — it's the one technical artifact worth human eyes before code.
2. `/pm:prd-parse` → `/pm:epic-decompose` → human sanity-checks the task breakdown (15 min).
3. **AFK**: `/loop /yolo-afk-dev --recycle` runs on the decomposed tasks from a Claude Code session in the nahel repo. TDD is in force (it's a deterministic CLI — perfect fit). Output: verified draft PRs.
4. Human cadence: review draft PRs (use `/yolo-pr-review` for the first pass), merge, kick next tasks — ~30–60 min/day at gates, everything else AFK.

**Exit**: `nahel brief` in the nahel repo outputs a briefing that would correctly onboard a fresh agent to the Nahel project itself.

### Stage C — Cutover: Nahel manages Nahel (dogfood moment #1)
1. Build `nahel import --from-ccpm` as an early real feature — migrates `.claude/{prds,epics}` ccpm state into nahel format. This is dogfooding AND the future adoption path for every existing ccpm user.
2. Run the import on nahel's own repo. From here, nahel's PRDs/epics/journal live in nahel format; ccpm commands retire from this repo (yolo-afk-dev keeps running until Phase 2 replaces it — it reads/writes through the `nahel` CLI from now on, which will surface its own friction list).

**Exit**: zero ccpm-format state in the nahel repo; development continues without regression.

### Stage D — Labs come alive (dogfood moment #2)
1. Create `nahel-labs/`, found **blackjack-trainer** with a *real* full inception (this time Nahel's inception workflow runs it — Phase 1 work), snipkit with standard, first scratch with seed.
2. Drive lab development AFK (use case b: one-liner kickoffs). Every gap, awkwardness, or missing command found in a lab → typed work item in nahel's backlog.
3. This stage overlaps roadmap Phases 1–3: labs are how Phase 1 (core loop), Phase 2 (AFK engine port), and Phase 3 (QA lane — blackjack in the browser) get acceptance-tested.

**Exit**: roadmap Phase 2 exit test passes — one-line kickoff at 9am against a lab, verified-by-driving draft PR by evening, zero human turns, from desktop and from a remote transport.

### Stage E — Steady state (the working relationship)
- Human role shrinks to: constitution amendments, PRD approvals, PR reviews, grill sessions at roadmap phase boundaries, and reading digests.
- Nahel's own backlog is fed by lab friction + roadmap phases; scratch projects spin up/die freely at seed tier.
- Remote transports (Claude Code remote / OpenClaw / Hermes) get exercised once Stage D is stable — same repos, different keyboard.

## Scaffolding rules (using ccpm to build nahel without poisoning it)

1. ccpm/yolo installed in the nahel repo are **temporary** and pinned — no improvements to ccpm itself; every ccpm annoyance becomes a nahel work item instead.
2. Don't over-invest in ccpm-format state: PRDs/epics written in Stage B should use frontmatter Nahel's schema will recognize (name, status, depends_on) so `import --from-ccpm` stays cheap.
3. yolo-afk-dev's invariants (never merge, never weaken tests, verify-by-driving, Codex consensus) are in force from the first AFK run — Nahel is built under the same rules it will enforce.
4. The migration command (`import --from-ccpm`) is a product feature, not a throwaway script.

## AFK-ness, honestly scoped

| Work | Mode |
|---|---|
| Constitution, ADR transcription, schema domain-modeling | Interactive (human-owned by our own governance rules) |
| PRD drafting | AFK-drafted, human-approved |
| Epic decomposition | AFK, 15-min human sanity check |
| Implementation, testing, review | Fully AFK (yolo now, nahel Phase 2 later) |
| PR merge | Human, always (yolo hard rule 3) |
| Lab development | Fully AFK after each lab's inception |

## Rough sequencing

- **Session 1** (interactive): Stage A complete.
- **Sessions 2–3** (interactive kickoff + AFK runs): Stage B PRD + first AFK implementation waves.
- **Following ~1–2 weeks** (mostly AFK, daily gate reviews): finish Phase 0, Stage C cutover.
- **Then**: Stage D labs, tracking roadmap Phases 1–3.

## Naming & namespace (settled)

- CLI binary: `nahel`.
- Slash-command prefix: **`/nd:` by default** (configurable via `nahel install --prefix`). Not `/pm:` — too generic.
- ccpm's `/context:*` commands do not carry over as a separate namespace: the context system is *absorbed* by the knowledge layer — `/context:prime` becomes `nahel brief` (`/nd:brief`), `/context:create|update` become inception + compaction workflows under `/nd:`.

## Gates, clarified (settled)

"Gate time" is not a required daily budget — it's the set of actions that are human-only by our own rules: **PR merges** (yolo hard rule 3: the system never merges), **PRD approvals** (until governance is delegated in roadmap Phase 4), and **constitution changes** (always). All of them batch: kick off five AFK runs, review five draft PRs whenever convenient. Volume scales with how much gets kicked off, not with a schedule. During the 2-week bootstrap burst, expect merge-review to be the rhythm; everything else is AFK.

## Resolved decisions (from planning discussion, 2026-07-14)

1. ✅ Sibling repo + labs layout; speed-count-game stays at its existing path.
2. ✅ `nahel` public under `visualjc`; labs private under `visualjc`, public-worthy ones promoted to Native Interactive, LLC org.
3. ✅ Labs: speed-count-game (brownfield) + poker-outs-trainer (greenfield) + scratch; no separate CLI-utility lab (nahel itself covers it).
4. ✅ Slash prefix `/nd:`; `/context:*` absorbed into knowledge layer / `/nd:brief`.
5. ✅ Heavy Claude+Codex driving for ~2 weeks; human actions limited to merge/approve/constitution, batched.

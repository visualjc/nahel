> Generated Stage B exit artifact (PRD success criterion 1): open a FRESH agent session with ONLY the brief below and score Jim's 5-point rubric — the agent must state (a) the project goal, (b) the hard constraints, (c) what is in progress, (d) the correct next action, (e) where canonical truth lives for each state layer. Pass = 5/5, judged by Jim.
> Regenerate at any time with: `bun run src/cli.ts brief` at the repo root (replace everything below this header with the fresh output).

nahel brief

== constitution (PRODUCT.md) ==
## Goal

Enable a solo builder to run an AFK software development team: durable, tool-agnostic project state + workflows such that any capable agent (Claude Code, Codex, opencode, cursor-agent, OpenClaw, Hermes, …) or human can pick up any Nahel project at any point and advance it correctly — including fully autonomous plan→implement→verify runs that end in verified draft PRs.

## Hard constraints

1. The `nahel` CLI is **deterministic**: no LLM calls, no API keys, no network dependence for core operations. Semantic work happens in workflows executed by host agents.
2. All durable state lives in **committed repo-level files**. No state in `.claude/` or any per-agent directory; no state trapped in an app or database.
3. Agents never hand-edit state file internals (frontmatter, journals); they mutate state through the CLI.
4. External issue trackers are **one-way mirrors** of local state, never peers.
5. Every workflow must be drivable through **pure conversation** — slash commands are conveniences, never the only door.
6. Quality invariants are never silently skipped: failing repro test before bug fix (waiver = logged + surfaced), prototype code never merges, AFK runs verify-by-driving before opening a PR, PRs are merged by humans only.
7. Open source (MIT), TypeScript on Bun, dual-distributed (npm + compiled binaries).

== knowledge & canonical truth ==
constitution (goal, hard constraints; human-owned): PRODUCT.md
glossary & ubiquitous language: CONTEXT.md
architecture decisions (ADRs): docs/adr
work items (intent): nahel/items/
runs & hot state (execution): nahel/runs/<run-id>/
journal (history, append-only; view via nahel progress): nahel/journal/
observations (curated facts): nahel/observations/
config (knowledge paths, actor): nahel/config

== item statuses ==
work items:
  nahel-core  feature  in-progress  lane=full  id=rms3bbdx
    mutation-commands  feature  done  lane=full  id=4e7zraf5
    init-scaffold  feature  done  lane=full  id=8pq27jbv
    schema-layer  feature  done  lane=full  id=hpeya2yc
    store-layer  feature  done  lane=full  id=nwq6cctv
    brief  feature  done  lane=full  id=d28f6kwz
    intervention-ops  feature  done  lane=full  id=rnsjx3ft
    validate  feature  done  lane=full  id=vvr205xa
    log-events  feature  done  lane=full  id=vy93w8dp
    views-status-progress  feature  done  lane=full  id=w6dmnpgc
    install-and-self-init  feature  in-progress  lane=full  id=xwtq0sqt

runs: none open

== recent activity (newest last) ==
[… 19 older events truncated — full timeline: nahel progress]
2026-07-16T20:38:10Z  item.updated  agent:claude-code  item=vy93w8dp  {"target":"item","record":{"id":"vy93w8dp","name":"log-events","type":"feature","status":"done","lane":"full","parent":"rms3bbdx","depends_on":[],"external_refs":[{"provider":"github","id":"6"}],"created":"2026-07-16T20:38:10Z","updated":"2026-07-16T20:38:10Z"},"body":""}
2026-07-16T20:38:10Z  item.created  agent:claude-code  item=w6dmnpgc  {"target":"item","record":{"id":"w6dmnpgc","name":"views-status-progress","type":"feature","status":"backlog","lane":"full","parent":"rms3bbdx","depends_on":[],"external_refs":[{"provider":"github","id":"7"}],"created":"2026-07-16T20:38:10Z","updated":"2026-07-16T20:38:10Z"},"body":""}
2026-07-16T20:38:10Z  item.updated  agent:claude-code  item=w6dmnpgc  {"target":"item","record":{"id":"w6dmnpgc","name":"views-status-progress","type":"feature","status":"done","lane":"full","parent":"rms3bbdx","depends_on":[],"external_refs":[{"provider":"github","id":"7"}],"created":"2026-07-16T20:38:10Z","updated":"2026-07-16T20:38:10Z"},"body":""}

== pending human decisions ==
none

== validate warnings ==
none

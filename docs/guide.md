# Nahel guide — every command, and when to reach for it

For a **new human** or a **new agent** picking up nahel for the first time. This
page is a router: it tells you which surface answers which situation and links
deeper instead of inlining detail. Per-command detail lives in the CLI itself
(`nahel <verb> --help`); procedures live in the canonical workflow docs
(`nahel/workflows/*.md`).

> **Maintenance rule** (roadmap ticket a1cy1xmn): any change that adds, renames,
> or removes a CLI verb or a canonical workflow updates this page **in the same
> change**. The two reference tables below are generator-owned marked regions,
> projected from the `COMMANDS` registry in `src/cli.ts` and the frontmatter in
> `nahel/workflows/*.md`; a check-mode run in CI fails on drift. Prose outside
> the markers is hand-written and never generator-touched.

## Quickstart

**Human, new machine:**

1. `bun run install:local` (from this repo) puts `nahel` on PATH — or grab a
   `dist/` binary.
2. In your project: `nahel init` — scaffolds the `nahel/` store, config,
   knowledge templates, and the canonical workflow docs; merges a marked
   orientation section into `AGENTS.md`. Re-run safe.
3. `nahel install --agent claude,codex` — generates the `/nd:*` slash-command
   shims (and points `CLAUDE.md` at `AGENTS.md`).
4. `nahel doctor` — verifies the run contract on this machine.

**Agent, entering a nahel-managed repo:**

1. Set `NAHEL_ACTOR=agent:<your-id>` before **any** `nahel` command.
2. Run `nahel brief` and act on it — not on repo archaeology.
3. Never hand-edit anything under `nahel/`; every mutation goes through a verb.

## Which command do I need?

Organized by starting situation, not alphabetically:

| You are… | Reach for |
|---|---|
| …just entering the repo | `nahel brief`, then `/nd:brief` |
| …founding a brand-new project | `/nd:inception`, then `/nd:setup-routing` |
| …wondering what state things are in | `nahel status` (tree + runs + claims), `nahel roadmap` (intent layer) |
| …asking "what moved while I was away" | `nahel standup --since 7d`, `nahel progress` |
| …planning — foggy feature, product direction | `nahel plan [ref]`, `/nd:plan`, `/nd:chart-map`, `/nd:work-map` |
| …starting to build something specific | `/nd:prd-new` → `/nd:prd-parse` → `/nd:epic-decompose` → `/nd:task-lifecycle` |
| …facing a bug | `/nd:bug-lane` (repro test before fix — hard rule) |
| …answering "nobody knows, build and look" | `/nd:prototype-lane`, `nahel prototype` |
| …running fully AFK | `/nd:afk-run`, `/nd:plan-frontier` |
| …reviewing a PR to sign-off | `/nd:review-loop` |
| …recording what you learned | `nahel log` (event), `nahel observe` (durable fact) |
| …trying to remember a past decision | `nahel recall <terms>`, `nahel decisions` |
| …a human taking over from agents | `nahel claim`, then `nahel handback` when done |
| …suspicious the store is unhealthy | `nahel validate` (`--repair`), `nahel doctor` |
| …asking about one specific command | `nahel <verb> --help` (see note below) |

## CLI reference — 25 verbs

<!-- nahel-guide:begin verbs -->
| Verb | Does |
|---|---|
| `brief` | render the onboarding pack: constitution extract, knowledge pointers, statuses, recent activity, pending decisions, qa state, warnings (4 KB target) |
| `claim` | claim an item and its subtree for a human: pause covered runs, refuse agent mutations |
| `config` | replace one optional nahel/config section (schema-validated, atomic, journaled as config.updated) |
| `decisions` | show a compact, read-only ledger of resolved map decisions |
| `dispatch` | spawn the agent CLI routing assigns to a responsibility (composed invocation + run record, journaled) |
| `distill` | mark archived journal segments as distilled (adds marker files under nahel/journal/distilled/, journals the act) |
| `doctor` | verify the run contract on this machine: contract present, named env vars set (names only, never values), healthcheck runnable |
| `handback` | release a claim you hold, journaling deterministic evidence of the hand-fix |
| `import` | migrate a ccpm project into this nahel store (import --from-ccpm) |
| `init` | scaffold nahel/ state structure, config, and knowledge templates (non-interactive, re-run safe); --hands-off "<paragraph>" records a hands-off founding |
| `install` | generate per-agent slash-command shims from canonical workflow docs (nahel/workflows/*.md) |
| `item` | create and update work items (item new \| item update) |
| `log` | append a typed journal event (observation about work; actor from config or NAHEL_ACTOR) |
| `observe` | distill one durable observation (a fact with provenance journal event ids) into nahel/observations/ |
| `pause` | suspend an active run (status becomes paused; hot state follows) |
| `plan` | render the planning briefing for a roadmap node: what moved since your last session, the decisions so far, the frontier, the fog, and what the partner may settle here (plan [ref]) |
| `progress` | show the journal timeline, newest last (--item covers the subtree; --since 7d\|24h\|ISO, --limit) |
| `prototype` | run the prototype lane: spawn variant worktrees, promote a winner, dispose of the rest |
| `recall` | keyword-search observation records (name/body/tags, ranked by hits then recency; cites provenance event ids) |
| `roadmap` | read the roadmap and zoom into it, and create or update its nodes — the intent layer above work items (roadmap [ref], roadmap node new \| update \| show, roadmap ack) |
| `run` | drive the run lifecycle (run start \| run update --phase \| run end) |
| `skills` | manage pinned skill dependencies: `lock` resolves skills.yaml refs to commit SHAs, `restore` materializes them at the locked commits |
| `standup` | show what moved in a time window, grouped by roadmap node and item (--since 7d\|24h\|ISO) |
| `status` | show the work-item tree, open runs with phases, and claims (--json for the raw snapshot) |
| `validate` | check store integrity — schema, refs, claims, journal (--repair replays journal-ahead mutations) |
<!-- nahel-guide:end verbs -->

## Agentic commands — the `/nd:*` workflows

These are not hand-written commands. `nahel install --agent <agent>` generates
one three-line shim per canonical workflow doc; each shim only says "read
`nahel/workflows/<name>.md` and follow it with `$ARGUMENTS`". All procedure
logic stays in the doc, so every workflow is also drivable through pure
conversation — the slash command is a convenience, never the only door.

- Claude Code: `.claude/commands/nd/<name>.md` → `/nd:<name>`
- Codex: `$CODEX_HOME/prompts/nd-<name>.md` → `/prompts:nd-<name>`
- `--prefix` changes the `nd` namespace; regeneration prunes stale shims.

<!-- nahel-guide:begin workflows -->
| Command | Args | Does |
|---|---|---|
| `/nd:afk-run` | `<kickoff line>` | Run a project AFK — autonomy gate, scope discovery, lane picks, dispatched waves, review, and one verified draft PR per epic, with zero human turns |
| `/nd:brief` | | Onboard onto this project — render the nahel brief and act on it |
| `/nd:bug-lane` | `<item-id>` | Work a bug diagnosis-first — investigation doc, failing repro test before any fix, waiver only after documented failed attempts |
| `/nd:chart-map` | `<node-slug-or-id>` | Chart a foggy effort as a wayfinder map — a destination, decision tickets, and the fog you have not cut yet |
| `/nd:compact` | | Distill un-distilled archived journal segments into observations, then mark them distilled |
| `/nd:epic-decompose` | `<feature-item-id>` | Decompose a parent feature item into dependency-ordered, session-sized child work items |
| `/nd:inception` | `[seed\|standard]` | Found a project — knowledge-first mining, then a confirm-and-correct interview (guided) or a single paragraph (hands-off), producing constitution, governance, glossary, ADRs, routing, run contract, and first work items |
| `/nd:migrate-roadmap` | `<product-node-slug>` | Adopt a store's existing work into the roadmap layer — journal the selected set, then create the nodes it names |
| `/nd:plan` | `[node-slug-or-id]` | Run a planning-partner session — place the altitude, grill the human, fire research, and hand off the moment they say enough to start |
| `/nd:plan-frontier` | `<node-slug-or-id>` | Work one map's frontier AFK — claim a takeable decision ticket, answer it by type, resolve or release, and loop while the frontier still offers one |
| `/nd:prd-new` | `<slug>` | Author a PRD through a grilling interview and record it as the plan item's deliverable |
| `/nd:prd-parse` | `<slug>` | Turn an approved PRD into a parent feature work item that references it by path |
| `/nd:prototype-lane` | `<item-id>` | Explore an open question with N parallel throwaway variants — ceremony stripped, code that never merges, and a promotion path that carries only the winning approach |
| `/nd:qa-lane` | `<target hint or item id>` | Run a QA pass on a target project — charter the plan from the criteria the project already records, then sweep, file, and ratchet what the sweep finds |
| `/nd:review-loop` | `<item-id>` | Review a PR to sign-off — two cross-vendor reviewers, findings validated against HEAD, red-first fixes capped at three rounds, then the merge decision |
| `/nd:setup-routing` | | Detect available agent CLIs and models, then write the responsibility routing map via the CLI |
| `/nd:task-lifecycle` | `<item-id>` | Work a leaf item start to close — status flips, a run with honest phases, journaled findings |
| `/nd:work-map` | `<node-slug-or-id>` | Work one decision ticket off a map — claim it, answer it with the right surface, record the decision, graduate the fog |
<!-- nahel-guide:end workflows -->

## Asking about a single command

Today, `nahel <verb>` with wrong arguments prints usage under an error banner
(exit 1), and `nahel item --help`-style probes are answered by some verbs but
not uniformly. The roadmap item **subcommand-help** commits to the universal
convention: every verb answers `--help`/`-h` with its usage as a success
(exit 0), each help text states its flags and accepted value forms, and the
top-level `nahel --help` says so — so a human or agent reaches full detail from
the entry point without guessing, and this page never needs to duplicate
per-verb flags.

## Deeper surfaces

- `PRODUCT.md` — the constitution (human-owned; agents never edit it)
- `CONTEXT.md` — the ubiquitous language; its terms are normative
- `docs/roadmap.md` — locked architectural decisions and phases
- `docs/workflow-format.md` — the canonical workflow doc contract
- `nahel/workflows/*.md` — the procedures behind every `/nd:*` command

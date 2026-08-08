# Canonical workflow format

Canonical workflows (PRD F10, ADR-0005) are the single place procedure logic
lives: agent-neutral markdown docs, versioned with the project, drivable by
**pure conversation** (constitution hard constraint 5). Per-agent slash
commands are generated 3-line shims that do nothing but load the canonical doc
— see `nahel install` below.

## Location

```
nahel/workflows/<name>.md
```

One doc per workflow. The file stem **is** the workflow name: `brief.md`
defines the `brief` workflow and installs as `/nd:brief` in Claude Code.

## Frontmatter

Every workflow doc opens with YAML frontmatter carrying exactly these fields
(unknown keys are rejected — schema: `src/install/workflow.ts`):

| field         | type   | rules                                                                                       |
| ------------- | ------ | ------------------------------------------------------------------------------------------- |
| `name`        | string | slug (`[a-z0-9]+(-[a-z0-9]+)*`); **must equal the file stem** so shims can never drift      |
| `description` | string | non-empty one-liner, shown in agent command listings                                        |
| `args`        | string | argument hint for the shim (e.g. `"<item-id>"`); `""` when the workflow takes no arguments |

Example:

```markdown
---
name: brief
description: Onboard onto this project — render the nahel brief and act on it
args: ""
---
```

## Body

The body is the procedure, written for any capable agent or human:

- Steps reference only the three universal interfaces — the filesystem, the
  shell, and natural language. Concretely: `nahel` CLI invocations plus prose.
- Every state mutation in a workflow goes through the CLI (hard constraint 3);
  a workflow that would need to hand-edit `nahel/` state has found a missing
  CLI feature, not a workaround.
- Workflows must stand alone: no references to any specific host agent's
  features. Slash commands are conveniences, never the only door.

## Shim generation: `nahel install`

```
nahel install --agent claude[,codex] [--prefix nd]
```

For every workflow doc with valid frontmatter, the generator writes a 3-line
shim into each named agent's command location (default prefix `nd`). The shim's
whole job is "load canonical workflow X"; the `description` and `args` fields
become the agent-native command metadata — both current targets take the same
`description` / `argument-hint` frontmatter and expand `$ARGUMENTS`.

| agent | location | invoked as |
| --- | --- | --- |
| `claude` | `.claude/commands/<prefix>/<name>.md` (repo) | `/nd:brief` |
| `codex` | `~/.codex/prompts/<prefix>-<name>.md` (home) | `/prompts:nd-brief` |

Codex reads custom prompts only from `$CODEX_HOME/prompts` (default
`~/.codex/prompts`), scanning top-level markdown files — no subdirectories, no
repo-level `.codex/prompts`. So codex shims land outside the repo, stay flat,
and the prefix becomes a **file-name namespace** instead of a directory. They
do not travel with a clone: each machine runs `nahel install --agent codex`
once. AGENTS.md is what travels, and it makes nahel discoverable with no shims
at all.

Semantics:

- **Idempotent**: identical workflow docs produce byte-identical shims.
- **Mirroring**: the generator's namespace is made to mirror the workflow set;
  shims whose workflow was deleted are pruned on regeneration. That namespace
  is the whole prefix directory when the agent gets one of its own (claude —
  foreign `.md` files placed there are pruned too), and the `<prefix>-` name
  namespace when the directory belongs to the user (codex — the user's own
  prompts are never touched).
- **All-or-nothing targets**: every agent in the list is resolved before any
  file is written, so an unknown agent (or an unresolvable home directory)
  leaves the invocation with nothing generated.
- **Tolerant scan**: a doc with invalid frontmatter is skipped with a warning;
  the remaining workflows still install.
- **Instruction-file import**: `--agent claude` also ensures the store root's
  `CLAUDE.md` imports the agent-neutral instructions, because Claude Code reads
  `CLAUDE.md` and not `AGENTS.md`. No file → one is created holding
  `@AGENTS.md`; that line already anywhere in the file → nothing changes; the
  line missing → it is **prepended**, every existing byte kept after it, and
  reported out loud. Codex has no such step: it reads `AGENTS.md` natively.
- **Additive agents**: targets live in a lookup table
  (`src/install/agents.ts`); supporting a new agent is one new table entry.
  Unknown agents fail with the known-agent list.

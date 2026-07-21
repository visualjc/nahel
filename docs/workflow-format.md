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
nahel install --agent claude [--prefix nd]
```

For every workflow doc with valid frontmatter, the generator writes a 3-line
shim under the agent's command directory (`.claude/commands/<prefix>/<name>.md`
for Claude Code, default prefix `nd`). The shim's whole job is "load canonical
workflow X"; the `description` and `args` fields become the agent-native
command metadata.

Semantics:

- **Idempotent**: identical workflow docs produce byte-identical shims.
- **Mirroring**: the prefix directory is generator-owned; shims whose workflow
  was deleted (or any foreign `.md` placed there) are pruned on regeneration.
- **Tolerant scan**: a doc with invalid frontmatter is skipped with a warning;
  the remaining workflows still install.
- **Additive agents**: targets live in a lookup table
  (`src/install/agents.ts`); supporting a new agent is one new table entry.
  Unknown agents fail with the known-agent list.

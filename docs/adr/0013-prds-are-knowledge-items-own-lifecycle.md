# 0013 — PRDs are knowledge documents; work items own their lifecycle

Date: 2026-07-21
Status: accepted

## Context

Phase 1 ports the ccpm PRD workflows (prd-new, prd-parse). ccpm stored PRDs in
`.claude/prds/` with a `status:` field in the PRD's own frontmatter. Nahel's
constitution forbids durable state in per-agent directories, and a PRD file
that carries its own `draft|approved` status while the owning work item also
has a status creates two sources of truth for one gate.

## Decision

PRDs live in `docs/prds/` as knowledge-layer documents. The draft→approved
lifecycle lives exclusively on the owning work item: the `plan` item that
authors a PRD delivers it, and `feature` items reference it by repo-relative
path in frontmatter. The PRD file itself carries no status. All lifecycle
transitions go through the CLI, like every other item mutation.

## Consequences

- One source of truth for the approval gate; the gate is journaled and
  claim-protected for free because it is an ordinary item mutation.
- PRDs are prose for humans and agents to read — no CLI surface is needed to
  edit them, and hand-editing a PRD never touches state.
- `import --from-ccpm` must relocate `.claude/prds/*` into `docs/prds/` and
  lift each PRD's status onto its migrated work item.
- A PRD's approval state is not visible by opening the PRD file alone; views
  (`status`, `brief`) must surface it from the referencing items.

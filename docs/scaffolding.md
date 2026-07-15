# Temporary scaffolding — CCPM + yolo-skills

This repo is currently built **using** [CCPM](https://github.com/automazeio/ccpm) (MIT) and the yolo-afk-dev / yolo-pr-review skills, installed under `.claude/`. They are pinned, temporary, and will be retired at the Stage C cutover (`nahel import --from-ccpm`) per [bootstrap-plan.md](bootstrap-plan.md).

## Pins

- CCPM source: Jim's fork at `~/projects/personal/ccpm`, commit `82fcd5815f863dcd6b37a3e432e2fa9d2d38f995` (2025-12-19).
- yolo-skills: copied from the same fork's working tree (untracked upstream at pin time); the copies under `.claude/skills/` are the frozen reference.

## Rules (from bootstrap plan)

1. No improvements to ccpm itself — every ccpm annoyance becomes a **Nahel work item**.
2. PRDs/epics authored during scaffolding keep import-friendly frontmatter (`name`, `status`, `depends_on`).
3. yolo invariants are in force from the first AFK run: never merge, never weaken tests, verify-by-driving, Codex consensus.
4. `nahel import --from-ccpm` is a product feature (the ccpm-user adoption path), not a throwaway script.
5. Slash prefix note: scaffolding commands use ccpm's native `/pm:*` namespace until cutover; Nahel's own shims will use `/nd:*`.

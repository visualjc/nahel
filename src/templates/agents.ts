/**
 * AGENTS.md template — the conversational entry point `nahel init` emits
 * (PRD F2): what any host agent reads on entering the repo so chat agents can
 * drive everything through pure conversation (hard constraint 5).
 */
export const AGENTS_TEMPLATE = `# AGENTS.md — how to work in this repository

This project is managed with Nahel: durable, tool-agnostic project state under \`nahel/\`, written only by the \`nahel\` CLI.

## Start here

1. Run \`nahel brief\` — the onboarding pack: goal, hard constraints, knowledge pointers, current item statuses, recent activity. Act on the brief, not on repo archaeology.
2. Read \`PRODUCT.md\` (the constitution — human-owned; never edit it autonomously) and \`CONTEXT.md\` (the glossary — its terms are normative).

## Rules of the road

- **Identify yourself first.** Agents MUST set \`NAHEL_ACTOR=agent:<your-id>\` in the environment (example: \`NAHEL_ACTOR=agent:claude-code\`) before running ANY \`nahel\` command — every journal event then carries the true actor, and claim enforcement can tell agents from humans. Humans set nothing: the config actor entry is the human default.
- **Never hand-edit state.** Everything under \`nahel/\` (frontmatter, journals, hot state) is mutated only through \`nahel\` CLI verbs. If a change you need has no verb, that is a missing-feature bug — say so instead of editing files.
- **Record what happens.** Log significant events with \`nahel log\` as you work; CLI mutations journal themselves automatically.
- **Check before acting.** \`nahel status\` shows the work-item tree, \`nahel progress\` the timeline, \`nahel validate\` confirms state integrity.
- **Respect claims.** An item with \`claimed_by\` set is in human hands; the CLI refuses agent mutations on it (and its subtree) until \`nahel handback\`.
- **Everything is conversational.** Every workflow can be driven through pure conversation — slash commands are conveniences, never the only door.
`;

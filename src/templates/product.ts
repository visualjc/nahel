/**
 * PRODUCT.md template — the constitution skeleton `nahel init` emits (PRD F2).
 * Mirrors the blessed constitution structure: Goal, Domain facts, Hard
 * constraints, Non-goals, Governance, Change log — as placeholder guidance.
 *
 * FROZEN CONTRACT: `nahel brief` (PRD F7) extracts the `## Goal` and
 * `## Hard constraints` sections VERBATIM by heading convention. The two
 * heading constants below define that convention — never reword them.
 */

/** Frozen heading `brief` extracts verbatim (PRD F7). */
export const GOAL_HEADING = "## Goal";

/** Frozen heading `brief` extracts verbatim (PRD F7). */
export const HARD_CONSTRAINTS_HEADING = "## Hard constraints";

/**
 * Render the constitution skeleton. `date` (YYYY-MM-DD, from the injected
 * clock) stamps the seed change-log entry.
 */
export function productTemplate(date: string): string {
  return `# <Project> — Product Constitution

> This is the constitution: human-owned, immutable without the maintainer's explicit sign-off, in every governance mode. Agents may propose amendments as observations; they may never edit this file autonomously.

${GOAL_HEADING}

<One paragraph: what this project makes possible, for whom, and the bar for "done right". \`nahel brief\` quotes this section verbatim to onboard fresh agents — write it to stand alone.>

## Domain facts

<Stable truths about the domain that constrain every design — the facts an agent must know to act correctly.>

- <First domain fact.>

${HARD_CONSTRAINTS_HEADING}

<Numbered, testable constraints no run may violate. \`nahel brief\` quotes this section verbatim — keep each constraint self-contained.>

1. <First hard constraint.>

## Non-goals

<What this project deliberately is NOT. Non-goals prevent scope creep more reliably than goals prevent drift.>

- <First non-goal.>

## Governance

\`\`\`yaml
governance:
  product: human        # <who owns product decisions>
  architecture: human   # <who owns architecture decisions>
\`\`\`

## Change log

Every change to this document is recorded here with the human sign-off that authorized it. Agents never edit this file autonomously: amendments are proposed as observations and applied only with the maintainer's recorded sign-off.

- **${date}** — Skeleton scaffolded by \`nahel init\`; awaiting the maintainer's first review and sign-off.
`;
}

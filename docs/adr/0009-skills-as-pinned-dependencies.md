# ADR-0009: External skills are pinned dependencies

Status: accepted · Date: 2026-07-15 · Source: founding grilling session

## Context

Workflows depend on third-party skills (Matt Pocock's diagnosing-bugs, tdd, grilling, domain-modeling; heavier tools like codegraph and Understand-Anything). Unmanaged symlinks make behavior vary by machine — poison for a system whose thesis is reproducible state across tools.

## Decision

`skills.yaml` declares `{repo, ref (pinned), use: [...], kind}`; a lockfile records exact versions. v1 is dumb clone-and-symlink, delegating fetch/placement to the existing `skills` CLI ecosystem where possible. `kind: markdown` (clone/symlink) vs `kind: tool` (declared install command + `nahel doctor` healthcheck; generated artifacts are environment, gitignored). Every skill-invoking workflow carries a one-paragraph inline fallback.

## Consequences

"Works from OpenClaw on Wednesday" holds for skills, not just state. No registry ambitions unless the ecosystem demands one.

# ADR-0009: External skills are pinned dependencies

Status: accepted · Date: 2026-07-15 · Source: founding grilling session

## Context

Workflows depend on third-party skills (Matt Pocock's diagnosing-bugs, tdd, grilling, domain-modeling; heavier tools like codegraph and Understand-Anything). Unmanaged symlinks make behavior vary by machine — poison for a system whose thesis is reproducible state across tools.

## Decision

`skills.yaml` declares `{repo, ref (pinned), use: [...], kind}`; a lockfile records exact versions. v1 is dumb clone-and-symlink, delegating fetch/placement to the existing `skills` CLI ecosystem where possible. `kind: markdown` (clone/symlink) vs `kind: tool` (declared install command + `nahel doctor` healthcheck; generated artifacts are environment, gitignored). Every skill-invoking workflow carries a one-paragraph inline fallback.

## Consequences

"Works from OpenClaw on Wednesday" holds for skills, not just state. No registry ambitions unless the ecosystem demands one.

## Amendment — 2026-08-05: the external `skills` CLI delegation is dropped

Status: accepted · Source: planning-partner D6/F7 (vendoring `grilling` + `domain-modeling`)

The original decision said "delegating fetch/placement to the existing `skills` CLI ecosystem **where possible**". Vendoring the first real skills forced the question of whether it *is* possible. It is not, so the clause is spent: clone-and-symlink is now the one and only placement path, and `restoreViaSkillsCli`/`skillsCliPath` are deleted.

**Why.** The current upstream CLI (vercel-labs/skills, verified against its README on 2026-08-05) accepts `skills add <source>` with `--skill <name>` selection and `-y`/`-a` for non-interactive runs. Its source formats are a repo shorthand, a git/GitLab URL, a `tree/<branch>/<path>` URL, a local path, or a direct download URL — **none of which name a commit**. The `@` suffix that our old invocation exploited (`skills add <url>@<sha>`) does not mean a ref at all: upstream reads `<source>@<name>` as a *skill-name* selector, so our call was already wrong, and would silently ask for a skill named after a SHA.

That single gap is decisive, because a lockfile that cannot be honored is worse than no lockfile: `skills.lock` would claim an exact commit while the CLI placed whatever the default branch pointed at that morning. Two secondary mismatches point the same way — the CLI symlinks into a canonical copy directory it owns rather than our SHA-keyed `.nahel-skills/<sha>` cache, and it decides which agent directories to write; so *which tool happened to be installed* would decide what a restore produced. Delegation was meant to buy ecosystem leverage; here it buys a reproducibility hole. `git clone --no-checkout` + `checkout <sha>` costs us ~30 lines and pins exactly what the lock says.

**Consequences.** One restore path, so the tested path is the shipped path on every machine — the tests that existed only to keep the two paths placing skills in the same directory are gone with the second path. We lose the CLI's richer discovery (its multi-level catalog walk, `--list`, agent fan-out); the locator absorbs the part we actually needed, searching the repo root, `skills/`, and one category level, and refusing rather than guessing when a name appears under two categories. Revisit only if upstream gains commit pinning: the manifest/lock shape already carries everything such a delegation would need.

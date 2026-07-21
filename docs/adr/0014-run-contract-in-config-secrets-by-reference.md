# 0014 — Run contract lives in nahel/config; secrets by reference only

Date: 2026-07-21
Status: accepted

## Context

The run contract (how to launch, seed, and test the app — prerequisite for QA
and any cold-start execution) needs a committed home. The roadmap sketch
included "test credentials", but all nahel state is committed to git, so the
contract can never hold secret values. Alternatives considered: a separate
`nahel/contract` file (second config surface), or reusing per-agent launcher
conventions like `.claude/launch.json` (constitution: per-agent dirs are
tooling-only, never state).

## Decision

The run contract is a `contract` section of the existing schema-validated
`nahel/config`: launch/seed/test/healthcheck commands, ports, and the *names*
of required environment variables. Secret values live in gitignored local env
files; the contract names them, and `nahel doctor` verifies they are set,
never reads or records their values.

## Consequences

- One config file, one schema, no new record type.
- The contract is portable and safe to publish; a clone plus a filled .env is
  a runnable environment.
- `nahel doctor` failures distinguish "contract missing" (autonomy-gated)
  from "env incomplete" (this machine isn't set up).
- Anything that would tempt a secret value into committed state must instead
  become a named env var — this is a hard rule, not a convention.

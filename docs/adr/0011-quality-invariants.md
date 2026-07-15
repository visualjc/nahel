# ADR-0011: Non-negotiable quality invariants for autonomous runs

Status: accepted · Date: 2026-07-15 · Source: founding grilling session + yolo-afk-dev hard rules

## Context

Autonomous agents route around soft rules ("I couldn't repro it" is the easiest excuse in software). Invariants must be structural, visible, and cheap to audit.

## Decision

1. **Repro before fix**: a bug fix requires a failing test reproducing the bug; the only escape is a logged `repro-waived: <reason>` observation, surfaced in the PR body and briefings, valid only when the investigation documents failed repro attempts.
2. **Prototypes never merge**: prototype branches are terminal; promotion = mini-PRD → feature lane re-implementation with the prototype as reference.
3. **Verify-by-driving**: every AFK run satisfies the run contract, launches the app, and exercises the changed flow before its draft PR opens. No lane skips it.
4. **QA ratchet**: exploratory agentic judgment is spent once per flow, then captured as deterministic e2e tests that run in CI forever.
5. **Humans merge**: autonomous runs end at draft PRs. Never weaken tests or revert feature code to go green.

## Consequences

Every quality shortcut is either impossible or loudly visible. Some waste (rebuilding a good prototype properly, failed repro harness attempts) is accepted as the price of invariants meaning anything.

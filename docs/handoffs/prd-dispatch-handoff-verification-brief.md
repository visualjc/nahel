# Verification brief — PRD dispatch-handoff-documents

You are the cross-vendor verifier for a PRD before it is approved for build.
Repo: nahel, a Bun/TypeScript CLI for durable project state.

## Read

1. `docs/prds/dispatch-handoff-documents.md` — the PRD under verification.
2. `src/dispatch/invocation.ts` — current invocation composition (the code F1/F3 change).
3. Skim `src/commands/dispatch.ts` — the dispatch flow (startRun → compose → journal → spawn → journal end) enough to judge feasibility.

## Check

1. **Internal consistency** — do the functional requirements contradict each other or the stated non-goals?
2. **Feasibility** — is anything required that the current dispatch flow cannot support without unstated extra work?
3. **Testability** — is each acceptance criterion checkable by a bun test?
4. **Completeness** — does the exit test actually prove the goal?

Do NOT restyle or expand scope; flag only real defects.

## Output

Findings as short bullets, then exactly one final line:
`VERDICT: approve | revise — <one sentence>`

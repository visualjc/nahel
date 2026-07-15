# ADR-0001: TypeScript on Bun for the CLI

Status: accepted · Date: 2026-07-15 · Source: founding grilling session

## Context

The CLI is 90% file I/O and YAML/JSON handling. Target users run AI CLI agents, so a JS runtime is ambient. Provider SDKs (GitHub, Linear) are strongest in JS. Rust/Go buy performance this tool doesn't need at the cost of iteration speed.

## Decision

TypeScript, developed on Bun. Dual distribution: npm package + `bun build --compile` standalone binaries, so the runtime is never a hard requirement for users.

## Consequences

Fastest iteration (including for agents writing the code); npm ecosystem for provider SDKs; CI cross-compiles release binaries. Go remains the documented runner-up if Windows or single-binary concerns ever dominate.

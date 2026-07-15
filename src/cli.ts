#!/usr/bin/env bun
// nahel — deterministic CLI for the Nahel state model.
// Pre-alpha placeholder: real commands arrive with the Phase 0 state schema (see docs/roadmap.md).

export const VERSION = "0.0.1";

if (import.meta.main) {
  const [cmd] = Bun.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(`nahel ${VERSION}`);
  } else {
    console.log(
      `nahel ${VERSION} — pre-alpha. State schema and commands land in Phase 0 (docs/roadmap.md).`,
    );
  }
}

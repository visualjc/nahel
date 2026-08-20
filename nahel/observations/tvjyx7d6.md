---
id: tvjyx7d6
name: codex-exec-hang-signatures
created: 2026-08-20T20:32:00Z
tags:
  - codex
  - dispatch
  - hang
  - field-evidence
  - liveness
sources:
  - nt93edc0
  - 1xj1v0ac
  - kp74t3wh
---
codex exec hangs in two distinct ways, both showing the same signature: ~0.0% CPU flatline and an empty output file (codex buffers all output until the final flush, so CPU time is the honest liveness signal, never the output file). Cause 1: an oversized inline prompt (mega-prompt in argv) — fixed by the handoff-document pattern, a one-line pointer prompt to a brief file; the pointer re-dispatch of an identical task answered in one round where the inline form hung 10+ minutes. Cause 2: detached stdin (spawning backgrounded/daemonized) — even a short prompt hangs; fixed by redirecting stdin from /dev/null or keeping the spawn foreground. nahel's own spawnDispatch path runs codex fine.

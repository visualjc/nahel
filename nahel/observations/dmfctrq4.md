---
id: dmfctrq4
name: agent-cli-stdin-must-be-closed
created: 2026-07-29T04:19:34Z
tags:
  - dispatch
  - codex
  - stdin
  - spawn
  - evqagdsd
sources:
  - d33zv72j
  - tnzrpge1
  - 7cv01pdg
  - te1rsgxa
---
Non-interactive agent CLIs must be spawned with stdin explicitly closed (/dev/null): codex exec blocks forever reading an open pipe nobody writes or closes (dispatch.started then silence — the evqagdsd hang), and claude -p only survives the same shape via its own 3-second stdin timeout. nahel dispatch now closes worker stdin, gives the worker its own process group, and journals signal deaths so every dispatch bracket closes. The lesson recurred with DIRECT spawns from a harness shell (codex wedged 25+ min, instant with </dev/null) — it is universal, not dispatch-specific.

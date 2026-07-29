---
id: h5qk51mx
name: rotation-archive-ownership-lock
created: 2026-07-29T04:19:52Z
tags:
  - rotation
  - journal
  - append-only
  - locking
  - 7nzsz577
sources:
  - g7e5e0cm
  - 195a80sh
---
Journal rotation destroyed append-only history once (HC6): rename() into the archive silently overwrote an existing same-name segment — a late note on an archived run clobbered 10 notes on speed-count-game. Fixed in PR #19 through a 3-round adversarial codex loop: no-clobber link-based archiving (collision copies get .N suffixes, distillable), and the sweep serialized by an ownership-safe mkdir lock — holder writes a pid marker, staleness is process LIVENESS not a clock, a steal can only remove a dead holder's marker. Two designs were PROVEN wrong first under 24-writer contention: lock-free link/unlink dedup (leaked duplicates ~50%) and time-based steal (all timed-out waiters cleared each other's lock: 43 archives, 38 duplicate ids). Codex's repro is a permanent e2e test.

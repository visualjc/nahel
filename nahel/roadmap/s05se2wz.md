---
id: s05se2wz
name: subcommand-help
kind: feature
horizon: later
parent: kyeb086y
adrs: []
features: []
created: 2026-08-06T19:08:39Z
updated: 2026-08-06T19:08:39Z
---
Every nahel verb answers --help/-h with its usage as a SUCCESS (exit 0), not as an unknown-option refusal — the universal CLI convention agents probe first. Today the usage prints only under an error banner with a nonzero exit. Observed in the wild: a Devin agent's first act against a nahel store was 'nahel log --help' during the PR #27 review (2026-08-05).

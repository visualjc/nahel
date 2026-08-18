---
id: s05se2wz
name: subcommand-help
kind: feature
horizon: next
parent: kyeb086y
adrs: []
features: []
created: 2026-08-06T19:08:39Z
updated: 2026-08-13T20:36:14Z
---
Every nahel verb answers --help/-h with its usage as a SUCCESS (exit 0), not as an unknown-option refusal — the universal CLI convention agents probe first. Today the usage prints only under an error banner with a nonzero exit. Observed in the wild: a Devin agent's first act against a nahel store was 'nahel log --help' during the PR #27 review (2026-08-05). The help surface must also be self-describing: the top-level 'nahel --help' tells the reader that each verb answers its own --help, and each verb's help states its flags and the accepted forms of their values (e.g. --since takes 7d, 24h or an ISO timestamp) — so an agent can reach detailed help from the entry point without guessing.

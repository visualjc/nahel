---
id: 6smbx2vy
name: skills-network-exception
created: 2026-07-25T15:42:22Z
tags:
  - skills
  - determinism
  - constraints
  - design
sources:
  - vmtqgqf5
---
Design call on Hard constraint 1 (CLI determinism): nahel skills lock/restore MAY touch the network because they are environment setup (delegating to the skills CLI, clone+symlink fallback), while core operations stay deterministic and offline. Skills drift warnings are pure/offline. use-list drift is deliberately unflagged (spec-literal).

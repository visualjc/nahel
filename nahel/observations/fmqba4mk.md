---
id: fmqba4mk
name: release-ritual-version-and-reinstall
created: 2026-07-29T04:20:06Z
tags:
  - release
  - versioning
  - install
sources:
  - z88fr0rb
  - te1rsgxa
  - 9f7secf6
---
Merge ritual for nahel main (Jim, 2026-07-28): bump the semver version — package.json is the ONLY place since PR #18 made src/cli.ts import it — then bun run install:local and verify nahel --version plus a real-store read. Reason: the installed binary is a compiled snapshot; a stale one rejects new config keys with unrecognized_keys errors, which forced a session-long shim workaround during Phase 2.

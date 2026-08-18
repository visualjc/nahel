---
id: b6wrf34n
name: e2e-binary-install-isolation
created: 2026-08-18T00:29:52Z
tags:
  - testing
  - e2e
  - binary
  - isolation
sources:
  - rtktathm
  - 2xn2fj88
  - 4pgmfnap
  - 6wft71j2
  - 9mqeb8t0
---
Until PR #34 the binary-install E2E ran 'bun run install:local' on every full-suite run, overwriting the developer's own ~/.local/bin/nahel and making concurrent suites fight over one artifact path. The fix: build-binary honors NAHEL_DIST_DIR (repo dist/ stays the default) alongside the already-honored NAHEL_BIN_DIR, so the E2E builds and installs entirely under one temporary prefix. Verified by driving with both vars under a unique temp prefix, observing separate build and installed artifacts.

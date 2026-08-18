---
id: 4ya5pse8
name: dispatch-pgid-test-env-failure
created: 2026-08-18T00:29:34Z
tags:
  - testing
  - sandbox
  - flake
  - dispatch
sources:
  - 3ecwan7x
  - fznqy69s
  - v3zkqp5c
---
tests/store/dispatch.test.ts:149 fails 11-pass/1-fail in sandboxed environments because the stub prints 'pid=<pid> pgid=' with an empty process group while the assertion requires a numeric pgid — the sandbox denies process-group access, not a code defect. It is tracked as bug item 6hpzv8za and reproduces consistently, so full-suite runs during 2026-08 legitimately report '2276 pass with only the tracked 6hpzv8za failure'. Runs needing real coverage of it must execute outside the sandbox.

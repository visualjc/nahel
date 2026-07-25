---
id: abk60mdz
name: root-cause-test-baseline-grep-under-set-e
created: 2026-07-25T16:17:48Z
tags:
  - root-cause
  - bash
  - set-e
  - yolo-scripts
sources:
  - hejkc6sm
item: 0k83q678
---
yolo test scripts (test-baseline.sh, test-current.sh) aborted before writing their output JSON exactly on fully green test runs: the failure-extraction grep exits 1 on zero matches, and under set -euo pipefail a failing command substitution in a plain assignment kills the script. The deliberate set +e window covered only the test command itself, not the extraction. Fixed by wrapping the grep in { ... || true; } at both assignment sites. Heredoc substitution sites are immune (exit status discarded — confirmed against a reviewer challenge by execution). Shipped in PR #14; adjacent unescaped-$TEST_CMD JSON defect filed as b5e07bmt.

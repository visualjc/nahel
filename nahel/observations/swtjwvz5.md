---
id: swtjwvz5
name: root-cause-docs-log-note-body-key
created: 2026-07-25T19:27:29Z
tags: []
sources:
  - 97ahjzev
item: rgm43hvc
---
Feature-lane workflow docs (bf34d52, 2026-07-21) taught 'nahel log note --data body=' three days after 3249203 (2026-07-18) reserved body (with target/record, MUTATION_PAYLOAD_KEYS) from nahel log — the docs were born broken, and no test scanned doc examples against the CLI's reserved keys. Fixed to --data summary= (the journaled-note convention) with a MUTATION_PAYLOAD_KEYS-driven sweep over every shipped doc in nahel/workflows/.

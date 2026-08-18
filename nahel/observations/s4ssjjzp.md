---
id: s4ssjjzp
name: journal-duplicate-seq-blocks-afk
created: 2026-08-18T00:29:07Z
tags:
  - journal
  - integrity
  - afk
  - append-only
sources:
  - eh92n5hy
  - 9yz58b9z
  - z41cw6vg
  - 5kdfgp3p
  - vs389mzy
---
A corrupt journal segment stops AFK work at the validation gate: live segment run-gyhmmwnt carried a duplicate seq=3, and the Decision Digest run refused to dispatch the CLI/render leaf until it was repaired, even though the dependency's own code was green (28/28 focused, typecheck, drive). Because the journal is append-only the repair is not an edit — the two lost finalization facts were restored by an authorized transcript reconstruction that appended fresh agent-attributed events (1jjktvgx, bta1zjbb). The same principle governs reads: duplicate event ids are excluded from the Decision Digest proof index so an affected row degrades to [incomplete] rather than silently picking one event.

---
id: zw2hajfq
name: decision-zf0n1nbp
created: 2026-08-09T00:00:55Z
tags:
  - decision
  - research
sources:
  - zgpwg0b1
  - qknya00f
  - wxmx5xby
---
A newest-N ring keeps retained rows bounded, but current journal reads still scan lifetime history and scale with segment fan-out.

Decided by resolving research ticket zf0n1nbp, charting: A human can scan every map decision in one deterministic, read-only store-wide ledger, filter it by time, actor, provenance, or map, and zoom from each row to the canonical ticket, map, and cited source records.

Question:
What is the read-cost envelope for a store-wide decision ledger, and can it stay streaming rather than loading the lifetime journal?

Rationale:
The live store is small in bytes and events but highly fragmented: 1,267 events, 504,127 bytes, and 635 active/archive segments. Direct reads completed in roughly 80-83ms; CLI startup plus rendering path was roughly 0.15s. The ring limit did not materially change observed time or RSS because readJournal opens every segment and scans every event before newest-N is known. Synthetic measurements showed both dimensions: 2,000 two-event segments reached about 313ms and 156MB observed RSS growth; 100,000 events reached about 407ms at 100 segments and 1.20s at 500 segments. Streaming is still the correct v1 shape because it avoids retaining lifetime rows, matching Bun and Node guidance, but it is bounded by O(N) only at the collector; the current merge has lifetime I/O, one 64KiB buffer/head per segment, and linear head selection across segments. For the still-human default-invocation ticket jfj0hpre, the evidence-backed recommendation is a capped newest slice of 10: modeled against current decisions it is about 3.1KB before provenance and footer, versus 5.2KB for 15 and 7.2KB for 20, best matching compact-first/query-more. Ten is a presentation/context default, not a performance guard or byte guarantee; long decision one-liners can exceed it, and --limit/--since cannot make the existing forward merge skip old bytes. Large-store indexing, reverse selection, or a better heap merge remains outside this first measured boundary rather than silently promised by the cap.

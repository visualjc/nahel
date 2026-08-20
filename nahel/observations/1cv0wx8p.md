---
id: 1cv0wx8p
name: result-doc-nonstrict-asymmetry
created: 2026-08-20T20:32:21Z
tags:
  - result-doc
  - schema
  - zod
  - design
  - anti-drift
sources:
  - h00hb6az
  - 99k80tk5
  - pmwf579x
---
The result-document schema (src/store/result.ts) is deliberately z.object NON-strict while every other record schema in the store is strictObject: records nahel writes are strict so field typos surface, but a result doc is authored by a worker nahel does not control, and rejecting it for an extra key (tokens_used, model) would throw away a good result — unknown keys are tolerated, the four required keys enforced exactly. Companion anti-drift design: RESULT_DOC_CONTRACT is a const beside the schema, interpolating the filename and status enum, embedded VERBATIM into the dispatch pointer prompt — prompt and parser are one source, and tests fail together if either moves. Future reviewers must not 'fix' the non-strictness.

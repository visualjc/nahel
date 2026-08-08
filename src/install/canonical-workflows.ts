import afkRunDoc from "../../nahel/workflows/afk-run.md" with { type: "text" };
import briefDoc from "../../nahel/workflows/brief.md" with { type: "text" };
import bugLaneDoc from "../../nahel/workflows/bug-lane.md" with { type: "text" };
import chartMapDoc from "../../nahel/workflows/chart-map.md" with { type: "text" };
import compactDoc from "../../nahel/workflows/compact.md" with { type: "text" };
import epicDecomposeDoc from "../../nahel/workflows/epic-decompose.md" with { type: "text" };
import inceptionDoc from "../../nahel/workflows/inception.md" with { type: "text" };
import migrateRoadmapDoc from "../../nahel/workflows/migrate-roadmap.md" with { type: "text" };
import planFrontierDoc from "../../nahel/workflows/plan-frontier.md" with { type: "text" };
import planDoc from "../../nahel/workflows/plan.md" with { type: "text" };
import prdNewDoc from "../../nahel/workflows/prd-new.md" with { type: "text" };
import prdParseDoc from "../../nahel/workflows/prd-parse.md" with { type: "text" };
import prototypeLaneDoc from "../../nahel/workflows/prototype-lane.md" with { type: "text" };
import qaLaneDoc from "../../nahel/workflows/qa-lane.md" with { type: "text" };
import reviewLoopDoc from "../../nahel/workflows/review-loop.md" with { type: "text" };
import setupRoutingDoc from "../../nahel/workflows/setup-routing.md" with { type: "text" };
import taskLifecycleDoc from "../../nahel/workflows/task-lifecycle.md" with { type: "text" };
import workMapDoc from "../../nahel/workflows/work-map.md" with { type: "text" };

/**
 * The canonical workflow docs, EMBEDDED at build time (bug mcm4ak0e).
 *
 * `nahel install` shims whatever sits in a store's `nahel/workflows/`, so a
 * store that never received those docs can install nothing — which is exactly
 * what the README quickstart hit in every repo except this one. The docs
 * therefore travel INSIDE the binary, and `nahel init` writes them into each
 * store it scaffolds.
 *
 * The mechanism is one static text import per doc: Bun resolves `with { type:
 * "text" }` imports to the file's contents and INLINES them into the module
 * graph, so the bodies survive `bun build --compile` as string constants and
 * resolve identically under `bun test` and `bun run src/cli.ts`. Nothing is
 * read at runtime — a compiled binary has no checkout to read from, and a path
 * derived from `import.meta.dir` would point at a directory that does not exist
 * on the consumer's machine.
 *
 * The import list is hand-maintained and `tests/repo/canonical-workflows.test.ts`
 * is what keeps it honest: it lists nahel/workflows/ on disk and fails when the
 * embedded set differs by so much as one doc. Adding a workflow means adding
 * its import here — the suite says so out loud, instead of shipping stores that
 * quietly lack it.
 */

/** One embedded doc: its slug (the file stem, which is also the shim name) and its bytes. */
export interface CanonicalWorkflow {
  name: string;
  body: string;
}

/** Every canonical workflow doc, in file-name order. */
export const CANONICAL_WORKFLOWS: ReadonlyArray<CanonicalWorkflow> = [
  { name: "afk-run", body: afkRunDoc },
  { name: "brief", body: briefDoc },
  { name: "bug-lane", body: bugLaneDoc },
  { name: "chart-map", body: chartMapDoc },
  { name: "compact", body: compactDoc },
  { name: "epic-decompose", body: epicDecomposeDoc },
  { name: "inception", body: inceptionDoc },
  { name: "migrate-roadmap", body: migrateRoadmapDoc },
  { name: "plan-frontier", body: planFrontierDoc },
  { name: "plan", body: planDoc },
  { name: "prd-new", body: prdNewDoc },
  { name: "prd-parse", body: prdParseDoc },
  { name: "prototype-lane", body: prototypeLaneDoc },
  { name: "qa-lane", body: qaLaneDoc },
  { name: "review-loop", body: reviewLoopDoc },
  { name: "setup-routing", body: setupRoutingDoc },
  { name: "task-lifecycle", body: taskLifecycleDoc },
  { name: "work-map", body: workMapDoc },
];

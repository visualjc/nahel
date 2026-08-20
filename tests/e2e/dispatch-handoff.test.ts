import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

/**
 * PRD dispatch-handoff-documents — the EXIT TEST, verbatim:
 *
 *   An end-to-end bun test drives the real CLI against a scratch store with a
 *   stub agent binary: dispatch a task large enough that inlining it would
 *   have produced a multi-hundred-KB argv. Prove: (1) the spawned argv's final
 *   argument is the bounded pointer prompt, (2) `nahel/runs/<run-id>/task.md`
 *   holds the full task with correct frontmatter, (3) the stub worker —
 *   reading only its prompt — locates task.md and writes a conforming
 *   result.md, (4) the journal's start/end events carry the two paths and no
 *   task content, (5) `nahel validate` passes with the new run dir present and
 *   flags a deliberately malformed result.md.
 *
 * Focused tests own each rule in isolation (tests/dispatch/handoff.test.ts,
 * tests/dispatch/invocation.test.ts, tests/commands/dispatch.test.ts,
 * tests/validate/). This file owns their COMPOSITION through the shipped
 * binary: one dispatch, one worker, one journal, one validate.
 *
 * E2E CONSTRAINT (tests/e2e/journey.test.ts's rule): state is advanced only
 * through child-process invocations of the real CLI — zero imports from src/.
 * Files under `nahel/` are READ as committed artifacts (the store's own
 * on-disk format is the contract a worker and a reviewer both read), and the
 * only file written by hand is `result.md`, which nahel never authors — a
 * dispatched worker does, and step 5 needs a worker that got it wrong.
 */

const CLI = join(import.meta.dir, "../../src/cli.ts");

/**
 * The prompt bound the feature exists to hold, shared verbatim with
 * tests/dispatch/invocation.test.ts and tests/commands/dispatch.test.ts:
 * comfortably above the composed pointer prompt and far below anything an
 * argv limit or a hung codex cares about. The task's size must not move it.
 */
const PROMPT_BYTE_BOUND = 4096;

/**
 * A string that appears in the dispatched task and NOWHERE else — not in the
 * prompt, not in the journal, not in any nahel-authored record. Step 4's
 * "no task content" is proved by hunting for it.
 */
const SENTINEL = "SENTINEL-b0kz7pzd-task-body-8w4qz";

/**
 * The pathological brief: 320 KB, the shape that hung codex when it travelled
 * in argv (journal nt93edc0). Sentinel-bracketed so a truncating handoff is
 * caught at either end, not just by a byte count.
 */
const HUGE_TASK = `${SENTINEL}-begin\n${"x".repeat(320_000)}\n${SENTINEL}-end\n`;

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn the real CLI in `cwd` as the DISPATCHER; echo the exchange for debugging. */
function nahel(cwd: string, ...args: string[]): CliResult {
  const result = spawnSync("bun", ["run", CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NAHEL_ACTOR: "agent:handoff-dispatcher" },
  });
  const output = { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  console.log(
    `$ nahel ${args.map((arg) => (arg.length > 80 ? `${arg.slice(0, 80)}…` : arg)).join(" ")}` +
      `\n  exit ${output.code}` +
      (output.stdout.trim() === "" ? "" : `\n  stdout: ${output.stdout.trim()}`) +
      (output.stderr.trim() === "" ? "" : `\n  stderr: ${output.stderr.trim()}`),
  );
  return output;
}

/** Assert success loudly — failures carry the full CLI exchange. */
function ok(result: CliResult, what: string): CliResult {
  if (result.code !== 0) {
    throw new Error(`${what} failed (exit ${result.code}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

/** Split a frontmatter document the way every reader of the store's files does. */
function splitFrontmatter(doc: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!doc.startsWith("---\n")) {
    throw new Error(`document has no frontmatter fence: ${doc.slice(0, 40)}`);
  }
  const close = doc.indexOf("\n---\n", 3);
  if (close === -1) throw new Error("frontmatter fence is never closed");
  return {
    frontmatter: YAML.parse(doc.slice(4, close + 1)) as Record<string, unknown>,
    body: doc.slice(close + 5),
  };
}

/** Every journal line the store has written, active segments and archive alike. */
async function journalEvents(root: string): Promise<Record<string, unknown>[]> {
  const dirs = [join(root, "nahel", "journal"), join(root, "nahel", "journal", "archive")];
  const events: Record<string, unknown>[] = [];
  for (const dir of dirs) {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.endsWith(".jsonl")) continue;
      const text = await readFile(join(dir, name), "utf8");
      for (const line of text.split("\n")) {
        if (line.trim() !== "") events.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  }
  return events;
}

/** Content-addressed comparison: a 320 KB `toBe` diff helps nobody. */
function digest(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text, "utf8").digest("hex");
}

/**
 * What the stub agent binary reports back about the handoff it was handed.
 * Every path in here was parsed OUT OF THE PROMPT by the worker itself — the
 * stub has no task path, no result path, and no item id baked into it. That is
 * the point of step 3: a worker following only its prompt finds everything.
 */
interface WorkerReport {
  argv: string[];
  actor: string | null;
  cwd: string;
  taskPathFromPrompt: string;
  resultPathFromPrompt: string;
  runFromPrompt: string;
  itemFromTaskDoc: string;
  runFromTaskDoc: string;
  taskBytes: number;
  taskDigest: string;
  sawBegin: boolean;
  sawEnd: boolean;
}

/**
 * The stub agent CLI: the one thing a real deployment supplies that this test
 * cannot (no agent CLI runs offline). Everything else — routing, composition,
 * spawn, journal, validate — is the shipped code path.
 *
 * The stub behaves like a compliant worker: read the prompt's LAST argv entry,
 * find the two document paths in its prose, read the task, prove it is whole,
 * and write the result document where the prompt said. It exits non-zero the
 * moment the handoff fails it, so a broken pointer surfaces as a failed
 * dispatch rather than a silently weaker assertion.
 */
function stubSource(recordPath: string): string {
  return [
    "#!/usr/bin/env bun",
    'import { readFileSync, writeFileSync } from "node:fs";',
    "const argv = Bun.argv.slice(2);",
    "const prompt = argv[argv.length - 1] ?? '';",
    // Nothing but the prompt: the paths are parsed out of its prose.
    "const taskPath = /nahel\\/runs\\/[0-9a-z]{8}\\/task\\.md/.exec(prompt)?.[0];",
    "const resultMatch = /nahel\\/runs\\/([0-9a-z]{8})\\/result\\.md/.exec(prompt);",
    "if (taskPath === undefined || resultMatch === null) {",
    "  console.error('prompt named no task/result document');",
    "  process.exit(92);",
    "}",
    "const doc = readFileSync(taskPath, 'utf8');",
    "const close = doc.indexOf('\\n---\\n', 3);",
    "if (!doc.startsWith('---\\n') || close === -1) {",
    "  console.error('task document has no frontmatter');",
    "  process.exit(93);",
    "}",
    "const head = doc.slice(4, close + 1);",
    "const field = (key) => new RegExp('^' + key + ': (.*)$', 'm').exec(head)?.[1] ?? '';",
    "const task = doc.slice(close + 5);",
    `const sawBegin = task.startsWith(${JSON.stringify(`${SENTINEL}-begin`)});`,
    `const sawEnd = task.trimEnd().endsWith(${JSON.stringify(`${SENTINEL}-end`)});`,
    "const hash = new Bun.CryptoHasher('sha256').update(task, 'utf8').digest('hex');",
    `writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
    "  argv,",
    "  actor: process.env.NAHEL_ACTOR ?? null,",
    "  cwd: process.cwd(),",
    "  taskPathFromPrompt: taskPath,",
    "  resultPathFromPrompt: resultMatch[0],",
    "  runFromPrompt: resultMatch[1],",
    "  itemFromTaskDoc: field('item'),",
    "  runFromTaskDoc: field('run'),",
    "  taskBytes: Buffer.byteLength(task, 'utf8'),",
    "  taskDigest: hash,",
    "  sawBegin,",
    "  sawEnd,",
    "}, null, 2));",
    // A worker that did NOT get its whole brief must not report success.
    "if (!sawBegin || !sawEnd) {",
    "  console.error('task document was truncated');",
    "  process.exit(94);",
    "}",
    // The result document: the ids come from the task doc it just read, and
    // the destination from the prompt — the contract the prompt embedded.
    "writeFileSync(resultMatch[0], [",
    "  '---',",
    "  `run: ${field('run')}`,",
    "  `item: ${field('item')}`,",
    "  'status: success',",
    "  `summary: followed the pointer and read ${Buffer.byteLength(task, 'utf8')} bytes of task`,",
    "  '---',",
    "  '',",
    "  'Read the whole brief from the run dir and did the thing.',",
    "  '',",
    "].join('\\n'));",
    "process.exit(0);",
    "",
  ].join("\n");
}

describe("E2E dispatch handoff (PRD exit test) — a 320 KB brief travels as a document", () => {
  test(
    "pointer prompt → task.md → worker-written result.md → journaled paths → validate",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "nahel-handoff-"));
      tempDirs.push(root);
      git(root, "init", "--initial-branch=main");

      ok(nahel(root, "init"), "init");
      const itemId = ok(
        nahel(root, "item", "new", "feature", "handoff-target", "direct"),
        "item new",
      ).stdout.trim();
      expect(itemId).not.toBe("");

      // The stub agent binary, wired in exactly as a real deployment points
      // `claude` at its actual CLI: through config, through the public verb.
      const binDir = join(root, "bin");
      await mkdir(binDir, { recursive: true });
      const stubPath = join(binDir, "stub-agent");
      const recordPath = join(binDir, "worker-report.json");
      await writeFile(stubPath, stubSource(recordPath), "utf8");
      await chmod(stubPath, 0o755);
      ok(
        nahel(
          root,
          "config",
          "set",
          "routing",
          "--data",
          JSON.stringify({ implementation: { agent: "claude", model: "claude-opus-5" } }),
        ),
        "config set routing",
      );
      ok(
        nahel(
          root,
          "config",
          "set",
          "dispatch",
          "--data",
          JSON.stringify({
            claude: { binary: stubPath, args: ["-p"], model_flag: "--model" },
          }),
        ),
        "config set dispatch",
      );

      // The brief: 320 KB on disk, handed over by path. Inlined, this is the
      // multi-hundred-KB argv the feature exists to never build again.
      const briefPath = join(root, "huge-brief.md");
      await writeFile(briefPath, HUGE_TASK, "utf8");
      const briefBytes = Buffer.byteLength(HUGE_TASK, "utf8");
      console.log(`[brief] ${briefBytes} bytes, sha ${digest(HUGE_TASK)}`);
      expect(briefBytes).toBeGreaterThan(300_000);

      const before = Date.now();
      const dispatched = ok(
        nahel(root, "dispatch", "implementation", "--item", itemId, "--task-file", "huge-brief.md"),
        "dispatch",
      );
      expect(dispatched.stdout).toContain("dispatched implementation");

      const runIds = await readdir(join(root, "nahel", "runs"));
      expect(runIds).toHaveLength(1);
      const runId = runIds[0]!;
      const taskDocRel = `nahel/runs/${runId}/task.md`;
      const resultDocRel = `nahel/runs/${runId}/result.md`;

      // ---- (1) the spawned argv's final argument is the bounded pointer ----
      const report = JSON.parse(await readFile(recordPath, "utf8")) as WorkerReport;
      const prompt = report.argv.at(-1)!;
      const promptBytes = Buffer.byteLength(prompt, "utf8");
      const argvBytes = report.argv.reduce((sum, arg) => sum + Buffer.byteLength(arg, "utf8"), 0);
      console.log(`[argv] ${report.argv.length} args, ${argvBytes} bytes total`);
      console.log(`[prompt ${promptBytes}B]\n${prompt}`);
      expect(report.argv.slice(0, 3)).toEqual(["-p", "--model", "claude-opus-5"]);
      expect(promptBytes).toBeLessThan(PROMPT_BYTE_BOUND);
      // The WHOLE command line stays bounded, not just its last argument.
      expect(argvBytes).toBeLessThan(PROMPT_BYTE_BOUND);
      // It is a POINTER: it names both documents and contains no task at all.
      expect(prompt).toContain(taskDocRel);
      expect(prompt).toContain(resultDocRel);
      expect(prompt).not.toContain(SENTINEL);
      expect(prompt).not.toContain("xxxxxxxxxx");
      // The worker's own identity travelled in the environment, as always.
      expect(report.actor).toBe("agent:claude");

      // ---- (2) task.md holds the full task, byte-identical, framed right ----
      const taskDoc = await readFile(join(root, taskDocRel), "utf8");
      const { frontmatter, body } = splitFrontmatter(taskDoc);
      console.log("[task.md frontmatter]", JSON.stringify(frontmatter));
      console.log(`[task.md] doc=${taskDoc.length}B body=${body.length}B sha ${digest(body)}`);
      expect(Object.keys(frontmatter).sort()).toEqual(["created", "item", "responsibility", "run"]);
      expect(frontmatter["run"]).toBe(runId);
      expect(frontmatter["item"]).toBe(itemId);
      expect(frontmatter["responsibility"]).toBe("implementation");
      const created = String(frontmatter["created"]);
      expect(created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(Date.parse(created)).toBeGreaterThanOrEqual(before - 60_000);
      // Byte fidelity, asserted by digest so a mismatch reports a hash, not
      // 320 KB of diff.
      expect(body.length).toBe(HUGE_TASK.length);
      expect(digest(body)).toBe(digest(HUGE_TASK));

      // ---- (3) the worker, told nothing but its prompt, found everything ----
      console.log(
        "[worker report]",
        JSON.stringify({ ...report, argv: `${report.argv.length} args` }, null, 2),
      );
      expect(report.taskPathFromPrompt).toBe(taskDocRel);
      expect(report.resultPathFromPrompt).toBe(resultDocRel);
      expect(report.runFromPrompt).toBe(runId);
      // Read out of the document it located, not out of its own argv.
      expect(report.runFromTaskDoc).toBe(runId);
      expect(report.itemFromTaskDoc).toBe(itemId);
      // It got the whole brief, both ends intact.
      expect(report.sawBegin).toBe(true);
      expect(report.sawEnd).toBe(true);
      expect(report.taskBytes).toBe(briefBytes);
      expect(report.taskDigest).toBe(digest(HUGE_TASK));
      // And it wrote a conforming result where the prompt said to.
      const resultDoc = await readFile(join(root, resultDocRel), "utf8");
      console.log("[result.md]\n" + resultDoc);
      const result = splitFrontmatter(resultDoc).frontmatter;
      expect(result["run"]).toBe(runId);
      expect(result["item"]).toBe(itemId);
      expect(result["status"]).toBe("success");
      expect(String(result["summary"])).not.toContain("\n");

      // ---- (4) the journal carries the two paths and no task content ----
      const events = await journalEvents(root);
      console.log("[journal]", events.map((event) => String(event["type"])).join(" "));
      const payloadOf = (type: string): Record<string, unknown> => {
        const event = events.find((candidate) => candidate["type"] === type);
        if (event === undefined) throw new Error(`no ${type} event in the journal`);
        return event["payload"] as Record<string, unknown>;
      };
      const started = payloadOf("dispatch.started");
      const ended = payloadOf("dispatch.ended");
      console.log("[dispatch.started]", started["task_doc"], "[ended]", ended["result_doc"]);
      expect(started["task_doc"]).toBe(taskDocRel);
      expect(ended["result_doc"]).toBe(resultDocRel);
      expect(ended["outcome"]).toBe("success");
      // Not one byte of the brief is in the journal — not in the recorded
      // invocation, not anywhere. The pointer is the whole record.
      const journalText = events.map((event) => JSON.stringify(event)).join("\n");
      console.log(`[journal bytes] ${journalText.length}`);
      expect(journalText).not.toContain(SENTINEL);
      expect(journalText).not.toContain("xxxxxxxxxx");

      // ---- (5) validate: silent on a conforming result, loud on a bad one ----
      const clean = nahel(root, "validate");
      expect(clean.code).toBe(0);
      // The run dir is present and its result document draws NO finding.
      expect(clean.stdout).not.toContain("run.result-doc");
      expect(clean.stdout).toContain("0 error(s)");

      // Corrupt it the way a worker gets it wrong: a status outside the enum.
      // result.md is the one file in the store nahel never authors, so writing
      // it by hand here is exactly the situation the check exists for.
      const corrupted = resultDoc.replace("status: success", "status: done");
      await writeFile(join(root, resultDocRel), corrupted);
      const flagged = nahel(root, "validate");
      console.log("[validate after corruption]\n" + flagged.stdout);
      // A worker's typo advises; it never breaks the repo's integrity gate.
      expect(flagged.code).toBe(0);
      expect(flagged.stdout).toContain("warning [run.result-doc]");
      expect(flagged.stdout).toContain(`run ${runId}`);
      expect(flagged.stdout).toContain(resultDocRel);
      expect(flagged.stdout).toContain("status");
      expect(flagged.stdout).toContain("0 error(s)");
    },
    { timeout: 180_000 },
  );
});

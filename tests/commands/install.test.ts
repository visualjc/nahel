import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandContext } from "../../src/cli";
import { installCommand } from "../../src/commands/install";
import { AGENT_TARGETS, KNOWN_AGENTS } from "../../src/install/agents";
import {
  parseWorkflowDoc,
  workflowFrontmatterSchema,
  type WorkflowDoc,
} from "../../src/install/workflow";
import { parseFrontmatter } from "../../src/store/frontmatter";
import {
  ensureLayout,
  listMarkdownDocs,
  removeFile,
  storeLayout,
  workflowsDir,
  writeConfig,
} from "../../src/store/layout";
import { makeConfig, makeTempDir, seededEnv } from "../store/helpers";

/**
 * `nahel install` (PRD F10, task #11): canonical workflow docs in
 * `nahel/workflows/*.md` (frontmatter: name/description/args) become 3-line
 * per-agent shims under the agent's command directory. Regeneration is
 * idempotent (same input → byte-identical output, stale shims removed);
 * unknown agents fail with the known-agent list; the agent table is a lookup
 * so later agents are additive (ADR-0005).
 */

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runInstall(args: string[], root: string): Promise<CommandResult> {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    env: seededEnv(),
    cwd: root,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  const code = await installCommand.run(args, ctx);
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

/** Initialized store root with a nahel/workflows directory. */
async function makeRepo(): Promise<string> {
  const root = await makeTempDir("nahel-install-");
  tempDirs.push(root);
  await writeConfig(await ensureLayout(root), makeConfig());
  await mkdir(workflowsDir(storeLayout(root)), { recursive: true });
  return root;
}

/** A canonical workflow doc body per the format spec (docs/workflow-format.md). */
function workflowDoc(name: string, description = `${name} workflow`, args = ""): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    `args: ${JSON.stringify(args)}`,
    "---",
    "",
    `# Workflow: ${name}`,
    "",
    `Run \`nahel ${name}\` and act on the output.`,
    "",
  ].join("\n");
}

async function writeWorkflow(root: string, file: string, content: string): Promise<void> {
  await writeFile(join(workflowsDir(storeLayout(root)), file), content, "utf8");
}

const shimDir = (root: string, prefix = "nd") => join(root, ".claude", "commands", prefix);

describe("workflow frontmatter format (PRD F10)", () => {
  test("accepts the canonical shape: slug name, description, args (possibly empty)", () => {
    const parsed = workflowFrontmatterSchema.parse({
      name: "brief",
      description: "Onboard onto the project",
      args: "",
    });
    expect(parsed).toEqual({ name: "brief", description: "Onboard onto the project", args: "" });
  });

  test("rejects a non-slug name, a missing field, and unknown keys — each with a reason", () => {
    for (const bad of [
      { name: "Not A Slug", description: "d", args: "" },
      { name: "brief", args: "" }, // missing description
      { name: "brief", description: "d" }, // missing args
      { name: "brief", description: "d", args: "", extra: true }, // unknown key
    ]) {
      const result = workflowFrontmatterSchema.safeParse(bad);
      expect(result.success).toBe(false);
    }
  });

  test("parseWorkflowDoc ties the doc to its file: frontmatter name must match the file stem", () => {
    const good = parseWorkflowDoc("brief.md", {
      name: "brief",
      description: "d",
      args: "",
    });
    expect(good.name).toBe("brief");
    expect(() =>
      parseWorkflowDoc("brief.md", { name: "other", description: "d", args: "" }),
    ).toThrow(/name/);
  });
});

describe("agent target lookup table (ADR-0005: later agents additive)", () => {
  test("claude is a known agent and the table drives KNOWN_AGENTS", () => {
    expect(AGENT_TARGETS["claude"]).toBeDefined();
    expect(KNOWN_AGENTS).toContain("claude");
    expect(KNOWN_AGENTS).toEqual(Object.keys(AGENT_TARGETS).sort());
  });

  test("claude shims live under .claude/commands/<prefix>", () => {
    expect(AGENT_TARGETS["claude"]!.shimDir("nd")).toBe(join(".claude", "commands", "nd"));
    expect(AGENT_TARGETS["claude"]!.shimDir("go")).toBe(join(".claude", "commands", "go"));
  });

  test("renderShim is deterministic, 3 lines of body, and points at the canonical doc", () => {
    const doc: WorkflowDoc = {
      frontmatter: { name: "brief", description: "Onboard onto the project", args: "" },
      path: "nahel/workflows/brief.md",
    };
    const first = AGENT_TARGETS["claude"]!.renderShim(doc);
    const second = AGENT_TARGETS["claude"]!.renderShim(doc);
    expect(first).toBe(second);
    const { frontmatter, body } = parseFrontmatter(first);
    expect(frontmatter["description"]).toBe("Onboard onto the project");
    expect(frontmatter["argument-hint"]).toBeUndefined(); // no args → no hint
    expect(body).toContain("nahel/workflows/brief.md");
    expect(body.trim().split("\n")).toHaveLength(3); // the generated 3-liner
  });

  test("a workflow with args renders an argument-hint and passes $ARGUMENTS through", () => {
    const doc: WorkflowDoc = {
      frontmatter: { name: "plan", description: "Plan a feature", args: "<item-id>" },
      path: "nahel/workflows/plan.md",
    };
    const shim = AGENT_TARGETS["claude"]!.renderShim(doc);
    const { frontmatter, body } = parseFrontmatter(shim);
    expect(frontmatter["argument-hint"]).toBe("<item-id>");
    expect(body).toContain("$ARGUMENTS");
  });
});

describe("nahel install --agent claude", () => {
  test("generates one shim per valid workflow under .claude/commands/nd/ (default prefix)", async () => {
    const root = await makeRepo();
    await writeWorkflow(root, "brief.md", workflowDoc("brief", "Onboard onto the project"));
    await writeWorkflow(root, "plan.md", workflowDoc("plan", "Plan a feature", "<item-id>"));

    const result = await runInstall(["--agent", "claude"], root);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("2");

    const files = (await readdir(shimDir(root))).sort();
    expect(files).toEqual(["brief.md", "plan.md"]);
    const brief = await readFile(join(shimDir(root), "brief.md"), "utf8");
    expect(brief).toContain("nahel/workflows/brief.md");
    expect(brief).toContain("Onboard onto the project");
  });

  test("--prefix changes the shim directory", async () => {
    const root = await makeRepo();
    await writeWorkflow(root, "brief.md", workflowDoc("brief"));
    const result = await runInstall(["--agent", "claude", "--prefix", "go"], root);
    expect(result.code).toBe(0);
    expect((await readdir(shimDir(root, "go"))).sort()).toEqual(["brief.md"]);
  });

  test("an invalid --prefix is refused before anything is written", async () => {
    const root = await makeRepo();
    await writeWorkflow(root, "brief.md", workflowDoc("brief"));
    const result = await runInstall(["--agent", "claude", "--prefix", "Bad/Prefix"], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("prefix");
  });

  test("regeneration is idempotent: byte-identical output, reported as unchanged", async () => {
    const root = await makeRepo();
    await writeWorkflow(root, "brief.md", workflowDoc("brief"));
    const first = await runInstall(["--agent", "claude"], root);
    expect(first.code).toBe(0);
    const firstBytes = await readFile(join(shimDir(root), "brief.md"));

    const second = await runInstall(["--agent", "claude"], root);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("unchanged");
    const secondBytes = await readFile(join(shimDir(root), "brief.md"));
    expect(Buffer.compare(firstBytes, secondBytes)).toBe(0);
  });

  test("stale shims for deleted workflows are removed on regeneration", async () => {
    const root = await makeRepo();
    await writeWorkflow(root, "brief.md", workflowDoc("brief"));
    await writeWorkflow(root, "plan.md", workflowDoc("plan"));
    await runInstall(["--agent", "claude"], root);
    expect((await readdir(shimDir(root))).sort()).toEqual(["brief.md", "plan.md"]);

    await rm(join(workflowsDir(storeLayout(root)), "plan.md"));
    const result = await runInstall(["--agent", "claude"], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("plan.md");
    expect((await readdir(shimDir(root))).sort()).toEqual(["brief.md"]);
  });

  test("the prefix directory is generator-owned: foreign .md files there are pruned too", async () => {
    const root = await makeRepo();
    await writeWorkflow(root, "brief.md", workflowDoc("brief"));
    await mkdir(shimDir(root), { recursive: true });
    await writeFile(join(shimDir(root), "hand-rolled.md"), "not a shim\n", "utf8");
    const result = await runInstall(["--agent", "claude"], root);
    expect(result.code).toBe(0);
    expect((await readdir(shimDir(root))).sort()).toEqual(["brief.md"]);
  });

  test("unknown agent: exit 1 with the known-agent list", async () => {
    const root = await makeRepo();
    const result = await runInstall(["--agent", "emacs"], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("emacs");
    expect(result.stderr).toContain("claude");
  });

  test("missing --agent is a usage error", async () => {
    const root = await makeRepo();
    const result = await runInstall([], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--agent");
  });

  test("a workflow doc with invalid frontmatter is skipped with a warning; the rest install", async () => {
    const root = await makeRepo();
    await writeWorkflow(root, "brief.md", workflowDoc("brief"));
    await writeWorkflow(root, "broken.md", "---\nname: broken\n---\n\nno description or args\n");
    const result = await runInstall(["--agent", "claude"], root);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("broken.md");
    expect((await readdir(shimDir(root))).sort()).toEqual(["brief.md"]);
  });

  test("a doc whose frontmatter name disagrees with its filename is skipped with a warning", async () => {
    const root = await makeRepo();
    await writeWorkflow(root, "mismatch.md", workflowDoc("other-name"));
    const result = await runInstall(["--agent", "claude"], root);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("mismatch.md");
    expect(await listMarkdownDocs(shimDir(root))).toEqual([]);
  });

  test("the repo's committed workflow docs all install — the four F1 feature-lane shims appear", async () => {
    const root = await makeRepo();
    // Copy the REAL shipped docs (nahel/workflows/) into the temp repo: this
    // proves the committed docs are installable, not just synthetic ones.
    const source = join(import.meta.dir, "../../nahel/workflows");
    for (const file of await listMarkdownDocs(source)) {
      await writeWorkflow(root, file, await readFile(join(source, file), "utf8"));
    }

    const result = await runInstall(["--agent", "claude"], root);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const shims = await readdir(shimDir(root));
    for (const shim of ["prd-new.md", "prd-parse.md", "epic-decompose.md", "task-lifecycle.md"]) {
      expect(shims).toContain(shim);
      const content = await readFile(join(shimDir(root), shim), "utf8");
      expect(content).toContain(`nahel/workflows/${shim}`);
    }
  });

  test("uninitialized repo: exit 1 pointing at `nahel init`", async () => {
    const root = await makeTempDir("nahel-install-uninit-");
    tempDirs.push(root);
    const result = await runInstall(["--agent", "claude"], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("nahel init");
  });

  test("no workflow docs at all: exit 0 with an explicit nothing-to-install message", async () => {
    const root = await makeRepo();
    const result = await runInstall(["--agent", "claude"], root);
    expect(result.code).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("no workflow");
  });
});

describe("store additions for install (fs stays store-owned)", () => {
  test("workflowsDir lives under nahel/", () => {
    const layout = storeLayout("/repo");
    expect(workflowsDir(layout)).toBe(join("/repo", "nahel", "workflows"));
  });

  test("listMarkdownDocs: sorted .md names; non-md ignored; missing dir → []", async () => {
    const root = await makeTempDir("nahel-docs-");
    tempDirs.push(root);
    await writeFile(join(root, "b.md"), "b", "utf8");
    await writeFile(join(root, "a.md"), "a", "utf8");
    await writeFile(join(root, "notes.txt"), "x", "utf8");
    expect(await listMarkdownDocs(root)).toEqual(["a.md", "b.md"]);
    expect(await listMarkdownDocs(join(root, "missing"))).toEqual([]);
  });

  test("removeFile deletes a file and is a no-op on a missing one", async () => {
    const root = await makeTempDir("nahel-remove-");
    tempDirs.push(root);
    const path = join(root, "gone.md");
    await writeFile(path, "x", "utf8");
    await removeFile(path);
    await removeFile(path); // idempotent
    expect(await listMarkdownDocs(root)).toEqual([]);
  });
});

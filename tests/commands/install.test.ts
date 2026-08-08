import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
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
import { parseFrontmatter, prependLineIfMissing } from "../../src/store/frontmatter";
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

async function runInstall(
  args: string[],
  root: string,
  homeDir?: string,
  codexHome?: string,
): Promise<CommandResult> {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    env: seededEnv(),
    cwd: root,
    homeDir,
    codexHome,
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

/** A throwaway home directory — codex shims land outside the repo (F8.2). */
async function makeHome(): Promise<string> {
  const home = await makeTempDir("nahel-install-home-");
  tempDirs.push(home);
  return home;
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
/** Codex reads custom prompts from $CODEX_HOME/prompts, top-level files only. */
const promptsDir = (home: string) => join(home, ".codex", "prompts");

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

  test("claude shims live under .claude/commands/<prefix>, and own that whole directory", () => {
    expect(AGENT_TARGETS["claude"]!.root).toBe("repo");
    expect(AGENT_TARGETS["claude"]!.shimDir("nd")).toBe(join(".claude", "commands", "nd"));
    expect(AGENT_TARGETS["claude"]!.shimDir("go")).toBe(join(".claude", "commands", "go"));
    // Empty file-name prefix = the directory itself is the generator's namespace.
    expect(AGENT_TARGETS["claude"]!.filePrefix("nd")).toBe("");
  });

  test("codex is a known agent whose shims are codex-home-scoped prompt files (F8.2)", () => {
    // Codex loads custom prompts ONLY from $CODEX_HOME/prompts (default
    // ~/.codex/prompts), top-level markdown files, no subdirectories — so the
    // target is rooted at the CODEX HOME (not the user's home) and the prefix
    // is a FILE-NAME namespace, not a directory; pruning is limited to that
    // namespace (the directory is shared with the user's own prompts).
    expect(AGENT_TARGETS["codex"]).toBeDefined();
    expect(KNOWN_AGENTS).toEqual(["claude", "codex"]);
    expect(AGENT_TARGETS["codex"]!.root).toBe("codex-home");
    expect(AGENT_TARGETS["codex"]!.shimDir("nd")).toBe("prompts");
    expect(AGENT_TARGETS["codex"]!.shimDir("go")).toBe("prompts");
    expect(AGENT_TARGETS["codex"]!.filePrefix("nd")).toBe("nd-");
    expect(AGENT_TARGETS["codex"]!.filePrefix("go")).toBe("go-");
  });

  test("the codex shim is the same generated 3-liner, pointing at the canonical doc", () => {
    const doc: WorkflowDoc = {
      frontmatter: { name: "plan", description: "Plan a feature", args: "<item-id>" },
      path: "nahel/workflows/plan.md",
    };
    const shim = AGENT_TARGETS["codex"]!.renderShim(doc);
    expect(AGENT_TARGETS["codex"]!.renderShim(doc)).toBe(shim); // deterministic
    const { frontmatter, body } = parseFrontmatter(shim);
    // Codex custom-prompt frontmatter uses the same two keys as claude.
    expect(frontmatter["description"]).toBe("Plan a feature");
    expect(frontmatter["argument-hint"]).toBe("<item-id>");
    expect(body).toContain("nahel/workflows/plan.md");
    expect(body).toContain("$ARGUMENTS");
    expect(body).toContain("nahel install --agent codex"); // regenerate pointer names ITS agent
    expect(body.trim().split("\n")).toHaveLength(3);
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

  test("prunes around a directory named *.md instead of crashing with EISDIR (bug 33b2j3kq)", async () => {
    const root = await makeRepo();
    await writeWorkflow(root, "brief.md", workflowDoc("brief"));
    // A directory whose name ends in .md is not a doc; unlinking it raises
    // EISDIR (macOS) / EPERM (Linux). Install must complete around it.
    await mkdir(join(shimDir(root), "junk.md"), { recursive: true });
    const result = await runInstall(["--agent", "claude"], root);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect((await readdir(shimDir(root))).sort()).toEqual(["brief.md", "junk.md"]);
  });

  test("unknown agent: exit 1 with the known-agent list", async () => {
    const root = await makeRepo();
    const result = await runInstall(["--agent", "emacs"], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("emacs");
    expect(result.stderr).toContain("claude");
    expect(result.stderr).toContain("codex");
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

  test("the repo's committed workflow docs all install — the feature-lane and afk-run shims appear", async () => {
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
    // A new canonical workflow needs no generator change: dropping the doc in
    // is what makes its shim exist (afk-run, Phase 2 F2).
    for (const shim of [
      "prd-new.md",
      "prd-parse.md",
      "epic-decompose.md",
      "task-lifecycle.md",
      "afk-run.md",
      "review-loop.md",
    ]) {
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

describe("nahel install --agent claude — CLAUDE.md imports AGENTS.md (chore zfewc1z3)", () => {
  const claudeMd = (root: string) => join(root, "CLAUDE.md");

  test("no CLAUDE.md: one is created containing exactly the @AGENTS.md import line", async () => {
    const root = await makeRepo();
    await writeWorkflow(root, "brief.md", workflowDoc("brief"));

    const result = await runInstall(["--agent", "claude"], root);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(await readFile(claudeMd(root), "utf8")).toBe("@AGENTS.md\n");
    expect(result.stdout).toContain("CLAUDE.md");
  });

  test("the import is ensured even when there is no workflow to shim", async () => {
    const root = await makeRepo();
    const result = await runInstall(["--agent", "claude"], root);
    expect(result.code).toBe(0);
    expect(await readFile(claudeMd(root), "utf8")).toBe("@AGENTS.md\n");
    // The nothing-to-install verdict about SHIMS still stands and is still said.
    expect(result.stdout.toLowerCase()).toContain("no workflow");
  });

  test("an existing CLAUDE.md that already imports @AGENTS.md on line 1 is left byte-identical", async () => {
    const root = await makeRepo();
    await writeWorkflow(root, "brief.md", workflowDoc("brief"));
    const existing = "@AGENTS.md\n\n# House rules\n\n- Run `bun test` before pushing.\n";
    await writeFile(claudeMd(root), existing, "utf8");

    const result = await runInstall(["--agent", "claude"], root);
    expect(result.code).toBe(0);
    expect(await readFile(claudeMd(root), "utf8")).toBe(existing);
    expect(result.stdout).toContain("CLAUDE.md");
  });

  test("a MID-FILE @AGENTS.md import counts: nothing is prepended, nothing is duplicated", async () => {
    const root = await makeRepo();
    await writeWorkflow(root, "brief.md", workflowDoc("brief"));
    // A legitimate import that lives further down the file — containment is
    // checked over the whole file, not just line 1.
    const existing = "# House rules\n\n- Run `bun test` before pushing.\n\n@AGENTS.md\n";
    await writeFile(claudeMd(root), existing, "utf8");

    const result = await runInstall(["--agent", "claude"], root);
    expect(result.code).toBe(0);
    const after = await readFile(claudeMd(root), "utf8");
    expect(after).toBe(existing);
    expect(after.split("@AGENTS.md")).toHaveLength(2); // exactly one occurrence
  });

  test("an existing CLAUDE.md without the import gets it PREPENDED, every existing byte kept", async () => {
    const root = await makeRepo();
    await writeWorkflow(root, "brief.md", workflowDoc("brief"));
    const existing = "# House rules\n\n- Run `bun test` before pushing.\n";
    await writeFile(claudeMd(root), existing, "utf8");

    const result = await runInstall(["--agent", "claude"], root);
    expect(result.code).toBe(0);
    expect(await readFile(claudeMd(root), "utf8")).toBe(`@AGENTS.md\n${existing}`);
    // Loud: editing the user's instruction file is never silent.
    expect(result.stdout).toContain("prepended @AGENTS.md to existing CLAUDE.md");
  });

  test("re-install is idempotent: the prepended file is not touched again", async () => {
    const root = await makeRepo();
    await writeWorkflow(root, "brief.md", workflowDoc("brief"));
    await writeFile(claudeMd(root), "# House rules\n\nkeep me\n", "utf8");
    await runInstall(["--agent", "claude"], root);
    const afterFirst = await readFile(claudeMd(root));

    const second = await runInstall(["--agent", "claude"], root);
    expect(second.code).toBe(0);
    expect(Buffer.compare(afterFirst, await readFile(claudeMd(root)))).toBe(0);
    expect(second.stdout).not.toContain("prepended");
  });

  test("the codex target never touches CLAUDE.md — codex reads AGENTS.md natively", async () => {
    const root = await makeRepo();
    const home = await makeHome();
    await writeWorkflow(root, "brief.md", workflowDoc("brief"));

    const bare = await runInstall(["--agent", "codex"], root, home);
    expect(bare.code).toBe(0);
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);

    // …and an existing one is left exactly as the user wrote it.
    const existing = "# House rules\n\nno import here\n";
    await writeFile(join(root, "CLAUDE.md"), existing, "utf8");
    const again = await runInstall(["--agent", "codex"], root, home);
    expect(again.code).toBe(0);
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe(existing);
  });
});

describe("nahel install --agent codex (PRD F8.2)", () => {
  test("generates one prompt file per workflow under <home>/.codex/prompts, prefix-namespaced", async () => {
    const root = await makeRepo();
    const home = await makeHome();
    await writeWorkflow(root, "brief.md", workflowDoc("brief", "Onboard onto the project"));
    await writeWorkflow(root, "plan.md", workflowDoc("plan", "Plan a feature", "<item-id>"));

    const result = await runInstall(["--agent", "codex"], root, home);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    // The path the user has to know is stated explicitly in the output.
    expect(result.stdout).toContain(join("~", ".codex", "prompts"));

    // Flat files, not a subdirectory: codex scans only the top level.
    expect((await readdir(promptsDir(home))).sort()).toEqual(["nd-brief.md", "nd-plan.md"]);
    const brief = await readFile(join(promptsDir(home), "nd-brief.md"), "utf8");
    expect(brief).toContain("nahel/workflows/brief.md");
    expect(brief).toContain("Onboard onto the project");
    // Nothing lands in the repo for a home-scoped target.
    expect(await listMarkdownDocs(join(root, ".codex", "prompts"))).toEqual([]);
  });

  test("--prefix renames the namespace, it does not create a subdirectory", async () => {
    const root = await makeRepo();
    const home = await makeHome();
    await writeWorkflow(root, "brief.md", workflowDoc("brief"));
    const result = await runInstall(["--agent", "codex", "--prefix", "go"], root, home);
    expect(result.code).toBe(0);
    expect((await readdir(promptsDir(home))).sort()).toEqual(["go-brief.md"]);
  });

  test("regeneration is idempotent: byte-identical output, reported as unchanged", async () => {
    const root = await makeRepo();
    const home = await makeHome();
    await writeWorkflow(root, "brief.md", workflowDoc("brief"));
    expect((await runInstall(["--agent", "codex"], root, home)).code).toBe(0);
    const firstBytes = await readFile(join(promptsDir(home), "nd-brief.md"));

    const second = await runInstall(["--agent", "codex"], root, home);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("unchanged");
    expect(Buffer.compare(firstBytes, await readFile(join(promptsDir(home), "nd-brief.md")))).toBe(0);
  });

  test("stale shims are pruned, but the user's own prompts in the shared dir survive", async () => {
    const root = await makeRepo();
    const home = await makeHome();
    await writeWorkflow(root, "brief.md", workflowDoc("brief"));
    await writeWorkflow(root, "plan.md", workflowDoc("plan"));
    await runInstall(["--agent", "codex"], root, home);
    // A hand-written codex prompt of the user's, living in the same directory.
    const mine = join(promptsDir(home), "draftpr.md");
    await writeFile(mine, "---\ndescription: mine\n---\n\nhand written\n", "utf8");

    await rm(join(workflowsDir(storeLayout(root)), "plan.md"));
    const result = await runInstall(["--agent", "codex"], root, home);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("nd-plan.md");
    expect((await readdir(promptsDir(home))).sort()).toEqual(["draftpr.md", "nd-brief.md"]);
    expect(await readFile(mine, "utf8")).toBe("---\ndescription: mine\n---\n\nhand written\n");
  });

  test("codex without a resolvable home directory fails fast, writing nothing", async () => {
    const root = await makeRepo();
    await writeWorkflow(root, "brief.md", workflowDoc("brief"));
    const result = await runInstall(["--agent", "codex"], root); // no homeDir, no CODEX_HOME
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("home");
    expect(result.stderr).toContain("codex");
    expect(result.stderr).toContain("CODEX_HOME");
  });

  test("CODEX_HOME wins over ~/.codex — shims land where codex actually looks (F8.2)", async () => {
    const root = await makeRepo();
    const home = await makeHome();
    const codexHome = await makeTempDir("nahel-install-codex-home-");
    tempDirs.push(codexHome);
    await writeWorkflow(root, "brief.md", workflowDoc("brief"));

    const result = await runInstall(["--agent", "codex"], root, home, codexHome);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    // Codex's documented discovery: $CODEX_HOME/prompts, flat markdown files.
    expect((await readdir(join(codexHome, "prompts"))).sort()).toEqual(["nd-brief.md"]);
    // …and NOT ~/.codex/prompts, which would be invisible to that codex.
    expect(existsSync(join(home, ".codex"))).toBe(false);
    // The output states the path the user has to know.
    expect(result.stdout).toContain(join(codexHome, "prompts"));
  });

  test("with CODEX_HOME set, codex installs even when no home directory resolves", async () => {
    const root = await makeRepo();
    const codexHome = await makeTempDir("nahel-install-codex-home-");
    tempDirs.push(codexHome);
    await writeWorkflow(root, "brief.md", workflowDoc("brief"));

    const result = await runInstall(["--agent", "codex"], root, undefined, codexHome);
    expect(result.code).toBe(0);
    expect((await readdir(join(codexHome, "prompts"))).sort()).toEqual(["nd-brief.md"]);
  });

  test("CODEX_HOME regeneration stays namespace-scoped: stale shims pruned, user prompts survive", async () => {
    const root = await makeRepo();
    const codexHome = await makeTempDir("nahel-install-codex-home-");
    tempDirs.push(codexHome);
    await writeWorkflow(root, "brief.md", workflowDoc("brief"));
    await writeWorkflow(root, "plan.md", workflowDoc("plan"));
    await runInstall(["--agent", "codex"], root, undefined, codexHome);
    const mine = join(codexHome, "prompts", "draftpr.md");
    await writeFile(mine, "hand written\n", "utf8");

    await rm(join(workflowsDir(storeLayout(root)), "plan.md"));
    const result = await runInstall(["--agent", "codex"], root, undefined, codexHome);
    expect(result.code).toBe(0);
    expect((await readdir(join(codexHome, "prompts"))).sort()).toEqual([
      "draftpr.md",
      "nd-brief.md",
    ]);
  });
});

describe("nahel install --agent claude,codex (multi-target, PRD F8 acceptance)", () => {
  test("installs both targets in one invocation and re-runs byte-identically", async () => {
    const root = await makeRepo();
    const home = await makeHome();
    await writeWorkflow(root, "brief.md", workflowDoc("brief"));
    await writeWorkflow(root, "plan.md", workflowDoc("plan", "Plan a feature", "<item-id>"));

    const first = await runInstall(["--agent", "claude,codex"], root, home);
    expect(first.stderr).toBe("");
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("claude");
    expect(first.stdout).toContain("codex");
    expect((await readdir(shimDir(root))).sort()).toEqual(["brief.md", "plan.md"]);
    expect((await readdir(promptsDir(home))).sort()).toEqual(["nd-brief.md", "nd-plan.md"]);

    const paths = [
      join(shimDir(root), "brief.md"),
      join(shimDir(root), "plan.md"),
      join(promptsDir(home), "nd-brief.md"),
      join(promptsDir(home), "nd-plan.md"),
    ];
    const before = await Promise.all(paths.map((path) => readFile(path)));
    const second = await runInstall(["--agent", "claude,codex"], root, home);
    expect(second.code).toBe(0);
    const after = await Promise.all(paths.map((path) => readFile(path)));
    for (const [index, bytes] of before.entries()) {
      expect(Buffer.compare(bytes, after[index]!)).toBe(0);
    }
  });

  test("one unknown agent in the list fails the whole invocation before any write", async () => {
    const root = await makeRepo();
    const home = await makeHome();
    await writeWorkflow(root, "brief.md", workflowDoc("brief"));
    const result = await runInstall(["--agent", "claude,emacs"], root, home);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("emacs");
    expect(await listMarkdownDocs(shimDir(root))).toEqual([]);
    expect(await listMarkdownDocs(promptsDir(home))).toEqual([]);
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

  test("prependLineIfMissing: creates, keeps a line found anywhere, else prepends atomically", async () => {
    const root = await makeTempDir("nahel-prepend-");
    tempDirs.push(root);
    const path = join(root, "nested", "CLAUDE.md");

    // Absent → created with exactly the line (parent directories included).
    expect(await prependLineIfMissing(path, "@AGENTS.md")).toBe("created");
    expect(await readFile(path, "utf8")).toBe("@AGENTS.md\n");

    // Present (line 1) → untouched.
    expect(await prependLineIfMissing(path, "@AGENTS.md")).toBe("present");
    expect(await readFile(path, "utf8")).toBe("@AGENTS.md\n");

    // Present mid-file → untouched, no duplicate.
    const midFile = join(root, "mid.md");
    const mid = "# Mine\n\n@AGENTS.md\n\nmore\n";
    await writeFile(midFile, mid, "utf8");
    expect(await prependLineIfMissing(midFile, "@AGENTS.md")).toBe("present");
    expect(await readFile(midFile, "utf8")).toBe(mid);

    // Missing → prepended, every existing byte kept after it.
    const otherFile = join(root, "other.md");
    await writeFile(otherFile, "# Mine\n\nkeep me\n", "utf8");
    expect(await prependLineIfMissing(otherFile, "@AGENTS.md")).toBe("prepended");
    expect(await readFile(otherFile, "utf8")).toBe("@AGENTS.md\n# Mine\n\nkeep me\n");

    // An empty file is a file: it gets the line, not a second blank line.
    const emptyFile = join(root, "empty.md");
    await writeFile(emptyFile, "", "utf8");
    expect(await prependLineIfMissing(emptyFile, "@AGENTS.md")).toBe("prepended");
    expect(await readFile(emptyFile, "utf8")).toBe("@AGENTS.md\n");
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

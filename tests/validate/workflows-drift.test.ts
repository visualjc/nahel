import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CANONICAL_WORKFLOWS } from "../../src/install/canonical-workflows";
import { workflowsDir } from "../../src/store/layout";
import { validateStore } from "../../src/validate";
import { findingsFor, setupFixture } from "./helpers";

/**
 * Canonical workflow drift (chore 7fq7yvne). `nahel init` writes the workflow
 * docs EMBEDDED in the binary (bug mcm4ak0e, v0.4.1) into every store it
 * scaffolds, and it never overwrites — so a store's copies can fall out of step
 * with the binary two ways: the binary moved on (upgrade), or the doc was hand
 * edited. Both are drift, both are WARNINGS, and the comparison is byte-exact
 * against the embedded constant — deterministic, no network, no clock.
 *
 * Extra, non-canonical docs in nahel/workflows/ are the sanctioned way to add
 * local judgment and are never flagged.
 */

let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

describe("validate — canonical workflow drift (warnings only)", () => {
  test("a store whose canonical docs are byte-identical to the binary is silent", async () => {
    const fixture = await setupFixture(dirs);
    const findings = await validateStore(fixture.layout);
    console.log("[workflows, pristine store]", findings);
    expect(findings.filter((f) => f.check.startsWith("workflows."))).toEqual([]);
  });

  test("an edited canonical doc is a workflows.drift warning naming the file and both causes", async () => {
    const fixture = await setupFixture(dirs);
    await writeFile(
      join(workflowsDir(fixture.layout), "plan.md"),
      "# plan\n\nmy own take on planning\n",
      "utf8",
    );

    const findings = await validateStore(fixture.layout);
    console.log("[workflows, edited plan.md]", findings);
    const drift = findingsFor(findings, "workflows.drift");
    expect(drift).toHaveLength(1);
    expect(drift[0]!.severity).toBe("warning");
    expect(drift[0]!.path).toBe(join(workflowsDir(fixture.layout), "plan.md"));
    expect(drift[0]!.message).toContain("plan.md");
    // Both readings are named, because the reader is the only one who knows
    // which happened: a binary upgrade, or a hand edit.
    expect(drift[0]!.message).toContain("upgrade");
    expect(drift[0]!.message).toContain("edit");
    // And the customization that IS sanctioned is pointed at.
    expect(drift[0]!.message.toLowerCase()).toContain("additional");
    // The fix says why re-init alone does nothing: it is write-if-missing.
    expect(drift[0]!.fix).toContain("nahel init");
    expect(drift[0]!.fix).toContain("aside");
    // Never an error — drift is legitimate mid-upgrade.
    expect(findings.some((f) => f.severity === "error")).toBe(false);
  });

  test("drift is BYTE-exact: one extra trailing newline is drift", async () => {
    const fixture = await setupFixture(dirs);
    const brief = CANONICAL_WORKFLOWS.find((w) => w.name === "brief")!;
    await writeFile(join(workflowsDir(fixture.layout), "brief.md"), `${brief.body}\n`, "utf8");

    const findings = await validateStore(fixture.layout);
    console.log("[workflows, brief.md + one newline]", findings);
    const drift = findingsFor(findings, "workflows.drift");
    expect(drift).toHaveLength(1);
    expect(drift[0]!.message).toContain("brief.md");
  });

  test("a deleted canonical doc is a workflows.missing warning healed by nahel init", async () => {
    const fixture = await setupFixture(dirs);
    await rm(join(workflowsDir(fixture.layout), "task-lifecycle.md"));

    const findings = await validateStore(fixture.layout);
    console.log("[workflows, deleted task-lifecycle.md]", findings);
    const missing = findingsFor(findings, "workflows.missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.severity).toBe("warning");
    expect(missing[0]!.path).toBe(join(workflowsDir(fixture.layout), "task-lifecycle.md"));
    expect(missing[0]!.message).toContain("task-lifecycle.md");
    expect(missing[0]!.fix).toContain("nahel init");
    // No drift finding for the same doc — absent is one fact, not two.
    expect(findingsFor(findings, "workflows.drift")).toEqual([]);
  });

  test("a store scaffolded before the docs shipped warns ONCE for the whole absent set — 18 lines would drown the brief", async () => {
    const fixture = await setupFixture(dirs);
    // A pre-v0.4.1 store: nahel/workflows/ never existed.
    await rm(workflowsDir(fixture.layout), { recursive: true, force: true });

    const findings = await validateStore(fixture.layout);
    const missing = findingsFor(findings, "workflows.missing");
    console.log(`[workflows, pre-0.4.1 store] ${missing.length} finding(s) for the absent set`);
    // The whole set absent is one condition, not eighteen: a single warning
    // names the count, and one init heals the lot — the hint says so.
    expect(missing).toHaveLength(1);
    expect(missing[0]?.severity).toBe("warning");
    expect(missing[0]?.message).toContain(`all ${CANONICAL_WORKFLOWS.length}`);
    expect(missing[0]?.fix).toContain("nahel init");
    expect(findingsFor(findings, "workflows.drift")).toEqual([]);
  });

  test("PARTIAL absence stays per-file — naming exactly what is gone earns its lines", async () => {
    const fixture = await setupFixture(dirs);
    const first = CANONICAL_WORKFLOWS[0];
    const second = CANONICAL_WORKFLOWS[1];
    if (first === undefined || second === undefined) throw new Error("no canonical docs");
    await rm(join(workflowsDir(fixture.layout), `${first.name}.md`), { force: true });
    await rm(join(workflowsDir(fixture.layout), `${second.name}.md`), { force: true });

    const findings = await validateStore(fixture.layout);
    const missing = findingsFor(findings, "workflows.missing");
    console.log(`[workflows, two deleted] ${missing.length} missing finding(s)`);
    expect(missing).toHaveLength(2);
    expect(missing.map((f) => f.message).join("\n")).toContain(`${first.name}.md`);
    expect(missing.map((f) => f.message).join("\n")).toContain(`${second.name}.md`);
  });

  test("an extra non-canonical workflow doc is never flagged — additional workflows are the customization path", async () => {
    const fixture = await setupFixture(dirs);
    await writeFile(
      join(workflowsDir(fixture.layout), "our-house-style.md"),
      "# our-house-style\n\nlocal judgment lives here\n",
      "utf8",
    );

    const findings = await validateStore(fixture.layout);
    console.log("[workflows, extra doc]", findings);
    expect(findings.filter((f) => f.check.startsWith("workflows."))).toEqual([]);
  });

  test("workflow drift never fails validate — every finding stays a warning", async () => {
    const fixture = await setupFixture(dirs);
    await writeFile(join(workflowsDir(fixture.layout), "qa-lane.md"), "edited\n", "utf8");
    await rm(join(workflowsDir(fixture.layout), "compact.md"));

    const findings = await validateStore(fixture.layout);
    console.log("[workflows, mixed drift]", findings);
    expect(findingsFor(findings, "workflows.drift")).toHaveLength(1);
    expect(findingsFor(findings, "workflows.missing")).toHaveLength(1);
    expect(findings.every((f) => f.severity === "warning")).toBe(true);
  });
});

#!/usr/bin/env bun
// Build the standalone `nahel` binaries — `bun build --compile` artifacts for
// macOS and Linux (ADR-0001 dual distribution, PRD F8.1), plus the local
// install path that lands `nahel` on PATH.
//
//   bun run build          current platform  → $NAHEL_DIST_DIR/nahel-<os>-<arch>
//   bun run build:all      every target      → $NAHEL_DIST_DIR/nahel-<os>-<arch>
//   bun run install:local  current platform  → $NAHEL_BIN_DIR/nahel
//   Defaults: NAHEL_DIST_DIR=dist, NAHEL_BIN_DIR=~/.local/bin
//
// This is build tooling, not CLI core: cross-compiling fetches the target
// runtime, so the deterministic-and-offline rule does not bind it.

import { chmod, copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

/** The platforms we ship binaries for. */
const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;
type Target = (typeof TARGETS)[number];

/** Environment variable overriding the install directory. */
const BIN_DIR_VAR = "NAHEL_BIN_DIR";
const DIST_DIR_VAR = "NAHEL_DIST_DIR";
const DEFAULT_BIN_DIR = join(homedir(), ".local", "bin");

const REPO_ROOT = resolve(import.meta.dir, "..");
const DIST_DIR = process.env[DIST_DIR_VAR] ?? join(REPO_ROOT, "dist");
const ENTRY = join(REPO_ROOT, "src", "cli.ts");

const USAGE = "usage: bun run scripts/build-binary.ts [--all] [--install]";

/** The target matching the machine we are building on. Throws if unsupported. */
function currentTarget(): Target {
  const target = `${process.platform}-${process.arch}`;
  const known = TARGETS.find((candidate) => candidate === target);
  if (known === undefined) {
    throw new Error(`unsupported platform ${target} — supported: ${TARGETS.join(", ")}`);
  }
  return known;
}

/** Compile one target into dist/; returns the artifact path. */
async function buildBinary(target: Target): Promise<string> {
  await mkdir(DIST_DIR, { recursive: true });
  const outfile = join(DIST_DIR, `nahel-${target}`);
  const build = Bun.spawnSync(
    ["bun", "build", "--compile", `--target=bun-${target}`, ENTRY, "--outfile", outfile],
    { cwd: REPO_ROOT, stdout: "inherit", stderr: "inherit" },
  );
  if (build.exitCode !== 0) {
    throw new Error(`bun build --compile failed for ${target} (exit ${build.exitCode})`);
  }
  return outfile;
}

/** Copy the artifact onto PATH as `nahel`; returns the installed path. */
async function installBinary(binary: string): Promise<string> {
  const binDir = process.env[BIN_DIR_VAR] ?? DEFAULT_BIN_DIR;
  await mkdir(binDir, { recursive: true });
  // Overwrites whatever sat here before — including the retired machine-local
  // wrapper script that exec'd `bun <checkout>/src/cli.ts`.
  const installed = join(binDir, "nahel");
  await copyFile(binary, installed);
  await chmod(installed, 0o755);
  return installed;
}

/** Whether a directory is on this shell's PATH. */
function onPath(dir: string): boolean {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((entry) => entry !== "" && resolve(entry) === resolve(dir));
}

const args = new Set(Bun.argv.slice(2));
const all = args.delete("--all");
const install = args.delete("--install");
if (args.size > 0) {
  console.error(`❌ unknown argument(s): ${[...args].join(", ")}\n${USAGE}`);
  process.exit(1);
}

const targets = all ? [...TARGETS] : [currentTarget()];
for (const target of targets) {
  const outfile = await buildBinary(target);
  console.log(`✅ built ${outfile}`);
}

if (install) {
  const installed = await installBinary(join(DIST_DIR, `nahel-${currentTarget()}`));
  console.log(`✅ installed ${installed}`);
  const binDir = process.env[BIN_DIR_VAR] ?? DEFAULT_BIN_DIR;
  if (!onPath(binDir)) {
    console.error(`⚠️ ${binDir} is not on your PATH — add it: export PATH="${binDir}:$PATH"`);
  }
}

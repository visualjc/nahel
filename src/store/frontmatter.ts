import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import YAML from "yaml";

/**
 * Markdown-with-frontmatter encoding and the atomic-write primitive every
 * record mutation in the store uses (PRD F1 atomic writes: write a temp file
 * in the target directory, fsync, then atomically rename — a killed process
 * never leaves a half-written record).
 *
 * The frontmatter split is deliberately the ~10-line convention over `yaml`
 * (epic decision: no gray-matter): frontmatter is everything between the
 * opening `---` line and the next `---` line; the body is everything after.
 */

export interface FrontmatterFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Split a markdown document into its YAML frontmatter mapping and body. */
export function parseFrontmatter(text: string): FrontmatterFile {
  if (!text.startsWith("---\n")) {
    throw new Error("missing frontmatter: file must start with a `---` line");
  }
  const close = text.indexOf("\n---\n", 3);
  if (close === -1) {
    throw new Error("unterminated frontmatter: no closing `---` line");
  }
  const parsed: unknown = YAML.parse(text.slice(4, close + 1));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("frontmatter must be a YAML mapping");
  }
  return { frontmatter: parsed as Record<string, unknown>, body: text.slice(close + 5) };
}

/** Serialize a frontmatter mapping and body back into one markdown document. */
export function serializeFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  return `---\n${YAML.stringify(frontmatter)}---\n${body}`;
}

// Distinguishes temp files from concurrent writers in the same process;
// combined with the pid it never collides across processes either.
let tempCounter = 0;

/**
 * Write `data` to `path` atomically: temp file in the same directory (same
 * filesystem, so rename is atomic), fsync, rename. Creates parent directories.
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  tempCounter += 1;
  const tempPath = join(dir, `.${basename(path)}.${process.pid}.${tempCounter}.tmp`);
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(tempPath, path);
}

/** Read and split a frontmatter file; errors carry the path. */
export async function readFrontmatterFile(path: string): Promise<FrontmatterFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return parseFrontmatter(text);
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Serialize and atomically write a frontmatter file. */
export async function writeFrontmatterFile(
  path: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<void> {
  await writeFileAtomic(path, serializeFrontmatter(frontmatter, body));
}

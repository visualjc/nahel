import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  parseFrontmatter,
  readFrontmatterFile,
  serializeFrontmatter,
  writeFileAtomic,
  writeFrontmatterFile,
} from "../../src/store/frontmatter";
import { makeTempDir } from "./helpers";

let dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir();
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

describe("parseFrontmatter", () => {
  test("splits frontmatter mapping from body", () => {
    const text = "---\nid: abc123de\nname: thing\n---\nBody line one.\n\nBody line two.\n";
    const parsed = parseFrontmatter(text);
    expect(parsed.frontmatter).toEqual({ id: "abc123de", name: "thing" });
    expect(parsed.body).toBe("Body line one.\n\nBody line two.\n");
  });

  test("preserves body byte-for-byte, including leading whitespace and --- inside the body", () => {
    const body = "  indented\n\n---\nnot frontmatter\n";
    const text = `---\nid: x\n---\n${body}`;
    expect(parseFrontmatter(text).body).toBe(body);
  });

  test("empty body is allowed", () => {
    const parsed = parseFrontmatter("---\nid: x\n---\n");
    expect(parsed.body).toBe("");
  });

  test("rejects a file that does not start with ---", () => {
    expect(() => parseFrontmatter("id: x\n---\n")).toThrow(/frontmatter/);
  });

  test("rejects unterminated frontmatter", () => {
    expect(() => parseFrontmatter("---\nid: x\nno closing delimiter\n")).toThrow(
      /frontmatter/,
    );
  });

  test("rejects non-mapping frontmatter (YAML list)", () => {
    expect(() => parseFrontmatter("---\n- a\n- b\n---\nbody\n")).toThrow(/mapping/);
  });
});

describe("serializeFrontmatter", () => {
  test("round-trips through parseFrontmatter", () => {
    const frontmatter = {
      id: "abc123de",
      list: ["x", "y"],
      nested: { provider: "github", id: "42" },
    };
    const body = "# Title\n\nProse.\n";
    const text = serializeFrontmatter(frontmatter, body);
    const parsed = parseFrontmatter(text);
    expect(parsed.frontmatter).toEqual(frontmatter);
    expect(parsed.body).toBe(body);
  });

  test("is deterministic: identical input yields identical bytes", () => {
    const fm = { id: "abc123de", name: "thing" };
    expect(serializeFrontmatter(fm, "body\n")).toBe(serializeFrontmatter(fm, "body\n"));
  });
});

describe("writeFileAtomic", () => {
  test("writes new file with exact content and creates parent directories", async () => {
    const dir = await tempDir();
    const path = join(dir, "deep/nested/file.md");
    await writeFileAtomic(path, "content\n");
    expect(await readFile(path, "utf8")).toBe("content\n");
  });

  test("replaces existing content completely (no partial mixing)", async () => {
    const dir = await tempDir();
    const path = join(dir, "file.md");
    await writeFileAtomic(path, "A".repeat(10_000));
    await writeFileAtomic(path, "B");
    expect(await readFile(path, "utf8")).toBe("B");
  });

  test("leaves no .tmp files behind after a successful write", async () => {
    const dir = await tempDir();
    const path = join(dir, "file.md");
    await writeFileAtomic(path, "content\n");
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    expect(entries).toEqual(["file.md"]);
  });
});

describe("frontmatter file I/O", () => {
  test("writeFrontmatterFile then readFrontmatterFile round-trips", async () => {
    const dir = await tempDir();
    const path = join(dir, "record.md");
    const frontmatter = { id: "abc123de", tags: ["one"] };
    await writeFrontmatterFile(path, frontmatter, "The fact.\n");
    const parsed = await readFrontmatterFile(path);
    expect(parsed.frontmatter).toEqual(frontmatter);
    expect(parsed.body).toBe("The fact.\n");
  });

  test("readFrontmatterFile on a missing file throws with the path in the message", async () => {
    const dir = await tempDir();
    const path = join(dir, "missing.md");
    expect(readFrontmatterFile(path)).rejects.toThrow(path);
  });
});

import { describe, expect, test } from "bun:test";
import { gitSpawnEnv } from "../../src/store/exec";

/**
 * The git spawn seam's environment sanitizing (HC1, HC6). Every question nahel
 * asks git is about "the repo AT this root", and git takes that instruction
 * from the environment as readily as from `-C`: one exported variable and the
 * answer describes a DIFFERENT repository — at exit 0, looking entirely
 * plausible. These are the variables that do it, pinned by name because the
 * list is the whole defence.
 */

/**
 * Git's repository discovery/selection overrides. GIT_DIR and GIT_COMMON_DIR
 * name another repository; GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY
 * and GIT_ALTERNATE_OBJECT_DIRECTORIES swap out pieces of the one it finds;
 * GIT_CEILING_DIRECTORIES stops discovery before it reaches the root; and
 * GIT_DISCOVERY_ACROSS_FILESYSTEM lets discovery CONTINUE past a filesystem
 * boundary, so a root below a mount point resolves to an OUTER repo — a
 * valid-looking answer about the wrong repository, which no error ever flags.
 */
const REDIRECTING_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
] as const;

/** Set the vars for the duration of `body`, restoring exactly what was there. */
function withAmbientGitEnv(value: string, body: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const name of REDIRECTING_VARS) {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    body();
  } finally {
    for (const [name, previous] of saved) {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }
}

describe("gitSpawnEnv — the one place ambient git state is disarmed", () => {
  test("every repository discovery/selection override is stripped", () => {
    withAmbientGitEnv("/somewhere/else", () => {
      const env = gitSpawnEnv();
      for (const name of REDIRECTING_VARS) {
        expect(env[name]).toBeUndefined();
      }
    });
  });

  test("everything else survives — git still needs its environment", () => {
    withAmbientGitEnv("/somewhere/else", () => {
      const env = gitSpawnEnv();
      // PATH is the one that must survive or git is not even findable; HOME
      // carries the user's git identity and credential configuration.
      expect(env["PATH"]).toBe(process.env["PATH"]);
      expect(env["HOME"]).toBe(process.env["HOME"]);
    });
  });

  test("the ambient environment itself is untouched — the child gets a copy", () => {
    withAmbientGitEnv("/somewhere/else", () => {
      gitSpawnEnv();
      // Stripping a variable from THIS process would change how every later
      // spawn behaves, including the user's own healthcheck and agent CLI.
      for (const name of REDIRECTING_VARS) {
        expect(process.env[name]).toBe("/somewhere/else");
      }
    });
  });
});

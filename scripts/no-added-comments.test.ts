import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commentSpans } from "./no-added-comments";

const script = join(import.meta.dir, "no-added-comments.ts");

function repo(): { dir: string; git: (...args: string[]) => void } {
  const dir = mkdtempSync(join(tmpdir(), "no-added-comments-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir });
    if (result.status !== 0) throw new Error(result.stderr.toString());
  };
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  return { dir, git };
}

function hook(path: string): { status: number | null; stderr: string } {
  const result = spawnSync("bun", [script], {
    input: JSON.stringify({ tool_input: { file_path: path } }),
  });
  return { status: result.status, stderr: result.stderr.toString() };
}

test("finds line, block and doc comments that start a line", () => {
  const source = [
    "// one",
    "// two",
    "const a = 1; // trailing",
    "/**",
    " * doc",
    " */",
    "function f() {}",
    "  /* inline */",
  ].join("\n");
  expect(commentSpans(source)).toEqual([
    { start: 1, end: 2 },
    { start: 4, end: 6 },
    { start: 8, end: 8 },
  ]);
});

test("rejects a docstring added to a tracked file", () => {
  const { dir, git } = repo();
  const file = join(dir, "a.ts");
  writeFileSync(file, "export const a = 1;\n");
  git("add", ".");
  git("commit", "-qm", "init");
  writeFileSync(file, "/** The answer. */\nexport const a = 1;\n");
  const result = hook(file);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("a.ts:1");
});

test("leaves comments that were already there", () => {
  const { dir, git } = repo();
  const file = join(dir, "a.ts");
  writeFileSync(file, "/** Old. */\nexport const a = 1;\n");
  git("add", ".");
  git("commit", "-qm", "init");
  writeFileSync(file, "/** Old. */\nexport const a = 2;\n");
  expect(hook(file).status).toBe(0);
});

test("rejects a comment in a new untracked file", () => {
  const { dir } = repo();
  const file = join(dir, "b.ts");
  writeFileSync(file, "export const b = 1;\n// why\n");
  expect(hook(file).status).toBe(2);
});

test("ignores files that are not code", () => {
  const { dir } = repo();
  const file = join(dir, "notes.md");
  writeFileSync(file, "// not code\n");
  expect(hook(file).status).toBe(0);
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { changedPaths, describeSelection, selectTests, type Selection } from "./affected-tests";

let root: string;

const FILES: Record<string, string> = {
  "package.json": `{ "name": "fixture" }\n`,
  "docs/merge.md": "# Merge\n",
  "src/merge/index.ts": `export { step } from "./step";\n`,
  "src/merge/step.ts": "export const step = 1;\n",
  "src/merge/step.test.ts": `import { step } from "./step";\n`,
  "src/merge/lane/order.test.ts": `import { step } from "../step";\n`,
  "src/loop/index.ts": `export const loop = 1;\n`,
  "src/loop/loop.test.ts": `import { loop } from "./index";\n`,
  "src/loop/merge-jobs.test.ts": `import { step } from "../merge";\n`,
  "test/boundaries.test.ts": `const SRC = new URL("../src/", import.meta.url);\n`,
  "test/merge-lane.test.ts": `import { step } from "../src/merge";\n`,
  "test/merge-step.test.ts": `import { step } from "../src/merge/step.ts";\n`,
  "test/merge-mock.test.ts": `mock.module("../src/merge/index.ts", () => ({}));\n`,
  "test/helper-user.test.ts": `import { lane } from "./lane-harness";\n`,
  "test/lane-harness.ts": `export { step as lane } from "../src/merge";\n`,
  "test/loop.test.ts": `import { loop } from "../src/loop";\n`,
  "test/docs.test.ts": `const text = await Bun.file("docs/closeout.md").text();\n`,
};

function git(...args: string[]): string {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** Commits `edits` on a branch from the base commit and returns what the script selects. */
function select(edits: Record<string, string>): Selection {
  git("checkout", "-q", "--detach", "base");
  for (const [path, text] of Object.entries(edits)) write(path, text);
  git("add", "-A");
  git("commit", "-q", "-m", "change");
  return selectTests({ root, changed: changedPaths(root, "base", "HEAD") });
}

function paths(selection: Selection): string[] {
  if (selection.full)
    throw new Error(`expected a selection, got the full suite: ${selection.reason}`);
  return selection.files.map((file) => file.path);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "affected-tests-"));
  git("init", "-q", "-b", "main");
  for (const [path, text] of Object.entries(FILES)) write(path, text);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("tag", "base");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test("a change in src/merge/step.ts selects src/merge tests and the tests that import src/merge", () => {
  const selection = select({ "src/merge/step.ts": "export const step = 2;\n" });
  expect(paths(selection)).toEqual([
    "src/loop/merge-jobs.test.ts",
    "src/merge/lane/order.test.ts",
    "src/merge/step.test.ts",
    "test/boundaries.test.ts",
    "test/helper-user.test.ts",
    "test/merge-lane.test.ts",
    "test/merge-mock.test.ts",
    "test/merge-step.test.ts",
  ]);
  const why = Object.fromEntries(
    (selection.full ? [] : selection.files).map((file) => [file.path, file.reasons.join(", ")]),
  );
  expect(why["src/merge/step.test.ts"]).toBe("in src/merge");
  expect(why["test/merge-lane.test.ts"]).toBe("imports src/merge");
  expect(why["test/boundaries.test.ts"]).toBe("always");
  expect(describeSelection(selection, 13)).toContain(
    "  test/merge-lane.test.ts       imports src/merge\n",
  );
});

test("a changed test file runs with the reason changed", () => {
  const selection = select({
    "test/loop.test.ts": `import { loop } from "../src/loop";\n// more\n`,
  });
  expect(selection).toEqual({
    full: false,
    files: [
      { path: "test/boundaries.test.ts", reasons: ["always"] },
      { path: "test/loop.test.ts", reasons: ["changed"] },
    ],
  });
});

test("a change to package.json selects everything", () => {
  expect(select({ "package.json": `{ "name": "fixture", "private": true }\n` })).toEqual({
    full: true,
    reason: "package.json changed",
  });
});

test("shared files select everything", () => {
  expect(select({ "tsconfig.json": "{}\n" })).toEqual({
    full: true,
    reason: "tsconfig.json changed",
  });
  expect(select({ "scripts/tool.ts": "export {};\n" })).toEqual({
    full: true,
    reason: "scripts/tool.ts changed",
  });
  expect(select({ "test/lane-harness.ts": "export const lane = 2;\n" })).toEqual({
    full: true,
    reason: "test helper test/lane-harness.ts changed",
  });
});

test("a docs-only change selects only test/boundaries.test.ts", () => {
  expect(select({ "docs/merge.md": "# Merge lane\n" })).toEqual({
    full: false,
    files: [{ path: "test/boundaries.test.ts", reasons: ["always"] }],
  });
});

test("a test that names a changed non-source file runs", () => {
  expect(paths(select({ "docs/closeout.md": "# Closeout\n" }))).toEqual([
    "test/boundaries.test.ts",
    "test/docs.test.ts",
  ]);
});

test("an unreadable diff selects everything", () => {
  const changed = changedPaths(root, "no-such-ref", "HEAD");
  expect(changed).toBeNull();
  const selection = selectTests({ root, changed });
  expect(selection).toEqual({ full: true, reason: "the diff could not be read" });
  expect(describeSelection(selection, 13)).toBe(
    "affected-tests: full suite (13 files): the diff could not be read",
  );
});

test("an unreadable test falls back to the full suite", () => {
  git("checkout", "-q", "--detach", "base");
  const selection = selectTests({
    root,
    changed: ["src/merge/step.ts"],
    tests: ["test/missing.test.ts"],
  });
  expect(selection.full).toBe(true);
  expect(describeSelection(selection, 1)).toContain("import graph could not be read");
});

test("an unreadable imported helper falls back to the full suite", () => {
  git("checkout", "-q", "--detach", "base");
  write("test/broken.test.ts", 'import "./missing-helper";');
  const selection = selectTests({
    root,
    changed: ["src/merge/step.ts"],
    tests: ["test/broken.test.ts"],
  });
  expect(selection.full).toBe(true);
  expect(describeSelection(selection, 1)).toContain("import graph could not be read");
  rmSync(join(root, "test/broken.test.ts"));
});

test("every entry into a helper cycle sees the module imported by the cycle", () => {
  git("checkout", "-q", "--detach", "base");
  write("test/cycle-a.ts", 'import "./cycle-b"; import "../src/merge";');
  write("test/cycle-b.ts", 'import "./cycle-a";');
  write("test/cycle-a.test.ts", 'import "./cycle-a";');
  write("test/cycle-b.test.ts", 'import "./cycle-b";');
  expect(
    paths(
      selectTests({
        root,
        changed: ["src/merge/step.ts"],
        tests: ["test/cycle-a.test.ts", "test/cycle-b.test.ts"],
      }),
    ),
  ).toEqual(["test/cycle-a.test.ts", "test/cycle-b.test.ts"]);
  for (const path of [
    "test/cycle-a.ts",
    "test/cycle-b.ts",
    "test/cycle-a.test.ts",
    "test/cycle-b.test.ts",
  ])
    rmSync(join(root, path));
});

test("import-looking fixture strings and comments do not trigger missing-helper fallback", () => {
  git("checkout", "-q", "--detach", "base");
  write(
    "test/fixtures.test.ts",
    `const fixture = 'import "./missing";'; // import "./also-missing";\nimport "../src/merge";`,
  );
  expect(
    paths(selectTests({ root, changed: ["src/merge/step.ts"], tests: ["test/fixtures.test.ts"] })),
  ).toEqual(["test/fixtures.test.ts"]);
  rmSync(join(root, "test/fixtures.test.ts"));
});

test("a parse error falls back to the full suite", () => {
  git("checkout", "-q", "--detach", "base");
  write("test/invalid.test.ts", "import {");
  expect(
    selectTests({ root, changed: ["src/merge/step.ts"], tests: ["test/invalid.test.ts"] }),
  ).toEqual({
    full: true,
    reason: "import graph could not be read: cannot parse test/invalid.test.ts",
  });
  rmSync(join(root, "test/invalid.test.ts"));
});

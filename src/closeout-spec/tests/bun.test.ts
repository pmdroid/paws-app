import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePolicyFiles } from "../facade";
import { createCloseoutSession } from "../session";
import { bunTestAdapter } from "./index";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}

function repo(select: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "paws-bun-select-"));
  roots.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  write(
    root,
    ".agents/closeout.yaml",
    [
      'specVersion: "0.1"',
      "items:",
      "  - id: test",
      "    kind: command",
      "    gate: beforePR",
      '    exec: ["bun", "test", "--timeout=20000"]',
      "    timeoutSeconds: 120",
      ...(select ? ["    select:", "      runner: bun"] : []),
    ].join("\n") + "\n",
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  write(root, "test/ok.test.ts", 'import { test } from "bun:test";\ntest("fine", () => {});\n');
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "ok"]);
  return root;
}

function breakTest(root: string): void {
  write(
    root,
    "test/math.test.ts",
    'import { describe, expect, test } from "bun:test";\ndescribe("math", () => {\n  test("adds", () => {\n    expect(1 + 1).toBe(3);\n  });\n});\n',
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "break"]);
}

test("the bun runner runs the full exec with the JUnit flags and names the failed test", async () => {
  const root = repo(true);
  const ran: string[][] = [];
  const session = () =>
    createCloseoutSession(root, {
      policy: async () => workspacePolicyFiles(root),
      allowCommand: (argv) => void ran.push([...argv]),
    });
  expect(await session().run("test")).toBe("test passed.");
  breakTest(root);
  const failing = session();
  const text = await failing.run("test");
  expect(text).toStartWith("test failed (exit 1). Full output: ");
  expect(text).toContain(
    "Failed tests (1):\n- test/math.test.ts: math > adds: expect(received).toBe(expected)",
  );
  expect(text.indexOf("Failed tests")).toBeLessThan(text.indexOf("(fail) math > adds"));
  expect(ran.at(-1)).toEqual(["bun", "test", "--timeout=20000"]);
  const report = JSON.parse(await failing.report()) as {
    required: { id: string; result?: { exitCode: number; failedTests?: unknown[] } }[];
  };
  expect(report.required[0]?.result).toMatchObject({
    exitCode: 1,
    failedTests: [{ file: "test/math.test.ts", name: "math > adds", kind: "failed" }],
  });
});

test("the bun plan is the full exec plus the JUnit reporter flags", () => {
  const plan = bunTestAdapter.plan({
    item: {
      id: "test",
      kind: "command",
      gate: "beforePR",
      exec: ["bun", "test", "--parallel=4"],
      timeoutSeconds: 60,
      select: { runner: "bun" },
    },
    cwd: "/repo",
    base: "a".repeat(40),
    head: "b".repeat(40),
    reportDir: "/reports/1",
    changes: async () => [],
    readAtBase: async () => undefined,
    readAtHead: async () => undefined,
  });
  expect(plan).toEqual({
    selection: { mode: "full", reasons: ["the bun runner runs the full suite"] },
    invocations: [
      {
        cwd: "/repo",
        argv: [
          "bun",
          "test",
          "--parallel=4",
          "--reporter=junit",
          "--reporter-outfile=/reports/1/junit.xml",
        ],
      },
    ],
    report: { kind: "junit", paths: ["/reports/1/junit.xml"] },
  });
});

test("without select a failing bun check reports as before, with no failed test list", async () => {
  const root = repo(false);
  breakTest(root);
  const session = createCloseoutSession(root, { policy: async () => workspacePolicyFiles(root) });
  const text = await session.run("test");
  expect(text).toStartWith("test failed (exit 1). Full output: ");
  expect(text).not.toContain("Failed tests");
  const report = JSON.parse(await session.report()) as {
    required: { id: string; result?: Record<string, unknown> }[];
  };
  expect(report.required[0]?.result).not.toHaveProperty("failedTests");
});

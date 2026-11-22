import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePolicyFiles } from "../facade";
import { createCloseoutSession } from "../session";
import { bunTestAdapter, type TestContext } from "./index";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const POLICY = `specVersion: "0.1"
items:
  - id: test
    kind: command
    gate: beforePR
    exec: ["bun", "test", "--timeout=20000"]
    timeoutSeconds: 120
    select: { runner: bun }
`;

const FAILING = `import { describe, expect, test } from "bun:test";
describe("math", () => test("adds", () => expect(1 + 1).toBe(3)));
`;

function commit(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
  for (const args of [
    ["add", "."],
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-m", path],
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
}

test("the bun runner runs the full exec with the JUnit flags and names the failed test", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-bun-select-"));
  roots.push(root);
  spawnSync("git", ["init", "-b", "main"], { cwd: root });
  commit(root, ".agents/closeout.yaml", POLICY);
  spawnSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });
  commit(root, "test/ok.test.ts", 'import { test } from "bun:test";\ntest("fine", () => {});\n');
  const ran: string[][] = [];
  const session = () =>
    createCloseoutSession(root, {
      policy: async () => workspacePolicyFiles(root),
      allowCommand: (argv) => void ran.push([...argv]),
    });
  expect(await session().run("test")).toBe("test passed.");
  commit(root, "test/math.test.ts", FAILING);
  const failing = session();
  const text = await failing.run("test");
  expect(text).toStartWith("test failed (exit 1). Full output: ");
  expect(text).toContain(
    "Failed tests (1):\n- test/math.test.ts: math > adds: expect(received).toBe(expected)",
  );
  expect(text.indexOf("Failed tests")).toBeLessThan(text.indexOf("(fail) math > adds"));
  expect(ran.at(-1)).toEqual(["bun", "test", "--timeout=20000"]);
  const report = JSON.parse(await failing.report()) as { required: { result?: unknown }[] };
  expect(report.required[0]?.result).toMatchObject({
    exitCode: 1,
    failedTests: [{ file: "test/math.test.ts", name: "math > adds", kind: "failed" }],
  });
  const context = { cwd: root, reportDir: "/r", item: { exec: ["bun", "test"] } };
  expect(await bunTestAdapter.plan(context as unknown as TestContext)).toMatchObject({
    invocations: [{ argv: ["bun", "test", "--reporter=junit", "--reporter-outfile=/r/junit.xml"] }],
    report: { kind: "junit", paths: ["/r/junit.xml"] },
  });
});

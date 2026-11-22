import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePolicyFiles } from "../facade";
import { createCloseoutSession } from "../session";
import type { TestSelect } from "../types";
import { snapshotAt, testChanges } from "./git";
import { bunTestAdapter, type TestContext, type TestPlan } from "./index";

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
  expect(bunTestAdapter.full(context as unknown as TestContext)).toMatchObject({
    invocations: [{ argv: ["bun", "test", "--reporter=junit", "--reporter-outfile=/r/junit.xml"] }],
    report: { kind: "junit", paths: ["/r/junit.xml"] },
  });
});

const FILES: Record<string, string> = {
  "package.json": '{"workspaces":["packages/*"],"devDependencies":{"left-pad":"1"}}',
  "tsconfig.json": '{\n  // aliases\n  "compilerOptions": { "paths": { "@lib/*": ["lib/*"] } },\n}',
  "bunfig.toml": '[test]\npreload = ["./test/setup.ts"]\n',
  "test/setup.ts": "export {};\n",
  "lib/math.ts": "export const add = (a: number, b: number) => a + b;\n",
  "lib/index.ts": 'export * from "./math";\n',
  "lib/old.ts": "export const old = 1;\n",
  "lib/alias.ts": "export const viaAlias = 1;\n",
  "lib/style.css": "a {}\n",
  "packages/util/package.json": '{"name":"@fx/util","main":"src/index.ts"}',
  "packages/util/src/index.ts": "export const util = 1;\n",
  "test/barrel.test.ts": 'import { add } from "../lib";\nimport "left-pad";\nadd(1, 2);\n',
  "test/old.test.ts": 'import { old } from "../lib/old";\nold;\n',
  "test/alias.test.ts": 'import { viaAlias } from "@lib/alias";\nviaAlias;\n',
  "test/lazy.test.ts": 'await import("../lib/math.ts");\n',
  "test/util.test.ts": 'import { util } from "@fx/util";\nimport "../lib/style.css";\nutil;\n',
  "test/strings.test.ts":
    'import { test } from "bun:test";\nimport { join } from "node:path";\nconst s = `require(${join("x")})`;\nconst r = /import\\(/;\ntest("s", () => [s, r]);\n',
  "test/always.test.ts": "export {};\n",
};

async function planned(
  edits: Record<string, string | null>,
  select: Partial<TestSelect> = {},
  paths?: string[],
): Promise<TestPlan> {
  const root = mkdtempSync(join(tmpdir(), "paws-bun-graph-"));
  roots.push(root);
  spawnSync("git", ["init", "-b", "main"], { cwd: root });
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  commit(root, "package.json", FILES["package.json"]!);
  const base = git(root, "rev-parse", "HEAD");
  for (const [path, text] of Object.entries(edits)) {
    if (text === null) rmSync(join(root, path));
    else {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
  }
  git(root, "add", "-A");
  git(root, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-m", "head");
  const head = git(root, "rev-parse", "HEAD");
  const env = { PATH: process.env.PATH ?? "" };
  return bunTestAdapter.plan({
    item: {
      id: "test",
      kind: "command",
      gate: "beforePR",
      exec: ["bun", "test"],
      timeoutSeconds: 60,
      select: { runner: "bun", ...select },
      ...(paths ? { paths } : {}),
    },
    cwd: root,
    base,
    head,
    reportDir: "/r",
    env,
    deadline: Date.now() + 60_000,
    changes: () => testChanges(root, base, head, env),
    readAtBase: async () => undefined,
    readAtHead: async () => undefined,
    snapshot: (at) => snapshotAt(root, at, env),
  });
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

const targets = (plan: TestPlan) =>
  plan.selection.mode === "selected" ? plan.selection.targets : plan.selection.reasons;

test("a changed module selects exactly the tests that reach it at base or head", async () => {
  const plan = await planned({
    "lib/math.ts": "export const add = (a: number, b: number) => b + a;\n",
    "test/new.test.ts": 'import { add } from "../lib/math";\nadd(1, 1);\n',
  });
  expect(targets(plan)).toEqual(["test/barrel.test.ts", "test/lazy.test.ts", "test/new.test.ts"]);
  expect(plan.invocations[0]?.argv).toEqual([
    "bun",
    "test",
    "--reporter=junit",
    "--reporter-outfile=/r/junit.xml",
    "./test/barrel.test.ts",
    "./test/lazy.test.ts",
    "./test/new.test.ts",
  ]);
  expect(targets(await planned({ "lib/old.ts": null }))).toEqual(["test/old.test.ts"]);
  expect(targets(await planned({ "lib/alias.ts": "export const viaAlias = 2;\n" }))).toEqual([
    "test/alias.test.ts",
  ]);
  expect(
    targets(await planned({ "packages/util/src/index.ts": "export const util = 2;\n" })),
  ).toEqual(["test/util.test.ts"]);
  expect(
    targets(await planned({ "lib/style.css": "b {}\n" }, { always: ["test/always.test.ts"] })),
  ).toEqual(["test/always.test.ts", "test/util.test.ts"]);
  expect(
    targets(await planned({ "README.md": "x\n" }, { always: ["test/always.test.ts"] }, ["lib/"])),
  ).toEqual(["test/always.test.ts"]);
});

test("the bun runner runs the full suite when it can't prove the selection", async () => {
  const math = { "lib/math.ts": "export const add = 2;\n" };
  const reasons = async (...args: Parameters<typeof planned>) => {
    const plan = await planned(...args);
    expect(plan.selection.mode).toBe("full");
    expect(plan.invocations[0]?.argv).toHaveLength(4);
    return plan.selection.reasons;
  };
  expect(
    await reasons({ "lib/index.ts": 'export * from "./math";\nrequire(process.env.X!);\n' }),
  ).toEqual(["at head: lib/index.ts has a non-literal dynamic import or require"]);
  expect(
    await reasons({ "test/lazy.test.ts": "await import(`../lib/${process.env.X}`);\n" }),
  ).toEqual(["at head: test/lazy.test.ts has a non-literal dynamic import or require"]);
  expect(await reasons({ "package.json": "{}" })).toContain("package.json changed");
  expect(await reasons({ "test/setup.ts": "export const x = 1;\n" })).toContain(
    "test/setup.ts changed",
  );
  expect(await reasons({ "README.md": "x\n" }, { always: ["test/always.test.ts"] })).toEqual([
    "README.md changed, and the bun runner doesn't know its file type",
  ]);
  expect(await reasons(math, { max_selected: 1 })).toEqual([
    "2 test files are selected, more than max_selected 1",
  ]);
  expect(await reasons(math, { full_on: ["lib/**"] })).toEqual([
    "lib/math.ts matches select.full_on",
  ]);
  expect(await reasons({ "lib/unused.ts": "export {};\n" })).toEqual([
    "no test file reaches a changed path, and select.always is empty",
  ]);
  expect(
    await reasons({ "test/odd.test.ts": 'import "./generated";\nimport "left-pad-2";\n' }),
  ).toEqual([
    "at head: test/odd.test.ts imports ./generated, which the graph can't follow",
    "at head: test/odd.test.ts imports left-pad-2, which the graph can't follow",
  ]);
  const missing = await planned(math, { always: ["test/gone.test.ts"] });
  expect([missing.invocations, missing.problem]).toEqual([
    [],
    "select.always names test/gone.test.ts, which the head doesn't have",
  ]);
});

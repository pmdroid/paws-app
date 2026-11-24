import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePolicyFiles } from "../facade";
import { createCloseoutSession, type CloseoutSessionEvent } from "../session";
import type { TestSelect } from "../types";
import { snapshotAt, testChanges } from "./git";
import {
  bunTestAdapter,
  jestTestAdapter,
  runTestCheck,
  vitestTestAdapter,
  type TestAdapter,
  type TestContext,
  type TestPlan,
} from "./index";

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
  const events: CloseoutSessionEvent[] = [];
  const session = () =>
    createCloseoutSession(root, {
      policy: async () => workspacePolicyFiles(root),
      allowCommand: (argv) => void ran.push([...argv]),
      onProgress: (event) => void events.push(event),
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
  expect(events.at(-1)).toMatchObject({
    type: "finished",
    state: "failed",
    failedTests: {
      total: 1,
      shown: [{ file: "test/math.test.ts", name: "math > adds", kind: "failed" }],
    },
    testSelection: {
      mode: "selected",
      reasons: [
        "test/math.test.ts reaches a changed path",
        "test/ok.test.ts reaches a changed path",
      ],
      selected: 2,
    },
  });
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
  adapter: TestAdapter = bunTestAdapter,
  exec = ["bun", "test"],
  setup: (root: string) => void = () => {},
): Promise<TestPlan> {
  const root = mkdtempSync(join(tmpdir(), "paws-bun-graph-"));
  roots.push(root);
  spawnSync("git", ["init", "-b", "main"], { cwd: root });
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  setup(root);
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
  return adapter.plan({
    item: {
      id: "test",
      kind: "command",
      gate: "beforePR",
      exec,
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

test("over_max direct runs the change's direct tests when the selection is over max_selected", async () => {
  const colocated = {
    "lib/math.ts": "export const add = 2;\n",
    "lib/math.test.ts": 'import { add } from "./math";\nadd;\n',
  };
  const direct = await planned(colocated, {
    max_selected: 1,
    over_max: "direct",
    always: ["test/always.test.ts"],
  });
  expect(direct.selection).toEqual({
    mode: "selected",
    targets: ["lib/math.test.ts", "test/always.test.ts"],
    reasons: [
      "4 test files are selected, more than max_selected 1; running the change's direct tests and leaving 2 to CI",
      "lib/math.test.ts is a direct test of the change",
      "test/always.test.ts is in select.always",
    ],
  });
  expect(direct.invocations[0]?.argv.slice(-2)).toEqual([
    "./lib/math.test.ts",
    "./test/always.test.ts",
  ]);
  const elsewhere = await planned(
    {
      "lib/math.ts": "export const add = 2;\n",
      "test/new.test.ts": 'import { add } from "../lib/math";\nadd;\n',
    },
    { max_selected: 1, over_max: "direct" },
  );
  expect(targets(elsewhere)).toEqual(["test/new.test.ts"]);
  const fullOn = await planned(colocated, {
    max_selected: 1,
    over_max: "direct",
    full_on: ["lib/math.ts"],
  });
  expect(fullOn.selection).toEqual({
    mode: "full",
    reasons: ["lib/math.ts matches select.full_on"],
  });
  const under = await planned(colocated, { max_selected: 10, over_max: "direct" });
  expect(targets(under)).toEqual(["lib/math.test.ts", "test/barrel.test.ts", "test/lazy.test.ts"]);
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
  expect(
    await reasons(
      { "lib/math.ts": "export const add = 2;\n" },
      { max_selected: 1, over_max: "direct" },
    ),
  ).toEqual([
    "2 test files are selected, more than max_selected 1, and the change has no direct test",
  ]);
  const missing = await planned(math, { always: ["test/gone.test.ts"] });
  expect([missing.invocations, missing.problem]).toEqual([
    [],
    "select.always names test/gone.test.ts, which the head doesn't have",
  ]);
});

const JEST_JUNIT = (root: string) => {
  mkdirSync(join(root, "node_modules/jest-junit"), { recursive: true });
  writeFileSync(join(root, "node_modules/jest-junit/package.json"), '{"name":"jest-junit"}');
  writeFileSync(join(root, "node_modules/jest-junit/index.js"), "");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
};

const VITEST_FAILING = `<testsuites name="vitest tests"><testsuite name="test/math.test.ts" tests="2" failures="1">
<testcase classname="test/math.test.ts" name="math &gt; adds"><failure message="expected 2 to be 3" /></testcase>
<testcase classname="test/math.test.ts" name="top" /></testsuite></testsuites>`;
const JEST_FAILING = `<testsuites name="jest tests"><testsuite name="math" tests="2" failures="1">
<testcase classname="math" name="adds" file="test/math.test.ts"><failure>Error: expect(received).toBe(expected)</failure></testcase>
<testcase classname="" name="top" file="test/math.test.ts" /></testsuite></testsuites>`;

test("vitest and jest select what the bun runner selects and name the failed test", async () => {
  const change = { "lib/math.ts": "export const add = (a: number, b: number) => b + a;\n" };
  const bun = await planned(change);
  const vitest = await planned(change, {}, undefined, vitestTestAdapter, ["npx", "vitest", "run"]);
  const jest = await planned(change, {}, undefined, jestTestAdapter, ["jest"], JEST_JUNIT);
  expect(targets(vitest)).toEqual(targets(bun));
  expect(targets(jest)).toEqual(targets(bun));
  expect(vitest.invocations[0]?.argv).toEqual([
    ...["npx", "vitest", "run", "--reporter=default", "--reporter=junit"],
    "--outputFile=/r/junit.xml",
    ...targets(bun).map((path) => `./${path}`),
  ]);
  const argv = jest.invocations[0]?.argv ?? [];
  expect(argv.slice(0, 2)).toEqual(["env", "JEST_JUNIT_OUTPUT_DIR=/r"]);
  expect(argv.slice(argv.indexOf("jest"))).toEqual([
    ...["jest", "--reporters=default", "--reporters=jest-junit", "--runTestsByPath"],
    ...targets(bun),
  ]);
  const config = (adapter: TestAdapter, exec: string[], path: string) =>
    planned({ [path]: "export default {};\n" }, {}, undefined, adapter, exec, JEST_JUNIT);
  for (const path of ["vitest.config.ts", "vite.config.mjs"]) {
    const plan = await config(vitestTestAdapter, ["vitest", "run"], path);
    expect(plan.selection.reasons).toContain(`${path} changed`);
  }
  for (const path of ["jest.config.js", "babel.config.cjs"]) {
    const plan = await config(jestTestAdapter, ["bunx", "jest"], path);
    expect(plan.selection.reasons).toContain(`${path} changed`);
  }
  for (const [adapter, report] of [
    [vitestTestAdapter, VITEST_FAILING],
    [jestTestAdapter, JEST_FAILING],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), "paws-js-runner-"));
    roots.push(root);
    JEST_JUNIT(root);
    const result = await runTestCheck({
      item: {
        ...{ id: "t", kind: "command", gate: "beforePR", exec: ["jest"], timeoutSeconds: 60 },
        select: { runner: "jest" },
      },
      cwd: root,
      base: "HEAD",
      head: "HEAD",
      env: {},
      adapter: { plan: (context) => adapter.full(context), full: adapter.full },
      execute: async (invocation) => {
        const out = invocation.argv.find((part) => part.startsWith("--outputFile="));
        const dir = invocation.argv.find((part) => part.startsWith("JEST_JUNIT_OUTPUT_DIR="));
        const path = out?.slice(13) ?? join(dir!.slice(22), "junit.xml");
        writeFileSync(path, report);
        return { code: 1, timedOut: false };
      },
    });
    expect(result.failures).toMatchObject([
      { file: "test/math.test.ts", name: "math > adds", kind: "failed" },
    ]);
  }
});

test("jest fails the check when jest-junit can't be resolved from the root", async () => {
  const change = { "lib/math.ts": "export const add = 2;\n" };
  const plan = await planned(change, {}, undefined, jestTestAdapter, ["jest"]);
  expect([plan.invocations, plan.problem]).toEqual([[], "jest-junit is not installed"]);
  const context = { cwd: "/nowhere", reportDir: "/r", item: { exec: ["jest"] } };
  expect(jestTestAdapter.full(context as unknown as TestContext).problem).toBe(
    "jest-junit is not installed",
  );
});
test("a report problem is a failed test in the session result and the finished event", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-bun-problem-"));
  roots.push(root);
  spawnSync("git", ["init", "-b", "main"], { cwd: root });
  commit(
    root,
    ".agents/closeout.yaml",
    POLICY.replace("runner: bun", 'runner: bun, always: ["test/gone.test.ts"]'),
  );
  spawnSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });
  commit(root, "test/ok.test.ts", 'import { test } from "bun:test";\ntest("fine", () => {});\n');
  const events: CloseoutSessionEvent[] = [];
  const session = createCloseoutSession(root, {
    policy: async () => workspacePolicyFiles(root),
    onProgress: (event) => void events.push(event),
  });
  await session.run("test");
  const problem = {
    message: "select.always names test/gone.test.ts, which the head doesn't have",
    kind: "error",
  };
  const report = JSON.parse(await session.report()) as { required: { result?: unknown }[] };
  expect(report.required[0]?.result).toMatchObject({ failedTests: [problem] });
  expect(events.at(-1)).toMatchObject({ failedTests: { total: 1, shown: [problem] } });
});

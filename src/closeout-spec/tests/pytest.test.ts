import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyParser } from "../policy/document";
import policySchema from "../schema/policy.schema.json" with { type: "json" };
import { runTestCheck, selectExecError, type TestCheckResult, type TestExecuted } from "./index";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PYTEST = process.env.PAWS_TEST_PYTEST ?? "pytest";
const HAS_PYTEST = spawnSync(PYTEST, ["--version"]).status === 0;

const FAILED = `<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="0" failures="1" skipped="0" tests="2"><testcase classname="tests.test_math" name="test_ok" file="tests/test_math.py" line="0" /><testcase classname="tests.test_math.TestAdd" name="test_bad" file="tests/test_math.py" line="3"><failure message="assert 1 == 2">E       assert 1 == 2</failure></testcase></testsuite></testsuites>`;
const COLLECTION = `<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="1" failures="0" skipped="0" tests="1"><testcase classname="" name="tests.test_broken" file="tests/test_broken.py"><error message="collection failure">ModuleNotFoundError: No module named 'nope'</error></testcase></testsuite></testsuites>`;

type Execute = (argv: string[], cwd: string) => TestExecuted;

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "paws-pytest-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

async function check(root: string, execute: Execute, exec = [PYTEST, "-q"]) {
  const argvs: string[][] = [];
  const result: TestCheckResult<TestExecuted> = await runTestCheck({
    item: {
      id: "test",
      kind: "command",
      gate: "beforePR",
      exec,
      timeoutSeconds: 60,
      select: { runner: "pytest" },
    },
    cwd: root,
    base: "a".repeat(40),
    head: "b".repeat(40),
    env: {},
    reportRoot: root,
    execute: async ({ argv, cwd }) => (argvs.push(argv), execute(argv, cwd)),
  });
  return { result, argvs };
}

function writing(report: string | undefined, code: number): Execute {
  return (argv) => {
    const path = argv.at(-1)!.replace("--junitxml=", "");
    if (report !== undefined) writeFileSync(path, report);
    return { code, timedOut: false };
  };
}

const real: Execute = (argv, cwd) => {
  const ran = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8" });
  return { code: ran.status ?? 1, timedOut: false };
};

test("the pytest runner runs exec in full with a JUnit report and names failed and broken tests", async () => {
  const root = project({});
  const failed = await check(root, writing(FAILED, 1), ["uv", "run", "pytest", "-x"]);
  expect(failed.argvs[0]!.slice(0, 6)).toEqual([
    "uv",
    "run",
    "pytest",
    "-x",
    "-o",
    "junit_family=xunit1",
  ]);
  expect(failed.argvs[0]![6]).toMatch(/^--junitxml=.+\/junit\.xml$/);
  expect(failed.result).toMatchObject({
    ok: false,
    selection: { mode: "full" },
    failures: [
      { file: "tests/test_math.py", name: "tests.test_math.TestAdd > test_bad", kind: "failed" },
    ],
  });
  const broken = await check(root, writing(COLLECTION, 2));
  expect(broken.result).toMatchObject({
    ok: false,
    failures: [{ file: "tests/test_broken.py", name: "tests.test_broken", kind: "error" }],
  });
  expect((await check(root, writing(FAILED, 0))).result.ok).toBe(false);
  const missing = await check(root, writing(undefined, 0));
  expect(missing.result.ok).toBe(false);
  expect(missing.result.problem).toMatch(/junit\.xml is missing$/);
});

test.skipIf(!HAS_PYTEST)("a fixture Python project reports through real pytest", async () => {
  const root = project({
    "tests/test_math.py": "def test_ok():\n    assert 1\n\ndef test_bad():\n    assert 1 == 2\n",
  });
  const failed = await check(root, real);
  expect(failed.result.failures).toMatchObject([
    { file: "tests/test_math.py", name: "tests.test_math > test_bad", kind: "failed" },
  ]);
  writeFileSync(join(root, "tests/test_broken.py"), "import nope\n");
  const broken = await check(root, real);
  expect(broken.result.ok).toBe(false);
  expect(broken.result.failures).toContainEqual(
    expect.objectContaining({ file: "tests/test_broken.py", kind: "error" }),
  );
  rmSync(join(root, "tests"), { recursive: true });
  expect((await check(root, real)).result.problem).toBe("the test report lists no tests");
});

test("pytest exec must run pytest with options only", () => {
  for (const exec of [
    ["pytest"],
    ["python", "-m", "pytest", "-q"],
    ["uv", "run", "pytest", "--maxfail=1", "-qx", "-pno:cacheprovider", "-rfE"],
    ["poetry", "run", "pytest", "--tb=short"],
  ]) {
    expect(selectExecError("pytest", exec)).toBeUndefined();
  }
  for (const exec of [
    ["pytest", "tests/test_a.py"],
    ["pytest", "-k", "fast"],
    ["pytest", "-kfast"],
    ["pytest", "-qkfast"],
    ["pytest", "-vxk", "fast"],
    ["pytest", "-h"],
    ["pytest", "--keyword=fast"],
    ["pytest", "--junitxml=out.xml"],
    ["pytest", "--junit-xml=out.xml"],
    ["python", "pytest"],
    ["pytest", "-p", "no:cacheprovider"],
    ["tox"],
  ]) {
    expect(selectExecError("pytest", exec)).toContain("select runner pytest needs exec");
  }
  const parse = createPolicyParser(policySchema);
  const policy = (exec: string) =>
    `specVersion: "0.1"\nitems:\n  - id: test\n    kind: command\n    gate: beforePR\n    exec: ${exec}\n    timeoutSeconds: 60\n    select: { runner: pytest }\n`;
  expect(parse(policy('["python", "-m", "pytest", "-q"]'))).toMatchObject({
    ok: true,
    document: { items: [{ select: { runner: "pytest" } }] },
  });
  expect(parse(policy('["pytest", "tests"]'))).toMatchObject({ ok: false });
});

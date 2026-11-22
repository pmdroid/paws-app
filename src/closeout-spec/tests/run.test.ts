import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failedTestsText, parseJunit, runTestCheck } from "./index";
import type { TestAdapter, TestContext, TestExecution, TestInvocation, TestPlan } from "./index";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CLEAN = `<testsuites><testsuite name="a" file="test/a.test.ts"><testcase name="works" /></testsuite></testsuites>`;
const FAILING = `<testsuites><testsuite name="a" file="test/a.test.ts"><testsuite name="group"><testcase name="adds" classname="group" file="test/a.test.ts"><failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: 3" /></testcase></testsuite></testsuite></testsuites>`;

const context: Omit<TestContext, "reportDir"> = {
  item: {
    id: "test",
    kind: "command",
    gate: "beforePR",
    exec: ["bun", "test"],
    timeoutSeconds: 60,
    select: { runner: "bun" },
  },
  cwd: "/repo",
  base: "a".repeat(40),
  head: "b".repeat(40),
  changes: async () => [],
  readAtBase: async () => undefined,
  readAtHead: async () => undefined,
};

function plan(dir: string, mode: "full" | "selected", argv: string[] = [mode]): TestPlan {
  return {
    selection:
      mode === "full"
        ? { mode, reasons: ["full"] }
        : { mode, targets: ["test/a.test.ts"], reasons: ["changed"] },
    invocations: [{ cwd: "/repo", argv }],
    report: { kind: "junit", paths: [join(dir, "junit.xml")] },
  };
}

function adapter(selected: (dir: string) => TestPlan): TestAdapter {
  return {
    plan: (ctx) => selected(ctx.reportDir),
    full: (ctx) => plan(ctx.reportDir, "full"),
  };
}

async function check(selected: (dir: string) => TestPlan, { code = 0 }: { code?: number }) {
  const reportRoot = mkdtempSync(join(tmpdir(), "paws-tests-core-"));
  roots.push(reportRoot);
  const ran: TestInvocation[] = [];
  const result = await runTestCheck({
    adapter: adapter(selected),
    context,
    timeoutSeconds: 60,
    reportRoot,
    execute: async (invocation): Promise<TestExecution> => {
      ran.push(invocation);
      return {
        code,
        timedOut: false,
        cancelled: false,
        output: "out\n",
        full: "out\n",
        stdout: "out\n",
        stderr: "",
        truncated: false,
      };
    },
  });
  return { result, ran };
}

function writing(report: string | undefined, mode: "full" | "selected", argv?: string[]) {
  return (dir: string) => {
    if (report !== undefined) writeFileSync(join(dir, "junit.xml"), report);
    return plan(dir, mode, argv);
  };
}

test("a selected plan runs only its invocations and passes on a clean report and exit 0", async () => {
  const { result, ran } = await check(writing(CLEAN, "selected", ["only", "these"]), {});
  expect(ran.map((entry) => entry.argv)).toEqual([["only", "these"]]);
  expect(result).toMatchObject({
    ok: true,
    code: 0,
    failures: [],
    selection: { mode: "selected" },
  });
});

test("a planning error falls back to the full plan and records why", async () => {
  const { result, ran } = await check(() => {
    throw new Error("no import graph");
  }, {});
  expect(ran.map((entry) => entry.argv)).toEqual([["full"]]);
  expect(result.selection).toEqual({
    mode: "full",
    reasons: ["full", "planning failed: no import graph"],
  });
  expect(result.ok).toBe(false);
  expect(result.problem).toEndWith("junit.xml is missing");
});

test("a missing, unparseable, failing or empty report and a nonzero exit fail the check", async () => {
  const missing = await check(writing(undefined, "selected"), {});
  expect(missing.result).toMatchObject({ ok: false });
  expect(missing.result.problem).toMatch(/^test report .*junit\.xml is missing$/);
  const broken = await check(writing("<testsuites><testsuite>", "selected"), {});
  expect(broken.result.ok).toBe(false);
  expect(broken.result.problem).toContain("is not valid XML");
  const failing = await check(writing(FAILING, "selected"), { code: 0 });
  expect(failing.result.ok).toBe(false);
  expect(failing.result.failures).toEqual([
    {
      file: "test/a.test.ts",
      name: "group > adds",
      message: "expect(received).toBe(expected)\n\nExpected: 3",
      kind: "failed",
    },
  ]);
  const exited = await check(writing(CLEAN, "selected"), { code: 1 });
  expect(exited.result).toMatchObject({ ok: false, code: 1, failures: [] });
  const empty = await check(writing("<testsuites />", "selected"), {});
  expect(empty.result.problem).toBe("the test report lists no tests");
  const intended = await check(
    (dir) => ({ ...writing("<testsuites />", "selected")(dir), intentionallyEmpty: true }),
    {},
  );
  expect(intended.result.ok).toBe(true);
});

test("a report of kind none passes on exit status alone", async () => {
  const none = (dir: string): TestPlan => ({ ...plan(dir, "selected"), report: { kind: "none" } });
  expect((await check(none, {})).result.ok).toBe(true);
  expect((await check(none, { code: 2 })).result.ok).toBe(false);
});

test("each attempt gets a fresh report directory that is removed afterwards", async () => {
  const seen: string[] = [];
  const record = (dir: string) => {
    seen.push(dir);
    return writing(CLEAN, "selected")(dir);
  };
  await check(record, {});
  await check(record, {});
  expect(new Set(seen).size).toBe(2);
  expect(seen.some((dir) => existsSync(dir))).toBe(false);
});

test("JUnit parsing refuses entities and DTDs, reads errors and caps the list for the agent", () => {
  expect(parseJunit(`<!DOCTYPE x [<!ENTITY e "boom">]><testsuites>&e;</testsuites>`)).toEqual({
    ok: false,
    message: "declares a DTD or entities",
  });
  expect(parseJunit(`<testsuites>${" ".repeat(8 * 1024 * 1024)}</testsuites>`)).toEqual({
    ok: false,
    message: "is larger than 8 MB",
  });
  expect(parseJunit(`<testsuite name="s" errors="1" file="test/b.test.ts"></testsuite>`)).toEqual({
    ok: true,
    cases: 0,
    failures: [
      { file: "test/b.test.ts", message: "1 error before any test ran", kind: "skipped-crash" },
    ],
  });
  const errored = parseJunit(
    `<testsuites><testsuite><testcase name="t"><error>crashed &lt;here&gt;</error></testcase></testsuite></testsuites>`,
  );
  expect(errored).toEqual({
    ok: true,
    cases: 1,
    failures: [{ name: "t", message: "crashed <here>", kind: "error" }],
  });
  const many = Array.from({ length: 52 }, (_, index) => ({
    file: "test/a.test.ts",
    name: `case ${index}`,
    message: "boom\nstack",
    kind: "failed" as const,
  }));
  const text = failedTestsText(many).split("\n");
  expect(text[0]).toBe("Failed tests (52):");
  expect(text[1]).toBe("- test/a.test.ts: case 0: boom");
  expect(text).toHaveLength(52);
  expect(text.at(-1)).toBe("- and 2 more");
});

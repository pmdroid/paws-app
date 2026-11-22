import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failedTestsText, parseJunit, runTestCheck, type TestPlan } from "./index";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CLEAN = `<testsuites><testsuite file="test/a.test.ts"><testcase name="works" /></testsuite></testsuites>`;
const FAILING = `<testsuites><testsuite file="test/a.test.ts"><testcase name="adds" classname="group"><failure message="Expected: 3&#10;Received: 2" /></testcase></testsuite></testsuites>`;

type Planner = (dir: string) => TestPlan;

function selected(report: string | undefined, extra: Partial<TestPlan> = {}): Planner {
  return (dir) => {
    if (report !== undefined) writeFileSync(join(dir, "junit.xml"), report);
    return {
      selection: { mode: "selected", targets: ["test/a.test.ts"], reasons: ["changed"] },
      invocations: [{ cwd: "/repo", argv: ["only", "these"] }],
      report: { kind: "junit", paths: [join(dir, "junit.xml")] },
      ...extra,
    };
  };
}

async function check(plan: Planner, code = 0) {
  const reportRoot = mkdtempSync(join(tmpdir(), "paws-tests-core-"));
  roots.push(reportRoot);
  const ran: string[][] = [];
  const dirs: string[] = [];
  const result = await runTestCheck({
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
    env: {},
    reportRoot,
    adapter: {
      plan: (context) => (dirs.push(context.reportDir), plan(context.reportDir)),
      full: (context) => ({
        ...selected(CLEAN)(context.reportDir),
        invocations: [{ cwd: "/", argv: ["full"] }],
      }),
    },
    execute: async (invocation) => (ran.push(invocation.argv), { code, timedOut: false }),
  });
  return { result, ran, dirs };
}

test("a selected plan runs only its invocations and a clean report with exit 0 passes", async () => {
  const { result, ran, dirs } = await check(selected(CLEAN));
  expect(ran).toEqual([["only", "these"]]);
  expect(result).toMatchObject({ ok: true, failures: [], selection: { mode: "selected" } });
  expect(existsSync(dirs[0]!)).toBe(false);
  expect((await check(selected(CLEAN))).dirs[0]).not.toBe(dirs[0]);
});

test("a planning error falls back to the full plan and records why", async () => {
  const { result, ran } = await check(() => {
    throw new Error("no import graph");
  });
  expect(ran).toEqual([["full"]]);
  expect(result.selection.reasons).toEqual(["changed", "planning failed: no import graph"]);
});

test("a missing, unparseable, failing or empty report and a nonzero exit fail", async () => {
  const result = async (plan: Planner, code = 0) => (await check(plan, code)).result;
  expect((await result(selected(undefined))).problem).toMatch(/junit\.xml is missing$/);
  expect((await result(selected("<testsuites><testsuite>"))).problem).toContain("not valid XML");
  const failing = await result(selected(FAILING));
  expect(failing).toMatchObject({ ok: false, failures: [{ name: "group > adds" }] });
  expect(failing.failures[0]?.message).toBe("Expected: 3\nReceived: 2");
  expect(await result(selected(CLEAN), 1)).toMatchObject({ ok: false, failures: [] });
  expect((await result(selected("<testsuites />"))).problem).toBe("the test report lists no tests");
  expect((await result(selected("<testsuites />", { intentionallyEmpty: true }))).ok).toBe(true);
  const none = selected(undefined, { report: { kind: "none" } });
  expect([(await result(none)).ok, (await result(none, 2)).ok]).toEqual([true, false]);
});

test("JUnit parsing refuses DTDs, counts suite errors and caps the list for the agent", () => {
  expect(parseJunit(`<!DOCTYPE x [<!ENTITY e "x">]><testsuites>&e;</testsuites>`).ok).toBe(false);
  expect(parseJunit(`<testsuites>${" ".repeat(8 * 1024 * 1024)}</testsuites>`).ok).toBe(false);
  const errored = parseJunit(`<testsuite errors="1"><testcase name="passed" /></testsuite>`);
  expect(errored.ok && errored.failures).toEqual([
    { message: "1 error outside any test", kind: "skipped-crash" },
  ]);
  const many = Array.from({ length: 52 }, (_, index) => ({
    file: "test/a.test.ts",
    name: `case ${index}`,
    message: "boom\nstack",
    kind: "failed" as const,
  }));
  const text = failedTestsText(many).split("\n");
  expect([text[1], text.length, text.at(-1)]).toEqual([
    "- test/a.test.ts: case 0: boom",
    52,
    "- and 2 more",
  ]);
});

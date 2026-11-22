import { journalCaught } from "../../journal";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_REPORT_BYTES, parseJunit } from "./junit";
import type {
  FailedTest,
  TestAdapter,
  TestContext,
  TestInvocation,
  TestPlan,
  TestSelection,
} from "./types";

export type TestExecution = {
  code: number;
  timedOut: boolean;
  cancelled: boolean;
  output: string;
  full: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

export type TestExecute = (
  invocation: TestInvocation,
  timeoutSeconds: number,
) => Promise<TestExecution>;

export type TestCheckResult = TestExecution & {
  ok: boolean;
  selection: TestSelection;
  invocations: TestInvocation[];
  failures: FailedTest[];
  problem?: string;
};

export async function runTestCheck(input: {
  adapter: TestAdapter;
  context: Omit<TestContext, "reportDir">;
  execute: TestExecute;
  timeoutSeconds: number;
  reportRoot?: string;
}): Promise<TestCheckResult> {
  const reportDir = mkdtempSync(join(input.reportRoot ?? tmpdir(), "paws-test-report-"));
  try {
    const context: TestContext = { ...input.context, reportDir };
    const plan = await planOf(input.adapter, context);
    const deadline = Date.now() + input.timeoutSeconds * 1000;
    const ran: TestExecution = {
      code: 0,
      timedOut: false,
      cancelled: false,
      output: "",
      full: "",
      stdout: "",
      stderr: "",
      truncated: false,
    };
    for (const invocation of plan.invocations) {
      const left = (deadline - Date.now()) / 1000;
      const result =
        left > 0 ? await input.execute(invocation, left) : { ...ran, code: 1, timedOut: true };
      if (ran.code === 0) ran.code = result.code;
      ran.timedOut ||= result.timedOut;
      ran.cancelled ||= result.cancelled;
      ran.truncated ||= result.truncated;
      ran.output = (ran.output + result.output).slice(-6_000);
      ran.full += result.full;
      ran.stdout = (ran.stdout + result.stdout).slice(-24_000);
      ran.stderr = (ran.stderr + result.stderr).slice(-24_000);
      if (ran.timedOut || ran.cancelled) break;
    }
    const read = ran.cancelled || ran.timedOut ? { failures: [] } : readReport(plan);
    const failures = read.failures;
    const problem = "problem" in read ? read.problem : undefined;
    const ok =
      ran.code === 0 &&
      !ran.timedOut &&
      !ran.cancelled &&
      problem === undefined &&
      failures.length === 0;
    return {
      ...ran,
      ok,
      selection: plan.selection,
      invocations: plan.invocations,
      failures,
      ...(problem !== undefined ? { problem } : {}),
    };
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
}

async function planOf(adapter: TestAdapter, context: TestContext): Promise<TestPlan> {
  try {
    return await adapter.plan(context);
  } catch (error) {
    journalCaught(error, "tests.planOf.plan", context.item.id);
    const plan = adapter.full(context);
    const why = error instanceof Error ? error.message : String(error);
    return {
      ...plan,
      selection: { mode: "full", reasons: [...plan.selection.reasons, `planning failed: ${why}`] },
    };
  }
}

function readReport(plan: TestPlan): { failures: FailedTest[]; problem?: string } {
  if (plan.report.kind === "none") return { failures: [] };
  if (plan.report.kind === "go-json") {
    return { failures: [], problem: "go-json test reports are not read yet" };
  }
  const failures: FailedTest[] = [];
  let cases = 0;
  for (const path of plan.report.paths) {
    let text: string;
    try {
      if (statSync(path).size > MAX_REPORT_BYTES) {
        return { failures, problem: `test report ${path} is larger than 8 MB` };
      }
      text = readFileSync(path, "utf8");
    } catch (error) {
      journalCaught(error, "tests.readReport.readFileSync", null, "the report may be absent");
      return { failures, problem: `test report ${path} is missing` };
    }
    const parsed = parseJunit(text);
    if (!parsed.ok) return { failures, problem: `test report ${path} ${parsed.message}` };
    cases += parsed.cases;
    failures.push(...parsed.failures);
  }
  if (cases === 0 && !plan.intentionallyEmpty) {
    return { failures, problem: "the test report lists no tests" };
  }
  return { failures };
}

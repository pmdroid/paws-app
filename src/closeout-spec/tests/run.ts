import { journalCaught } from "../../journal";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAt, snapshotAt, testChanges } from "./git";
import { MAX_GO_REPORT_BYTES, parseGoJson } from "./go-json";
import { MAX_REPORT_BYTES, parseJunit } from "./junit";
import { adapterFor } from "./select";
import type {
  FailedTest,
  SelectedCommand,
  TestAdapter,
  TestContext,
  TestInvocation,
  TestPlan,
  TestSelection,
} from "./types";

export type TestExecuted = { code: number; timedOut: boolean; cancelled?: boolean };

export type TestCheckResult<R> = {
  ok: boolean;
  results: R[];
  selection: TestSelection;
  failures: FailedTest[];
  problem?: string;
  note?: string;
};

export async function runTestCheck<R extends TestExecuted>(input: {
  item: SelectedCommand;
  cwd: string;
  base: string;
  head: string;
  env: Record<string, string>;
  execute: (invocation: TestInvocation, timeoutSeconds: number) => Promise<R>;
  adapter?: TestAdapter;
  reportRoot?: string;
}): Promise<TestCheckResult<R>> {
  const { item, cwd, base, head, env } = input;
  const reportDir = mkdtempSync(join(input.reportRoot ?? tmpdir(), "paws-test-report-"));
  const deadline = Date.now() + item.timeoutSeconds * 1000;
  try {
    const context: TestContext = {
      item,
      cwd,
      base,
      head,
      reportDir,
      env,
      deadline,
      changes: () => testChanges(cwd, base, head, env),
      readAtBase: (path) => readAt(cwd, base, path, env),
      readAtHead: (path) => readAt(cwd, head, path, env),
      snapshot: (commit) => snapshotAt(cwd, commit, env),
    };
    const adapter = input.adapter ?? adapterFor(item.select.runner);
    const plan = await planOf(adapter, context);
    if (plan.problem !== undefined) {
      return {
        ok: false,
        results: [],
        selection: plan.selection,
        failures: [],
        problem: plan.problem,
      };
    }
    const results: R[] = [];
    let ran = true;
    for (const invocation of plan.invocations) {
      const left = (deadline - Date.now()) / 1000;
      const result = left > 0 ? await input.execute(invocation, left) : undefined;
      if (result) results.push(result);
      if (!result || result.timedOut || result.cancelled) {
        ran = false;
        break;
      }
    }
    const read = ran ? readReport(plan) : { failures: [] };
    const ok =
      ran &&
      results.every((result) => result.code === 0) &&
      read.problem === undefined &&
      read.failures.length === 0;
    return {
      ok,
      results,
      selection: plan.selection,
      ...read,
      ...(plan.note ? { note: plan.note } : {}),
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
    const { path } = plan.report;
    let text: string;
    try {
      if (statSync(path).size > MAX_GO_REPORT_BYTES) {
        return { failures: [], problem: `test report ${path} is larger than 64 MB` };
      }
      text = readFileSync(path, "utf8");
    } catch (error) {
      journalCaught(error, "tests.readReport.goJson", null, "the report may be absent");
      return { failures: [], problem: `test report ${path} is missing` };
    }
    const parsed = parseGoJson(text);
    if (!parsed.ok) return { failures: [], problem: `test report ${path} ${parsed.message}` };
    if (parsed.cases === 0 && !plan.intentionallyEmpty) {
      return { failures: parsed.failures, problem: "the test report lists no tests" };
    }
    return { failures: parsed.failures };
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
      const why = plan.report.missing ? `: ${plan.report.missing}` : "";
      return { failures, problem: `test report ${path} is missing${why}` };
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

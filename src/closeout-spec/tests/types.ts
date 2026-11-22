import type { ResolvedCommand, TestSelect } from "../types";

export type SelectedCommand = ResolvedCommand & { select: TestSelect };

export type TestChange = { status: string; path: string; oldPath?: string };

export type TestSelection =
  | { mode: "full"; reasons: string[] }
  | { mode: "selected"; targets: string[]; reasons: string[] };

export type TestInvocation = { cwd: string; argv: string[] };

export type TestReport =
  | { kind: "junit"; paths: string[] }
  | { kind: "go-json"; path: string }
  | { kind: "none" };

export type TestPlan = {
  selection: TestSelection;
  invocations: TestInvocation[];
  report: TestReport;
  intentionallyEmpty?: boolean;
};

export type TestContext = {
  item: SelectedCommand;
  cwd: string;
  base: string;
  head: string;
  reportDir: string;
  changes(): Promise<TestChange[]>;
  readAtBase(path: string): Promise<string | undefined>;
  readAtHead(path: string): Promise<string | undefined>;
};

export type TestAdapter = {
  plan(context: TestContext): TestPlan | Promise<TestPlan>;
  full(context: TestContext): TestPlan;
};

export type FailedTest = {
  file?: string;
  name?: string;
  message: string;
  kind: "failed" | "error" | "skipped-crash";
};

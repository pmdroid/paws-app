import { join } from "node:path";
import type { TestSelect } from "../types";
import type { TestAdapter, TestContext, TestPlan } from "./types";

function fullPlan(context: TestContext): TestPlan {
  const outfile = join(context.reportDir, "junit.xml");
  return {
    selection: { mode: "full", reasons: ["the bun runner runs the full suite"] },
    invocations: [
      {
        cwd: context.cwd,
        argv: [...context.item.exec, "--reporter=junit", `--reporter-outfile=${outfile}`],
      },
    ],
    report: { kind: "junit", paths: [outfile] },
  };
}

export const bunTestAdapter: TestAdapter = { plan: fullPlan, full: fullPlan };

export function selectExecError(
  runner: TestSelect["runner"],
  exec: readonly string[],
): string | undefined {
  const [command, verb, ...rest] = exec;
  if (command === "bun" && verb === "test" && rest.every((part) => part.startsWith("-"))) {
    return undefined;
  }
  return `select runner ${runner} needs exec to start with "bun", "test" and pass only flags, as --flag=value`;
}

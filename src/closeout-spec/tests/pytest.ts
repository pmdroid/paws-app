import { join } from "node:path";
import type { TestAdapter, TestContext, TestPlan } from "./types";

const PREFIXES = [
  ["pytest"],
  ["py.test"],
  ["python", "-m", "pytest"],
  ["python3", "-m", "pytest"],
  ["uv", "run", "pytest"],
  ["uv", "run", "python", "-m", "pytest"],
  ["poetry", "run", "pytest"],
  ["poetry", "run", "python", "-m", "pytest"],
];

const REFUSED = /^--(keyword|junit-?xml)(=|$)/;
const SHORT_FLAGS = "qvxsl";
const SHORT_VALUED = "pWrocmn";

function optionAllowed(part: string): boolean {
  if (part.startsWith("--")) return !REFUSED.test(part);
  if (!part.startsWith("-") || part.length < 2) return false;
  for (const letter of part.slice(1)) {
    if (SHORT_FLAGS.includes(letter)) continue;
    return SHORT_VALUED.includes(letter);
  }
  return true;
}

function fullPlan(context: TestContext): TestPlan {
  const outfile = join(context.reportDir, "junit.xml");
  return {
    selection: { mode: "full", reasons: ["the pytest runner runs the full suite"] },
    invocations: [
      {
        cwd: context.cwd,
        argv: [...context.item.exec, "-o", "junit_family=xunit1", `--junitxml=${outfile}`],
      },
    ],
    report: { kind: "junit", paths: [outfile] },
  };
}

export const pytestTestAdapter: TestAdapter = { plan: fullPlan, full: fullPlan };

export function pytestExecError(exec: readonly string[]): string | undefined {
  const prefix = PREFIXES.find((start) => start.every((part, index) => exec[index] === part));
  const options = exec.slice(prefix?.length ?? 0);
  if (prefix && options.every(optionAllowed)) {
    return undefined;
  }
  return `select runner pytest needs exec to run pytest, as "pytest", "python -m pytest", "uv run pytest" or "poetry run pytest", and pass only options, as --option=value, without -k or --junitxml`;
}

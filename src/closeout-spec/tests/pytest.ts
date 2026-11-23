import { join, posix } from "node:path";
import { anyPathMatches, pathMatches } from "../evaluate/paths";
import {
  isPythonTest,
  namespaceProblems,
  PYTHON_READ,
  pythonAffected,
  rootOf,
  under,
} from "./python";
import type { Snapshot, TestAdapter, TestContext, TestPlan } from "./types";

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

const SHARED =
  /^(conftest\.py|pyproject\.toml|uv\.lock|poetry\.lock|requirements[^/]*\.txt|setup\.py|setup\.cfg|pytest\.ini|tox\.ini)$/;
const PYTEST_CONFIG = /(^|\/)(pytest\.ini|setup\.cfg|pyproject\.toml|tox\.ini)$/;
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

function invocation(context: TestContext, selection: TestPlan["selection"]): TestPlan {
  const outfile = join(context.reportDir, "junit.xml");
  const files = selection.mode === "selected" ? selection.targets : [];
  return {
    selection,
    invocations: [
      {
        cwd: context.cwd,
        argv: [
          ...context.item.exec,
          "-o",
          "junit_family=xunit1",
          `--junitxml=${outfile}`,
          ...files,
        ],
      },
    ],
    report: { kind: "junit", paths: [outfile] },
  };
}

function fullPlan(
  context: TestContext,
  reasons = ["the pytest runner runs the full suite"],
): TestPlan {
  return invocation(context, { mode: "full", reasons });
}

function customFiles(snapshot: Snapshot): string[] {
  return [...snapshot.paths]
    .filter(
      (path) => PYTEST_CONFIG.test(path) && /^\s*python_files\s*=/m.test(snapshot.read(path) ?? ""),
    )
    .map((path) => `${path} sets python_files`);
}

async function plan(context: TestContext): Promise<TestPlan> {
  const { item } = context;
  if (item.select.package_roots === undefined) return fullPlan(context, ["package_roots not set"]);
  const roots = item.select.package_roots.map(rootOf);
  const always = item.select.always ?? [];
  const [changes, base, head] = await Promise.all([
    context.changes(),
    context.snapshot(context.base, PYTHON_READ),
    context.snapshot(context.head, PYTHON_READ),
  ]);
  const missing = always.filter((path) => !head.paths.has(path));
  if (missing.length > 0) {
    return {
      selection: { mode: "full", reasons: [] },
      invocations: [],
      report: { kind: "none" },
      problem: `select.always names ${missing.join(", ")}, which the head doesn't have`,
    };
  }
  const changed = new Set(changes.flatMap((change) => [change.path, change.oldPath ?? []].flat()));
  const full: string[] = [...customFiles(base), ...customFiles(head)];
  for (const path of [...changed].sort()) {
    if (SHARED.test(posix.basename(path))) {
      full.push(`${path} changed`);
    } else if (item.select.full_on?.some((pattern) => pathMatches(pattern, path))) {
      full.push(`${path} matches select.full_on`);
    } else if (
      !path.endsWith(".py") &&
      roots.some((root) => under(root, path)) &&
      anyPathMatches(item.paths ?? ["**"], [path], item.except)
    ) {
      full.push(`${path} changed, and it is not a Python file under package_roots`);
    }
  }
  for (const [at, snapshot] of [
    ["base", base],
    ["head", head],
  ] as const) {
    full.push(...namespaceProblems(snapshot, roots).map((problem) => `at ${at}: ${problem}`));
  }
  if (full.length > 0) return fullPlan(context, [...new Set(full)]);
  const atBase = await pythonAffected(context, base, roots, changed, "base");
  const atHead = await pythonAffected(context, head, roots, changed, "head");
  full.push(...atBase.problems.map((problem) => `at base: ${problem}`));
  full.push(...atHead.problems.map((problem) => `at head: ${problem}`));
  const selected = [...new Set([...atBase.affected, ...atHead.affected])]
    .filter((path) => head.paths.has(path) && isPythonTest(path))
    .sort();
  const targets = [...new Set([...selected, ...always])].sort();
  if (selected.length === 0 && always.length === 0) {
    full.push("no test file reaches a changed path, and select.always is empty");
  }
  const max = item.select.max_selected;
  if (max !== undefined && targets.length > max) {
    full.push(`${targets.length} test files are selected, more than max_selected ${max}`);
  }
  if (full.length > 0) return fullPlan(context, full);
  return invocation(context, {
    mode: "selected",
    targets,
    reasons: [
      ...selected.map((path) => `${path} reaches a changed path`),
      ...always.map((path) => `${path} is in select.always`),
    ],
  });
}

export const pytestTestAdapter: TestAdapter = { plan, full: (context) => fullPlan(context) };

export function pytestExecError(exec: readonly string[]): string | undefined {
  const prefix = PREFIXES.find((start) => start.every((part, index) => exec[index] === part));
  const options = exec.slice(prefix?.length ?? 0);
  if (prefix && options.every(optionAllowed)) {
    return undefined;
  }
  return `select runner pytest needs exec to run pytest, as "pytest", "python -m pytest", "uv run pytest" or "poetry run pytest", and pass only options, as --option=value, without -k or --junitxml`;
}

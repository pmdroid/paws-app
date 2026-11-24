import { basename, dirname } from "node:path/posix";
import { anyPathMatches, pathMatches } from "../evaluate/paths";
import type { TestSelect } from "../types";
import { affectedTests, knownType } from "./graph";
import type { Snapshot, TestAdapter, TestContext, TestPlan } from "./types";

const SHARED =
  /^(package\.json|bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|tsconfig[^/]*\.json)$/;

export type JavaScriptRunner = {
  name: TestSelect["runner"];
  commands: readonly (readonly string[])[];
  config: RegExp;
  preloads?: (snapshot: Snapshot) => string[];
  invocation(
    context: TestContext,
    files: readonly string[] | undefined,
  ): Pick<TestPlan, "invocations" | "report" | "problem">;
};

function fullPlan(
  runner: JavaScriptRunner,
  context: TestContext,
  reasons = [`the ${runner.name} runner runs the full suite`],
): TestPlan {
  return { selection: { mode: "full", reasons }, ...runner.invocation(context, undefined) };
}

async function plan(runner: JavaScriptRunner, context: TestContext): Promise<TestPlan> {
  const { item } = context;
  const always = item.select.always ?? [];
  const [changes, base, head] = await Promise.all([
    context.changes(),
    context.snapshot(context.base),
    context.snapshot(context.head),
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
  const preloads = new Set([base, head].flatMap((snapshot) => runner.preloads?.(snapshot) ?? []));
  const full: string[] = [];
  for (const path of [...changed].sort()) {
    const name = basename(path);
    if (SHARED.test(name) || runner.config.test(name) || preloads.has(path)) {
      full.push(`${path} changed`);
    } else if (item.select.full_on?.some((pattern) => pathMatches(pattern, path))) {
      full.push(`${path} matches select.full_on`);
    } else if (!knownType(path) && anyPathMatches(item.paths ?? ["**"], [path], item.except)) {
      full.push(`${path} changed, and the ${runner.name} runner doesn't know its file type`);
    }
  }
  const atBase = affectedTests(base, changed);
  const atHead = affectedTests(head, changed);
  full.push(...atBase.problems.map((problem) => `at base: ${problem}`));
  full.push(...atHead.problems.map((problem) => `at head: ${problem}`));
  const selected = [...new Set([...atBase.affected, ...atHead.affected])]
    .filter((path) => head.paths.has(path))
    .sort();
  const targets = [...new Set([...selected, ...always])].sort();
  if (selected.length === 0 && always.length === 0) {
    full.push("no test file reaches a changed path, and select.always is empty");
  }
  const max = item.select.max_selected;
  const over = max !== undefined && targets.length > max;
  const overReason = `${targets.length} test files are selected, more than max_selected ${max}`;
  if (over && item.select.over_max !== "direct") full.push(overReason);
  if (full.length > 0) return fullPlan(runner, context, full);
  if (over) return directPlan(runner, context, { changed, selected, always, overReason });
  return {
    selection: {
      mode: "selected",
      targets,
      reasons: [
        ...selected.map((path) => `${path} reaches a changed path`),
        ...always.map((path) => `${path} is in select.always`),
      ],
    },
    ...runner.invocation(context, targets),
  };
}

function directPlan(
  runner: JavaScriptRunner,
  context: TestContext,
  input: {
    changed: ReadonlySet<string>;
    selected: readonly string[];
    always: readonly string[];
    overReason: string;
  },
): TestPlan {
  const { changed, selected, always, overReason } = input;
  const folders = [...changed]
    .filter((path) => !selected.includes(path))
    .map((path) => dirname(path))
    .filter((folder) => folder !== ".");
  const direct = selected.filter(
    (path) =>
      !always.includes(path) &&
      (changed.has(path) || folders.some((folder) => path.startsWith(`${folder}/`))),
  );
  if (direct.length === 0 && always.length === 0)
    return fullPlan(runner, context, [`${overReason}, and the change has no direct test`]);
  const targets = [...direct, ...always].sort();
  const leftToCi = new Set([...selected, ...always]).size - targets.length;
  return {
    selection: {
      mode: "selected",
      targets,
      reasons: [
        `${overReason}; running the change's direct tests and leaving ${leftToCi} to CI`,
        ...direct.map((path) => `${path} is a direct test of the change`),
        ...always.map((path) => `${path} is in select.always`),
      ],
    },
    ...runner.invocation(context, targets),
  };
}

export function javascriptAdapter(runner: JavaScriptRunner): TestAdapter {
  return {
    plan: (context) => plan(runner, context),
    full: (context) => fullPlan(runner, context),
  };
}

export function javascriptExecError(
  runner: JavaScriptRunner,
  exec: readonly string[],
): string | undefined {
  for (const command of runner.commands) {
    const rest = exec.slice(command.length);
    if (command.every((part, index) => exec[index] === part) && rest.every(isFlag)) {
      return undefined;
    }
  }
  const named = runner.commands.map((command) => `"${command.join(" ")}"`).join(", ");
  return `select runner ${runner.name} needs exec to start with ${named} and pass only flags, as --flag=value`;
}

function isFlag(part: string): boolean {
  return part.startsWith("-");
}

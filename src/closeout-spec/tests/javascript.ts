import { basename } from "node:path/posix";
import { anyPathMatches, pathMatches } from "../evaluate/paths";
import type { TestSelect } from "../types";
import { affectedTests, directTests, knownType, testFilesOf } from "./graph";
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
  const reasons: string[] = [];
  let sharesEverything = false;
  for (const path of [...changed].sort()) {
    const name = basename(path);
    if (SHARED.test(name) || runner.config.test(name) || preloads.has(path)) {
      reasons.push(`${path} changed`);
      sharesEverything = true;
    } else if (item.select.full_on?.some((pattern) => pathMatches(pattern, path))) {
      reasons.push(`${path} matches select.full_on`);
      sharesEverything = true;
    } else if (!knownType(path) && anyPathMatches(item.paths ?? ["**"], [path], item.except)) {
      reasons.push(`${path} changed, and the ${runner.name} runner doesn't know its file type`);
    }
  }
  const atBase = affectedTests(base, changed);
  const atHead = affectedTests(head, changed);
  reasons.push(...atBase.problems.map((problem) => `at base: ${problem}`));
  reasons.push(...atHead.problems.map((problem) => `at head: ${problem}`));
  const reaching = [...new Set([...atBase.affected, ...atHead.affected])].filter((path) =>
    head.paths.has(path),
  );
  const opaque = atHead.opaque.filter((path) => !reaching.includes(path));
  const selected = [...reaching, ...opaque].sort();
  const targets = [...new Set([...selected, ...always])].sort();
  if (selected.length === 0 && always.length === 0) {
    reasons.push("no test file reaches a changed path, and select.always is empty");
  }
  const max = item.select.max_selected;
  if (max !== undefined && targets.length > max) {
    reasons.push(`${targets.length} test files are selected, more than max_selected ${max}`);
  }
  if (reasons.length > 0 && (sharesEverything || item.select.over_max !== "direct"))
    return fullPlan(runner, context, reasons);
  if (reasons.length > 0) return directPlan(runner, context, { changed, head, always, reasons });
  return {
    selection: {
      mode: "selected",
      targets,
      reasons: [
        ...reaching.sort().map((path) => `${path} reaches a changed path`),
        ...opaque.map(
          (path) => `${path} has a non-literal dynamic import or require, so it always runs`,
        ),
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
    head: Snapshot;
    always: readonly string[];
    reasons: readonly string[];
  },
): TestPlan {
  const { changed, head, always, reasons } = input;
  const siblings = new Set([...changed].map(sourceStem));
  const importers = new Set(directTests(head, changed));
  const direct = testFilesOf(head).filter(
    (path) => !always.includes(path) && (importers.has(path) || siblings.has(testStem(path))),
  );
  if (direct.length === 0 && always.length === 0)
    return fullPlan(runner, context, [
      ...reasons,
      "the change has no direct test, and select.always is empty",
    ]);
  const targets = [...direct, ...always].sort();
  return {
    selection: {
      mode: "selected",
      targets,
      reasons: [
        ...reasons,
        "running the change's direct tests and leaving the rest to CI",
        ...direct.map((path) => `${path} is a direct test of the change`),
        ...always.map((path) => `${path} is in select.always`),
      ],
    },
    ...runner.invocation(context, targets),
  };
}

function sourceStem(path: string): string {
  return path.replace(/\.[^./]+$/, "");
}

function testStem(path: string): string {
  return path.replace(/(\.|_)(test|spec)\.[^./]+$/, "");
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

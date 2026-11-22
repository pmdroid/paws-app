import { basename, join, normalize } from "node:path/posix";
import { anyPathMatches, pathMatches } from "../evaluate/paths";
import { affectedTests, knownType } from "./graph";
import type { Snapshot, TestAdapter, TestContext, TestPlan } from "./types";

const SHARED =
  /^(package\.json|bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bunfig\.toml|tsconfig[^/]*\.json)$/;

function invocation(context: TestContext, files: readonly string[] = []) {
  const outfile = join(context.reportDir, "junit.xml");
  return {
    invocations: [
      {
        cwd: context.cwd,
        argv: [
          ...context.item.exec,
          "--reporter=junit",
          `--reporter-outfile=${outfile}`,
          ...files.map((file) => `./${file}`),
        ],
      },
    ],
    report: { kind: "junit" as const, paths: [outfile] },
  };
}

function fullPlan(
  context: TestContext,
  reasons = ["the bun runner runs the full suite"],
): TestPlan {
  return { selection: { mode: "full", reasons }, ...invocation(context) };
}

async function plan(context: TestContext): Promise<TestPlan> {
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
  const preloads = new Set([...preloadsOf(base), ...preloadsOf(head)]);
  const full: string[] = [];
  for (const path of [...changed].sort()) {
    if (SHARED.test(basename(path)) || preloads.has(path)) full.push(`${path} changed`);
    else if (item.select.full_on?.some((pattern) => pathMatches(pattern, path))) {
      full.push(`${path} matches select.full_on`);
    } else if (!knownType(path) && anyPathMatches(item.paths ?? ["**"], [path], item.except)) {
      full.push(`${path} changed, and the bun runner doesn't know its file type`);
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
  if (max !== undefined && targets.length > max) {
    full.push(`${targets.length} test files are selected, more than max_selected ${max}`);
  }
  if (full.length > 0) return fullPlan(context, full);
  return {
    selection: {
      mode: "selected",
      targets,
      reasons: [
        ...selected.map((path) => `${path} reaches a changed path`),
        ...always.map((path) => `${path} is in select.always`),
      ],
    },
    ...invocation(context, targets),
  };
}

function preloadsOf(snapshot: Snapshot): string[] {
  const text = snapshot.read("bunfig.toml");
  if (text === undefined) return [];
  const config = Bun.TOML.parse(text) as { preload?: unknown; test?: { preload?: unknown } };
  return [config.preload, config.test?.preload]
    .flat()
    .filter((path): path is string => typeof path === "string")
    .map((path) => normalize(path));
}

export const bunTestAdapter: TestAdapter = { plan, full: (context) => fullPlan(context) };

export function bunExecError(exec: readonly string[]): string | undefined {
  const [command, verb, ...rest] = exec;
  if (command === "bun" && verb === "test" && rest.every((part) => part.startsWith("-"))) {
    return undefined;
  }
  return `select runner bun needs exec to start with "bun", "test" and pass only flags, as --flag=value`;
}

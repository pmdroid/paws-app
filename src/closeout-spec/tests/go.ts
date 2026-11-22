import { realpathSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { pathsMatch } from "../policy/paths";
import { git, spawnArgv } from "../run/exec";
import type { TestAdapter, TestContext, TestPlan } from "./types";

const PATTERN = "./...";
const LIST_SECONDS = 300;
const LIST_BYTES = 256 * 1024 * 1024;
const MODULE_FILES = new Set(["go.mod", "go.sum", "go.work", "go.work.sum"]);
const GRAPH_FLAGS = new Set([
  "tags",
  "mod",
  "modfile",
  "race",
  "msan",
  "asan",
  "overlay",
  "pgo",
  "compiler",
]);
const GENERATED = /^\/\/ Code generated .* DO NOT EDIT\.$/m;
const GO_GENERATE = /^\/\/go:generate\s/m;
const FILE_FIELDS = [
  "GoFiles",
  "CgoFiles",
  "CFiles",
  "CXXFiles",
  "MFiles",
  "HFiles",
  "FFiles",
  "SFiles",
  "SwigFiles",
  "SwigCXXFiles",
  "SysoFiles",
  "TestGoFiles",
  "XTestGoFiles",
  "IgnoredGoFiles",
  "IgnoredOtherFiles",
  "EmbedFiles",
  "TestEmbedFiles",
  "XTestEmbedFiles",
] as const;
const FIELDS = ["ImportPath", "Name", "Dir", "Standard", "Deps", ...FILE_FIELDS];
const TEE = `f=$1; shift; exec 3>&1; s=$({ { "$@" 3>&- 4>&-; echo $? >&4; } | tee "$f" >&3; } 4>&1); exit "$s"`;

type GoPackage = { ImportPath: string; Name?: string; Dir?: string; Standard?: boolean } & {
  [field in (typeof FILE_FIELDS)[number] | "Deps"]?: string[];
};

type Graph = {
  packages: Set<string>;
  owners: Map<string, Set<string>>;
  dirs: [string, string][];
  tests: [string, Set<string>][];
};

export function goExecError(exec: readonly string[]): string | undefined {
  const [command, verb, ...rest] = exec;
  const patterns = rest.filter((part) => !part.startsWith("-"));
  const terminator = rest.some((part) => /^--?args(=|$)/.test(part));
  if (
    command === "go" &&
    verb === "test" &&
    !terminator &&
    patterns.length === 1 &&
    patterns[0] === PATTERN
  ) {
    return undefined;
  }
  return `select runner go needs exec to start with "go", "test" and pass only flags, as -flag=value, and exactly one package pattern, ${PATTERN}, without -args`;
}

function invocation(
  context: TestContext,
  packages: string[] | undefined,
  reasons: string[],
): TestPlan {
  const report = join(context.reportDir, "go-test.json");
  const [go = "go", verb = "test", ...rest] = context.item.exec;
  const args = rest.flatMap((part) => (part === PATTERN && packages ? packages : [part]));
  return {
    selection: packages
      ? { mode: "selected", targets: packages, reasons }
      : { mode: "full", reasons },
    invocations: [
      { cwd: context.cwd, argv: ["sh", "-c", TEE, "sh", report, go, verb, "-json", ...args] },
    ],
    report: { kind: "go-json", path: report },
  };
}

function full(context: TestContext, reason = "the go runner runs every package"): TestPlan {
  return invocation(context, undefined, [reason]);
}

async function plan(context: TestContext): Promise<TestPlan> {
  const { select } = context.item;
  const changes = await context.changes();
  const paths = [
    ...new Set(changes.flatMap((change) => [change.oldPath ?? change.path, change.path])),
  ];
  const moduleFile = paths.find((path) => MODULE_FILES.has(posix.basename(path)));
  if (moduleFile !== undefined) return full(context, `${moduleFile} changed`);
  const fullOn = paths.find((path) => select.full_on?.some((pattern) => pathsMatch(pattern, path)));
  if (fullOn !== undefined) return full(context, `${fullOn} matches full_on`);
  for (const change of changes) {
    const reads = [
      ...(change.status.startsWith("A")
        ? []
        : [{ path: change.oldPath ?? change.path, at: "base", read: context.readAtBase }]),
      ...(change.status.startsWith("D")
        ? []
        : [{ path: change.path, at: "head", read: context.readAtHead }]),
    ];
    for (const { path, at, read } of reads) {
      const text = await read(path);
      if (text === undefined) return full(context, `could not read ${path} at ${at}`);
      if (GENERATED.test(text)) return full(context, `${path} is generated`);
      if (GO_GENERATE.test(text)) return full(context, `${path} has a //go:generate directive`);
    }
  }
  const head = await listGraph(context, context.cwd, "head");
  if (typeof head === "string") return full(context, head);
  const base = await atBase(context);
  if (typeof base === "string") return full(context, base);
  const changed = new Set<string>();
  for (const path of paths) {
    const owners = [...ownersOf(head, path), ...ownersOf(base, path)];
    if (owners.length === 0) return full(context, `no package owns ${path}`);
    for (const owner of owners) changed.add(owner);
  }
  const selected = new Set(changed);
  for (const graph of [head, base]) {
    for (const [pkg, deps] of graph.tests) {
      if ([...changed].some((name) => deps.has(name))) selected.add(pkg);
    }
  }
  const targets = [...selected].filter((pkg) => head.packages.has(pkg)).sort();
  const always = select.always ?? [];
  if (targets.length === 0 && always.length === 0) {
    return full(context, "no package is affected and always is empty");
  }
  if (select.max_selected !== undefined && targets.length > select.max_selected) {
    return full(context, `${targets.length} packages are affected, more than max_selected`);
  }
  const reasons = [...changed].sort().map((pkg) => `${pkg} changed`);
  return invocation(context, [...new Set([...targets, ...always])], reasons);
}

async function atBase(context: TestContext): Promise<Graph | string> {
  const dir = join(context.reportDir, "base");
  const hooksOff = ["-c", "core.hooksPath=/dev/null"];
  const added = await git(
    context.cwd,
    [...hooksOff, "worktree", "add", "--detach", "--quiet", dir, context.base],
    context.env,
  );
  if (!added.ok) return `could not check out base ${context.base}`;
  try {
    return await listGraph(context, dir, "base");
  } finally {
    await git(context.cwd, [...hooksOff, "worktree", "remove", "--force", dir], context.env);
  }
}

async function listGraph(context: TestContext, dir: string, at: string): Promise<Graph | string> {
  const flags = context.item.exec
    .slice(2)
    .filter((part) => GRAPH_FLAGS.has(part.replace(/^--?/, "").split("=")[0] ?? ""));
  const argv = [context.item.exec[0] ?? "go", "list", "-deps", "-test", `-json=${FIELDS}`];
  const listed = await spawnArgv(
    [...argv, ...flags, PATTERN],
    dir,
    context.env,
    LIST_SECONDS,
    undefined,
    LIST_BYTES,
  );
  if (!listed.started || listed.timedOut || listed.truncated || listed.exitCode !== 0) {
    const why = listed.stderr.trim().split("\n")[0] ?? "";
    return `go list failed at ${at}${why ? `: ${why}` : ""}`;
  }
  return graphOf(listed.stdout, realpathSync(dir));
}

export function graphOf(text: string, root: string): Graph {
  const graph: Graph = { packages: new Set(), owners: new Map(), dirs: [], tests: [] };
  const listed = text
    .split(/^\}$/m)
    .filter((part) => part.trim().length > 0)
    .map((part) => JSON.parse(`${part}}`) as GoPackage);
  const tests: GoPackage[] = [];
  for (const pkg of listed) {
    if (pkg.ImportPath.includes(" ") || pkg.Standard) continue;
    if (pkg.Name === "main" && pkg.ImportPath.endsWith(".test")) {
      tests.push(pkg);
      continue;
    }
    if (pkg.Dir === undefined) continue;
    const dir = relative(root, pkg.Dir).split(sep).join("/");
    if (dir === ".." || dir.startsWith("../")) continue;
    graph.packages.add(pkg.ImportPath);
    graph.dirs.push([dir, pkg.ImportPath]);
    graph.tests.push([pkg.ImportPath, depsOf(pkg)]);
    for (const field of FILE_FIELDS) {
      for (const file of pkg[field] ?? []) {
        const path = posix.join(dir, file);
        graph.owners.set(path, new Set([...(graph.owners.get(path) ?? []), pkg.ImportPath]));
      }
    }
  }
  for (const main of tests) {
    const pkg = main.ImportPath.slice(0, -".test".length);
    if (!graph.packages.has(pkg)) continue;
    graph.tests.push([pkg, depsOf(main)]);
  }
  return graph;
}

function depsOf(pkg: GoPackage): Set<string> {
  return new Set((pkg.Deps ?? []).map((dep) => dep.split(" ")[0] ?? dep));
}

function ownersOf(graph: Graph, path: string): string[] {
  const testdata = graph.dirs
    .filter(([dir]) => path.startsWith(dir === "" ? "testdata/" : `${dir}/testdata/`))
    .map(([, pkg]) => pkg);
  return [...(graph.owners.get(path) ?? []), ...testdata];
}

export const goTestAdapter: TestAdapter = { plan, full: (context) => full(context) };

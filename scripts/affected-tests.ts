/**
 * Closeout's `test` check: run the tests a change between `<base>` and `<head>` affects.
 *
 *   bun scripts/affected-tests.ts [--list] [<base> [<head>]]
 *
 * Without a base it uses `git merge-base origin/main HEAD`; on a runner, Closeout's worktree
 * points `origin/main` at the run's base. Test files are read from the working tree, which
 * Closeout checks out at the candidate head. Anything the script cannot decide runs the full
 * suite. GitHub CI always runs the full suite.
 */
import { parseSync } from "oxc-parser";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

/**
 * Always runs. Both read every file under `src/` by path, so a change can break them without
 * an import the graph can see.
 */
export const ALWAYS = ["test/boundaries.test.ts", "test/empty-catches.test.ts"] as const;

export const TEST_COMMAND = ["bun", "test", "--parallel=4", "--timeout=20000", "--no-orphans"];

const TEST_FILE = /(\.|_)(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SKIPPED = /(^|\/)(node_modules|dist|\.git)\//;

export function testFiles(root = "."): string[] {
  return [...new Bun.Glob("**/*").scanSync({ cwd: root, onlyFiles: true })]
    .filter((path) => TEST_FILE.test(path) && !SKIPPED.test(path))
    .sort();
}

const SHARED_FILES = new Set(["package.json", "bun.lock", "bunfig.toml"]);
const EXTENSIONS = ["", ".ts", ".tsx", ".js", "/index.ts", "/index.tsx"];

export type Selection =
  | { full: true; reason: string }
  | { full: false; files: { path: string; reasons: string[] }[] };

/** Paths changed between two commits, or null when git cannot say. */
export function changedPaths(root: string, base: string, head: string): string[] | null {
  const diff = spawnSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`, "--"],
    { cwd: root, encoding: "utf8" },
  );
  if (diff.status !== 0 || diff.error) return null;
  return diff.stdout.split("\0").filter((path) => path.length > 0);
}

/** Why a changed path needs the full suite, or undefined when it does not. */
export function sharedReason(path: string): string | undefined {
  if (SHARED_FILES.has(path)) return `${path} changed`;
  if (/(^|\/)tsconfig[^/]*\.json$/.test(path)) return `${path} changed`;
  if (path.startsWith("scripts/")) return `${path} changed`;
  if (path.startsWith("test/") && !TEST_FILE.test(path)) return `test helper ${path} changed`;
  return undefined;
}

/**
 * The unit a source path belongs to: `src/merge` for `src/merge/step.ts`, the file itself for
 * a file directly under `src/`, and undefined outside `src/`.
 */
export function sourceUnit(path: string): string | undefined {
  const match = /^src\/([^/]+)(\/)?/.exec(path);
  if (!match) return undefined;
  return match[2] ? `src/${match[1]}` : path.replace(/\.(ts|tsx|js)$/, "");
}

export function selectTests(input: {
  root: string;
  changed: readonly string[] | null;
  tests?: readonly string[];
}): Selection {
  const { root, changed } = input;
  if (changed === null) return { full: true, reason: "the diff could not be read" };
  for (const path of changed) {
    const reason = sharedReason(path);
    if (reason !== undefined) return { full: true, reason };
  }
  const tests = input.tests ?? testFiles(root);
  const chosen = new Map<string, Set<string>>();
  const choose = (path: string, reason: string) => {
    const reasons = chosen.get(path) ?? new Set<string>();
    reasons.add(reason);
    chosen.set(path, reasons);
  };
  const units = new Set<string>();
  const others: string[] = [];
  for (const path of changed) {
    if (TEST_FILE.test(path)) {
      if (tests.includes(path)) choose(path, "changed");
    }
    const unit = sourceUnit(path);
    if (unit !== undefined) units.add(unit);
    else if (!TEST_FILE.test(path)) others.push(path);
  }
  const graph = createImportGraph(root);
  try {
    const users = units.size === 0 ? new Map<string, Set<string>>() : unitsThatImport(root, graph);
    for (const test of tests) {
      const home = sourceUnit(test);
      let reached: Set<string> | undefined;
      for (const unit of units) {
        if (test.startsWith(`${unit}/`)) choose(test, `in ${unit}`);
        else if (
          (reached ??= graph.reaches(test)).has(unit) ||
          (home !== undefined && home !== unit && users.get(unit)?.has(home) === true)
        )
          choose(test, `imports ${unit}`);
      }
      if (others.length === 0) continue;
      const text = graph.read(test);
      for (const path of others) if (text.includes(path)) choose(test, `mentions ${path}`);
    }
  } catch (error) {
    return {
      full: true,
      reason: `import graph could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  for (const path of ALWAYS) if (tests.includes(path)) choose(path, "always");
  return {
    full: false,
    files: [...chosen]
      .map(([path, reasons]) => ({ path, reasons: [...reasons] }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

/** Parse executable imports without treating fixture strings or comments as code. */
function relativeImports(path: string, text: string): string[] {
  if (!/\.(tsx?|jsx?|mjs|cjs)$/.test(path)) return [];
  const parsed = parseSync(path, text);
  if (parsed.errors.length) throw new Error(`cannot parse ${path}`);
  const imports = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && /^\.{1,2}\//.test(value)) imports.add(value);
  };
  for (const entry of parsed.module.staticImports) add(entry.moduleRequest.value);
  for (const group of parsed.module.staticExports)
    for (const entry of group.entries) add(entry.moduleRequest?.value);
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const node = record(value);
    if (
      node.type === "ImportExpression" ||
      node.type === "ExportAllDeclaration" ||
      node.type === "ExportNamedDeclaration"
    )
      add(record(node.source).value);
    if (node.type === "CallExpression") {
      const callee = record(node.callee);
      if (
        (callee.type === "Identifier" && callee.name === "require") ||
        (callee.type === "MemberExpression" &&
          record(callee.object).name === "mock" &&
          record(callee.property).name === "module")
      ) {
        const argument = Array.isArray(node.arguments) ? node.arguments[0] : undefined;
        add(record(argument).value);
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(parsed.program);
  return [...imports];
}

/**
 * Relative imports, followed through test helpers and through `src/` so a file that imports
 * `src/loop`, which imports `src/merge`, reaches both units. A finished file is cached. A walk
 * that hit a file still on the stack is not, so a cycle cannot store a partial result.
 */
function createImportGraph(root: string) {
  const texts = new Map<string, string>();
  const read = (path: string): string => {
    let text = texts.get(path);
    if (text === undefined) {
      text = readFileSync(join(root, path), "utf8");
      texts.set(path, text);
    }
    return text;
  };
  const resolve = (from: string, specifier: string): string | undefined => {
    const target = normalize(join(dirname(from), specifier));
    if (target.startsWith("..")) return undefined;
    for (const extension of EXTENSIONS) {
      const candidate = `${target}${extension}`;
      const full = join(root, candidate);
      if (existsSync(full) && statSync(full).isFile()) return relative(root, full);
    }
    return target;
  };
  const cache = new Map<string, Set<string>>();
  // `partial` is true when a dependency was still on the stack. That result must not be cached:
  // the in-progress file may import a unit this walk could not see yet.
  const walk = (path: string, stack: Set<string>): { units: Set<string>; partial: boolean } => {
    const cached = cache.get(path);
    if (cached !== undefined) return { units: cached, partial: false };
    if (stack.has(path)) return { units: new Set(), partial: true };
    stack.add(path);
    const units = new Set<string>();
    let partial = false;
    for (const specifier of relativeImports(path, read(path))) {
      const target = resolve(path, specifier);
      if (target === undefined || target.includes("node_modules/")) continue;
      const unit = sourceUnit(target);
      if (unit !== undefined) units.add(unit);
      if (stack.has(target)) {
        partial = true;
        continue;
      }
      const found = walk(target, stack);
      partial ||= found.partial;
      for (const reached of found.units) units.add(reached);
    }
    stack.delete(path);
    if (!partial) cache.set(path, units);
    return { units, partial };
  };
  return { read, reaches: (path: string) => walk(path, new Set()).units };
}

/** Units that import `unit`, directly or through another unit. The unit itself is left out. */
function unitsThatImport(
  root: string,
  graph: ReturnType<typeof createImportGraph>,
): Map<string, Set<string>> {
  const imports = new Map<string, Set<string>>();
  const files = [...new Bun.Glob("src/**/*").scanSync({ cwd: root, onlyFiles: true })].filter(
    (path) => /\.(tsx?|jsx?|mjs|cjs)$/.test(path) && !TEST_FILE.test(path) && !SKIPPED.test(path),
  );
  for (const file of files) {
    const unit = sourceUnit(file);
    if (unit === undefined) continue;
    const deps = imports.get(unit) ?? new Set<string>();
    for (const found of graph.reaches(file)) if (found !== unit) deps.add(found);
    imports.set(unit, deps);
  }
  const users = new Map<string, Set<string>>();
  for (const [unit, deps] of imports) {
    for (const dep of deps) {
      const set = users.get(dep) ?? new Set<string>();
      set.add(unit);
      users.set(dep, set);
    }
  }
  return users;
}

/** What ran and why, for the check's log and evidence. */
export function describeSelection(selection: Selection, total: number): string {
  if (selection.full) return `affected-tests: full suite (${total} files): ${selection.reason}`;
  const width = Math.max(...selection.files.map((file) => file.path.length), 0);
  return [
    `affected-tests: ${selection.files.length} of ${total} test files`,
    ...selection.files.map((file) => `  ${file.path.padEnd(width)}  ${file.reasons.join(", ")}`),
  ].join("\n");
}

function git(root: string, args: string[]): string | null {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 && !result.error ? result.stdout.trim() : null;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const list = args.includes("--list");
  const [base, head = "HEAD"] = args.filter((arg) => arg !== "--list");
  const root = process.cwd();
  const from = base ?? git(root, ["merge-base", "origin/main", "HEAD"]);
  const tests = testFiles(root);
  const selection =
    from === null
      ? ({ full: true, reason: "no base: origin/main and HEAD have no merge base" } as const)
      : selectTests({ root, changed: changedPaths(root, from, head), tests });
  if (from !== null) console.log(`affected-tests: base ${from}, head ${head}`);
  console.log(describeSelection(selection, tests.length));
  if (!list && (selection.full || selection.files.length > 0)) {
    const argv = selection.full
      ? TEST_COMMAND
      : [...TEST_COMMAND, ...selection.files.map((file) => `./${file.path}`)];
    const run = spawnSync(argv[0]!, argv.slice(1), { cwd: root, stdio: "inherit" });
    process.exit(run.status ?? 1);
  }
}

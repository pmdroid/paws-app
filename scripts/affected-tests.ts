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
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { testFiles } from "./test-shard";

/** Always runs: it reads every module, so any change can break it. */
export const BOUNDARIES = "test/boundaries.test.ts";

export const TEST_COMMAND = ["bun", "test", "--parallel=4", "--timeout=20000", "--no-orphans"];

const TEST_FILE = /(\.|_)(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SHARED_FILES = new Set(["package.json", "bun.lock", "bunfig.toml"]);
const IMPORT =
  /(?:\bfrom|\bimport|\brequire\s*\(|\bimport\s*\(|\bmock\.module\s*\()\s*["'](\.{1,2}\/[^"']*)["']/g;
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
  for (const test of tests) {
    for (const unit of units) {
      if (test.startsWith(`${unit}/`)) choose(test, `in ${unit}`);
      else if (graph.reaches(test).has(unit)) choose(test, `imports ${unit}`);
    }
    if (others.length === 0) continue;
    const text = graph.read(test);
    for (const path of others) if (text.includes(path)) choose(test, `mentions ${path}`);
  }
  if (tests.includes(BOUNDARIES)) choose(BOUNDARIES, "always");
  return {
    full: false,
    files: [...chosen]
      .map(([path, reasons]) => ({ path, reasons: [...reasons] }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

/**
 * Relative imports, followed through files outside `src/` (test helpers) and stopped at the
 * first `src/` unit they reach.
 */
function createImportGraph(root: string) {
  const texts = new Map<string, string>();
  const reached = new Map<string, Set<string>>();
  const read = (path: string): string => {
    let text = texts.get(path);
    if (text === undefined) {
      try {
        text = readFileSync(join(root, path), "utf8");
      } catch {
        text = "";
      }
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
  const reaches = (path: string, seen = new Set<string>()): Set<string> => {
    const cached = reached.get(path);
    if (cached) return cached;
    const units = new Set<string>();
    seen.add(path);
    for (const match of read(path).matchAll(IMPORT)) {
      const target = resolve(path, match[1]!);
      if (target === undefined) continue;
      const unit = sourceUnit(target);
      if (unit !== undefined) units.add(unit);
      else if (!seen.has(target) && !target.includes("node_modules/"))
        for (const found of reaches(target, seen)) units.add(found);
    }
    reached.set(path, units);
    return units;
  };
  return { read, reaches: (path: string) => reaches(path) };
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

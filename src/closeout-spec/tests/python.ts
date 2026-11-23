import { writeFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { spawnArgv } from "../run/exec";
import type { Snapshot, TestContext } from "./types";

const SCAN = `import ast, json, sys
DYNAMIC = {"__import__", "import_module", "entry_points", "iter_modules", "walk_packages", "spec_from_file_location"}
def scan(text):
    imports, dynamic = [], False
    for node in ast.walk(ast.parse(text)):
        if isinstance(node, ast.Import):
            imports += [[alias.name, 0, []] for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            imports.append([node.module or "", node.level, [alias.name for alias in node.names]])
        elif isinstance(node, ast.Call):
            name = getattr(node.func, "id", None) or getattr(node.func, "attr", None)
            dynamic = dynamic or name in DYNAMIC
    return {"imports": imports, "dynamic": dynamic}
out = {}
with open(sys.argv[1], encoding="utf-8") as file:
    sources = json.load(file)
for path, text in sources.items():
    try:
        out[path] = scan(text)
    except (SyntaxError, ValueError) as error:
        out[path] = {"error": str(error)}
json.dump(out, sys.stdout)
`;

export const PYTHON_READ = /(\.py|\.toml|\.ini|\.cfg)$/;
const SKIPPED = /(^|\/)(\.git|\.venv|venv|node_modules|__pycache__|site-packages)\//;
const SCAN_SECONDS = 120;
const SCAN_BYTES = 256 * 1024 * 1024;

type Scanned = { imports?: [string, number, string[]][]; dynamic?: boolean; error?: string };

export type PythonGraph = { affected: string[]; problems: string[] };

export function isPythonTest(path: string): boolean {
  const name = posix.basename(path);
  return /^test_.*\.py$/.test(name) || /^.+_test\.py$/.test(name);
}

export function rootOf(path: string): string {
  const normal = posix.normalize(path).replace(/\/+$/, "");
  return normal === "." ? "" : normal;
}

export function under(root: string, path: string): boolean {
  return root === "" || path.startsWith(`${root}/`);
}

function parent(path: string): string {
  const dir = posix.dirname(path);
  return dir === "." ? "" : dir;
}

function inside(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

function interpreter(exec: readonly string[]): string[] {
  const [first, second] = exec;
  if (first === "python" || first === "python3") return [first];
  if ((first === "uv" || first === "poetry") && second === "run") return [first, "run", "python"];
  return ["python3"];
}

function testBase(snapshot: Snapshot, test: string): string {
  let dir = parent(test);
  while (dir !== "" && snapshot.paths.has(inside(dir, "__init__.py"))) dir = parent(dir);
  return dir;
}

function moduleFiles(snapshot: Snapshot, dir: string, parts: string[]): string[] | undefined {
  const files: string[] = [];
  for (const [index, part] of parts.entries()) {
    dir = inside(dir, part);
    const init = inside(dir, "__init__.py");
    if (index === parts.length - 1 && snapshot.paths.has(`${dir}.py`)) {
      files.push(`${dir}.py`);
    } else if (snapshot.paths.has(init)) {
      files.push(init);
    } else {
      return undefined;
    }
  }
  return files;
}

function resolveImport(
  snapshot: Snapshot,
  file: string,
  [module, level, names]: [string, number, string[]],
  searchRoots: string[],
): string[] {
  const parts = module === "" ? [] : module.split(".");
  let dirs = searchRoots;
  if (level > 0) {
    let dir = parent(file);
    for (let up = 1; up < level; up++) {
      if (dir === "") return [];
      dir = parent(dir);
    }
    dirs = [dir];
  }
  const found: string[] = [];
  for (const dir of dirs) {
    const files = parts.length === 0 ? [] : moduleFiles(snapshot, dir, parts);
    if (files === undefined) continue;
    if (parts.length === 0 && snapshot.paths.has(inside(dir, "__init__.py"))) {
      files.push(inside(dir, "__init__.py"));
    }
    found.push(...files);
    for (const name of names) found.push(...(moduleFiles(snapshot, dir, [...parts, name]) ?? []));
  }
  return found;
}

export function namespaceProblems(snapshot: Snapshot, roots: string[]): string[] {
  const tests = [...snapshot.paths].filter(isPythonTest);
  const testDirs = new Set(tests.map((test) => testBase(snapshot, test)));
  const problems = new Set<string>();
  for (const path of snapshot.paths) {
    if (!path.endsWith(".py") || SKIPPED.test(path) || isPythonTest(path)) continue;
    if (basename(path) === "conftest.py" || testDirs.has(parent(path))) continue;
    for (const root of roots.filter((candidate) => under(candidate, path))) {
      for (let dir = parent(path); dir !== root; dir = parent(dir)) {
        if (!snapshot.paths.has(inside(dir, "__init__.py"))) {
          problems.add(`${dir} is a namespace package without __init__.py`);
        }
      }
    }
  }
  return [...problems].sort();
}

async function scan(
  context: TestContext,
  files: string[],
  snapshot: Snapshot,
  at: string,
): Promise<Map<string, Scanned> | string> {
  const sources = Object.fromEntries(files.map((path) => [path, snapshot.read(path) ?? ""]));
  const input = join(context.reportDir, `python-${at}.json`);
  writeFileSync(input, JSON.stringify(sources));
  const seconds = Math.min(SCAN_SECONDS, (context.deadline - Date.now()) / 1000);
  const argv = [...interpreter(context.item.exec), "-c", SCAN, input];
  const ran = await spawnArgv(argv, context.cwd, context.env, seconds, undefined, SCAN_BYTES);
  if (!ran.started || ran.timedOut || ran.truncated || ran.exitCode !== 0) {
    const why = ran.stderr.trim().split("\n").at(-1) ?? "";
    return `reading Python imports at ${at} failed${why ? `: ${why}` : ""}`;
  }
  return new Map(Object.entries(JSON.parse(ran.stdout) as Record<string, Scanned>));
}

export async function pythonAffected(
  context: TestContext,
  snapshot: Snapshot,
  roots: string[],
  changed: ReadonlySet<string>,
  at: string,
): Promise<PythonGraph> {
  const tests = [...snapshot.paths].filter((path) => isPythonTest(path) && !SKIPPED.test(path));
  const searchRoots = [...new Set([...roots, ...tests.map((test) => testBase(snapshot, test))])];
  const files = [...snapshot.paths].filter(
    (path) =>
      path.endsWith(".py") && !SKIPPED.test(path) && searchRoots.some((root) => under(root, path)),
  );
  const scanned = await scan(context, [...new Set([...files, ...tests])], snapshot, at);
  if (typeof scanned === "string") return { affected: [], problems: [scanned] };
  const edges = new Map<string, string[]>();
  const problems: string[] = [];
  const pending = [...tests];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (edges.has(path)) continue;
    const found = scanned.get(path) ?? {};
    if (found.error !== undefined) problems.push(`${path} could not be parsed: ${found.error}`);
    if (found.dynamic) problems.push(`${path} imports modules dynamically`);
    const targets = (found.imports ?? []).flatMap((entry) =>
      resolveImport(snapshot, path, entry, searchRoots),
    );
    if (isPythonTest(path)) {
      for (let dir = parent(path); ; dir = parent(dir)) {
        if (snapshot.paths.has(inside(dir, "conftest.py")))
          targets.push(inside(dir, "conftest.py"));
        if (dir === "") break;
      }
    }
    edges.set(path, targets);
    pending.push(...targets);
  }
  const users = new Map<string, string[]>();
  for (const [path, targets] of edges) {
    for (const target of targets) users.set(target, [...(users.get(target) ?? []), path]);
  }
  const reached = new Set<string>();
  const queue = [...changed];
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (reached.has(path)) continue;
    reached.add(path);
    queue.push(...(users.get(path) ?? []));
  }
  return { affected: tests.filter((test) => reached.has(test)), problems };
}

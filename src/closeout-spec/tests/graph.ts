import { builtinModules } from "node:module";
import { dirname, join, normalize } from "node:path/posix";
import type { Snapshot } from "./types";

export const TEST_FILE = /(\.|_)(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;
export const SKIPPED = /(^|\/)(node_modules|dist|\.git)\//;
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const LEAF =
  /\.(json|jsonc|css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|html|txt|wasm)$/;
const EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
];
const BUILTINS = new Set(builtinModules);
const CALL = /(?<![\w$.])(require(\.resolve)?|import|mock\.module)\s*\(/y;
const SHOWN_PROBLEMS = 20;

export function knownType(path: string): boolean {
  return SOURCE.test(path) || LEAF.test(path);
}

export function testFilesOf(snapshot: Snapshot): string[] {
  return [...snapshot.paths].filter((path) => TEST_FILE.test(path) && !SKIPPED.test(path)).sort();
}

export type GraphResult = { affected: string[]; opaque: string[]; problems: string[] };

type Graph = {
  tests: string[];
  edges: Map<string, string[]>;
  opaque: string[];
  problems: string[];
};

function importGraph(snapshot: Snapshot, changed: ReadonlySet<string>): Graph {
  const config = repositoryConfig(snapshot);
  const tests = testFilesOf(snapshot);
  const edges = new Map<string, string[]>();
  const problems: string[] = [];
  const opaque: string[] = [];
  const pending = [...tests];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (edges.has(path)) continue;
    const targets: string[] = [];
    edges.set(path, targets);
    const text = SOURCE.test(path) ? snapshot.read(path) : undefined;
    if (text === undefined) continue;
    let found: ReturnType<typeof specifiers>;
    try {
      found = specifiers(path, text);
    } catch (error) {
      problems.push(
        `${path} could not be parsed: ${error instanceof Error ? error.message : error}`,
      );
      continue;
    }
    if (found.dynamic && TEST_FILE.test(path)) opaque.push(path);
    else if (found.dynamic) problems.push(`${path} has a non-literal dynamic import or require`);
    for (const specifier of found.literal) {
      const target = resolve(path, specifier, snapshot, config, changed);
      if (target === null) continue;
      if (target === undefined) {
        problems.push(`${path} imports ${specifier}, which the graph can't follow`);
        continue;
      }
      targets.push(target);
      pending.push(target);
    }
  }
  return { tests, edges, opaque, problems };
}

export function directTests(snapshot: Snapshot, changed: ReadonlySet<string>): string[] {
  const { tests, edges } = importGraph(snapshot, changed);
  return tests.filter(
    (test) => changed.has(test) || (edges.get(test) ?? []).some((target) => changed.has(target)),
  );
}

export function affectedTests(snapshot: Snapshot, changed: ReadonlySet<string>): GraphResult {
  const { tests, edges, opaque, problems } = importGraph(snapshot, changed);
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
  const shown = problems.slice(0, SHOWN_PROBLEMS);
  if (problems.length > SHOWN_PROBLEMS) shown.push(`and ${problems.length - SHOWN_PROBLEMS} more`);
  return {
    affected: tests.filter((test) => reached.has(test) && !opaque.includes(test)),
    opaque: opaque.sort(),
    problems: shown,
  };
}

function specifiers(path: string, text: string): { literal: Set<string>; dynamic: boolean } {
  const loader = path.endsWith(".tsx") ? "tsx" : /\.[mc]?ts$/.test(path) ? "ts" : "jsx";
  const transpiler = new Bun.Transpiler({ loader });
  const literal = new Set(transpiler.scanImports(text).map((entry) => entry.path));
  let dynamic = false;
  for (const argument of calls(transpiler.transformSync(text))) {
    if (argument === undefined) dynamic = true;
    else literal.add(argument);
  }
  return { literal, dynamic };
}

function calls(code: string): (string | undefined)[] {
  const found: (string | undefined)[] = [];
  const resume: number[] = [];
  let depth = 0;
  let last = "";
  let index = 0;
  const template = () => {
    while (index < code.length) {
      const char = code[index];
      if (char === "\\") index += 2;
      else if (char === "`") {
        index += 1;
        last = "`";
        return;
      } else if (char === "$" && code[index + 1] === "{") {
        index += 2;
        resume.push(depth);
        depth += 1;
        last = "{";
        return;
      } else index += 1;
    }
  };
  while (index < code.length) {
    const char = code[index]!;
    const next = code[index + 1];
    if (char === '"' || char === "'") {
      index = endOfString(code, index);
      last = '"';
    } else if (char === "`") {
      index += 1;
      template();
    } else if (char === "/" && next === "/") {
      const end = code.indexOf("\n", index);
      index = end < 0 ? code.length : end;
    } else if (char === "/" && next === "*") {
      const end = code.indexOf("*/", index + 2);
      index = end < 0 ? code.length : end + 2;
    } else if (char === "/" && regexAllowed(code, index, last)) {
      index = endOfRegex(code, index);
      last = "/";
    } else if (char === "}" && resume.at(-1) === depth - 1) {
      resume.pop();
      depth -= 1;
      index += 1;
      template();
    } else {
      CALL.lastIndex = index;
      const match = "rim".includes(char) ? CALL.exec(code) : null;
      if (match) {
        index += match[0].length;
        found.push(argumentAt(code, index));
        last = "(";
        continue;
      }
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      if (!/\s/.test(char)) last = char;
      index += 1;
    }
  }
  return found;
}

function regexAllowed(code: string, index: number, last: string): boolean {
  if (last === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(last)) return true;
  return /(^|[^\w$])(return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new)\s*$/.test(
    code.slice(Math.max(0, index - 12), index),
  );
}

function endOfString(code: string, start: number): number {
  const quote = code[start];
  let index = start + 1;
  while (index < code.length && code[index] !== quote && code[index] !== "\n") {
    index += code[index] === "\\" ? 2 : 1;
  }
  return index + 1;
}

function endOfRegex(code: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < code.length && code[index] !== "\n") {
    const char = code[index];
    if (char === "\\") index += 1;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      index += 1;
      while (/[a-z]/.test(code[index] ?? "")) index += 1;
      return index;
    }
    index += 1;
  }
  return start + 1;
}

function argumentAt(code: string, start: number): string | undefined {
  let index = start;
  while (/\s/.test(code[index] ?? "")) index += 1;
  const quote = code[index];
  if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
  const end = endOfString(code, index);
  const value = code.slice(index + 1, end - 1);
  if (quote === "`" && value.includes("${")) return undefined;
  let after = end;
  while (/\s/.test(code[after] ?? "")) after += 1;
  return code[after] === ")" || code[after] === "," ? value : undefined;
}

type RepositoryConfig = {
  aliases: [string, string[]][];
  aliasBase: string;
  baseUrl?: string;
  packages: Map<string, string>;
  dependencies: Set<string>;
};

type Manifest = {
  name?: unknown;
  workspaces?: unknown;
  exports?: unknown;
  module?: unknown;
  main?: unknown;
} & Record<string, unknown>;

function json<T>(snapshot: Snapshot, path: string): T | undefined {
  const text = snapshot.read(path);
  return text === undefined ? undefined : (Bun.JSONC.parse(text) as T);
}

function repositoryConfig(snapshot: Snapshot): RepositoryConfig {
  const root = json<Manifest>(snapshot, "package.json") ?? {};
  const workspaces = Array.isArray(root.workspaces)
    ? root.workspaces
    : (root.workspaces as { packages?: unknown } | undefined)?.packages;
  const patterns = (Array.isArray(workspaces) ? workspaces : []).filter(
    (pattern): pattern is string => typeof pattern === "string",
  );
  const packages = new Map<string, string>();
  const dependencies = new Set<string>();
  const manifests: Manifest[] = [root];
  for (const path of snapshot.paths) {
    if (!path.endsWith("/package.json") || SKIPPED.test(path)) continue;
    const dir = dirname(path);
    if (!patterns.some((pattern) => globMatches(pattern, dir))) continue;
    const manifest = json<Manifest>(snapshot, path) ?? {};
    manifests.push(manifest);
    if (typeof manifest.name === "string") packages.set(manifest.name, dir);
  }
  for (const manifest of manifests) {
    for (const key of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      for (const name of Object.keys((manifest[key] as object | undefined) ?? {})) {
        dependencies.add(name);
      }
    }
  }
  const options =
    json<{ compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }>(
      snapshot,
      "tsconfig.json",
    )?.compilerOptions ?? {};
  const baseUrl = options.baseUrl === undefined ? undefined : normalize(options.baseUrl);
  return {
    aliases: Object.entries(options.paths ?? {}),
    aliasBase: baseUrl ?? ".",
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    packages,
    dependencies,
  };
}

function globMatches(pattern: string, path: string): boolean {
  const source = normalize(pattern)
    .replace(/\/$/, "")
    .split("**")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${source}$`).test(path);
}

function resolve(
  from: string,
  specifier: string,
  snapshot: Snapshot,
  config: RepositoryConfig,
  changed: ReadonlySet<string>,
): string | null | undefined {
  const file = (target: string) => fileAt(normalize(target), snapshot, changed);
  if (/^\.{1,2}(\/|$)/.test(specifier)) return file(join(dirname(from), specifier));
  if (specifier.startsWith("/")) return undefined;
  if (/^(node|bun):/.test(specifier) || specifier === "bun") return null;
  if (BUILTINS.has(specifier) || BUILTINS.has(specifier.split("/")[0]!)) return null;
  for (const [pattern, targets] of config.aliases) {
    const star = aliasMatch(pattern, specifier);
    if (star === undefined) continue;
    for (const target of targets) {
      const found = file(join(config.aliasBase, target.replace("*", star)));
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const parts = specifier.split("/");
  const name = parts.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
  const dir = config.packages.get(name);
  if (dir !== undefined) {
    const subpath = specifier.slice(name.length + 1);
    if (subpath.length > 0) return file(join(dir, subpath));
    const manifest = json<Manifest>(snapshot, join(dir, "package.json")) ?? {};
    const entry = exportTarget(manifest.exports) ?? manifest.module ?? manifest.main;
    return file(join(dir, typeof entry === "string" ? entry : "index"));
  }
  if (config.baseUrl !== undefined) {
    const found = file(join(config.baseUrl, specifier));
    if (found !== undefined) return found;
  }
  return config.dependencies.has(name) ? null : undefined;
}

function exportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const conditions = value as Record<string, unknown>;
  if ("." in conditions) return exportTarget(conditions["."]);
  for (const key of ["bun", "import", "default", "require", "node"]) {
    const found = exportTarget(conditions[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

function aliasMatch(pattern: string, specifier: string): string | undefined {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === specifier ? "" : undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
  if (specifier.length < prefix.length + suffix.length) return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function fileAt(
  target: string,
  snapshot: Snapshot,
  changed: ReadonlySet<string>,
): string | undefined {
  if (target.startsWith("..")) return undefined;
  const stem = target.replace(/\.(m|c)?jsx?$/, "");
  const candidates = [
    ...EXTENSIONS.map((extension) => `${target}${extension}`),
    ...(stem === target ? [] : [".ts", ".tsx", ".mts", ".cts"].map((ext) => `${stem}${ext}`)),
  ];
  return (
    candidates.find((candidate) => snapshot.paths.has(candidate)) ??
    candidates.find((candidate) => changed.has(candidate))
  );
}

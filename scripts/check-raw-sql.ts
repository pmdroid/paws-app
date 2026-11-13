import { readFileSync } from "node:fs";
import { join } from "node:path";

const ALLOWED_FILES = new Set([
  "src/db/migrate.ts",
  "src/db/open.ts",
  "src/runner-daemon/commands-ddl.ts",
  "src/runner-health-runtime/health-ddl.ts",
  "src/runner-journal/ddl.ts",
  "src/runner-retro-runtime/retro-ddl.ts",
]);
const TEST_FILE = /(^|\/)(test|fixtures)\/|\.test\.tsx?$/;
const RECEIVER = /^(?:db|database|\w*Db|\w*Database)$/;
const OPENED = /\b(?:const|let)\s+(\w+)\s*=\s*(?:new Database|openDatabase)\(/g;
const TYPED_DB = /\b(\w+)\s*:\s*Db\b/g;
const TYPED_DATABASE = /\b(\w+)\s*:\s*Database\b/g;
const CALL =
  /(?<![\w$.])((?:[\w$]+\.)*([\w$]+)\s*\.(?:query|run|prepare|exec))\s*(?:<[^()]*?>\s*)?\(\s*(sql`)?/g;
const REGEX_BEFORE = /(?:[(,=:[!&|?{};+\-*%<>~^]|^|\breturn)$/;

export function maskCode(source: string): string {
  const out = source.split("");
  const templates: number[] = [];
  let depth = 0;
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const skipQuoted = (start: number, quote: string): number => {
    let k = start + 1;
    while (k < source.length && source[k] !== quote && source[k] !== "\n")
      k += source[k] === "\\" ? 2 : 1;
    blank(start + 1, k);
    return k + 1;
  };
  const skipTemplate = (start: number): number => {
    let k = start;
    while (k < source.length && source[k] !== "`" && !(source[k] === "$" && source[k + 1] === "{"))
      k += source[k] === "\\" ? 2 : 1;
    blank(start, k);
    if (source[k] === "`") return k + 1;
    templates.push(depth);
    depth = 0;
    return k + 2;
  };
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === "'" || c === '"') i = skipQuoted(i, c);
    else if (c === "`") i = skipTemplate(i + 1);
    else if (c === "/" && REGEX_BEFORE.test(source.slice(0, i).trimEnd().slice(-6))) {
      let k = i + 1;
      let inClass = false;
      while (k < source.length && source[k] !== "\n" && (inClass || source[k] !== "/")) {
        if (source[k] === "[") inClass = true;
        else if (source[k] === "]") inClass = false;
        k += source[k] === "\\" ? 2 : 1;
      }
      blank(i + 1, k);
      i = k + 1;
    } else if (c === "{") {
      depth++;
      i++;
    } else if (c === "}" && depth === 0 && templates.length > 0) {
      depth = templates.pop()!;
      i = skipTemplate(i + 1);
    } else {
      if (c === "}") depth--;
      i++;
    }
  }
  return out.join("");
}

export type RawCall = { path: string; line: number; content: string };
export function rawCalls(path: string, source: string): RawCall[] {
  if (TEST_FILE.test(path) || ALLOWED_FILES.has(path)) return [];
  const code = maskCode(source);
  const opened = new Set([...code.matchAll(OPENED)].map((match) => match[1]!));
  const databases = new Set([...code.matchAll(TYPED_DATABASE)].map((match) => match[1]!));
  const dbs = new Set(
    [...code.matchAll(TYPED_DB)].map((match) => match[1]!).filter((name) => !databases.has(name)),
  );
  const lines = source.split("\n");
  const calls: RawCall[] = [];
  for (const match of code.matchAll(CALL)) {
    const [, call, name, drizzleSql] = match;
    if (!RECEIVER.test(name!) && !opened.has(name!)) continue;
    if (dbs.has(name!) && !opened.has(name!)) continue;
    if (drizzleSql && path.startsWith("src/db/")) continue;
    const start = code.slice(0, match.index).split("\n").length;
    const method = start + call!.split("\n").length - 1;
    const content = lines.slice(start - 1, method).map((line) => line.trim());
    calls.push({ path, line: method, content: content.join(" ") });
  }
  return calls;
}

function sourceCalls(root: string): RawCall[] {
  const files = new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: root });
  return [...files]
    .sort()
    .flatMap((file) => rawCalls(file, readFileSync(join(root, file), "utf8")));
}

function main(root: string): number {
  const refused = sourceCalls(root);
  for (const call of refused)
    console.error(
      `${call.path}:${call.line}: raw bun:sqlite call; write it with Drizzle in the module that owns the table: ${call.content}`,
    );
  if (refused.length === 0) return 0;
  console.error(`\n${refused.length} raw SQL call(s) refused.`);
  return 1;
}

if (import.meta.main) {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex === -1 ? join(import.meta.dir, "..") : process.argv[rootIndex + 1]!;
  process.exit(main(root));
}

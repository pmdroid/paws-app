import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ALLOWED_FILES = new Set(["src/db/migrate.ts", "src/db/open.ts"]);
const TEST_FILE = /(^|\/)(test|fixtures)\/|\.test\.tsx?$/;
const RECEIVER = /^(?:db|database|\w*Db|\w*Database)$/;
const OPENED = /\b(?:const|let)\s+(\w+)\s*=\s*(?:new Database|openDatabase)\(/g;
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
export type Entry = { path: string; content: string; reason: string };

export function rawCalls(path: string, source: string): RawCall[] {
  if (TEST_FILE.test(path) || ALLOWED_FILES.has(path)) return [];
  const code = maskCode(source);
  const opened = new Set([...code.matchAll(OPENED)].map((match) => match[1]!));
  const lines = source.split("\n");
  const calls: RawCall[] = [];
  for (const match of code.matchAll(CALL)) {
    const [, call, name, drizzleSql] = match;
    if (!RECEIVER.test(name!) && !opened.has(name!)) continue;
    if (drizzleSql && path.startsWith("src/db/")) continue;
    const start = code.slice(0, match.index).split("\n").length;
    const method = start + call!.split("\n").length - 1;
    const content = lines.slice(start - 1, method).map((line) => line.trim());
    calls.push({ path, line: method, content: content.join(" ") });
  }
  return calls;
}

export function parseAllowlist(text: string): Entry[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map((line) => {
      const first = line.indexOf(" | ");
      const last = line.lastIndexOf(" | ");
      if (first === -1 || first === last)
        throw new Error(`Allowlist line is not "path | line | reason": ${line}`);
      return {
        path: line.slice(0, first),
        content: line.slice(first + 3, last),
        reason: line.slice(last + 3),
      };
    });
}

export function checkRawSql(calls: readonly RawCall[], allowlist: readonly Entry[]) {
  const unused = [...allowlist];
  const used: Entry[] = [];
  const refused: RawCall[] = [];
  for (const call of calls) {
    const index = unused.findIndex(
      (entry) => entry.path === call.path && entry.content === call.content,
    );
    if (index === -1) refused.push(call);
    else used.push(...unused.splice(index, 1));
  }
  return { refused, used, stale: unused };
}

function sourceCalls(root: string): RawCall[] {
  const files = new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: root });
  return [...files]
    .sort()
    .flatMap((file) => rawCalls(file, readFileSync(join(root, file), "utf8")));
}

function main(root: string, baseline: boolean): number {
  const allowlistPath = join(root, "scripts/raw-sql-allowlist.txt");
  const { refused, used, stale } = checkRawSql(
    sourceCalls(root),
    parseAllowlist(readFileSync(allowlistPath, "utf8")),
  );
  if (baseline) {
    for (const call of refused)
      console.log(`${call.path} | ${call.content} | not yet converted to Drizzle`);
    return 0;
  }
  const counts = new Map<string, number>();
  for (const entry of used) {
    const key = `${entry.path} (${entry.reason})`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of counts) console.log(`allowlisted: ${count} × ${key}`);
  for (const entry of stale)
    console.log(`stale allowlist entry, remove it: ${entry.path} | ${entry.content}`);
  for (const call of refused)
    console.error(
      `${call.path}:${call.line}: raw bun:sqlite call; go through Drizzle in src/db: ${call.content}`,
    );
  if (refused.length === 0) return 0;
  console.error(
    `\n${refused.length} raw SQL call(s) refused. Move them to src/db through orm(db), or list them in ${relative(root, allowlistPath)} with a reason.`,
  );
  return 1;
}

if (import.meta.main) {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex === -1 ? join(import.meta.dir, "..") : process.argv[rootIndex + 1]!;
  process.exit(main(root, process.argv.includes("--baseline")));
}

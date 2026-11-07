import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ALLOWED_FILES = new Set(["src/db/migrate.ts", "src/db/open.ts"]);
const TEST_FILE = /(^|\/)(test|fixtures)\/|\.test\.tsx?$/;
const RECEIVER = /^(?:db|database|\w*Db|\w*Database)$/;
const OPENED = /\b(?:const|let)\s+(\w+)\s*=\s*(?:new Database|openDatabase)\(/g;
const CALL = /(?<![\w$.])((?:[\w$]+\.)*([\w$]+)\s*\.(?:query|run|prepare|exec))\s*\(\s*(sql`)?/g;

export type RawCall = { path: string; line: number; content: string };
export type Entry = { path: string; content: string; reason: string };

export function rawCalls(path: string, source: string): RawCall[] {
  if (TEST_FILE.test(path) || ALLOWED_FILES.has(path)) return [];
  const opened = new Set([...source.matchAll(OPENED)].map((match) => match[1]!));
  const lines = source.split("\n");
  const calls: RawCall[] = [];
  for (const match of source.matchAll(CALL)) {
    const [, call, name, drizzleSql] = match;
    if (!RECEIVER.test(name!) && !opened.has(name!)) continue;
    if (drizzleSql && path.startsWith("src/db/")) continue;
    const start = source.slice(0, match.index).split("\n").length;
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

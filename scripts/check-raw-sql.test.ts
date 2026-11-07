import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRawSql, parseAllowlist, rawCalls } from "./check-raw-sql";

function run(files: Record<string, string>, allowlist = "") {
  const root = mkdtempSync(join(tmpdir(), "raw-sql-"));
  for (const [path, source] of Object.entries({
    ...files,
    "scripts/raw-sql-allowlist.txt": allowlist,
  })) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return spawnSync("bun", [join(import.meta.dir, "check-raw-sql.ts"), "--root", root], {
    encoding: "utf8",
  });
}

test("a raw query in src/loop fails the check, naming the file and line", () => {
  const result = run({
    "src/loop/fixture.ts":
      'import type { Database } from "bun:sqlite";\n\nexport const one = (db: Database) => db.query("SELECT 1").get();\n',
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("src/loop/fixture.ts:3: raw bun:sqlite call");
});

test("a typed raw query fails the check", () => {
  const result = run({
    "src/loop/typed.ts":
      'export const ids = (db: Database) =>\n  db.query<{ id: string; n: number }, []>("SELECT id FROM work_item").all();\n',
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("src/loop/typed.ts:2: raw bun:sqlite call");
});

test("db.run() on a Db is Drizzle, and on a Database in the same file it is still raw", () => {
  expect(
    rawCalls("src/db/converted.ts", "export const f = (db: Db) => db.run(function* (q) {});\n"),
  ).toEqual([]);
  expect(
    rawCalls(
      "src/db/mixed.ts",
      'export const f = (db: Db) => db.run(steps);\nexport const g = (db: Database) => db.run("DELETE FROM x");\n',
    ).map((call) => call.line),
  ).toEqual([1, 2]);
});

test("calls inside comments, strings and templates are not database access", () => {
  const source = [
    '// db.query("SELECT 1");',
    "/* db.run(x) */",
    "const text = \"db.query('SELECT 1')\";",
    "const help = `run ${name}: db.exec(sql)`;",
    "const pattern = /db.run\\(/;",
    'db.prepare("SELECT 1");',
  ].join("\n");
  expect(rawCalls("src/loop/a.ts", source).map((call) => call.line)).toEqual([6]);
});

test("an allowlisted line passes and is printed; an unused entry is only a note", () => {
  const result = run(
    { "src/loop/fixture.ts": 'db.run("DELETE FROM t");\n' },
    'src/loop/fixture.ts | db.run("DELETE FROM t"); | not yet converted to Drizzle\nsrc/loop/gone.ts | db.run("x"); | not yet converted to Drizzle\n',
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(
    "allowlisted: 1 × src/loop/fixture.ts (not yet converted to Drizzle)",
  );
  expect(result.stdout).toContain(
    'stale allowlist entry, remove it: src/loop/gone.ts | db.run("x");',
  );
});

test("finds calls on Database receivers across lines and skips Drizzle, tests and allowed files", () => {
  const source = [
    "const old = new Database(path);",
    "old.exec(sql);",
    "this.db",
    "  .prepare(`SELECT 1`)",
    "orm(db).run(sql`DELETE FROM t`);",
    "db.run(sql`DELETE FROM t`);",
    "client.query(QUERY);",
    "/x/.exec(text);",
  ].join("\n");
  expect(rawCalls("src/loop/a.ts", source)).toEqual([
    { path: "src/loop/a.ts", line: 2, content: "old.exec(sql);" },
    { path: "src/loop/a.ts", line: 4, content: "this.db .prepare(`SELECT 1`)" },
    { path: "src/loop/a.ts", line: 6, content: "db.run(sql`DELETE FROM t`);" },
  ]);
  expect(rawCalls("src/db/a.ts", source).map((call) => call.line)).toEqual([2, 4]);
  expect(rawCalls("src/loop/a.test.ts", source)).toEqual([]);
  expect(rawCalls("src/db/open.ts", source)).toEqual([]);
});

test("a repeated line needs one entry per call", () => {
  const call = { path: "src/a.ts", line: 1, content: "db.run(x);" };
  const allowlist = parseAllowlist("src/a.ts | db.run(x); | reason\n");
  expect(checkRawSql([call, { ...call, line: 2 }], allowlist).refused).toEqual([
    { ...call, line: 2 },
  ]);
});

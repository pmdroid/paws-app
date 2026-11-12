import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Project } from "ts-morph";
import { manipulationSettings } from "./db-async";
import { convert, renderReport, type Report } from "./sqlite-tests";

const repo = join(import.meta.dir, "../..");
const fixtures = join(import.meta.dir, "fixtures/sqlite-tests");

function run(dir: string): Report {
  const project = new Project({
    tsConfigFilePath: join(repo, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
    manipulationSettings,
  });
  project.addSourceFilesAtPaths(join(dir, "**/*.ts"));
  const files = ["temp.ts", "memory.ts", "left.ts"].map((file) =>
    project.getSourceFileOrThrow(join(dir, file)),
  );
  const report = convert(files, { pglite: join(dir, "test/pglite.ts") });
  project.saveSync();
  spawnSync("bun", ["x", "oxfmt", "-c", join(repo, ".oxfmtrc.json"), dir], { cwd: repo });
  return report;
}

const dir = realpathSync(mkdtempSync(join(tmpdir(), "sqlite-tests-")));
cpSync(join(fixtures, "before"), dir, { recursive: true });
const first = run(dir);
const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");
const at = (sites: { file: string; line: number; text: string }[]) =>
  sites.map((s) => `${s.file.slice(dir.length + 1)}:${s.line} ${s.text}`);

test.each([
  ["tempDb() becomes tempStore() and each close awaits the store's close", "temp.ts"],
  [
    "an in-memory openDatabase and its migrate become tempStore() in an async helper that drops its Database return type",
    "memory.ts",
  ],
])("%s", (_name, file) => {
  expect(read(dir, file)).toBe(read(join(fixtures, "after"), file));
});

test("an assigned database and a file database stay as they are", () => {
  expect(read(dir, "left.ts")).toBe(read(join(fixtures, "before"), "left.ts"));
});

test("raw calls and the databases left on SQLite are reported by line", () => {
  expect(at(first.raw)).toEqual([
    `memory.ts:22 db.query("SELECT * FROM item")`,
    `temp.ts:8 db.run("INSERT INTO item VALUES ('a')")`,
  ]);
  expect(at(first.sources)).toEqual([
    "left.ts:8 tempDb()",
    `left.ts:13 openDatabase("/tmp/paws.db")`,
    "memory.ts:6 db is never closed",
    "memory.ts:12 db is never closed",
  ]);
  expect(first).toMatchObject({ stores: 4, closes: 2, unwrapped: 5, asyncFunctions: 2 });
  expect(renderReport(first, dir)).toContain("- `memory.ts` 1\n- `temp.ts` 1\n");
});

test("a second run changes nothing and still reports the raw calls", () => {
  const report = run(dir);
  expect(report).toMatchObject({ stores: 0, unwrapped: 0, files: [] });
  expect(report.raw.map((s) => s.text)).toEqual(first.raw.map((s) => s.text));
  for (const file of ["temp.ts", "memory.ts"])
    expect(read(dir, file)).toBe(read(join(fixtures, "after"), file));
});

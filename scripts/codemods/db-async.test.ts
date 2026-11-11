import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Project } from "ts-morph";
import { convert, manipulationSettings, parseArgs, type Report } from "./db-async";

const repo = join(import.meta.dir, "../..");
const fixtures = join(import.meta.dir, "fixtures/db-async");

function run(dir: string, wrappers?: string[]): Report {
  const project = new Project({
    tsConfigFilePath: join(repo, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
    manipulationSettings,
  });
  const files = project
    .addSourceFilesAtPaths(join(dir, "**/*.ts"))
    .filter((file) => !file.getFilePath().endsWith("/outside.ts"));
  const picked = wrappers?.map((file) => files.find((f) => f.getFilePath() === join(dir, file))!);
  const report = convert(project, { files, dbDir: join(dir, "db"), wrappers: picked });
  project.saveSync();
  spawnSync("bun", ["x", "oxfmt", "-c", join(repo, ".oxfmtrc.json"), dir], { cwd: repo });
  return report;
}

const dir = realpathSync(mkdtempSync(join(tmpdir(), "db-async-")));
cpSync(join(fixtures, "before"), dir, { recursive: true });
const first = run(dir);
const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");
const boundary = (file: string) =>
  first.boundaries.filter((b) => b.file === join(dir, file)).map((b) => [b.line, b.reason]);

test.each([
  ["a simple call awaits and wraps its Database in sqliteDb", "simple.ts"],
  ["a Db argument is kept as is", "db-arg.ts"],
  ["propagation reaches the caller's caller", "propagation.ts"],
  ["a sync test callback becomes async", "sync-test.ts"],
  ["a helper declared after its caller propagates", "helper.ts"],
  ["a test.each callback becomes async", "each.ts"],
  ["a typeof reference does not hold the wrapper back", "typeof.ts"],
  ["a test or script module awaits at top level", "test/top.ts"],
  ["a this.method() call propagates like a plain call", "method.ts"],
  ["a .map callback stays synchronous", "map.ts"],
  ["a transaction body stays synchronous", "transaction.ts"],
  ["callers of a folded fooAsync sibling use the final name", "fold.ts"],
  ["an export used outside the globs stays synchronous", "outside.ts"],
  ["wrappers become async over Db, fooAsync siblings fold in, side effects stay", "db/items.ts"],
])("%s", (_name, file) => {
  expect(read(dir, file)).toBe(read(join(fixtures, "after"), file));
});

test("boundaries and exports without a Steps form are reported", () => {
  expect(boundary("map.ts")).toEqual([[5, "sync callback (map)"]]);
  expect(boundary("transaction.ts")).toEqual([
    [6, "inside a transaction(...) body"],
    [7, "inside a transaction(...) body"],
  ]);
  expect(boundary("outside.ts")).toEqual([[5, "used outside the given files"]]);
  expect(boundary("db/items.ts")).toEqual([]);
  expect(first.withoutSteps.map((s) => s.name)).toEqual(["itemFile"]);
  expect(first).toMatchObject({
    wrappers: 5,
    folded: 1,
    calls: 14,
    wrapped: 9,
    asyncFunctions: 12,
  });
});

test("a second run changes nothing", () => {
  const report = run(dir);
  expect(report).toMatchObject({ wrappers: 0, calls: 0, asyncFunctions: 0, files: [] });
  for (const file of ["simple.ts", "fold.ts", "db/items.ts", "propagation.ts"])
    expect(read(dir, file)).toBe(read(join(fixtures, "after"), file));
});

test("--wrappers converts only the named files' wrappers and still finds every caller", () => {
  const fixture = join(import.meta.dir, "fixtures/db-async-wrappers");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "db-async-wrappers-")));
  cpSync(join(fixture, "before"), root, { recursive: true });
  const report = run(root, ["db/picked.ts"]);
  expect(report).toMatchObject({ wrappers: 1, calls: 1, wrapped: 1, boundaries: [] });
  for (const file of ["caller.ts", "db/picked.ts", "db/skipped.ts"])
    expect(read(root, file)).toBe(read(join(fixture, "after"), file));
});

test("--wrappers takes the arguments up to -- or the end", () => {
  expect(parseArgs(["src/**/*.ts"])).toEqual({ globs: ["src/**/*.ts"] });
  expect(parseArgs(["src/**/*.ts", "--wrappers", "src/db/a.ts", "src/db/b.ts"])).toEqual({
    globs: ["src/**/*.ts"],
    wrappers: ["src/db/a.ts", "src/db/b.ts"],
  });
  expect(parseArgs(["--wrappers", "src/db/a.ts", "--", "src/**/*.ts", "test/**/*.ts"])).toEqual({
    globs: ["src/**/*.ts", "test/**/*.ts"],
    wrappers: ["src/db/a.ts"],
  });
});

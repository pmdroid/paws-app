import { expect, test } from "bun:test";
import { rawCalls } from "./check-raw-sql";

test("SQL templates belong in the database module", () => {
  const source = "db.run(sql`DELETE FROM t`);";
  expect(rawCalls("src/loop/a.ts", source)).toEqual([
    { path: "src/loop/a.ts", line: 1, content: source },
  ]);
  expect(rawCalls("src/db/a.ts", source)).toEqual([]);
  expect(rawCalls("src/loop/a.test.ts", source)).toEqual([]);
  expect(rawCalls("src/loop/a.ts", "db.run(steps);")).toEqual([]);
});

test("ignores SQL calls in comments and strings", () => {
  expect(rawCalls("src/loop/a.ts", "// db.run(sql`DELETE FROM t`);")).toEqual([]);
  expect(rawCalls("src/loop/a.ts", '"db.run(sql`DELETE FROM t`);"')).toEqual([]);
});

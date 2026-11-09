import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runningFiles, stallReport } from "./test-watchdog";

test("the stall report names each running file, its worker and how long it has run", () => {
  const directory = mkdtempSync(join(tmpdir(), "watchdog-"));
  writeFileSync(join(directory, "202"), `5000 ${join(process.cwd(), "test/later.test.ts")}\n`);
  writeFileSync(join(directory, "101"), `1000 ${join(process.cwd(), "test/stuck.test.ts")}\n`);
  const files = runningFiles(directory);
  expect(files.map((file) => file.pid)).toEqual([101, 202]);
  const report = stallReport(files, 180_000, 181_000);
  expect(report).toContain("no progress for 180 s");
  expect(report).toContain("test/stuck.test.ts (worker 101, running 180 s)");
  expect(report).toContain("test/later.test.ts (worker 202, running 176 s)");
});

test("a stall with no running file says so", () => {
  expect(stallReport([], 180_000)).toContain("(no test file is running)");
});

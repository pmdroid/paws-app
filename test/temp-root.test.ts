import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";

test("tests write temp files under one per-run folder", () => {
  expect(basename(tmpdir())).toMatch(/^pt-/);
  expect(dirname(tmpdir())).not.toBe(tmpdir());
  expect(existsSync(tmpdir())).toBe(true);
});

import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeDependencySnapshots } from "./local/intake-dependencies";

test("Authoritative dependency snapshots preserve workspace and generation fences", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-dependencies-"));
  const names: string[] = [];
  try {
    await probeDependencySnapshots(root, (name, passed) => {
      assert(passed, name);
      names.push(name);
    });
    assert.equal(names.length, 10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeMergeDependencyYield } from "./local/merge-dependency-yield";

test("a new blocker runs in the yielded Linear session before its original verified merge", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-merge-dependency-yield-"));
  const observations: string[] = [];
  try {
    await probeMergeDependencyYield(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

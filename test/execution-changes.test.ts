import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { probeExecutionChanges } from "./local/execution-changes";

test("Linear execution changes fence stale publication and join selected remote work", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-execution-changes-"));
  const names: string[] = [];
  try {
    await probeExecutionChanges(root, (name, passed) => {
      assert(passed, name);
      names.push(name);
    });
    assert.equal(names.length, 12);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

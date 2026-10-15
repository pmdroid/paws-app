import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { probeExecutionLifecycle } from "./local/execution-lifecycle";

test("epic execution finishes, waits and wakes through durable production state", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-execution-lifecycle-"));
  const names: string[] = [];
  try {
    await probeExecutionLifecycle(root, (name, passed) => {
      assert(passed, name);
      names.push(name);
    });
    assert.equal(names.length, 17);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

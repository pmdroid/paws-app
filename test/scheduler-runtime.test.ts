import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { probeSchedulerRuntime } from "./local/scheduler-runtime";

test("durable scheduler ticks reconcile before admission and preserve the default dispatcher", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-scheduler-runtime-"));
  const observations: string[] = [];
  try {
    await probeSchedulerRuntime(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

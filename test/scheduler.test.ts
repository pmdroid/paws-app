import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeScheduler } from "./local/scheduler";

test("Scheduler dispatch is durable, capacity bound and conflict safe across processes", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-scheduler-"));
  const observations: string[] = [];
  try {
    await probeScheduler(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 22);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

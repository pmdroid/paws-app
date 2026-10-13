import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerWork } from "./local/runner-work";

test("remote work has durable signed commands, scoped grants and fenced leases", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-work-"));
  const observations: string[] = [];
  try {
    await probeRunnerWork(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 9);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

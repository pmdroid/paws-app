import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerHealth } from "./local/runner-health";

test("signed runner health is identity-bound, immutable and recoverable over real mTLS", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-health-"));
  const observations: string[] = [];
  try {
    await probeRunnerHealth(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

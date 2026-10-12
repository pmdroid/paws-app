import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerDaemonHealth } from "./local/runner-daemon-health";

test("the paired daemon validates and persists real mTLS health receipts", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-daemon-health-"));
  const observations: string[] = [];
  try {
    await probeRunnerDaemonHealth(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

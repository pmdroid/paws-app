import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerWorker } from "./local/runner-worker";

test("remote worker executes real ACP against exact Git snapshots through a credential-free job", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-worker-"));
  const observations: string[] = [];
  try {
    await probeRunnerWorker(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 15);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

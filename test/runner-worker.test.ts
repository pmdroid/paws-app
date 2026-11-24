import { test } from "bun:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { probeRunnerWorker } from "./local/runner-worker";
import { scratchDirectory } from "./local/scratch";

test("remote worker executes real ACP against exact Git snapshots through a credential-free job", async () => {
  const root = scratchDirectory("paws-runner-worker-");
  const observations: string[] = [];
  try {
    await probeRunnerWorker(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 17);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

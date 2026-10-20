import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerCoordinator } from "./local/runner-coordinator";

test("the coordinator composes persistent signing identity, pairing and fenced mTLS work", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-coordinator-"));
  const observations: string[] = [];
  try {
    await probeRunnerCoordinator(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

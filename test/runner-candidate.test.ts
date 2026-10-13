import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerCandidate } from "./local/runner-candidate";

test("credential-scoped candidate import validates fetched ancestry before checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-candidate-"));
  const observations: string[] = [];
  try {
    await probeRunnerCandidate(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

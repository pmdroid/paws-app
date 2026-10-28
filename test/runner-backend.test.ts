import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerBackend } from "./local/runner-backend";

test("remote agent bridge preserves canonical task state, questions and candidate identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-backend-"));
  const observations: string[] = [];
  try {
    await probeRunnerBackend(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 51);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

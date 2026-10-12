import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerArtifacts } from "./local/runner-artifacts";

test("remote artifact evidence uses immutable bounded private chunks and scoped delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-artifacts-"));
  const observations: string[] = [];
  try {
    await probeRunnerArtifacts(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

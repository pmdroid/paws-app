import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerOrchestration } from "./local/runner-orchestration";

test("remote orchestration keeps verification on the selected execution path", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-orchestration-"));
  const observations: string[] = [];
  try {
    await probeRunnerOrchestration(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 23);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeExecutionControls } from "./local/execution-controls";

test("Workspace execution controls reach canonical Stop, Pause and Resume with current authorization", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-controls-"));
  try {
    const observations = await probeExecutionControls(root);
    assert.equal(observations.length, 10);
    assert(observations.every((entry) => entry.passed));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

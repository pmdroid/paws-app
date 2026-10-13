import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeEpicReconciliation } from "./local/intake-reconciliation";

test("Authoritative issue reconciliation fences edits, children, events and five-minute sweeps", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-reconciliation-"));
  try {
    const observations = await probeEpicReconciliation(root);
    assert.equal(observations.length, 14);
    assert(observations.every((observation) => observation.passed));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

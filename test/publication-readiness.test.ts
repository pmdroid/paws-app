import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probePublicationReadiness } from "./local/publication-readiness";

test("Publication waits for fresh Linear criteria and abortable owned-job reconciliation", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-publication-readiness-"));
  try {
    const observations = await probePublicationReadiness(root);
    assert.equal(observations.length, 8);
    assert(observations.every((observation) => observation.passed));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

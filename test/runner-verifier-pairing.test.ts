import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerVerifierPairing } from "./local/runner-verifier-pairing";

test("runner pairing and renewal retain an explicitly approved verifier identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-verifier-pairing-test-"));
  const observations: string[] = [];
  try {
    await probeRunnerVerifierPairing(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

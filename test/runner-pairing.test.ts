import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerPairing } from "./local/runner-pairing";

test("runner pairing binds current workspace approval and persists revocation across process restarts", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-pairing-"));
  const observations: string[] = [];
  try {
    await probeRunnerPairing(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 8);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

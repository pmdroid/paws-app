import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeProvisionedPairing } from "./local/runner-pairing";

test("Paws approves the pairing of a VM it created, owned by the requesting member", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-provisioned-pairing-"));
  const observations: string[] = [];
  try {
    await probeProvisionedPairing(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

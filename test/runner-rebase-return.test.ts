import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerRebaseReturn } from "./local/runner-rebase-return";

test("a rebase-conflict return under a commit policy publishes and imports the rebased candidate", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-rebase-return-"));
  const observations: string[] = [];
  try {
    await probeRunnerRebaseReturn(root, (name, passed, observed) => {
      assert(passed, `${name}: ${JSON.stringify(observed)}`);
      observations.push(name);
    });
    assert.equal(observations.length, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

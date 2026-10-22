import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerRepositories } from "./local/runner-repositories";

test("runner repository cache fetches exact bases and validates candidates outside the agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-repositories-"));
  let observations = 0;
  try {
    await probeRunnerRepositories(root, (name, passed) => {
      assert(passed, name);
      observations += 1;
    });
    assert.equal(observations, 11);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

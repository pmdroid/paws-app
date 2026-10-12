import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerResults } from "./local/runner-results";

test("remote agent results and question answers persist with immutable grant-bound delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-results-"));
  const observations: string[] = [];
  try {
    await probeRunnerResults(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

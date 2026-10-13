import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerSessionHelpers } from "./local/runner-session-helpers";

test("signed session helper work is fenced independently from repository runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-session-helper-test-"));
  const observations: string[] = [];
  try {
    await probeRunnerSessionHelpers(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

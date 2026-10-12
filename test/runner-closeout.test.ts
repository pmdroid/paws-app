import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerCloseout } from "./local/runner-closeout";

test("native Closeout preserves remote check results and candidate binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-closeout-"));
  const observations: string[] = [];
  try {
    await probeRunnerCloseout(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 9);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

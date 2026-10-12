import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeGitCancellation } from "./local/git-cancellation";

test("credentialed Git joins its owned process group on cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-git-cancel-"));
  let observations = 0;
  try {
    await probeGitCancellation(root, (name, passed) => {
      assert(passed, name);
      observations += 1;
    });
    assert.equal(observations, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

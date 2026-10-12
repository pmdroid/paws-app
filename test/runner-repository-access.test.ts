import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerRepositoryAccess } from "./local/runner-repository-access";

test("remote repository credentials require current mTLS identity and a scoped live run grant", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-repository-access-"));
  const observations: string[] = [];
  try {
    await probeRunnerRepositoryAccess(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

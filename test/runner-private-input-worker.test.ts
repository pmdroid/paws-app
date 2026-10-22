import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerWorker } from "./local/runner-worker";
import { executeRunnerCommand } from "../src/runner-worker";

test("worker restores protected inputs and excludes them from real candidate checkpoints", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-private-input-worker-"));
  const observations: string[] = [];
  try {
    await probeRunnerWorker(
      root,
      (name, passed) => {
        assert(passed, name);
        observations.push(name);
      },
      executeRunnerCommand,
      true,
    );
    assert.equal(observations.length, 17);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

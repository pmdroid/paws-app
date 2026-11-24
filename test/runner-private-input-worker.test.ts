import { test } from "bun:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { probeRunnerWorker } from "./local/runner-worker";
import { scratchDirectory } from "./local/scratch";
import { executeRunnerCommand } from "../src/runner-worker";

test("worker restores protected inputs and excludes them from real candidate checkpoints", async () => {
  const root = scratchDirectory("paws-private-input-worker-");
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
    assert.equal(observations.length, 18);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

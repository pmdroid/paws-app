import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerOrchestration } from "./local/runner-orchestration";

test("Closeout waits for a paused runner, says why once, asks after the limit and resumes", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-closeout-runner-wait-"));
  const observations: string[] = [];
  const identity = {
    GIT_AUTHOR_NAME: "Paws Test",
    GIT_AUTHOR_EMAIL: "paws-test@example.invalid",
    GIT_COMMITTER_NAME: "Paws Test",
    GIT_COMMITTER_EMAIL: "paws-test@example.invalid",
  };
  const previous = Object.fromEntries(Object.keys(identity).map((key) => [key, process.env[key]]));
  Object.assign(process.env, identity);
  try {
    await probeRunnerOrchestration(
      root,
      (name, passed) => {
        assert(passed, name);
        observations.push(name);
      },
      false,
      ["runner-wait"],
    );
    assert.deepEqual(observations, [
      "Closeout waits for a paused runner and asks after the wait limit",
      "resuming the runner continues Closeout without using an attempt",
    ]);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

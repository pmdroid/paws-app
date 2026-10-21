import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerOrchestration } from "./local/runner-orchestration";

test("remote orchestration keeps verification on the selected execution path", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-orchestration-"));
  const observations: string[] = [];
  // Rebasing before a merge writes commits, so Git needs an identity even where none is configured.
  const identity = {
    GIT_AUTHOR_NAME: "Paws Test",
    GIT_AUTHOR_EMAIL: "paws-test@example.invalid",
    GIT_COMMITTER_NAME: "Paws Test",
    GIT_COMMITTER_EMAIL: "paws-test@example.invalid",
  };
  const previous = Object.fromEntries(Object.keys(identity).map((key) => [key, process.env[key]]));
  Object.assign(process.env, identity);
  try {
    await probeRunnerOrchestration(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 32);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

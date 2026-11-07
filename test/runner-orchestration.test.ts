import { afterAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeRunnerOrchestration,
  RUNNER_ORCHESTRATION_SCENARIOS,
} from "./local/runner-orchestration";

const identity = {
  GIT_AUTHOR_NAME: "Paws Test",
  GIT_AUTHOR_EMAIL: "paws-test@example.invalid",
  GIT_COMMITTER_NAME: "Paws Test",
  GIT_COMMITTER_EMAIL: "paws-test@example.invalid",
};
const previous = Object.fromEntries(Object.keys(identity).map((key) => [key, process.env[key]]));
Object.assign(process.env, identity);
const observations: string[] = [];

afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// One test per scenario, so a loaded machine slows each against its own budget.
for (const scenario of RUNNER_ORCHESTRATION_SCENARIOS)
  test(`remote orchestration keeps verification on the selected execution path: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "paws-runner-orchestration-"));
    try {
      await probeRunnerOrchestration(
        root,
        (name, passed) => {
          assert(passed, name);
          observations.push(name);
        },
        false,
        [scenario],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

test("remote orchestration observes every scenario", () => {
  expect(observations).toHaveLength(34);
});

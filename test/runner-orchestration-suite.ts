import { afterAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeRunnerOrchestration,
  RUNNER_ORCHESTRATION_SCENARIOS,
} from "./local/runner-orchestration";

export const RUNNER_ORCHESTRATION_PARTS = [
  { scenarios: ["success", "error", "cancelled"], observations: 7 },
  { scenarios: ["reassigned", "stale", "merge"], observations: 6 },
  {
    scenarios: [
      "unavailable",
      "crashed-implementation",
      "crashed-review",
      "start-lease",
      "resume-lease",
    ],
    observations: 7,
  },
  { scenarios: ["reverify-lease", "rebase"], observations: 4 },
  { scenarios: ["rebase-failing"], observations: 2 },
  { scenarios: ["rebase-unreachable", "rebase-empty-report"], observations: 4 },
  { scenarios: ["rebase-rate-limited"], observations: 2 },
  { scenarios: ["rebase-missing-result"], observations: 2 },
  { scenarios: ["rebase-missing-twice"], observations: 2 },
] as const;

const identity = {
  GIT_AUTHOR_NAME: "Paws Test",
  GIT_AUTHOR_EMAIL: "paws-test@example.invalid",
  GIT_COMMITTER_NAME: "Paws Test",
  GIT_COMMITTER_EMAIL: "paws-test@example.invalid",
};

export function runnerOrchestrationTests(part: number) {
  const { scenarios, observations: expected } = RUNNER_ORCHESTRATION_PARTS[part]!;
  const previous = Object.fromEntries(Object.keys(identity).map((key) => [key, process.env[key]]));
  Object.assign(process.env, identity);
  const observations: string[] = [];

  afterAll(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("remote orchestration parts cover every scenario once", () => {
    expect(RUNNER_ORCHESTRATION_PARTS.flatMap((entry) => entry.scenarios).toSorted()).toEqual(
      [...RUNNER_ORCHESTRATION_SCENARIOS].toSorted(),
    );
    expect(RUNNER_ORCHESTRATION_PARTS.reduce((sum, entry) => sum + entry.observations, 0)).toBe(36);
  });

  for (const scenario of scenarios)
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
    expect(observations).toHaveLength(expected);
  });
}

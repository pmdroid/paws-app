import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Step = { shell?: string; name?: string; run?: string; env?: Record<string, string> };
const workflow = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, "../.github/workflows/ci.yml"), "utf8"),
) as { jobs: Record<string, { name: string; needs?: string[]; if?: string; steps: Step[] }> };
const aggregate = workflow.jobs.check!;
const gate = aggregate.steps.find((step) => step.name === "Require successful test results")!;

test("the existing required aggregate waits for stress even when dependencies fail or skip", () => {
  expect(aggregate.name).toBe("lint, format, types, test, dashboard build");
  expect(aggregate.needs).toEqual([
    "test",
    "test-postgres",
    "select-changed-tests",
    "changed-tests",
  ]);
  expect(aggregate.if).toBe("always()");
  expect(gate.env).toEqual({
    EVENT_NAME: "${{ github.event_name }}",
    TEST_RESULT: "${{ needs.test.result }}",
    POSTGRES_RESULT: "${{ needs.test-postgres.result }}",
    SELECTION_RESULT: "${{ needs.select-changed-tests.result }}",
    STRESS_RESULT: "${{ needs.changed-tests.result }}",
  });
  expect(aggregate.steps.indexOf(gate)).toBe(0);
});

for (const event of ["pull_request", "push"]) {
  for (const stress of ["success", "failure", "cancelled", "skipped"]) {
    test(`${event} aggregate with stress ${stress}`, () => {
      const result = Bun.spawnSync(["bash", "-e", "-c", gate.run!], {
        env: {
          ...process.env,
          EVENT_NAME: event,
          TEST_RESULT: "success",
          POSTGRES_RESULT: "success",
          SELECTION_RESULT: event === "push" ? "skipped" : "success",
          STRESS_RESULT: stress,
        },
      });
      expect(result.exitCode === 0).toBe(stress === (event === "push" ? "skipped" : "success"));
    });
  }
}

for (const job of ["TEST_RESULT", "POSTGRES_RESULT"]) {
  for (const status of ["failure", "cancelled", "skipped"]) {
    test(`push still rejects ${job} ${status}`, () => {
      const result = Bun.spawnSync(["bash", "-e", "-c", gate.run!], {
        env: {
          ...process.env,
          EVENT_NAME: "push",
          TEST_RESULT: "success",
          POSTGRES_RESULT: "success",
          SELECTION_RESULT: "skipped",
          STRESS_RESULT: "skipped",
          [job]: status,
        },
      });
      expect(result.exitCode).not.toBe(0);
    });
  }
}

test("stress is intentionally skipped only outside pull requests", () => {
  expect(workflow.jobs["changed-tests"]!.if).toBe("github.event_name == 'pull_request'");
});

for (const status of ["failure", "cancelled", "skipped"]) {
  test(`pull request rejects selection ${status} even if stress reports success`, () => {
    const result = Bun.spawnSync(["bash", "-e", "-c", gate.run!], {
      env: {
        ...process.env,
        EVENT_NAME: "pull_request",
        TEST_RESULT: "success",
        POSTGRES_RESULT: "success",
        SELECTION_RESULT: status,
        STRESS_RESULT: "success",
      },
    });
    expect(result.exitCode).not.toBe(0);
  });
}

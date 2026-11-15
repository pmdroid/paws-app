import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Step = { shell?: string; name?: string; run?: string; env?: Record<string, string> };
const workflow = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, "../.github/workflows/ci.yml"), "utf8"),
) as { jobs: Record<string, { name: string; needs?: string[]; if?: string; steps: Step[] }> };
const aggregate = workflow.jobs.check!;
const gate = aggregate.steps.find((step) => step.name === "Require successful test results")!;

test("the existing required aggregate waits for stress even when dependencies fail or skip", () => {
  expect(aggregate.name).toBe("lint, format, types, test, dashboard build");
  expect(aggregate.needs).toEqual(["test", "test-postgres", "changed-tests"]);
  expect(aggregate.if).toBe("always()");
  expect(gate.env).toEqual({
    EVENT_NAME: "${{ github.event_name }}",
    TEST_RESULT: "${{ needs.test.result }}",
    POSTGRES_RESULT: "${{ needs.test-postgres.result }}",
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

for (const failure of ["none", "diff", "selection"]) {
  test(
    failure === "none" ? "zero selected tests succeeds" : `${failure} failure fails stress`,
    () => {
      const dir = mkdtempSync(join(tmpdir(), "paws-ci-gate-"));
      try {
        writeFileSync(join(dir, "git"), `#!/bin/sh\nexit ${failure === "diff" ? 1 : 0}\n`, {
          mode: 0o755,
        });
        if (failure === "selection") {
          writeFileSync(join(dir, "head"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
        }
        const step = workflow.jobs["changed-tests"]!.steps.find((entry) =>
          entry.run?.includes("git diff"),
        )!;
        expect(step.shell).toBe("bash");
        const result = Bun.spawnSync(
          ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step.run!],
          {
            env: {
              ...process.env,
              PATH: `${dir}:${process.env.PATH}`,
              RUNNER_TEMP: dir,
              BASE_REF: "main",
            },
          },
        );
        expect(result.exitCode === 0).toBe(failure === "none");
        if (failure === "none")
          expect(result.stdout.toString()).toContain("No new or changed test files");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}

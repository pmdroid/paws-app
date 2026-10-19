import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { RUNNER_RESULT_BODY_LIMIT, RunnerResultSchema } from "../src/runner-protocol";
import { probeRunnerResults } from "./local/runner-results";

test("remote agent results and question answers persist with immutable grant-bound delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-results-"));
  const observations: string[] = [];
  try {
    await probeRunnerResults(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("runner result bounds preserve health schema derivation and escaped metadata", () => {
  const result = RunnerResultSchema.parse({
    executionId: "01K00000000000000000000000",
    commandId: "c".repeat(128),
    role: "reviewer",
    stopReason: "end_turn",
    timedOut: false,
    cancelled: false,
    authRequired: false,
    agentExited: true,
    sessionId: "\u0000".repeat(512),
    errorMessage: "\u0000".repeat(16384),
    identity: {
      session: "\u0000".repeat(512),
      model: "\u0000".repeat(512),
      provider: "\u0000".repeat(512),
    },
    reviewText: "\u0000".repeat(150000),
  });
  assert(
    Buffer.byteLength(JSON.stringify({ generation: Number.MAX_SAFE_INTEGER, result })) <=
      RUNNER_RESULT_BODY_LIMIT,
  );
  const health = RunnerResultSchema.omit({ candidateSha: true, reviewText: true }).extend({
    models: z.array(z.strictObject({ id: z.string(), name: z.string() })),
  });
  const metadata = { ...result };
  delete metadata.reviewText;
  assert(health.safeParse({ ...metadata, models: [{ id: "codex", name: "Codex" }] }).success);
  assert(RunnerResultSchema.shape.reviewText.safeParse(result.reviewText).success);
  const report = JSON.stringify({ pending: [], blocked: null });
  assert(RunnerResultSchema.safeParse({ ...result, closeoutReport: report }).success);
  assert(!RunnerResultSchema.safeParse({ ...result, closeoutReport: "x".repeat(65_537) }).success);
});

test("runner results carry the agent's Closeout command output within a byte budget", () => {
  const base = {
    executionId: "01J00000000000000000000000",
    commandId: "run-1",
    role: "implementer",
    stopReason: "end_turn",
    timedOut: false,
    cancelled: false,
    authRequired: false,
    agentExited: true,
  } as const;
  const run = {
    id: "unit",
    argv: ["bun", "test"],
    exitCode: 0,
    timedOut: false,
    durationMs: 24_200,
    stdout: "12 pass\n",
    stderr: "",
    truncated: false,
  };
  assert.deepEqual(RunnerResultSchema.parse({ ...base, closeoutRuns: [run] }).closeoutRuns, [run]);
  const wide = Array.from({ length: 32 }, (_, index) => ({
    ...run,
    id: `check-${index}`,
    stdout: "x".repeat(8_192),
  }));
  assert.equal(RunnerResultSchema.safeParse({ ...base, closeoutRuns: wide }).success, false);
});

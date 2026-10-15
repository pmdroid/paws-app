import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runAgent } from "../../src/acp";
import { RunnerHealthResultSchema } from "../../src/runner-protocol";

const root = process.argv[2]
  ? resolve(process.argv[2])
  : mkdtempSync(join(tmpdir(), "paws-default-model-"));
mkdirSync(root, { recursive: true, mode: 0o700 });
const worktree = join(root, "workspace");
mkdirSync(worktree, { mode: 0o700 });
const observations = [];
for (const scenario of [
  "named-default",
  "explicit-model",
  "ambiguous-default",
  "rejected-default",
]) {
  const scriptPath = join(root, `${scenario}.script.json`);
  const resultPath = join(root, `${scenario}.trace.json`);
  writeFileSync(
    scriptPath,
    JSON.stringify({
      model: "default",
      modelOptions: [
        { value: "default", name: "Default (recommended)", description: "Sonnet 5.5" },
        { value: "sonnet", name: "Sonnet 5.5" },
        { value: "opus", name: scenario === "ambiguous-default" ? "Sonnet 5.5" : "Opus 5.5" },
      ],
      ...(scenario === "rejected-default" ? { modelError: "Default model unavailable" } : {}),
      steps: [{ type: "end" }],
    }),
  );
  const result = await runAgent({
    role: "implementer",
    profile: { agent: "claude", model: scenario === "explicit-model" ? "opus" : null },
    itemId: "MODEL-1",
    runId: scenario,
    worktreePath: worktree,
    pawsRoot: join(root, "paws"),
    home: root,
    command: process.execPath,
    args: [
      new URL("../../src/acp/testing/fake-agent.ts", import.meta.url).pathname,
      resultPath,
      scriptPath,
    ],
    prepareOnly: true,
    readOnly: true,
    checkpoint: false,
    prompt: "",
  });
  const trace = JSON.parse(readFileSync(resultPath, "utf8"));
  assert.equal(result.agentExited, true);
  assert.equal(trace.methods.includes("session/prompt"), false);
  if (scenario === "ambiguous-default" || scenario === "rejected-default") {
    assert.equal(result.identity, undefined);
    if (scenario === "rejected-default") assert.equal(result.stopReason, "error");
    else assert.equal(trace.modelSelection, undefined);
  } else {
    const expected = scenario === "explicit-model" ? "opus" : "sonnet";
    assert.equal(result.identity?.model, expected);
    assert.equal(trace.modelSelection.value, expected);
    const transported = RunnerHealthResultSchema.parse({
      executionId: "01M4YNHNTGV6MF94MC17BY8SW3",
      commandId: scenario,
      role: result.role,
      stopReason: result.stopReason,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      authRequired: result.authRequired,
      agentExited: result.agentExited,
      sessionId: result.sessionId,
      identity: result.identity,
      models: result.models,
      effort: result.effort,
      efforts: result.efforts,
    });
    assert.deepEqual(transported.identity, result.identity);
  }
  observations.push({
    scenario,
    passed: true,
    model: result.identity?.model ?? null,
    agentExited: result.agentExited,
  });
}
writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2) + "\n");
console.log(JSON.stringify({ root, observations }, null, 2));

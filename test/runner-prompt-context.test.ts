import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  RunnerCommandSchema,
  signRunnerCommand,
  verifyRunnerCommand,
  type RunnerCommand,
  RunnerPromptContextSchema,
  RUNNER_PROMPT_CONTEXT_MAX_BYTES,
} from "../src/runner-protocol";

const common = {
  id: "command",
  runnerId: "runner",
  workspaceId: "workspace",
  issuedAt: 1,
  expiresAt: 100,
};
const profile = { agent: "codex", model: null };
const context = { sizeBytes: 20_972_002, sha256: "a".repeat(64) };
test("context descriptor is bounded independently and only permitted on signed run/review/task commands", () => {
  expect(RunnerPromptContextSchema.safeParse(context).success).toBe(true);
  expect(
    RunnerPromptContextSchema.safeParse({ ...context, sizeBytes: RUNNER_PROMPT_CONTEXT_MAX_BYTES })
      .success,
  ).toBe(true);
  for (const changed of [
    { ...context, sizeBytes: RUNNER_PROMPT_CONTEXT_MAX_BYTES + 1 },
    { ...context, sizeBytes: -1 },
    { ...context, sha256: "invalid" },
  ])
    expect(RunnerPromptContextSchema.safeParse(changed).success).toBe(false);
  const work = {
    ...common,
    runId: "run",
    itemId: "item",
    generation: 1,
    profile,
    prompt: "Read protected prepared prompt",
    promptContext: context,
  };
  const repository = {
    owner: "fixture",
    repo: "repo",
    remoteUrl: "https://github.com/fixture/repo.git",
    baseSha: "b".repeat(40),
  };
  for (const type of ["run", "review"])
    expect(RunnerCommandSchema.safeParse({ ...work, type, repository }).success).toBe(true);
  expect(
    RunnerCommandSchema.safeParse({
      ...work,
      type: "task",
      sessionId: "session",
      sessionGeneration: 0,
      taskModeGeneration: 0,
      purpose: "answer",
    }).success,
  ).toBe(true);
  expect(
    RunnerCommandSchema.safeParse({
      ...common,
      type: "helper",
      sessionId: "session",
      sessionGeneration: 0,
      purpose: "classify",
      profile,
      prompt: "Route",
      promptContext: context,
    }).success,
  ).toBe(false);
  expect(
    RunnerCommandSchema.safeParse({ ...common, type: "probe", profile, promptContext: context })
      .success,
  ).toBe(false);
});

test("prompt context digest is part of the signed command authority", () => {
  const keys = generateKeyPairSync("ed25519");
  const command: RunnerCommand = {
    ...common,
    type: "task",
    runId: "run",
    itemId: "item",
    generation: 1,
    sessionId: "session",
    sessionGeneration: 0,
    taskModeGeneration: 0,
    purpose: "answer",
    profile: { agent: "codex", model: null },
    prompt: "Read full context",
    promptContext: context,
  };
  const envelope = signRunnerCommand({ keyId: "key", privateKey: keys.privateKey, command });
  const verifier = {
    trustedKeys: new Map([["key", keys.publicKey]]),
    runnerId: "runner",
    workspaceId: "workspace",
    now: 2,
    allowedRepositories: [],
    claimCommand: () => true,
  };
  expect(verifyRunnerCommand(envelope, verifier).ok).toBe(true);
  const changed = { ...command, promptContext: { ...context, sha256: "b".repeat(64) } };
  expect(
    verifyRunnerCommand(
      { ...envelope, payload: Buffer.from(JSON.stringify(changed)).toString("base64url") },
      verifier,
    ),
  ).toEqual({ ok: false, reason: "invalid_signature" });
});

test("large restored prompts transfer exactly over mTLS and remain fenced after process reopen", () => {
  const proof = JSON.parse(
    execFileSync(process.execPath, ["--no-env-file", "test/local/runner-prompt-context.ts"], {
      encoding: "utf8",
      timeout: 120_000,
    }),
  );
  expect(proof.observations).toHaveLength(6);
  expect(proof.observations.every((value: { passed: boolean }) => value.passed)).toBe(true);
});

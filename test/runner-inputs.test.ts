import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  RunnerCommandSchema,
  RunnerInputFileSchema,
  RunnerInputFilesSchema,
  signRunnerCommand,
  verifyRunnerCommand,
  type RunnerCommand,
} from "../src/runner-protocol";

const file = {
  id: 0,
  path: ".paws-linear-inputs/turn/file.png",
  mimeType: "image/png",
  sizeBytes: 4,
  sha256: "a".repeat(64),
};
const command: Extract<RunnerCommand, { type: "run" }> = {
  id: "command",
  runnerId: "runner",
  workspaceId: "workspace",
  issuedAt: 1,
  expiresAt: 100,
  type: "run",
  runId: "run",
  itemId: "item",
  generation: 1,
  repository: {
    owner: "fixture",
    repo: "repo",
    remoteUrl: "https://github.com/fixture/repo.git",
    baseSha: "b".repeat(40),
  },
  profile: { agent: "codex", model: null },
  prompt: "Inspect attachment",
  inputFiles: [file],
};
test("input metadata is signed with the exact run and repository authority", () => {
  const keys = generateKeyPairSync("ed25519");
  const envelope = signRunnerCommand({ keyId: "key", privateKey: keys.privateKey, command });
  const context = {
    trustedKeys: new Map([["key", keys.publicKey]]),
    runnerId: "runner",
    workspaceId: "workspace",
    now: 2,
    allowedRepositories: ["fixture/repo"],
    claimCommand: () => true,
  };
  const verified = verifyRunnerCommand(envelope, context);
  expect(verified.ok).toBe(true);
  const modified = JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8"));
  modified.inputFiles[0].sha256 = "c".repeat(64);
  expect(
    verifyRunnerCommand(
      { ...envelope, payload: Buffer.from(JSON.stringify(modified)).toString("base64url") },
      context,
    ),
  ).toEqual({ ok: false, reason: "invalid_signature" });
  expect(RunnerCommandSchema.safeParse({ ...command, type: "review" }).success).toBe(true);
  expect(
    RunnerCommandSchema.safeParse({
      id: "health",
      runnerId: "runner",
      workspaceId: "workspace",
      issuedAt: 1,
      expiresAt: 100,
      type: "login_check",
      agent: "codex",
      inputFiles: [file],
    }).success,
  ).toBe(false);
});
test("input manifests reject malformed MIME, hidden Git paths, overlapping paths and noncanonical indices", () => {
  for (const changed of [
    { ...file, mimeType: "text/plain;token=value" },
    { ...file, path: "a/.GIT/config" },
    { ...file, path: "a\\b" },
    { ...file, path: "a//b" },
    { ...file, path: "../outside" },
    { ...file, sizeBytes: -1 },
    { ...file, sha256: "invalid" },
  ])
    expect(RunnerInputFileSchema.safeParse(changed).success).toBe(false);
  expect(
    RunnerInputFilesSchema.safeParse([
      { ...file, path: "a" },
      { ...file, id: 1, path: "a/b" },
    ]).success,
  ).toBe(false);
  expect(RunnerInputFilesSchema.safeParse([{ ...file, id: 1 }]).success).toBe(false);
  expect(
    RunnerInputFilesSchema.safeParse([
      { ...file, sizeBytes: 20 * 1024 * 1024 },
      { ...file, id: 1, path: "other", sizeBytes: 1 },
    ]).success,
  ).toBe(false);
});

test("private input storage recovers Unicode manifests, directory faults and interrupted publication", () => {
  const proof = JSON.parse(
    execFileSync(process.execPath, ["--no-env-file", "test/local/runner-input-faults.ts"], {
      encoding: "utf8",
    }),
  );
  expect(proof.observations).toHaveLength(4);
  expect(proof.observations.every((value: { passed: boolean }) => value.passed)).toBe(true);
});

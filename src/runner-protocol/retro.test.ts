import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  RUNNER_RETRO_LIMITS,
  RETRO_RUNNER_VERSION,
  RunnerRetroCommandSchema,
  RunnerRetroResultSchema,
  acceptRetroResult,
  authorizeRetroInput,
  runnerAcceptsRetro,
  runnerRetroInputGrant,
  runnerRetroSlot,
  runnerRetroSlotKey,
  signRunnerCommand,
  signRunnerRetroCommand,
  verifyRunnerCommand,
  verifyRunnerRetroCommand,
  type RunnerRetroCommand,
  type RunnerRetroCommandVerifier,
  type RunnerRetroResult,
} from "./index";

const key = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const retro: RunnerRetroCommand = {
  id: "retro-command-1",
  runnerId: "runner-1",
  workspaceId: "workspace-1",
  issuedAt: 1_000,
  expiresAt: 61_000,
  type: "retro",
  capability: 1,
  retroId: "retro-1",
  attempt: 2,
  settingsRevision: 4,
  profile: { agent: "codex", model: "gpt-6-astra", effort: "high" },
  executionLimit: { activeMinutes: 15 },
  output: { maxItems: 5, workedWell: 3, maxChars: 32_000 },
  digest: {
    kind: "digest",
    workspaceId: "workspace-1",
    retroId: "retro-1",
    sha256: "a".repeat(64),
    sizeBytes: 4_096,
  },
  prompt: {
    kind: "prompt",
    workspaceId: "workspace-1",
    retroId: "retro-1",
    sha256: "b".repeat(64),
    sizeBytes: 6_000,
  },
};

function verifier(overrides: Partial<RunnerRetroCommandVerifier> = {}): RunnerRetroCommandVerifier {
  const claimed = new Set<string>();
  return {
    trustedKeys: new Map([["paws", key.publicKey]]),
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    now: 2_000,
    latestAttempt: () => undefined,
    claimCommand(id) {
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    },
    ...overrides,
  };
}

const signed = (command: RunnerRetroCommand = retro) =>
  signRunnerRetroCommand({ keyId: "paws", privateKey: key.privateKey, command });

function result(overrides: Partial<RunnerRetroResult> = {}): RunnerRetroResult {
  const output = '{"patterns":[],"workedWell":[]}';
  return {
    executionId: "01JBX0000000000000000000AA",
    commandId: retro.id,
    type: "retro",
    capability: 1,
    runnerId: retro.runnerId,
    workspaceId: retro.workspaceId,
    retroId: retro.retroId,
    attempt: retro.attempt,
    settingsRevision: retro.settingsRevision,
    digestSha256: retro.digest.sha256,
    promptSha256: retro.prompt.sha256,
    outcome: "completed",
    activeMs: 120_000,
    output,
    outputSha256: hash(output),
    ...overrides,
  };
}

test("a signed retro command round-trips without a session, work item or checkout", () => {
  const verified = verifyRunnerRetroCommand(signed(), verifier());
  expect(verified).toEqual({ ok: true, command: retro });
  if (!verified.ok) throw new Error("unreachable");
  for (const field of ["sessionId", "itemId", "runId", "repository", "generation"])
    expect(field in verified.command).toBe(false);
});

test("signature binds workspace, runner, attempt, digest hash and expiry", () => {
  const envelope = signed();
  const payload = JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8"));
  for (const tamper of [
    { workspaceId: "workspace-2" },
    { runnerId: "runner-2" },
    { attempt: 3 },
    { settingsRevision: 5 },
    { expiresAt: 600_000 },
    { digest: { ...payload.digest, sha256: "c".repeat(64) } },
    { prompt: { ...payload.prompt, sha256: "c".repeat(64) } },
  ]) {
    const forged = {
      ...envelope,
      payload: Buffer.from(JSON.stringify({ ...payload, ...tamper })).toString("base64url"),
    };
    expect(verifyRunnerRetroCommand(forged, verifier())).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
  }
  const foreign = signRunnerRetroCommand({
    keyId: "paws",
    privateKey: other.privateKey,
    command: retro,
  });
  expect(verifyRunnerRetroCommand(foreign, verifier())).toEqual({
    ok: false,
    reason: "invalid_signature",
  });
  expect(verifyRunnerRetroCommand({ ...envelope, keyId: "unknown" }, verifier())).toEqual({
    ok: false,
    reason: "untrusted_key",
  });
});

test("verification refuses another runner or workspace, expiry, replay and stale attempts", () => {
  expect(verifyRunnerRetroCommand(signed(), verifier({ runnerId: "runner-2" }))).toEqual({
    ok: false,
    reason: "identity_mismatch",
  });
  expect(verifyRunnerRetroCommand(signed(), verifier({ workspaceId: "workspace-2" }))).toEqual({
    ok: false,
    reason: "identity_mismatch",
  });
  expect(verifyRunnerRetroCommand(signed(), verifier({ now: 500 }))).toEqual({
    ok: false,
    reason: "not_yet_valid",
  });
  expect(verifyRunnerRetroCommand(signed(), verifier({ now: 61_000 }))).toEqual({
    ok: false,
    reason: "expired",
  });
  for (const latest of [2, 3])
    expect(verifyRunnerRetroCommand(signed(), verifier({ latestAttempt: () => latest }))).toEqual({
      ok: false,
      reason: "stale_attempt",
    });
  expect(verifyRunnerRetroCommand(signed(), verifier({ latestAttempt: () => 1 })).ok).toBe(true);
  const once = verifier();
  expect(verifyRunnerRetroCommand(signed(), once).ok).toBe(true);
  expect(verifyRunnerRetroCommand(signed(), once)).toEqual({ ok: false, reason: "replayed" });
  expect(
    verifyRunnerRetroCommand(
      signed(),
      verifier({
        claimCommand: () => {
          throw new Error("store closed");
        },
      }),
    ),
  ).toEqual({ ok: false, reason: "replay_unavailable" });
});

test("schemas bound sizes and reject cross-workspace input references", () => {
  const invalid: Partial<RunnerRetroCommand>[] = [
    { digest: { ...retro.digest, workspaceId: "workspace-2" } },
    { prompt: { ...retro.prompt, retroId: "retro-2" } },
    { digest: { ...retro.prompt } },
    { digest: { ...retro.digest, sizeBytes: RUNNER_RETRO_LIMITS.digestBytes + 1 } },
    { prompt: { ...retro.prompt, sizeBytes: RUNNER_RETRO_LIMITS.promptBytes + 1 } },
    { output: { ...retro.output, maxChars: RUNNER_RETRO_LIMITS.outputChars + 1 } },
    { output: { ...retro.output, maxItems: 6 } },
    { executionLimit: { activeMinutes: 121 } },
    { attempt: 0 },
    { expiresAt: retro.issuedAt + RUNNER_RETRO_LIMITS.commandLifetimeMs + 1 },
    { expiresAt: retro.issuedAt },
  ];
  for (const change of invalid)
    expect(RunnerRetroCommandSchema.safeParse({ ...retro, ...change }).success).toBe(false);
  expect(RunnerRetroCommandSchema.safeParse({ ...retro, sessionId: "session-1" }).success).toBe(
    false,
  );
  expect(() =>
    signRunnerRetroCommand({
      keyId: "paws",
      privateKey: key.privateKey,
      command: { ...retro, digest: { ...retro.digest, workspaceId: "workspace-2" } },
    }),
  ).toThrow();
});

test("a work runner and a retro runner each refuse the other's command", () => {
  const workContext = {
    trustedKeys: new Map([["paws", key.publicKey]]),
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    now: 2_000,
    claimCommand: () => true,
  };
  expect(verifyRunnerCommand(signed(), workContext)).toEqual({
    ok: false,
    reason: "invalid_payload",
  });
  const probe = signRunnerCommand({
    keyId: "paws",
    privateKey: key.privateKey,
    command: {
      id: "probe-1",
      runnerId: "runner-1",
      workspaceId: "workspace-1",
      issuedAt: 1_000,
      expiresAt: 3_000,
      type: "probe",
      profile: { agent: "codex", model: null },
    },
  });
  expect(verifyRunnerRetroCommand(probe, verifier())).toEqual({
    ok: false,
    reason: "invalid_payload",
  });
});

test("only runners at the retro release accept the command", () => {
  const [major, minor, patch] = RETRO_RUNNER_VERSION;
  expect(runnerAcceptsRetro(`${major}.${minor}.${patch}`)).toBe(true);
  expect(runnerAcceptsRetro(`${major}.${minor}.${patch + 1}-beta.1`)).toBe(true);
  expect(runnerAcceptsRetro(`${major}.${minor}.${patch - 1}`)).toBe(false);
  expect(runnerAcceptsRetro(null)).toBe(false);
  expect(runnerAcceptsRetro("unknown")).toBe(false);
});

test("results carry the command identities and reject stale or malformed data", () => {
  const accept = (body: unknown, currentAttempt = retro.attempt) =>
    acceptRetroResult(retro, { body, currentAttempt, outputSha256: hash });
  expect(accept(result())).toEqual({ ok: true, result: result() });
  expect(RunnerRetroResultSchema.parse(JSON.parse(JSON.stringify(result())))).toEqual(result());
  for (const change of [
    { workspaceId: "workspace-2" },
    { runnerId: "runner-2" },
    { retroId: "retro-2" },
    { attempt: 1 },
    { commandId: "retro-command-0" },
    { settingsRevision: 3 },
    { digestSha256: "c".repeat(64) },
    { promptSha256: "c".repeat(64) },
  ])
    expect(accept(result(change))).toEqual({ ok: false, reason: "identity_mismatch" });
  expect(accept(result(), retro.attempt + 1)).toEqual({ ok: false, reason: "stale_attempt" });
  for (const body of [
    result({ outputSha256: "d".repeat(64) }),
    result({ outcome: "error" }),
    result({ output: undefined, outputSha256: undefined }),
    result({ errorMessage: "partial" }),
    { ...result(), sessionId: "session-1" },
    { ...result(), output: "x".repeat(RUNNER_RETRO_LIMITS.outputChars + 1) },
    "not json",
  ])
    expect(accept(body)).toEqual({ ok: false, reason: "malformed" });
  expect(
    acceptRetroResult(
      { ...retro, output: { ...retro.output, maxChars: 10 } },
      { body: result(), currentAttempt: retro.attempt, outputSha256: hash },
    ),
  ).toEqual({ ok: false, reason: "over_limit" });
  expect(accept(result({ activeMs: 15 * 60_000 + 1 }))).toEqual({
    ok: false,
    reason: "over_limit",
  });
  expect(
    accept(result({ outcome: "timeout", output: undefined, outputSha256: undefined })).ok,
  ).toBe(true);
});

test("input grants cover one retro attempt and its exact input hashes", () => {
  const grant = runnerRetroInputGrant(retro, 61_000);
  const request = {
    commandId: retro.id,
    workspaceId: retro.workspaceId,
    retroId: retro.retroId,
    attempt: retro.attempt,
    kind: "digest" as const,
    sha256: retro.digest.sha256,
    offset: 0,
    length: 4_096,
  };
  const read = (
    body: unknown,
    overrides: { runnerId?: string; currentAttempt?: number; now?: number } = {},
  ) =>
    authorizeRetroInput(grant, {
      runnerId: "runner-1",
      request: body,
      currentAttempt: retro.attempt,
      now: 2_000,
      ...overrides,
    });
  expect(read(request)).toEqual({ ok: true, request });
  expect(read({ ...request, kind: "prompt", sha256: retro.prompt.sha256, length: 6_000 }).ok).toBe(
    true,
  );
  expect(read(request, { runnerId: "runner-2" })).toEqual({
    ok: false,
    reason: "identity_mismatch",
  });
  expect(read({ ...request, workspaceId: "workspace-2" })).toEqual({
    ok: false,
    reason: "identity_mismatch",
  });
  expect(read({ ...request, attempt: 1 })).toEqual({ ok: false, reason: "identity_mismatch" });
  expect(read(request, { currentAttempt: 3 })).toEqual({ ok: false, reason: "stale_attempt" });
  expect(read(request, { now: 61_000 })).toEqual({ ok: false, reason: "expired" });
  expect(read({ ...request, sha256: retro.prompt.sha256 })).toEqual({
    ok: false,
    reason: "input_mismatch",
  });
  expect(read({ ...request, offset: 1 })).toEqual({ ok: false, reason: "out_of_range" });
  expect(read({ ...request, length: 0 })).toEqual({ ok: false, reason: "invalid_request" });
});

test("slot admission and release share one identity per attempt", () => {
  const slot = runnerRetroSlot(retro);
  expect(slot).toEqual({
    kind: "retro",
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    retroId: "retro-1",
    attempt: 2,
    commandId: "retro-command-1",
  });
  expect(runnerRetroSlotKey(slot)).toBe(runnerRetroSlotKey(runnerRetroSlot({ ...retro })));
  expect(runnerRetroSlotKey(slot)).not.toBe(
    runnerRetroSlotKey(runnerRetroSlot({ ...retro, attempt: 3, id: "retro-command-2" })),
  );
});

import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  RunnerCommandSchema,
  RunnerRepositorySchema,
  signRunnerCommand,
  verifyRunnerCommand,
  type RunnerCommand,
  type RunnerCommandVerifier,
} from "./index";

const first = generateKeyPairSync("ed25519");
const second = generateKeyPairSync("ed25519");
const common = {
  id: "command-1",
  runnerId: "runner-1",
  workspaceId: "workspace-1",
  issuedAt: 1000,
  expiresAt: 2000,
};
const repository = {
  owner: "acme",
  repo: "project",
  remoteUrl: "https://github.com/acme/project.git",
  baseSha: "a".repeat(40),
};
const profile = { agent: "claude" as const, model: null };
const run: RunnerCommand = {
  ...common,
  type: "run",
  runId: "run-1",
  itemId: "item-1",
  generation: 2,
  repository,
  profile,
  prompt: "Preserve rows. 雪",
};

function context(overrides: Partial<RunnerCommandVerifier> = {}): RunnerCommandVerifier {
  const claimed = new Set<string>();
  return {
    trustedKeys: new Map([["first", first.publicKey]]),
    runnerId: common.runnerId,
    workspaceId: common.workspaceId,
    now: 1500,
    allowedRepositories: ["ACME/PROJECT"],
    claimCommand(id) {
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    },
    ...overrides,
  };
}

function signed(command: RunnerCommand = run) {
  return signRunnerCommand({ keyId: "first", privateKey: first.privateKey, command });
}

test.each<RunnerCommand>([
  run,
  { ...run, type: "review" },
  { ...common, type: "probe", profile },
  { ...common, type: "login_check", agent: "codex" },
  { ...common, type: "cancel", runId: "run-1", generation: 2 },
  { ...common, type: "upgrade", version: "1.2.3", sha256: "b".repeat(64) },
])("signed $type commands verify with their complete typed payload", (command) => {
  expect(verifyRunnerCommand(signed(command), context())).toEqual({ ok: true, command });
});

test("signing is stable across object insertion order and absent optional fields", () => {
  const reordered = {
    ...run,
    repository: { ...repository, owner: repository.owner },
    profile: { model: null, agent: "claude" as const, effort: undefined },
  };
  expect(signed(reordered)).toEqual(signed());
  expect(verifyRunnerCommand(signed(reordered), context()).ok).toBe(true);
});

test("tampering with signed payload fails before consuming a command ID", () => {
  let claims = 0;
  const envelope = signed();
  const payload = JSON.parse(Buffer.from(envelope.payload, "base64url").toString());
  payload.prompt = "Different instructions";
  expect(
    verifyRunnerCommand(
      { ...envelope, payload: Buffer.from(JSON.stringify(payload)).toString("base64url") },
      context({
        claimCommand: () => {
          claims++;
          return true;
        },
      }),
    ),
  ).toEqual({ ok: false, reason: "invalid_signature" });
  expect(claims).toBe(0);
});

test.each([{ runnerId: "other" }, { workspaceId: "other" }])(
  "identity mismatch rejects an otherwise valid signature without burning replay state",
  (identity) => {
    let claims = 0;
    expect(
      verifyRunnerCommand(
        signed(),
        context({
          ...identity,
          claimCommand: () => {
            claims++;
            return true;
          },
        }),
      ),
    ).toEqual({ ok: false, reason: "identity_mismatch" });
    expect(claims).toBe(0);
  },
);

test.each([
  { now: 999, reason: "not_yet_valid" },
  { now: 2000, reason: "expired" },
  { now: Number.NaN, reason: "not_yet_valid" },
])("command time bounds reject $reason", ({ now, reason }) => {
  expect(verifyRunnerCommand(signed(), context({ now }))).toEqual({ ok: false, reason });
});

test("repository authorization is separate from signer trust", () => {
  expect(verifyRunnerCommand(signed(), context({ allowedRepositories: ["acme/another"] }))).toEqual(
    { ok: false, reason: "repository_denied" },
  );
});

test("atomic replay claims reject duplicate commands and fail closed on storage failure", () => {
  const verifier = context();
  const envelope = signed();
  expect(verifyRunnerCommand(envelope, verifier).ok).toBe(true);
  expect(verifyRunnerCommand(envelope, verifier)).toEqual({ ok: false, reason: "replayed" });
  expect(
    verifyRunnerCommand(
      envelope,
      context({
        claimCommand: () => {
          throw new Error("database unavailable");
        },
      }),
    ),
  ).toEqual({ ok: false, reason: "replay_unavailable" });
});

test("operator key rotation trusts both keys during overlap and denies the removed key", () => {
  const envelope = signRunnerCommand({
    keyId: "second",
    privateKey: second.privateKey,
    command: run,
  });
  const trustedKeys = new Map([
    ["first", first.publicKey],
    ["second", second.publicKey],
  ]);
  expect(verifyRunnerCommand(envelope, context({ trustedKeys })).ok).toBe(true);
  trustedKeys.delete("second");
  expect(verifyRunnerCommand(envelope, context({ trustedKeys }))).toEqual({
    ok: false,
    reason: "untrusted_key",
  });
  expect(verifyRunnerCommand({ ...signed(), signature: envelope.signature }, context())).toEqual({
    ok: false,
    reason: "invalid_signature",
  });
});

test.each([
  { ...run, token: "fixture" },
  { ...run, argv: ["sh", "-c", "id"] },
  { ...run, repository: { ...repository, credential: "fixture" } },
  { ...run, profile: { ...profile, apiKey: "fixture" } },
  { ...run, type: "exec" },
  { ...run, generation: 1.5 },
  { ...run, expiresAt: common.issuedAt },
])("strict command validation rejects unsupported fields or kinds %#", (command) => {
  expect(RunnerCommandSchema.safeParse(command).success).toBe(false);
});

test.each([
  "https://user:fixture@github.com/acme/project.git",
  "https://github.com/acme/project.git?token=fixture",
  "https://github.com/acme/project.git#main",
  "http://github.com/acme/project.git",
  "https://github.com.evil.example/acme/project.git",
  "https://github.com/other/project.git",
  "/tmp/local-origin.git",
])("repository URL validation rejects %s", (remoteUrl) => {
  expect(RunnerRepositorySchema.safeParse({ ...repository, remoteUrl }).success).toBe(false);
});

test("valid signatures cannot authorize noncanonical JSON, unsupported payloads or envelope keys", () => {
  const envelope = signed();
  const bytes = Buffer.from(envelope.payload, "base64url");
  const whitespace = Buffer.concat([Buffer.from(" "), bytes]);
  const noncanonical = {
    ...envelope,
    payload: whitespace.toString("base64url"),
    signature: sign(null, whitespace, first.privateKey).toString("base64url"),
  };
  expect(verifyRunnerCommand(noncanonical, context())).toEqual({
    ok: false,
    reason: "noncanonical_payload",
  });
  const unsupported = Buffer.from('{"type":"exec"}');
  expect(
    verifyRunnerCommand(
      {
        ...envelope,
        payload: unsupported.toString("base64url"),
        signature: sign(null, unsupported, first.privateKey).toString("base64url"),
      },
      context(),
    ),
  ).toEqual({ ok: false, reason: "invalid_payload" });
  expect(verifyRunnerCommand({ ...envelope, credential: "fixture" }, context())).toEqual({
    ok: false,
    reason: "invalid_envelope",
  });
  expect(verifyRunnerCommand({ ...envelope, payload: `${envelope.payload}=` }, context())).toEqual({
    ok: false,
    reason: "invalid_envelope",
  });
});

test("signing refuses non-Ed25519 keys", () => {
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  expect(() =>
    signRunnerCommand({ keyId: "wrong", privateKey: key.privateKey, command: run }),
  ).toThrow("Ed25519");
});

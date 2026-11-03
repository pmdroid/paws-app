import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  RunnerAccountCapabilitySchema,
  RunnerCommandSchema,
  RunnerHealthResultSchema,
  RunnerHelperResultSchema,
  RunnerResultSchema,
  runnerAccountAgentUnsupported,
  runnerAccountEchoed,
  signRunnerCommand,
  verifyRunnerCommand,
  type RunnerCommand,
  type RunnerCommandVerifier,
} from "./index";

const keys = generateKeyPairSync("ed25519");
const account = {
  accountId: "01JACCOUNT0000000000000000",
  bindingId: "01JBINDING0000000000000000",
};
const probe: RunnerCommand = {
  id: "command-1",
  runnerId: "runner-1",
  workspaceId: "workspace-1",
  issuedAt: 1000,
  expiresAt: 2000,
  type: "probe",
  profile: { agent: "claude", model: null },
};

function context(overrides: Partial<RunnerCommandVerifier> = {}) {
  let claims = 0;
  const verifier: RunnerCommandVerifier = {
    trustedKeys: new Map([["key", keys.publicKey]]),
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    now: 1500,
    claimCommand: () => ++claims > 0,
    ...overrides,
  };
  return { verifier, claims: () => claims };
}

const signed = (command: RunnerCommand) =>
  signRunnerCommand({ keyId: "key", privateKey: keys.privateKey, command });

test("a command without an account is the legacy default and still verifies", () => {
  const { verifier } = context();
  expect(verifyRunnerCommand(signed(probe), verifier)).toEqual({ ok: true, command: probe });
});

test("a runner refuses a named account it does not hold, before claiming the command", () => {
  const named = { ...probe, account };
  const missing = context();
  expect(verifyRunnerCommand(signed(named), missing.verifier)).toEqual({
    ok: false,
    reason: "account_unavailable",
  });
  expect(missing.claims()).toBe(0);
  const other = context({ accountBindings: new Set(["01JOTHER00000000000000000"]) });
  expect(verifyRunnerCommand(signed(named), other.verifier).ok).toBe(false);
  const held = context({ accountBindings: new Set([account.bindingId]) });
  expect(verifyRunnerCommand(signed(named), held.verifier)).toEqual({ ok: true, command: named });
});

test.each<RunnerCommand["type"]>([
  "run",
  "review",
  "task",
  "helper",
  "probe",
  "login",
  "login_check",
])("%s commands carry an optional signed account", (type) => {
  const shape = RunnerCommandSchema.options.find((option) => option.shape.type.value === type);
  expect(shape?.shape).toHaveProperty("account");
});

test.each<RunnerCommand["type"]>(["cancel", "handover", "checkpoint", "upgrade"])(
  "%s commands carry no account",
  (type) => {
    const shape = RunnerCommandSchema.options.find((option) => option.shape.type.value === type);
    expect(shape?.shape).not.toHaveProperty("account");
  },
);

test("legacy, malformed and extra account fields are rejected", () => {
  for (const value of [
    { ...account, accountId: "legacy_claude_workspace" },
    { ...account, bindingId: "legacy_claude_runner" },
    { accountId: account.accountId },
    { ...account, email: "person@example.test" },
    null,
  ])
    expect(RunnerCommandSchema.safeParse({ ...probe, account: value }).success).toBe(false);
});

test("heartbeat capability needs a protocol and unique bindings", () => {
  const binding = { bindingId: account.bindingId, agent: "claude" };
  expect(RunnerAccountCapabilitySchema.safeParse({ protocol: 1, bindings: [] }).success).toBe(true);
  expect(
    RunnerAccountCapabilitySchema.safeParse({ protocol: 1, bindings: [binding, binding] }).success,
  ).toBe(false);
  expect(RunnerAccountCapabilitySchema.safeParse({ protocol: 0, bindings: [] }).success).toBe(
    false,
  );
  expect(
    RunnerAccountCapabilitySchema.safeParse({
      protocol: 1,
      bindings: [{ ...binding, token: "secret" }],
    }).success,
  ).toBe(false);
});

test("results echo the command's account exactly", () => {
  const result = {
    executionId: "01J0000000000000000000000A",
    commandId: "command-1",
    role: "implementer" as const,
    stopReason: "end_turn" as const,
    timedOut: false,
    cancelled: false,
    authRequired: false,
    agentExited: true,
  };
  expect(RunnerResultSchema.parse({ ...result, account }).account).toEqual(account);
  expect(RunnerHealthResultSchema.parse({ ...result, account }).account).toEqual(account);
  expect(RunnerHelperResultSchema.parse({ ...result, text: "ok", account }).account).toEqual(
    account,
  );
  expect(runnerAccountEchoed({}, {})).toBe(true);
  expect(runnerAccountEchoed({ account }, { account: { ...account } })).toBe(true);
  expect(runnerAccountEchoed({ account }, {})).toBe(false);
  expect(runnerAccountEchoed({}, { account })).toBe(false);
  expect(runnerAccountEchoed({ account }, { account: { ...account, bindingId: "other" } })).toBe(
    false,
  );
});

test("a named sign-in may reach a runner that does not hold the binding yet", () => {
  const login: RunnerCommand = {
    id: "command-2",
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    issuedAt: 1000,
    expiresAt: 2000,
    type: "login",
    agent: "codex",
    account,
  };
  const check: RunnerCommand = { ...login, id: "command-3", type: "login_check" };
  const { verifier, claims } = context();
  expect(verifyRunnerCommand(signed(login), verifier)).toEqual({ ok: true, command: login });
  expect(verifyRunnerCommand(signed(check), verifier)).toEqual({
    ok: false,
    reason: "account_unavailable",
  });
  expect(claims()).toBe(1);
});

test("every runner agent declares whether it can run as a named account", () => {
  for (const agent of ["claude", "codex", "grok", "opencode"] as const)
    expect(runnerAccountAgentUnsupported(agent)).toBeNull();
  expect(runnerAccountAgentUnsupported("other" as "claude")).toMatch(/no isolated account/);
});

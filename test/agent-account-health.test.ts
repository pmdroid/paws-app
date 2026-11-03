import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  ACCOUNT_RECHECK_BASE_MS,
  ACCOUNT_RECHECK_MAX_MS,
  ACCOUNT_RESET_SLACK_MS,
  accountRecheckDelay,
  bindAgentAccount,
  bindingAccountHealth,
  createAgentAccount,
  ensureLegacyAgentBinding,
  migrate,
  openDatabase,
  recordAccountObservation,
  removeAgentBinding,
  resumeAccountHealthNow,
  setAgentAccountConcurrency,
  setAgentAccountEnabled,
} from "../src/db";
import {
  bindingReadiness,
  classifyAgentFailure,
  createRunnerPlacement,
} from "../src/runner-placement";
import type { RunnerResult } from "../src/runner-protocol";

const NOW = 1_800_000_000_000;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seed(db: Database) {
  db.run("INSERT INTO workspace VALUES('W1','org-W1','W1',?)", [NOW]);
  db.run(
    "INSERT INTO workspace_user(id,linear_user_id,name,email) VALUES('U1','linear-U1','Owner','owner@example.test')",
  );
  db.run(
    "INSERT INTO workspace_member(workspace_id,user_id,role,source,active,checked_at) VALUES('W1','U1','admin','manual',1,?)",
    [NOW],
  );
  for (const runner of ["R1", "R2", "R3"])
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,'W1','U1',?,'active',?,?)",
      [runner, runner, NOW, NOW],
    );
  const a = createAgentAccount(db, { workspaceId: "W1", agent: "claude", label: "A", now: NOW });
  const b = createAgentAccount(db, { workspaceId: "W1", agent: "claude", label: "B", now: NOW });
  const c = createAgentAccount(db, { workspaceId: "W1", agent: "codex", label: "C", now: NOW });
  const bind = (accountId: string, runnerId: string) =>
    bindAgentAccount(db, { workspaceId: "W1", accountId, runnerId, now: NOW }).id;
  return {
    accounts: { a: a.id, b: b.id, c: c.id },
    bindings: {
      a1: bind(a.id, "R1"),
      a2: bind(a.id, "R2"),
      b1: bind(b.id, "R1"),
      c2: bind(c.id, "R2"),
    },
  };
}

function fixture(path = ":memory:") {
  const db = openDatabase(path);
  migrate(db);
  return { db, ...seed(db) };
}

const seen = (db: Database, at: number) => db.run("UPDATE runner SET last_seen_at=?", [at]);

function exhaust(
  db: Database,
  bindingId: string,
  sourceId: string,
  observedAt: number,
  resetsAt: number | null = null,
) {
  return recordAccountObservation(db, {
    bindingId,
    source: "result",
    sourceId,
    observedAt,
    now: observedAt,
    state: "exhausted",
    resetsAt,
  });
}

function attempt(db: Database, commandId: string, bindingId: string, startedAt: number) {
  const binding = db
    .query<{ accountId: string; runnerId: string; agent: string }, [string]>(
      "SELECT account_id AS accountId,runner_id AS runnerId,agent FROM agent_account_binding WHERE id=?",
    )
    .get(bindingId)!;
  db.run(
    "INSERT INTO runner_execution_usage(command_id,runner_id,owner_user_id,agent,role,purpose,started_at) VALUES(?,?,'U1',?,'implementer','work',?)",
    [commandId, binding.runnerId, binding.agent, startedAt],
  );
  db.run(
    "INSERT INTO runner_command_account(command_id,workspace_id,runner_id,agent,account_id,binding_id,named,recorded_at) VALUES(?,'W1',?,?,?,?,1,?)",
    [commandId, binding.runnerId, binding.agent, binding.accountId, bindingId, startedAt],
  );
}

test("the same account on two runners shares a quota cooldown; other accounts and providers stay ready", () => {
  const { db, bindings } = fixture();
  const reset = NOW + 2 * 3_600_000;
  expect(exhaust(db, bindings.a1, "cmd-1", NOW, reset)).toEqual({ quota: "applied" });
  for (const bindingId of [bindings.a1, bindings.a2])
    expect(bindingReadiness(db, { bindingId, now: NOW + 1 })).toEqual({
      ready: false,
      reason: "exhausted",
      until: reset + ACCOUNT_RESET_SLACK_MS,
    });
  for (const bindingId of [bindings.b1, bindings.c2])
    expect(bindingReadiness(db, { bindingId, now: NOW + 1 })).toMatchObject({ ready: true });
});

test("a runner's default sign-in keeps its quota to that runner", () => {
  const { db } = fixture();
  const r1 = ensureLegacyAgentBinding(db, "R1", "claude", NOW).id;
  const r2 = ensureLegacyAgentBinding(db, "R2", "claude", NOW).id;
  exhaust(db, r1, "cmd-1", NOW);
  expect(bindingReadiness(db, { bindingId: r1, now: NOW + 1 })).toMatchObject({
    reason: "exhausted",
  });
  expect(bindingReadiness(db, { bindingId: r2, now: NOW + 1 })).toMatchObject({ ready: true });
});

test("a sign-in failure disables only its binding until a successful repair", () => {
  const { db, bindings } = fixture();
  recordAccountObservation(db, {
    bindingId: bindings.a1,
    source: "result",
    sourceId: "cmd-1",
    observedAt: NOW,
    now: NOW,
    state: "auth_required",
  });
  const late = NOW + 30 * 86_400_000;
  seen(db, late);
  expect(bindingReadiness(db, { bindingId: bindings.a1, now: late })).toEqual({
    ready: false,
    reason: "auth-required",
    until: null,
  });
  expect(bindingReadiness(db, { bindingId: bindings.a2, now: late })).toMatchObject({
    ready: true,
  });
  recordAccountObservation(db, {
    bindingId: bindings.a1,
    source: "sign_in",
    sourceId: "login-1",
    observedAt: late,
    now: late,
    state: "ok",
    clears: ["auth"],
  });
  expect(bindingReadiness(db, { bindingId: bindings.a1, now: late })).toMatchObject({
    ready: true,
  });
});

test("a stale or late success cannot erase a newer failure, and a repeat changes nothing", () => {
  const { db, bindings } = fixture();
  recordAccountObservation(db, {
    bindingId: bindings.a1,
    source: "result",
    sourceId: "cmd-2",
    observedAt: NOW + 10,
    now: NOW + 10,
    state: "auth_required",
  });
  expect(
    recordAccountObservation(db, {
      bindingId: bindings.a1,
      source: "login_check",
      sourceId: "check-1",
      observedAt: NOW,
      now: NOW + 20,
      state: "ok",
      clears: ["auth"],
    }),
  ).toEqual({ auth: "stale" });
  expect(
    recordAccountObservation(db, {
      bindingId: bindings.a1,
      source: "login_check",
      sourceId: "check-2",
      observedAt: NOW + 10,
      now: NOW + 20,
      state: "ok",
      clears: ["auth"],
    }),
  ).toEqual({ auth: "stale" });
  expect(bindingReadiness(db, { bindingId: bindings.a1, now: NOW + 20 })).toMatchObject({
    reason: "auth-required",
  });

  exhaust(db, bindings.a1, "cmd-3", NOW);
  const before = bindingAccountHealth(db, bindings.a1).find((row) => row.kind === "quota");
  expect(exhaust(db, bindings.a1, "cmd-3", NOW)).toEqual({ quota: "duplicate" });
  expect(exhaust(db, bindings.a2, "cmd-3", NOW)).toEqual({ quota: "duplicate" });
  expect(bindingAccountHealth(db, bindings.a1).find((row) => row.kind === "quota")).toEqual(before);
  expect(before).toMatchObject({ failures: 1, sourceId: "cmd-3", bindingId: bindings.a1 });
});

test("a success cannot re-enable a removed binding or a disabled account", () => {
  const { db, bindings, accounts } = fixture();
  removeAgentBinding(db, { workspaceId: "W1", bindingId: bindings.a1, now: NOW });
  expect(
    recordAccountObservation(db, {
      bindingId: bindings.a1,
      source: "login_check",
      sourceId: "check-1",
      observedAt: NOW + 1,
      now: NOW + 1,
      state: "ok",
      clears: ["auth", "quota"],
    }),
  ).toEqual({ auth: "removed", quota: "removed" });
  expect(bindingReadiness(db, { bindingId: bindings.a1, now: NOW + 1 })).toMatchObject({
    reason: "removed",
  });
  setAgentAccountEnabled(db, {
    workspaceId: "W1",
    accountId: accounts.b,
    enabled: false,
    now: NOW,
  });
  expect(bindingReadiness(db, { bindingId: bindings.b1, now: NOW + 1 })).toMatchObject({
    reason: "disabled",
  });
  db.run("UPDATE runner SET status='revoked',revoked_at=? WHERE id='R2'", [NOW]);
  expect(bindingReadiness(db, { bindingId: bindings.c2, now: NOW + 1 })).toMatchObject({
    reason: "revoked",
  });
});

test("exhausted, auth-required, offline, busy, paused, restricted and unsupported-model stay distinct", () => {
  const { db, bindings, accounts } = fixture();
  const reason = (bindingId: string, model?: string) => {
    const readiness = bindingReadiness(db, { bindingId, model: model ?? null, now: NOW + 1 });
    return readiness.ready ? "ready" : readiness.reason;
  };
  recordAccountObservation(db, {
    bindingId: bindings.b1,
    source: "result",
    sourceId: "cmd-model",
    observedAt: NOW,
    now: NOW,
    state: "unsupported_model",
    model: "opus-9",
  });
  expect(reason(bindings.b1, "opus-9")).toBe("unsupported-model");
  expect(reason(bindings.b1, "sonnet-9")).toBe("ready");
  exhaust(db, bindings.a1, "cmd-quota", NOW);
  expect(reason(bindings.a1)).toBe("exhausted");
  recordAccountObservation(db, {
    bindingId: bindings.a2,
    source: "result",
    sourceId: "cmd-auth",
    observedAt: NOW + 1,
    now: NOW + 1,
    state: "auth_required",
  });
  expect(reason(bindings.a2)).toBe("auth-required");
  db.run("UPDATE runner SET last_seen_at=? WHERE id='R3'", [NOW - 120_000]);
  const r3 = bindAgentAccount(db, {
    workspaceId: "W1",
    accountId: accounts.c,
    runnerId: "R3",
    now: NOW,
  }).id;
  expect(reason(r3)).toBe("offline");
  db.run("UPDATE runner SET last_seen_at=?,status='paused' WHERE id='R3'", [NOW]);
  expect(reason(r3)).toBe("paused");
  db.run("UPDATE runner SET status='active' WHERE id='R3'");
  setAgentAccountConcurrency(db, {
    workspaceId: "W1",
    accountId: accounts.c,
    concurrency: 1,
    now: NOW,
  });
  attempt(db, "cmd-running", bindings.c2, NOW);
  expect(reason(r3)).toBe("busy");
  recordAccountObservation(db, {
    bindingId: bindings.c2,
    source: "result",
    sourceId: "cmd-overloaded",
    observedAt: NOW,
    now: NOW,
    state: "restricted",
  });
  expect(reason(r3)).toBe("provider-restricted");
  expect(reason(bindings.b1, "sonnet-9")).toBe("ready");
});

test("a provider restriction cannot be bypassed by rotating to another account", () => {
  const { db, bindings } = fixture();
  recordAccountObservation(db, {
    bindingId: bindings.a1,
    source: "result",
    sourceId: "cmd-1",
    observedAt: NOW,
    now: NOW,
    state: "restricted",
  });
  for (const bindingId of [bindings.a1, bindings.a2, bindings.b1])
    expect(bindingReadiness(db, { bindingId, now: NOW + 1 })).toMatchObject({
      reason: "provider-restricted",
    });
  expect(bindingReadiness(db, { bindingId: bindings.c2, now: NOW + 1 })).toMatchObject({
    ready: true,
  });
});

test("an unknown reset backs off with bounded jitter instead of a fixed retry", () => {
  const { db, bindings, accounts } = fixture();
  const delays: number[] = [];
  let at = NOW;
  for (let failure = 1; failure <= 8; failure++) {
    exhaust(db, bindings.a1, `cmd-${failure}`, at);
    const row = bindingAccountHealth(db, bindings.a1).find((entry) => entry.kind === "quota")!;
    expect(row.failures).toBe(failure);
    expect(row.nextCheckAt! - at).toBe(accountRecheckDelay(accounts.a, failure));
    delays.push(row.nextCheckAt! - at);
    at = row.nextCheckAt!;
  }
  const nominal = (failure: number) =>
    Math.min(ACCOUNT_RECHECK_BASE_MS * 2 ** (failure - 1), ACCOUNT_RECHECK_MAX_MS);
  delays.forEach((delay, index) => {
    expect(delay).toBeGreaterThanOrEqual(nominal(index + 1) * 0.8);
    expect(delay).toBeLessThanOrEqual(nominal(index + 1) * 1.2);
  });
  expect(Math.max(...delays)).toBeLessThanOrEqual(ACCOUNT_RECHECK_MAX_MS * 1.2);
  expect(accountRecheckDelay(accounts.a, 3)).toBe(accountRecheckDelay(accounts.a, 3));
  expect(
    new Set([accounts.a, accounts.b, accounts.c].map((id) => accountRecheckDelay(id, 1))).size,
  ).toBeGreaterThan(1);
});

test("a due recheck admits one real attempt; the others keep waiting for its result", () => {
  const { db, bindings } = fixture();
  exhaust(db, bindings.a1, "cmd-1", NOW);
  const due = bindingAccountHealth(db, bindings.a1)[0]!.nextCheckAt!;
  seen(db, due);
  expect(bindingReadiness(db, { bindingId: bindings.a2, now: due - 1 })).toMatchObject({
    reason: "exhausted",
  });
  expect(bindingReadiness(db, { bindingId: bindings.a2, now: due })).toEqual({
    ready: true,
    low: false,
    revalidating: true,
  });
  attempt(db, "cmd-recheck", bindings.a2, due);
  expect(bindingReadiness(db, { bindingId: bindings.a1, now: due + 1 })).toEqual({
    ready: false,
    reason: "exhausted",
    until: null,
  });
  db.run("UPDATE runner_execution_usage SET ended_at=? WHERE command_id='cmd-recheck'", [due + 5]);
  recordAccountObservation(db, {
    bindingId: bindings.a2,
    source: "result",
    sourceId: "cmd-recheck",
    observedAt: due,
    now: due + 5,
    state: "ok",
    clears: ["auth", "provider", "quota"],
  });
  expect(bindingReadiness(db, { bindingId: bindings.a1, now: due + 6 })).toEqual({
    ready: true,
    low: false,
    revalidating: false,
  });
});

test("low quota is advisory and never blocks", () => {
  const { db, bindings } = fixture();
  recordAccountObservation(db, {
    bindingId: bindings.a1,
    source: "result",
    sourceId: "cmd-1",
    observedAt: NOW,
    now: NOW,
    state: "low",
  });
  expect(bindingReadiness(db, { bindingId: bindings.a2, now: NOW + 1 })).toEqual({
    ready: true,
    low: true,
    revalidating: false,
  });
});

test("cooldowns survive a restart and resume-now makes the account due", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-account-health-"));
  roots.push(root);
  const path = join(root, "paws.sqlite");
  const first = fixture(path);
  exhaust(first.db, first.bindings.a1, "cmd-1", NOW);
  first.db.close();
  const db = openDatabase(path);
  migrate(db);
  expect(bindingReadiness(db, { bindingId: first.bindings.a2, now: NOW + 1 })).toMatchObject({
    reason: "exhausted",
  });
  expect(exhaust(db, first.bindings.a1, "cmd-1", NOW)).toEqual({ quota: "duplicate" });
  resumeAccountHealthNow(db, "claude", null, NOW + 2);
  expect(bindingReadiness(db, { bindingId: first.bindings.a2, now: NOW + 2 })).toMatchObject({
    ready: true,
    revalidating: true,
  });
  db.close();
});

test("a usage-limit result shares its cooldown across the account and returns the recheck", () => {
  const { db, bindings } = fixture();
  const placement = createRunnerPlacement({ db, now: () => NOW + 50 });
  attempt(db, "cmd-limit", bindings.a1, NOW);
  const outcome = placement.finished({
    commandId: "cmd-limit",
    runnerId: "R1",
    profile: { agent: "claude" },
    result: {
      executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      commandId: "cmd-limit",
      role: "implementer",
      stopReason: "end_turn",
      timedOut: false,
      cancelled: false,
      authRequired: false,
      agentExited: true,
      errorMessage: "insufficient_quota",
    },
    finishedAt: NOW + 40,
  });
  const recheckAt =
    NOW + 40 + accountRecheckDelay(bindingAccountHealth(db, bindings.a1)[0]!.scopeId, 1);
  expect(outcome).toEqual({ retryable: true, usageLimit: { resetsAt: null, recheckAt } });
  expect(bindingReadiness(db, { bindingId: bindings.a2, now: NOW + 41 })).toEqual({
    ready: false,
    reason: "exhausted",
    until: recheckAt,
  });
  expect(bindingReadiness(db, { bindingId: bindings.b1, now: NOW + 41 })).toMatchObject({
    ready: true,
  });
  attempt(db, "cmd-tests", bindings.b1, NOW + 41);
  placement.finished({
    commandId: "cmd-tests",
    runnerId: "R1",
    profile: { agent: "claude" },
    result: {
      executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      commandId: "cmd-tests",
      role: "implementer",
      stopReason: "end_turn",
      timedOut: false,
      cancelled: false,
      authRequired: false,
      agentExited: true,
      errorMessage: "bun test: 3 tests failed",
    },
    finishedAt: NOW + 45,
  });
  expect(bindingAccountHealth(db, bindings.b1)).toEqual([]);
  attempt(db, "cmd-lost", bindings.b1, NOW + 46);
  expect(
    placement.finished({
      commandId: "cmd-lost",
      runnerId: "R1",
      failure: "heartbeat_lost",
      finishedAt: NOW + 47,
    }),
  ).toEqual({ retryable: true });
  expect(bindingAccountHealth(db, bindings.b1)).toEqual([]);
});

test("failures are classified so only account problems change account health", () => {
  const result = (overrides: Partial<RunnerResult>): RunnerResult => ({
    executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    commandId: "cmd",
    role: "implementer",
    stopReason: "end_turn",
    timedOut: false,
    cancelled: false,
    authRequired: false,
    agentExited: true,
    ...overrides,
  });
  const kind = (input: Parameters<typeof classifyAgentFailure>[0]) =>
    classifyAgentFailure(input).kind;
  expect(kind({ result: result({}), now: NOW })).toBe("ok");
  expect(kind({ result: result({ authRequired: true }), now: NOW })).toBe("auth");
  expect(kind({ result: result({ errorMessage: "insufficient_quota" }), now: NOW })).toBe("quota");
  expect(
    kind({ result: result({ errorMessage: "API error 529 overloaded_error" }), now: NOW }),
  ).toBe("provider");
  expect(
    kind({
      result: result({ errorMessage: "This service is not available in your region" }),
      now: NOW,
    }),
  ).toBe("provider");
  expect(kind({ result: result({ errorMessage: "model: claude-x not found" }), now: NOW })).toBe(
    "model",
  );
  expect(kind({ failure: "heartbeat_lost", now: NOW })).toBe("runner");
  expect(kind({ failure: "timeout", now: NOW })).toBe("runner");
  expect(
    kind({ result: result({ stopReason: "end_turn", errorMessage: "3 tests failed" }), now: NOW }),
  ).toBe("task");
  expect(
    classifyAgentFailure({ result: result({ errorMessage: "10% remaining" }), now: NOW }),
  ).toMatchObject({ kind: "task", quota: { state: "low" } });
});

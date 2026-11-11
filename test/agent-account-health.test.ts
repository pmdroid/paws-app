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
  sqliteDb,
} from "../src/db";
import {
  bindingReadinessSteps,
  classifyAgentFailure,
  createRunnerPlacement,
} from "../src/runner-placement";
import type { RunnerResult } from "../src/runner-protocol";

const NOW = 1_800_000_000_000;
const bindingReadiness = (db: Database, input: Parameters<typeof bindingReadinessSteps>[1]) =>
  sqliteDb(db).run((q) => bindingReadinessSteps(q, input));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function seed(db: Database) {
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
  const a = await createAgentAccount(sqliteDb(db), {
    workspaceId: "W1",
    agent: "claude",
    label: "A",
    now: NOW,
  });
  const b = await createAgentAccount(sqliteDb(db), {
    workspaceId: "W1",
    agent: "claude",
    label: "B",
    now: NOW,
  });
  const c = await createAgentAccount(sqliteDb(db), {
    workspaceId: "W1",
    agent: "codex",
    label: "C",
    now: NOW,
  });
  const bind = async (accountId: string, runnerId: string) =>
    (await bindAgentAccount(sqliteDb(db), { workspaceId: "W1", accountId, runnerId, now: NOW })).id;
  return {
    accounts: { a: a.id, b: b.id, c: c.id },
    bindings: {
      a1: await bind(a.id, "R1"),
      a2: await bind(a.id, "R2"),
      b1: await bind(b.id, "R1"),
      c2: await bind(c.id, "R2"),
    },
  };
}

async function fixture(path = ":memory:") {
  const db = openDatabase(path);
  migrate(db);
  return { db, ...(await seed(db)) };
}

const seen = (db: Database, at: number) => db.run("UPDATE runner SET last_seen_at=?", [at]);

async function exhaust(
  db: Database,
  bindingId: string,
  sourceId: string,
  observedAt: number,
  resetsAt: number | null = null,
) {
  return await recordAccountObservation(sqliteDb(db), {
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
  db.run(
    "INSERT INTO runner_command(id,runner_id,kind,envelope,expires_at) VALUES(?,?,'probe','{}',?)",
    [commandId, binding.runnerId, startedAt + 3_600_000],
  );
}

test("the same account on two runners shares a quota cooldown; other accounts and providers stay ready", async () => {
  const { db, bindings } = await fixture();
  const reset = NOW + 2 * 3_600_000;
  expect(await exhaust(db, bindings.a1, "cmd-1", NOW, reset)).toEqual({ quota: "applied" });
  for (const bindingId of [bindings.a1, bindings.a2])
    expect(await bindingReadiness(db, { bindingId, now: NOW + 1 })).toEqual({
      ready: false,
      reason: "exhausted",
      until: reset + ACCOUNT_RESET_SLACK_MS,
    });
  for (const bindingId of [bindings.b1, bindings.c2])
    expect(await bindingReadiness(db, { bindingId, now: NOW + 1 })).toMatchObject({ ready: true });
});

test("a runner's default sign-in keeps its quota to that runner", async () => {
  const { db } = await fixture();
  const r1 = (await ensureLegacyAgentBinding(sqliteDb(db), "R1", "claude", NOW)).id;
  const r2 = (await ensureLegacyAgentBinding(sqliteDb(db), "R2", "claude", NOW)).id;
  await exhaust(db, r1, "cmd-1", NOW);
  expect(await bindingReadiness(db, { bindingId: r1, now: NOW + 1 })).toMatchObject({
    reason: "exhausted",
  });
  expect(await bindingReadiness(db, { bindingId: r2, now: NOW + 1 })).toMatchObject({
    ready: true,
  });
});

test("a sign-in failure disables only its binding until a successful repair", async () => {
  const { db, bindings } = await fixture();
  await recordAccountObservation(sqliteDb(db), {
    bindingId: bindings.a1,
    source: "result",
    sourceId: "cmd-1",
    observedAt: NOW,
    now: NOW,
    state: "auth_required",
  });
  const late = NOW + 30 * 86_400_000;
  seen(db, late);
  expect(await bindingReadiness(db, { bindingId: bindings.a1, now: late })).toEqual({
    ready: false,
    reason: "auth-required",
    until: null,
  });
  expect(await bindingReadiness(db, { bindingId: bindings.a2, now: late })).toMatchObject({
    ready: true,
  });
  await recordAccountObservation(sqliteDb(db), {
    bindingId: bindings.a1,
    source: "sign_in",
    sourceId: "login-1",
    observedAt: late,
    now: late,
    state: "ok",
    clears: ["auth"],
  });
  expect(await bindingReadiness(db, { bindingId: bindings.a1, now: late })).toMatchObject({
    ready: true,
  });
});

test("a stale or late success cannot erase a newer failure, and a repeat changes nothing", async () => {
  const { db, bindings } = await fixture();
  await recordAccountObservation(sqliteDb(db), {
    bindingId: bindings.a1,
    source: "result",
    sourceId: "cmd-2",
    observedAt: NOW + 10,
    now: NOW + 10,
    state: "auth_required",
  });
  expect(
    await recordAccountObservation(sqliteDb(db), {
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
    await recordAccountObservation(sqliteDb(db), {
      bindingId: bindings.a1,
      source: "login_check",
      sourceId: "check-2",
      observedAt: NOW + 10,
      now: NOW + 20,
      state: "ok",
      clears: ["auth"],
    }),
  ).toEqual({ auth: "stale" });
  expect(await bindingReadiness(db, { bindingId: bindings.a1, now: NOW + 20 })).toMatchObject({
    reason: "auth-required",
  });

  await exhaust(db, bindings.a1, "cmd-3", NOW);
  const before = (await bindingAccountHealth(sqliteDb(db), bindings.a1)).find(
    (row) => row.kind === "quota",
  );
  expect(await exhaust(db, bindings.a1, "cmd-3", NOW)).toEqual({ quota: "duplicate" });
  expect(await exhaust(db, bindings.a2, "cmd-3", NOW)).toEqual({ quota: "duplicate" });
  expect(
    (await bindingAccountHealth(sqliteDb(db), bindings.a1)).find((row) => row.kind === "quota"),
  ).toEqual(before);
  expect(before).toMatchObject({ failures: 1, sourceId: "cmd-3", bindingId: bindings.a1 });
});

test("a success cannot re-enable a removed binding or a disabled account", async () => {
  const { db, bindings, accounts } = await fixture();
  await removeAgentBinding(sqliteDb(db), { workspaceId: "W1", bindingId: bindings.a1, now: NOW });
  expect(
    await recordAccountObservation(sqliteDb(db), {
      bindingId: bindings.a1,
      source: "login_check",
      sourceId: "check-1",
      observedAt: NOW + 1,
      now: NOW + 1,
      state: "ok",
      clears: ["auth", "quota"],
    }),
  ).toEqual({ auth: "removed", quota: "removed" });
  expect(await bindingReadiness(db, { bindingId: bindings.a1, now: NOW + 1 })).toMatchObject({
    reason: "removed",
  });
  await setAgentAccountEnabled(sqliteDb(db), {
    workspaceId: "W1",
    accountId: accounts.b,
    enabled: false,
    now: NOW,
  });
  expect(await bindingReadiness(db, { bindingId: bindings.b1, now: NOW + 1 })).toMatchObject({
    reason: "disabled",
  });
  db.run("UPDATE runner SET status='revoked',revoked_at=? WHERE id='R2'", [NOW]);
  expect(await bindingReadiness(db, { bindingId: bindings.c2, now: NOW + 1 })).toMatchObject({
    reason: "revoked",
  });
});

test("exhausted, auth-required, offline, busy, paused, restricted and unsupported-model stay distinct", async () => {
  const { db, bindings, accounts } = await fixture();
  const reason = async (bindingId: string, model?: string) => {
    const readiness = await bindingReadiness(db, { bindingId, model: model ?? null, now: NOW + 1 });
    return readiness.ready ? "ready" : readiness.reason;
  };
  await recordAccountObservation(sqliteDb(db), {
    bindingId: bindings.b1,
    source: "result",
    sourceId: "cmd-model",
    observedAt: NOW,
    now: NOW,
    state: "unsupported_model",
    model: "opus-9",
  });
  expect(await reason(bindings.b1, "opus-9")).toBe("unsupported-model");
  expect(await reason(bindings.b1, "sonnet-9")).toBe("ready");
  await exhaust(db, bindings.a1, "cmd-quota", NOW);
  expect(await reason(bindings.a1)).toBe("exhausted");
  await recordAccountObservation(sqliteDb(db), {
    bindingId: bindings.a2,
    source: "result",
    sourceId: "cmd-auth",
    observedAt: NOW + 1,
    now: NOW + 1,
    state: "auth_required",
  });
  expect(await reason(bindings.a2)).toBe("auth-required");
  db.run("UPDATE runner SET last_seen_at=? WHERE id='R3'", [NOW - 120_000]);
  const r3 = (
    await bindAgentAccount(sqliteDb(db), {
      workspaceId: "W1",
      accountId: accounts.c,
      runnerId: "R3",
      now: NOW,
    })
  ).id;
  expect(await reason(r3)).toBe("offline");
  db.run("UPDATE runner SET last_seen_at=?,status='paused' WHERE id='R3'", [NOW]);
  expect(await reason(r3)).toBe("paused");
  db.run("UPDATE runner SET status='active' WHERE id='R3'");
  await setAgentAccountConcurrency(sqliteDb(db), {
    workspaceId: "W1",
    accountId: accounts.c,
    concurrency: 1,
    now: NOW,
  });
  attempt(db, "cmd-running", bindings.c2, NOW);
  expect(await reason(r3)).toBe("busy");
  await recordAccountObservation(sqliteDb(db), {
    bindingId: bindings.c2,
    source: "result",
    sourceId: "cmd-overloaded",
    observedAt: NOW,
    now: NOW,
    state: "restricted",
  });
  expect(await reason(r3)).toBe("provider-restricted");
  expect(await reason(bindings.b1, "sonnet-9")).toBe("ready");
});

test("a provider restriction cannot be bypassed by rotating to another account", async () => {
  const { db, bindings } = await fixture();
  await recordAccountObservation(sqliteDb(db), {
    bindingId: bindings.a1,
    source: "result",
    sourceId: "cmd-1",
    observedAt: NOW,
    now: NOW,
    state: "restricted",
  });
  for (const bindingId of [bindings.a1, bindings.a2, bindings.b1])
    expect(await bindingReadiness(db, { bindingId, now: NOW + 1 })).toMatchObject({
      reason: "provider-restricted",
    });
  expect(await bindingReadiness(db, { bindingId: bindings.c2, now: NOW + 1 })).toMatchObject({
    ready: true,
  });
});

test("an unknown reset backs off with bounded jitter instead of a fixed retry", async () => {
  const { db, bindings, accounts } = await fixture();
  const delays: number[] = [];
  let at = NOW;
  for (let failure = 1; failure <= 8; failure++) {
    await exhaust(db, bindings.a1, `cmd-${failure}`, at);
    const row = (await bindingAccountHealth(sqliteDb(db), bindings.a1)).find(
      (entry) => entry.kind === "quota",
    )!;
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

test("a due recheck admits one real attempt; the others keep waiting for its result", async () => {
  const { db, bindings } = await fixture();
  await exhaust(db, bindings.a1, "cmd-1", NOW);
  const due = (await bindingAccountHealth(sqliteDb(db), bindings.a1))[0]!.nextCheckAt!;
  seen(db, due);
  expect(await bindingReadiness(db, { bindingId: bindings.a2, now: due - 1 })).toMatchObject({
    reason: "exhausted",
  });
  expect(await bindingReadiness(db, { bindingId: bindings.a2, now: due })).toEqual({
    ready: true,
    low: false,
    revalidating: true,
  });
  attempt(db, "cmd-recheck", bindings.a2, due);
  expect(await bindingReadiness(db, { bindingId: bindings.a1, now: due + 1 })).toEqual({
    ready: false,
    reason: "exhausted",
    until: null,
  });
  db.run("UPDATE runner_execution_usage SET ended_at=? WHERE command_id='cmd-recheck'", [due + 5]);
  await recordAccountObservation(sqliteDb(db), {
    bindingId: bindings.a2,
    source: "result",
    sourceId: "cmd-recheck",
    observedAt: due,
    now: due + 5,
    state: "ok",
    clears: ["auth", "provider", "quota"],
  });
  expect(await bindingReadiness(db, { bindingId: bindings.a1, now: due + 6 })).toEqual({
    ready: true,
    low: false,
    revalidating: false,
  });
});

test("low quota is advisory and never blocks", async () => {
  const { db, bindings } = await fixture();
  await recordAccountObservation(sqliteDb(db), {
    bindingId: bindings.a1,
    source: "result",
    sourceId: "cmd-1",
    observedAt: NOW,
    now: NOW,
    state: "low",
  });
  expect(await bindingReadiness(db, { bindingId: bindings.a2, now: NOW + 1 })).toEqual({
    ready: true,
    low: true,
    revalidating: false,
  });
});

test("cooldowns survive a restart and resume-now makes the account due", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-account-health-"));
  roots.push(root);
  const path = join(root, "paws.sqlite");
  const first = await fixture(path);
  await exhaust(first.db, first.bindings.a1, "cmd-1", NOW);
  first.db.close();
  const db = openDatabase(path);
  migrate(db);
  expect(await bindingReadiness(db, { bindingId: first.bindings.a2, now: NOW + 1 })).toMatchObject({
    reason: "exhausted",
  });
  expect(await exhaust(db, first.bindings.a1, "cmd-1", NOW)).toEqual({ quota: "duplicate" });
  await resumeAccountHealthNow(sqliteDb(db), "claude", null, NOW + 2);
  expect(await bindingReadiness(db, { bindingId: first.bindings.a2, now: NOW + 2 })).toMatchObject({
    ready: true,
    revalidating: true,
  });
  db.close();
});

test("a usage-limit result shares its cooldown across the account and returns the recheck", async () => {
  const { db, bindings } = await fixture();
  const placement = createRunnerPlacement({ store: sqliteDb(db), now: () => NOW + 50 });
  const finished = (input: Parameters<typeof placement.finishedSteps>[1]) =>
    sqliteDb(db).transaction((q) => placement.finishedSteps(q, input));
  attempt(db, "cmd-limit", bindings.a1, NOW);
  const outcome = await finished({
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
    NOW +
    40 +
    accountRecheckDelay((await bindingAccountHealth(sqliteDb(db), bindings.a1))[0]!.scopeId, 1);
  expect(outcome).toEqual({ retryable: true, usageLimit: { resetsAt: null, recheckAt } });
  expect(await bindingReadiness(db, { bindingId: bindings.a2, now: NOW + 41 })).toEqual({
    ready: false,
    reason: "exhausted",
    until: recheckAt,
  });
  expect(await bindingReadiness(db, { bindingId: bindings.b1, now: NOW + 41 })).toMatchObject({
    ready: true,
  });
  attempt(db, "cmd-tests", bindings.b1, NOW + 41);
  await finished({
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
  expect(await bindingAccountHealth(sqliteDb(db), bindings.b1)).toEqual([]);
  attempt(db, "cmd-lost", bindings.b1, NOW + 46);
  expect(
    await finished({
      commandId: "cmd-lost",
      runnerId: "R1",
      failure: "heartbeat_lost",
      finishedAt: NOW + 47,
    }),
  ).toEqual({ retryable: true });
  expect(await bindingAccountHealth(sqliteDb(db), bindings.b1)).toEqual([]);
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

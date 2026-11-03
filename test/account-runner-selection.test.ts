import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  accountSlotsInUse,
  beginImplementRun,
  bindAgentAccount,
  bindLinearSessionTask,
  closeFallbackAttempts,
  consumeWorkspaceBootstrap,
  createAgentAccount,
  fallbackHistory,
  immediate,
  insertQueuedItem,
  legacyAgentAccountId,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordAccountObservation,
  recordCommandAccount,
  recordFallbackAttempt,
  recordLinearInstallation,
  recordRunnerAccountCapability,
  setAgentAccountConcurrency,
  setAgentAccountEnabled,
} from "../src/db";
import {
  createRunnerPlacement,
  itemOwnerHasEligibleRunner,
  itemOwnerRunnerSetupNeed,
  PlacementRaceError,
  type PlacementAccount,
  type PlacementRequest,
} from "../src/runner-placement";
import type { RunnerCommand } from "../src/runner-protocol";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { tempHome } from "./helpers";

function fixture() {
  const db = openDatabase(join(tempHome(), "paws.sqlite"));
  migrate(db);
  let clock = Date.now();
  const owner = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Test",
    userId: owner,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", clock)),
    now: clock,
  });
  recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "app-client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: clock,
  });
  const item = insertQueuedItem(db, { id: "item", now: clock, sessionKey: "session" });
  bindLinearSessionTask(db, "session", item.delegationId, { actorId: "owner" });
  db.run("UPDATE work_item SET owner_user_id=? WHERE id=?", [owner, item.id]);
  for (const id of ["R1", "R2", "R3"]) {
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
      [id, workspace.id, owner, id, clock, clock],
    );
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'claude',1)", [id]);
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'codex',1)", [id]);
  }
  const namedAccount = (label: string) =>
    createAgentAccount(db, { workspaceId: workspace.id, agent: "claude", label, now: clock }).id;
  const a = namedAccount("A");
  const b = namedAccount("B");
  const bind = (accountId: string, runnerId: string) =>
    bindAgentAccount(db, { workspaceId: workspace.id, accountId, runnerId, now: clock }).id;
  const bindings = { a1: bind(a, "R1"), a2: bind(a, "R2"), b1: bind(b, "R1"), a3: bind(a, "R3") };
  const report = (runnerId: string, version: string, ids: string[]) => {
    db.run(
      "INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES(?,?,?) ON CONFLICT(runner_id) DO UPDATE SET runner_version=excluded.runner_version",
      [runnerId, version, clock],
    );
    recordRunnerAccountCapability(
      db,
      runnerId,
      { protocol: 1, bindings: ids.map((bindingId) => ({ bindingId, agent: "claude" })) },
      clock,
    );
  };
  report("R1", "0.1.60", [bindings.a1, bindings.b1]);
  report("R2", "0.1.60", [bindings.a2]);
  report("R3", "0.1.59", [bindings.a3]);
  const legacy = legacyAgentAccountId(workspace.id, "claude");
  const placement = createRunnerPlacement({ db, now: () => clock });
  const request = (accountIds: string[], extra: Partial<PlacementRequest> = {}) =>
    ({
      itemId: item.id,
      profile: { agent: "claude", model: "opus" },
      role: "implementer",
      purpose: "work",
      accounts: { revision: "rev-1", accountIds },
      ...extra,
    }) satisfies PlacementRequest;
  const choices = async (accountIds: string[], extra: Partial<PlacementRequest> = {}) => {
    const rejected: { runnerId: string; reason: string; until?: number }[] = [];
    const placed = await placement.candidates({
      ...request(accountIds, extra),
      onRejected: (runnerId, reason, until) =>
        rejected.push({ runnerId, reason, ...(until === undefined ? {} : { until }) }),
    });
    return {
      placed: placed.map((entry) => [entry.id, entry.account!.accountId]),
      candidates: placed,
      rejected,
    };
  };
  let ordinal = 0;
  const command = (runnerId: string, account: PlacementAccount, runId?: string) => {
    const id = `cmd-${++ordinal}`;
    const signed = {
      id,
      runnerId,
      workspaceId: workspace.id,
      issuedAt: clock,
      expiresAt: clock + 3_600_000,
      type: "probe",
      profile: { agent: "claude", model: "opus" },
      ...(account.named
        ? { account: { accountId: account.accountId, bindingId: account.bindingId } }
        : {}),
    } as RunnerCommand;
    recordCommandAccount(db, signed, clock);
    db.run(
      "INSERT INTO runner_command(id,runner_id,run_id,generation,kind,envelope,expires_at) VALUES(?,?,?,?,'probe','{}',?)",
      [id, runnerId, runId ?? null, runId ? 1 : null, clock + 3_600_000],
    );
    return id;
  };
  const admit = (
    runnerId: string,
    account: PlacementAccount,
    accountIds: string[],
    options: { carried?: PlacementAccount; runId?: string } = {},
  ) =>
    immediate(db, () => {
      const commandId = command(runnerId, options.carried ?? account, options.runId);
      placement.started({
        commandId,
        runnerId,
        itemId: item.id,
        profile: { agent: "claude", model: "opus" },
        account,
        accounts: { revision: "rev-1", accountIds },
        role: "implementer",
        purpose: "work",
        startedAt: clock,
      });
      return commandId;
    });
  const counts = () =>
    db
      .query<{ commands: number; accounts: number; usage: number }, []>(
        `SELECT (SELECT COUNT(*) FROM runner_command) AS commands,
         (SELECT COUNT(*) FROM runner_command_account) AS accounts,
         (SELECT COUNT(*) FROM runner_execution_usage) AS usage`,
      )
      .get()!;
  return {
    db,
    item,
    workspaceId: workspace.id,
    accounts: { a, b, legacy },
    bindings,
    placement,
    choices,
    admit,
    counts,
    now: () => clock,
    tick(ms: number) {
      clock += ms;
      db.run("UPDATE runner SET last_seen_at=?", [clock]);
    },
  };
}

function candidate(
  f: ReturnType<typeof fixture>,
  found: Awaited<ReturnType<ReturnType<typeof fixture>["choices"]>>,
  runnerId: string,
  accountId: string,
) {
  const entry = found.candidates.find(
    (row) => row.id === runnerId && row.account?.accountId === accountId,
  );
  if (!entry?.account) throw new Error(`no candidate ${runnerId} ${accountId}`);
  return entry.account;
}

test("distinct accounts on one runner and one account on several runners follow the configured order", async () => {
  const f = fixture();
  const first = await f.choices([f.accounts.a, f.accounts.b]);
  expect(first.placed.slice(0, 2).map(([, account]) => account)).toEqual([
    f.accounts.a,
    f.accounts.a,
  ]);
  expect(new Set(first.placed.slice(0, 2).map(([runner]) => runner))).toEqual(
    new Set(["R1", "R2"]),
  );
  expect(first.placed[2]).toEqual(["R1", f.accounts.b]);
  expect(first.candidates.find((row) => row.account?.accountId === f.accounts.b)?.account).toEqual({
    accountId: f.accounts.b,
    bindingId: f.bindings.b1,
    named: true,
  });
  expect(first.rejected).toContainEqual({
    runnerId: "R2",
    reason: "B: account has no binding on this runner",
  });
  expect(first.rejected).toContainEqual({
    runnerId: "R3",
    reason: "A: Named agent accounts need runner 0.1.60 or later",
  });
  const reversed = await f.choices([f.accounts.b, f.accounts.a]);
  expect(reversed.placed[0]).toEqual(["R1", f.accounts.b]);
});

test("an exhausted account yields to the next account on the same runner, and reports its next check", async () => {
  const f = fixture();
  const reset = f.now() + 3_600_000;
  recordAccountObservation(f.db, {
    bindingId: f.bindings.a1,
    source: "result",
    sourceId: "limit",
    observedAt: f.now(),
    now: f.now(),
    state: "exhausted",
    resetsAt: reset,
  });
  const found = await f.choices([f.accounts.a, f.accounts.b]);
  expect(found.placed).toEqual([["R1", f.accounts.b]]);
  const waits = found.rejected.filter((entry) => entry.until !== undefined);
  expect(waits.map((entry) => entry.runnerId).sort()).toEqual(["R1", "R2"]);
  expect(waits.every((entry) => entry.until! > reset)).toBe(true);
  expect(
    f.db
      .query<{ cooldown: number }, []>(
        "SELECT cooldown_until AS cooldown FROM runner_agent_policy WHERE runner_id='R1' AND agent='claude'",
      )
      .get()!.cooldown,
  ).toBe(0);
  expect((await f.choices([f.accounts.legacy])).placed.map(([runner]) => runner).sort()).toEqual([
    "R1",
    "R2",
    "R3",
  ]);
});

test("only one admission owns a limited account slot, and a rejected admission leaks nothing", async () => {
  const f = fixture();
  setAgentAccountConcurrency(f.db, {
    workspaceId: f.workspaceId,
    accountId: f.accounts.a,
    concurrency: 1,
    now: f.now(),
  });
  const order = [f.accounts.a, f.accounts.b];
  const found = await f.choices(order);
  const onR1 = candidate(f, found, "R1", f.accounts.a);
  const onR2 = candidate(f, found, "R2", f.accounts.a);
  const winner = f.admit("R1", onR1, order);
  const before = f.counts();
  expect(() => f.admit("R2", onR2, order)).toThrow(PlacementRaceError);
  expect(() => f.admit("R2", onR2, order)).toThrow(/A: account at its concurrency limit/);
  expect(f.counts()).toEqual(before);
  expect(accountSlotsInUse(f.db, f.accounts.a, f.now())).toBe(1);
  const next = await f.choices(order);
  expect(next.placed).toEqual([["R1", f.accounts.b]]);
  expect(next.rejected).toContainEqual({
    runnerId: "R2",
    reason: "A: account at its concurrency limit",
  });
  f.placement.finished({
    commandId: winner,
    runnerId: "R1",
    failure: "error",
    finishedAt: f.now(),
  });
  expect(accountSlotsInUse(f.db, f.accounts.a, f.now())).toBe(0);
  const freed = await f.choices(order);
  f.admit("R2", candidate(f, freed, "R2", f.accounts.a), order);
  expect(accountSlotsInUse(f.db, f.accounts.a, f.now())).toBe(1);
});

test("parallel placements race for the last account slot and exactly one assigns", async () => {
  const f = fixture();
  setAgentAccountConcurrency(f.db, {
    workspaceId: f.workspaceId,
    accountId: f.accounts.a,
    concurrency: 1,
    now: f.now(),
  });
  const order = [f.accounts.a];
  const [left, right] = await Promise.all([f.choices(order), f.choices(order)]);
  const outcomes = await Promise.allSettled([
    Promise.resolve().then(() => f.admit("R1", candidate(f, left!, "R1", f.accounts.a), order)),
    Promise.resolve().then(() => f.admit("R2", candidate(f, right!, "R2", f.accounts.a), order)),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  expect(
    outcomes.filter(
      (outcome) => outcome.status === "rejected" && outcome.reason instanceof PlacementRaceError,
    ),
  ).toHaveLength(1);
  expect(f.counts()).toEqual({ commands: 1, accounts: 1, usage: 1 });
});

test("a stale generation's result or a lost command cannot release the newer generation's slot", async () => {
  const f = fixture();
  setAgentAccountConcurrency(f.db, {
    workspaceId: f.workspaceId,
    accountId: f.accounts.a,
    concurrency: 1,
    now: f.now(),
  });
  const { run } = beginImplementRun(f.db, f.item.id, f.now());
  const order = [f.accounts.a];
  const older = f.admit("R1", candidate(f, await f.choices(order), "R1", f.accounts.a), order, {
    runId: run.id,
  });
  f.db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES(?,?,?,1,0,?,?)",
    [run.id, "R1", f.workspaceId, older, f.now() + 60_000],
  );
  expect(accountSlotsInUse(f.db, f.accounts.a, f.now())).toBe(1);
  f.db.run("UPDATE runner_work SET ended_at=? WHERE run_id=?", [f.now(), run.id]);
  expect(accountSlotsInUse(f.db, f.accounts.a, f.now())).toBe(1);
  f.db.run("UPDATE runner_work SET teardown_confirmed_at=? WHERE run_id=?", [f.now(), run.id]);
  expect(accountSlotsInUse(f.db, f.accounts.a, f.now())).toBe(0);
  const newer = f.admit("R2", candidate(f, await f.choices(order), "R2", f.accounts.a), order, {
    runId: run.id,
  });
  f.db.run(
    "UPDATE runner_work SET runner_id='R2',generation=2,command_id=?,ended_at=NULL,teardown_confirmed_at=NULL WHERE run_id=?",
    [newer, run.id],
  );
  expect(accountSlotsInUse(f.db, f.accounts.a, f.now())).toBe(1);
  const result = {
    executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    role: "implementer" as const,
    stopReason: "end_turn" as const,
    timedOut: false,
    cancelled: false,
    authRequired: false,
    agentExited: true,
  };
  expect(() =>
    f.placement.finished({
      commandId: newer,
      runnerId: "R2",
      result: { ...result, commandId: older },
      finishedAt: f.now(),
    }),
  ).toThrow("Runner result is not bound to its command");
  for (let replay = 0; replay < 2; replay++)
    f.placement.finished({
      commandId: older,
      runnerId: "R1",
      result: { ...result, commandId: older },
      finishedAt: f.now(),
    });
  expect(accountSlotsInUse(f.db, f.accounts.a, f.now())).toBe(1);
  expect(
    f.db
      .query<{ ended: number | null; revision: string | null }, [string]>(
        "SELECT ended_at AS ended,account_policy_revision AS revision FROM runner_execution_usage WHERE command_id=?",
      )
      .get(newer),
  ).toEqual({ ended: null, revision: "rev-1" });
  const blocked = await f.choices(order);
  expect(blocked.placed).toEqual([]);
});

test("a disabled account, a changed binding or a command without the chosen account fails admission", async () => {
  const f = fixture();
  const order = [f.accounts.a, f.accounts.b];
  const found = await f.choices(order);
  const a1 = candidate(f, found, "R1", f.accounts.a);
  const b1 = candidate(f, found, "R1", f.accounts.b);
  const legacy = { accountId: f.accounts.legacy, bindingId: `legacy_claude_R1`, named: false };
  const before = f.counts();
  expect(() => f.admit("R1", a1, order, { carried: legacy })).toThrow(
    "The command does not carry the account placement chose",
  );
  expect(() => f.admit("R1", a1, order, { carried: b1 })).toThrow(PlacementRaceError);
  expect(f.counts()).toEqual(before);
  setAgentAccountEnabled(f.db, {
    workspaceId: f.workspaceId,
    accountId: f.accounts.a,
    enabled: false,
    now: f.now(),
  });
  expect(() =>
    immediate(f.db, () =>
      f.placement.started({
        commandId: "unrecorded",
        runnerId: "R1",
        itemId: f.item.id,
        profile: { agent: "claude", model: "opus" },
        account: a1,
        accounts: { revision: "rev-1", accountIds: order },
        role: "implementer",
        purpose: "work",
        startedAt: f.now(),
      }),
    ),
  ).toThrow(PlacementRaceError);
  expect(f.counts()).toEqual(before);
  const after = await f.choices([f.accounts.a]);
  expect(after.placed).toEqual([]);
});

test("an incompatible runner or a missing binding never falls back to the default sign-in", async () => {
  const f = fixture();
  const named = await f.choices([f.accounts.a]);
  expect(named.placed.map(([runner]) => runner).sort()).toEqual(["R1", "R2"]);
  expect(named.candidates.every((row) => row.account?.named)).toBe(true);
  const fallback = await f.choices([f.accounts.b, f.accounts.legacy]);
  expect(fallback.placed[0]).toEqual(["R1", f.accounts.b]);
  expect(fallback.placed.slice(1).map(([, account]) => account)).toEqual([
    f.accounts.legacy,
    f.accounts.legacy,
    f.accounts.legacy,
  ]);
});

test("a runner whose default sign-in expired still runs its named account", async () => {
  const f = fixture();
  f.db.run("UPDATE runner_agent_policy SET ready=0,auth_expired=1 WHERE runner_id='R1'");
  const legacyOnly = await f.choices([f.accounts.legacy]);
  expect(legacyOnly.placed.map(([runner]) => runner)).not.toContain("R1");
  expect(legacyOnly.rejected).toContainEqual({ runnerId: "R1", reason: "auth-expired" });
  const withNamed = await f.choices([f.accounts.b, f.accounts.legacy]);
  expect(withNamed.placed[0]).toEqual(["R1", f.accounts.b]);
  expect(withNamed.rejected).toContainEqual({
    runnerId: "R1",
    reason: "default sign-in: agent not signed in",
  });
});

test("a failed binding is excluded on its own, so another account on that runner stays usable", async () => {
  const f = fixture();
  const found = await f.choices([f.accounts.a, f.accounts.b], {
    excludeRunnerIds: [f.bindings.a1],
  });
  expect(found.placed).toEqual([
    ["R2", f.accounts.a],
    ["R1", f.accounts.b],
  ]);
});

test("a named account's usage limit leaves the runner's default sign-in and other agents ready", async () => {
  const f = fixture();
  const order = [f.accounts.a];
  const commandId = f.admit("R1", candidate(f, await f.choices(order), "R1", f.accounts.a), order);
  const outcome = f.placement.finished({
    commandId,
    runnerId: "R1",
    profile: { agent: "claude", model: "opus" },
    result: {
      executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      commandId,
      role: "implementer",
      stopReason: "end_turn",
      timedOut: false,
      cancelled: false,
      authRequired: false,
      agentExited: true,
      errorMessage: "insufficient_quota",
    },
    finishedAt: f.now(),
  });
  expect(outcome).toMatchObject({ retryable: true, usageLimit: { resetsAt: null } });
  expect(
    f.db
      .query<{ quota: string; cooldown: number }, []>(
        "SELECT quota_state AS quota,cooldown_until AS cooldown FROM runner_agent_policy WHERE runner_id='R1' AND agent='claude'",
      )
      .get(),
  ).toEqual({ quota: "ok", cooldown: 0 });
  expect((await f.choices(order)).placed).toEqual([]);
  expect((await f.choices([f.accounts.legacy])).placed.map(([runner]) => runner)).toContain("R1");
  const codex = await f.placement.candidates({
    itemId: f.item.id,
    profile: { agent: "codex", model: null },
    role: "implementer",
    purpose: "work",
  });
  expect(codex.map((row) => row.id).sort()).toEqual(["R1", "R2", "R3"]);
  expect(codex.every((row) => row.account?.named === false)).toBe(true);
});

test("a cancelled execution keeps its account slot until the runner confirms teardown", async () => {
  const f = fixture();
  setAgentAccountConcurrency(f.db, {
    workspaceId: f.workspaceId,
    accountId: f.accounts.a,
    concurrency: 1,
    now: f.now(),
  });
  const { run } = beginImplementRun(f.db, f.item.id, f.now());
  const order = [f.accounts.a];
  const running = f.admit("R1", candidate(f, await f.choices(order), "R1", f.accounts.a), order, {
    runId: run.id,
  });
  f.db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES(?,?,?,1,0,?,?)",
    [run.id, "R1", f.workspaceId, running, f.now() + 60_000],
  );
  f.db.run(
    "INSERT INTO runner_command(id,runner_id,run_id,generation,kind,envelope,expires_at) VALUES('cancel-1','R1',?,1,'cancel','{}',?)",
    [run.id, f.now() + 65_000],
  );
  f.db.run("UPDATE runner_work SET ended_at=? WHERE run_id=?", [f.now(), run.id]);
  f.placement.finished({
    commandId: running,
    runnerId: "R1",
    failure: "cancelled",
    finishedAt: f.now(),
  });
  expect(accountSlotsInUse(f.db, f.accounts.a, f.now())).toBe(1);
  const waiting = await f.choices(order);
  expect(waiting.placed).toEqual([]);
  expect(waiting.rejected).toContainEqual({
    runnerId: "R2",
    reason: "A: account at its concurrency limit",
  });
  f.db.run("UPDATE runner_work SET teardown_confirmed_at=? WHERE run_id=?", [f.now(), run.id]);
  const freed = await f.choices(order);
  f.admit("R2", candidate(f, freed, "R2", f.accounts.a), order);
  expect(accountSlotsInUse(f.db, f.accounts.a, f.now())).toBe(1);
});

test("scheduler readiness counts a runner whose usable named account outlives its default sign-in", () => {
  const f = fixture();
  f.db.run("UPDATE runner_agent_policy SET ready=0,auth_expired=1 WHERE agent='claude'");
  const input = { itemId: f.item.id, agent: "claude", now: f.now() };
  expect(itemOwnerHasEligibleRunner(f.db, input)).toBe(true);
  expect(itemOwnerRunnerSetupNeed(f.db, input)).toBeNull();
  for (const accountId of [f.accounts.a, f.accounts.b])
    setAgentAccountEnabled(f.db, {
      workspaceId: f.workspaceId,
      accountId,
      enabled: false,
      now: f.now(),
    });
  expect(itemOwnerHasEligibleRunner(f.db, input)).toBe(false);
  expect(itemOwnerRunnerSetupNeed(f.db, input)).toMatchObject({ reason: "agent-not-signed-in" });
});

test("a helper ended locally keeps its account slot until its result or its expiry", () => {
  const f = fixture();
  const helper = (id: string, expiresAt: number) => {
    f.db.run(
      "INSERT INTO runner_helper(id,runner_id,workspace_id,session_id,session_generation,runner_fence,envelope,expires_at,acknowledged_at) VALUES(?,'R1',?,'session',0,0,'{}',?,?)",
      [id, f.workspaceId, expiresAt, f.now()],
    );
    f.db.run(
      "INSERT INTO runner_command_account(command_id,workspace_id,runner_id,agent,account_id,binding_id,named,recorded_at) VALUES(?,?,'R1','claude',?,?,1,?)",
      [id, f.workspaceId, f.accounts.a, f.bindings.a1, f.now()],
    );
    f.db.run(
      "INSERT INTO runner_execution_usage(command_id,runner_id,owner_user_id,agent,role,purpose,started_at) VALUES(?,'R1',(SELECT owner_user_id FROM runner WHERE id='R1'),'claude','implementer','helper',?)",
      [id, f.now()],
    );
  };
  helper("helper-1", f.now() + 60_000);
  expect(accountSlotsInUse(f.db, f.accounts.a, f.now())).toBe(1);
  f.db.run("UPDATE runner_helper SET ended_at=? WHERE id='helper-1'", [f.now()]);
  f.db.run(
    "UPDATE runner_execution_usage SET ended_at=?,outcome='timeout' WHERE command_id='helper-1'",
    [f.now()],
  );
  expect(accountSlotsInUse(f.db, f.accounts.a, f.now())).toBe(1);
  f.db.run("UPDATE runner_helper SET result='{}' WHERE id='helper-1'");
  expect(accountSlotsInUse(f.db, f.accounts.a, f.now())).toBe(0);
  helper("helper-2", f.now() + 60_000);
  f.db.run("UPDATE runner_helper SET ended_at=? WHERE id='helper-2'", [f.now()]);
  expect(accountSlotsInUse(f.db, f.accounts.a, f.now())).toBe(1);
  expect(accountSlotsInUse(f.db, f.accounts.a, f.now() + 60_001)).toBe(0);
});

test("an abandoned attempt keeps its account and binding, once per execution, across a restart", async () => {
  const f = fixture();
  const { run } = beginImplementRun(f.db, f.item.id, f.now());
  const order = [f.accounts.a, f.accounts.b];
  const commandId = f.admit("R1", candidate(f, await f.choices(order), "R1", f.accounts.a), order, {
    runId: run.id,
  });
  f.db.run("UPDATE runner_command SET kind='run' WHERE id=?", [commandId]);
  f.db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES(?,?,?,1,0,?,?)",
    [run.id, "R1", f.workspaceId, commandId, f.now() + 60_000],
  );
  const entry = {
    runId: run.id,
    callId: `implementer:${run.id}`,
    policyKey: "rev-1",
    outcome: "failed" as const,
    runnerId: "R1",
    excludedKey: f.bindings.a1,
    now: f.now(),
  };
  expect(recordFallbackAttempt(f.db, entry)).toBe(true);
  expect(recordFallbackAttempt(f.db, entry)).toBe(false);
  expect(
    f.db
      .query<{ accountId: string; bindingId: string; generation: number }, [string]>(
        "SELECT account_id AS accountId,binding_id AS bindingId,generation FROM run_fallback_attempt WHERE run_id=?",
      )
      .all(run.id),
  ).toEqual([{ accountId: f.accounts.a, bindingId: f.bindings.a1, generation: 1 }]);
  const history = fallbackHistory(f.db, run.id, entry.callId, "rev-1");
  expect(history).toEqual({ excluded: [f.bindings.a1], failures: 1, usageLimits: 0 });
  expect(fallbackHistory(f.db, run.id, "reviewer:rev-1", "rev-1").excluded).toEqual([]);
  const next = await f.choices(order, { excludeRunnerIds: history.excluded });
  expect(next.placed[0]).toEqual(["R2", f.accounts.a]);
  expect(next.placed).not.toContainEqual(["R1", f.accounts.a]);
  expect(next.placed).toContainEqual(["R1", f.accounts.b]);
  closeFallbackAttempts(f.db, run.id, entry.callId, f.now());
  expect(fallbackHistory(f.db, run.id, entry.callId, "rev-1")).toEqual({
    excluded: [],
    failures: 0,
    usageLimits: 0,
  });
  expect(recordFallbackAttempt(f.db, entry)).toBe(true);
  expect(
    f.db
      .query<{ ordinal: number; closed: number | null }, [string]>(
        "SELECT ordinal,closed_at AS closed FROM run_fallback_attempt WHERE run_id=? ORDER BY ordinal",
      )
      .all(run.id),
  ).toEqual([
    { ordinal: 1, closed: f.now() },
    { ordinal: 2, closed: null },
  ]);
});

test("a moved run prefers a runner whose candidate account may restore its session", async () => {
  const f = fixture();
  beginImplementRun(f.db, f.item.id, f.now());
  f.db.run("UPDATE runner SET last_seen_at=0 WHERE id='R3'");
  const order = [f.accounts.a, f.accounts.b];
  for (const [restorer, other] of [
    ["R1", "R2"],
    ["R2", "R1"],
  ] as const) {
    const asked: [string, string | undefined][] = [];
    const found = await f.choices(order, {
      pinnedRunnerId: "R3",
      restore: (runnerId, account) => {
        asked.push([runnerId, account?.accountId]);
        return runnerId === restorer && account?.accountId === f.accounts.a
          ? { sameVersion: true }
          : null;
      },
    });
    expect(asked).toContainEqual(["R1", f.accounts.b]);
    expect(found.placed.slice(0, 2)).toEqual([
      [restorer, f.accounts.a],
      [other, f.accounts.a],
    ]);
  }
});

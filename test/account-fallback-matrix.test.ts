import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accountAgentEnv } from "../src/acp";
import {
  AgentAccountError,
  accountSlotsInUse,
  admitAgentAccounts,
  bindAgentAccount,
  bindLinearSessionTask,
  consumeWorkspaceBootstrap,
  createAgentAccount,
  immediate,
  insertQueuedItem,
  legacyAgentAccountId,
  legacyAgentBindingId,
  listAgentAccounts,
  listAgentBindings,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordAccountObservation,
  recordCommandAccount,
  recordLinearInstallation,
  recordRunnerAccountCapability,
  removeAgentAccount,
  setAgentAccountEnabled,
} from "../src/db";
import { RUNNER_ACCOUNT_HOMES, runnerAccountHome } from "../src/runner-execution";
import {
  bindingReadiness,
  createRunnerPlacement,
  PlacementRaceError,
  type PlacementAccount,
} from "../src/runner-placement";
import {
  RUNNER_CODING_AGENTS,
  RunnerAccountCapabilitySchema,
  RunnerAccountSchema,
  runnerAccountAgentUnsupported,
  runnerAccountEchoed,
  type RunnerCommand,
} from "../src/runner-protocol";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { tempHome } from "./helpers";

const SECRET = "sk-ant-oat01-PAS1021-planted-secret";
const HOUR = 3_600_000;

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
  for (const id of ["R1", "R2"]) {
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
      [id, workspace.id, owner, id, clock, clock],
    );
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'claude',1)", [id]);
    db.run(
      "INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES(?,'0.1.60',?)",
      [id, clock],
    );
  }
  const named = (label: string) =>
    createAgentAccount(db, { workspaceId: workspace.id, agent: "claude", label, now: clock }).id;
  const accounts = {
    a: named("A"),
    b: named("B"),
    legacy: legacyAgentAccountId(workspace.id, "claude"),
  };
  const bind = (accountId: string, runnerId: string) =>
    bindAgentAccount(db, { workspaceId: workspace.id, accountId, runnerId, now: clock }).id;
  const bindings = {
    a1: bind(accounts.a, "R1"),
    a2: bind(accounts.a, "R2"),
    b1: bind(accounts.b, "R1"),
  };
  const report = (runnerId: string, ids: string[]) =>
    recordRunnerAccountCapability(
      db,
      runnerId,
      { protocol: 1, bindings: ids.map((bindingId) => ({ bindingId, agent: "claude" })) },
      clock,
    );
  report("R1", [bindings.a1, bindings.b1]);
  report("R2", [bindings.a2]);
  const placement = createRunnerPlacement({ db, now: () => clock });
  const choices = async (accountIds: string[]) => {
    const rejected: { runnerId: string; reason: string; until?: number }[] = [];
    const found = await placement.candidates({
      itemId: item.id,
      profile: { agent: "claude", model: "opus" },
      role: "implementer",
      purpose: "work",
      accounts: { revision: "rev-1", accountIds },
      onRejected: (runnerId, reason, until) =>
        rejected.push({ runnerId, reason, ...(until === undefined ? {} : { until }) }),
    });
    return {
      placed: found.map((entry) => [entry.id, entry.account!.accountId] as const),
      pick(runnerId: string, accountId: string): PlacementAccount {
        const entry = found.find(
          (row) => row.id === runnerId && row.account?.accountId === accountId,
        );
        if (!entry?.account) throw new Error(`no candidate ${runnerId} ${accountId}`);
        return entry.account;
      },
      rejected,
    };
  };
  let ordinal = 0;
  const admit = (runnerId: string, account: PlacementAccount, order: string[]) =>
    immediate(db, () => {
      const id = `cmd-${++ordinal}`;
      const command = {
        id,
        runnerId,
        workspaceId: workspace.id,
        issuedAt: clock,
        expiresAt: clock + HOUR,
        type: "probe",
        profile: { agent: "claude", model: "opus" },
        ...(account.named
          ? { account: { accountId: account.accountId, bindingId: account.bindingId } }
          : {}),
      } as RunnerCommand;
      recordCommandAccount(db, command, clock);
      db.run(
        "INSERT INTO runner_command(id,runner_id,kind,envelope,expires_at) VALUES(?,?,'probe','{}',?)",
        [id, runnerId, clock + HOUR],
      );
      placement.started({
        commandId: id,
        runnerId,
        itemId: item.id,
        profile: { agent: "claude", model: "opus" },
        account,
        accounts: { revision: "rev-1", accountIds: order },
        role: "implementer",
        purpose: "work",
        startedAt: clock,
      });
      return id;
    });
  const finish = (commandId: string, runnerId: string, errorMessage?: string) =>
    placement.finished({
      commandId,
      runnerId,
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
        ...(errorMessage === undefined ? {} : { errorMessage }),
      },
      finishedAt: clock,
    });
  return {
    db,
    workspaceId: workspace.id,
    accounts,
    bindings,
    report,
    choices,
    admit,
    finish,
    now: () => clock,
    tick(ms: number, runners: string[] = ["R1", "R2"]) {
      clock += ms;
      for (const id of runners) db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [clock, id]);
    },
  };
}

function code(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (error instanceof AgentAccountError) return error.code;
    throw error;
  }
  return null;
}

function databaseText(db: Database) {
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  return tables
    .map(({ name }) => JSON.stringify(db.query(`SELECT * FROM "${name}"`).all()))
    .join("\n");
}

test("A unavailable falls to B on the same runner, all unavailable waits, and A's recheck resumes it once", async () => {
  const f = fixture();
  const order = [f.accounts.a, f.accounts.b];
  const first = await f.choices(order);
  expect(first.placed.slice(0, 2).map(([, account]) => account)).toEqual([
    f.accounts.a,
    f.accounts.a,
  ]);
  const onA = f.admit("R1", first.pick("R1", f.accounts.a), order);
  expect(f.finish(onA, "R1", `insufficient_quota: ${SECRET}`)).toMatchObject({ retryable: true });

  const fallback = await f.choices(order);
  expect(fallback.placed).toEqual([["R1", f.accounts.b]]);
  const onB = f.admit("R1", fallback.pick("R1", f.accounts.b), order);
  expect(f.finish(onB, "R1")).toMatchObject({ retryable: false });
  expect(bindingReadiness(f.db, { bindingId: f.bindings.b1, now: f.now() })).toMatchObject({
    ready: true,
  });

  const bReset = f.now() + 24 * HOUR;
  recordAccountObservation(f.db, {
    bindingId: f.bindings.b1,
    source: "result",
    sourceId: "b-limit",
    observedAt: f.now(),
    now: f.now(),
    state: "exhausted",
    resetsAt: bReset,
  });
  const none = await f.choices(order);
  expect(none.placed).toEqual([]);
  const until = none.rejected.flatMap((entry) => (entry.until === undefined ? [] : [entry.until]));
  expect(until.length).toBeGreaterThan(0);
  expect(Math.min(...until)).toBeLessThan(bReset);
  expect(accountSlotsInUse(f.db, f.accounts.a, f.now())).toBe(0);
  expect(accountSlotsInUse(f.db, f.accounts.b, f.now())).toBe(0);
  expect(none.placed.some(([, account]) => account === f.accounts.legacy)).toBe(false);

  f.tick(5 * HOUR);
  const resumed = await f.choices(order);
  expect(resumed.placed.map(([, account]) => account)).toEqual([f.accounts.a, f.accounts.a]);
  f.admit("R1", resumed.pick("R1", f.accounts.a), order);
  const probing = await f.choices(order);
  expect(probing.placed).toEqual([]);
  expect(bindingReadiness(f.db, { bindingId: f.bindings.a2, now: f.now() })).toEqual({
    ready: false,
    reason: "exhausted",
    until: null,
  });

  expect(databaseText(f.db)).not.toContain(SECRET);
  expect(databaseText(f.db)).not.toContain(RUNNER_ACCOUNT_HOMES);
});

test("a second binding of the same account is refused and cannot evade its cooldown", async () => {
  const f = fixture();
  expect(
    code(() =>
      bindAgentAccount(f.db, {
        workspaceId: f.workspaceId,
        accountId: f.accounts.a,
        runnerId: "R1",
        now: f.now(),
      }),
    ),
  ).toBe("duplicate");
  recordAccountObservation(f.db, {
    bindingId: f.bindings.a2,
    source: "login_check",
    sourceId: "check-a2",
    observedAt: f.now(),
    now: f.now(),
    state: "exhausted",
    resetsAt: f.now() + HOUR,
  });
  for (const bindingId of [f.bindings.a1, f.bindings.a2])
    expect(bindingReadiness(f.db, { bindingId, now: f.now() })).toMatchObject({
      ready: false,
      reason: "exhausted",
    });
  expect((await f.choices([f.accounts.a])).placed).toEqual([]);
  expect((await f.choices([f.accounts.b])).placed).toEqual([["R1", f.accounts.b]]);
});

test("stale readiness: a binding the runner stops reporting, or an offline runner, is not offered", async () => {
  const f = fixture();
  f.report("R1", [f.bindings.b1]);
  const unreported = await f.choices([f.accounts.a]);
  expect(unreported.placed).toEqual([["R2", f.accounts.a]]);
  expect(unreported.rejected.some((entry) => entry.runnerId === "R1")).toBe(true);
  f.report("R1", [f.bindings.a1, f.bindings.b1]);
  f.tick(10 * 60_000, ["R1"]);
  expect(bindingReadiness(f.db, { bindingId: f.bindings.a2, now: f.now() })).toEqual({
    ready: false,
    reason: "offline",
    until: null,
  });
  expect((await f.choices([f.accounts.a])).placed).toEqual([["R1", f.accounts.a]]);
});

test("auth repair: a sign-in failure blocks only its binding until a completed sign-in", async () => {
  const f = fixture();
  recordAccountObservation(f.db, {
    bindingId: f.bindings.b1,
    source: "result",
    sourceId: "b-auth",
    observedAt: f.now(),
    now: f.now(),
    state: "auth_required",
  });
  expect(bindingReadiness(f.db, { bindingId: f.bindings.b1, now: f.now() })).toEqual({
    ready: false,
    reason: "auth-required",
    until: null,
  });
  f.tick(24 * HOUR);
  expect((await f.choices([f.accounts.b, f.accounts.a])).placed[0]).toEqual(["R1", f.accounts.a]);
  f.tick(1);
  recordAccountObservation(f.db, {
    bindingId: f.bindings.b1,
    source: "sign_in",
    sourceId: "b-repair",
    observedAt: f.now(),
    now: f.now(),
    state: "ok",
    clears: ["auth"],
  });
  expect((await f.choices([f.accounts.b, f.accounts.a])).placed[0]).toEqual(["R1", f.accounts.b]);
});

test("revocation: a revoked runner or removed account is skipped, and its late success changes nothing", async () => {
  const f = fixture();
  f.db.run("UPDATE runner SET status='revoked',revoked_at=? WHERE id='R2'", [f.now()]);
  expect(bindingReadiness(f.db, { bindingId: f.bindings.a2, now: f.now() })).toMatchObject({
    reason: "revoked",
  });
  expect((await f.choices([f.accounts.a])).placed).toEqual([["R1", f.accounts.a]]);
  expect(
    code(() =>
      bindAgentAccount(f.db, {
        workspaceId: f.workspaceId,
        accountId: f.accounts.b,
        runnerId: "R2",
        now: f.now(),
      }),
    ),
  ).toBe("removed");

  recordAccountObservation(f.db, {
    bindingId: f.bindings.b1,
    source: "result",
    sourceId: "b-limit",
    observedAt: f.now(),
    now: f.now(),
    state: "exhausted",
    resetsAt: null,
  });
  removeAgentAccount(f.db, { workspaceId: f.workspaceId, accountId: f.accounts.b, now: f.now() });
  f.tick(1);
  expect(
    recordAccountObservation(f.db, {
      bindingId: f.bindings.b1,
      source: "result",
      sourceId: "b-late",
      observedAt: f.now(),
      now: f.now(),
      state: "ok",
      clears: ["quota"],
    }),
  ).toEqual({ quota: "removed" });
  expect(
    admitAgentAccounts(f.db, f.workspaceId, "claude", {
      agent: "claude",
      accounts: [f.accounts.b],
    }),
  ).toMatchObject({
    eligible: [],
    skipped: [{ accountId: f.accounts.b, reason: "removed" }],
  });
  expect((await f.choices([f.accounts.b])).placed).toEqual([]);
});

test("wrong-account use: a command, result or heartbeat that mixes identities is refused", async () => {
  const f = fixture();
  const command = (
    id: string,
    runnerId: string,
    account: { accountId: string; bindingId: string },
  ) =>
    ({
      id,
      runnerId,
      workspaceId: f.workspaceId,
      issuedAt: f.now(),
      expiresAt: f.now() + HOUR,
      type: "probe",
      profile: { agent: "claude", model: null },
      account,
    }) as RunnerCommand;
  expect(
    code(() =>
      recordCommandAccount(
        f.db,
        command("x1", "R1", { accountId: f.accounts.a, bindingId: f.bindings.b1 }),
        f.now(),
      ),
    ),
  ).toBe("binding_mismatch");
  expect(
    code(() =>
      recordCommandAccount(
        f.db,
        command("x2", "R1", { accountId: f.accounts.a, bindingId: f.bindings.a2 }),
        f.now(),
      ),
    ),
  ).toBe("binding_mismatch");
  expect(
    f.db.query("SELECT 1 FROM runner_command_account WHERE command_id IN ('x1','x2')").all(),
  ).toEqual([]);

  const a = { accountId: f.accounts.a, bindingId: f.bindings.a1 };
  const b = { accountId: f.accounts.b, bindingId: f.bindings.b1 };
  expect(runnerAccountEchoed({ account: a }, { account: b })).toBe(false);
  expect(runnerAccountEchoed({ account: a }, {})).toBe(false);
  expect(runnerAccountEchoed({}, { account: a })).toBe(false);

  expect(RunnerAccountSchema.safeParse({ ...a, token: SECRET }).success).toBe(false);
  expect(RunnerAccountSchema.safeParse({ ...a, bindingId: "../R2" }).success).toBe(false);
  expect(
    RunnerAccountSchema.safeParse({
      accountId: f.accounts.legacy,
      bindingId: legacyAgentBindingId("R1", "claude"),
    }).success,
  ).toBe(false);
  expect(
    RunnerAccountCapabilitySchema.safeParse({
      protocol: 1,
      bindings: [{ bindingId: f.bindings.a1, agent: "claude", home: "/x" }],
    }).success,
  ).toBe(false);

  const found = await f.choices([f.accounts.a]);
  setAgentAccountEnabled(f.db, {
    workspaceId: f.workspaceId,
    accountId: f.accounts.a,
    enabled: false,
    now: f.now(),
  });
  const counts = () =>
    f.db
      .query(
        "SELECT (SELECT COUNT(*) FROM runner_command_account) AS accounts,(SELECT COUNT(*) FROM runner_command) AS commands,(SELECT COUNT(*) FROM runner_execution_usage) AS usage",
      )
      .get();
  const before = counts();
  expect(() => f.admit("R1", found.pick("R1", f.accounts.a), [f.accounts.a])).toThrow(
    "Agent account is disabled",
  );
  setAgentAccountEnabled(f.db, {
    workspaceId: f.workspaceId,
    accountId: f.accounts.a,
    enabled: true,
    now: f.now(),
  });
  recordAccountObservation(f.db, {
    bindingId: f.bindings.a2,
    source: "result",
    sourceId: "a-limit",
    observedAt: f.now(),
    now: f.now(),
    state: "exhausted",
    resetsAt: null,
  });
  expect(() => f.admit("R1", found.pick("R1", f.accounts.a), [f.accounts.a])).toThrow(
    PlacementRaceError,
  );
  expect(counts()).toEqual(before);
});

test("every advertised adapter isolates a binding's config, sessions and caches in its own home", () => {
  const agentHome = "/var/lib/paws-agent";
  const homes = ["01JBINDINGA000000000000000", "01JBINDINGB000000000000000"].map((bindingId) =>
    runnerAccountHome(agentHome, { accountId: "01JACCOUNTA000000000000000", bindingId }),
  );
  expect(runnerAccountHome(agentHome)).toBe(agentHome);
  const [first, second] = homes.map((home) => accountAgentEnv(home));
  for (const [key, value] of Object.entries(first!)) {
    expect(value.startsWith(`${homes[0]}`)).toBe(true);
    expect(second![key]!.startsWith(`${homes[1]}`)).toBe(true);
  }
  expect(Object.keys(first!).sort()).toEqual(
    [
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "HOME",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
    ].sort(),
  );
  expect(Object.keys(first!)).not.toContain("XAI_API_KEY");
  expect(runnerAccountAgentUnsupported("gemini" as never)).not.toBeNull();

  const doc = readFileSync(new URL("../docs/agent-account-rollout.md", import.meta.url), "utf8");
  for (const agent of RUNNER_CODING_AGENTS) {
    const row = doc.split("\n").find((line) => line.startsWith(`| \`${agent}\``));
    expect(row, `${agent} has a row in the adapter matrix`).toBeDefined();
    expect(row!.includes("Supported")).toBe(runnerAccountAgentUnsupported(agent) === null);
  }
});

test("a legacy installation upgrades to default sign-in accounts and rolls back without losing history", async () => {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  try {
    migrate(db, { until: "20261102T0055_runner_admin_repositories" });
    db.run(
      "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('w','o','W',1)",
    );
    db.run(
      "INSERT INTO workspace_user(id,linear_user_id,name,email) VALUES('u','l','U','u@example.com')",
    );
    db.run(
      "INSERT INTO workspace_member(workspace_id,user_id,role,source,active,checked_at) VALUES('w','u','admin','manual',1,1)",
    );
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at) VALUES('r','w','u','R','active',1)",
    );
    db.run(
      "INSERT INTO runner_agent_policy(runner_id,agent,ready,quota_state,cooldown_until) VALUES('r','claude',1,'exhausted',99)",
    );
    db.run(
      "INSERT INTO runner_command(id,runner_id,kind,envelope,expires_at) VALUES('old','r','probe','{}',9)",
    );
    db.run(
      "INSERT INTO runner_execution_usage(command_id,runner_id,owner_user_id,agent,role,purpose,started_at,ended_at,outcome) VALUES('old','r','u','claude','implementer','check',1,2,'ok')",
    );

    migrate(db);
    const legacy = legacyAgentAccountId("w", "claude");
    expect(listAgentAccounts(db, "w")).toMatchObject([{ id: legacy, legacy: true, enabled: true }]);
    expect(listAgentBindings(db, "w")).toMatchObject([
      {
        id: legacyAgentBindingId("r", "claude"),
        accountId: legacy,
        quotaScope: "unknown",
        legacy: true,
      },
    ]);
    expect(
      db
        .query("SELECT quota_state AS quota,cooldown_until AS cooldown FROM runner_agent_policy")
        .get(),
    ).toEqual({ quota: "exhausted", cooldown: 99 });
    expect(db.query("SELECT command_id AS id,outcome FROM runner_execution_usage").all()).toEqual([
      { id: "old", outcome: "ok" },
    ]);

    db.run("UPDATE runner SET last_seen_at=1");
    const named = createAgentAccount(db, {
      workspaceId: "w",
      agent: "claude",
      label: "A",
      now: 10,
    });
    const binding = bindAgentAccount(db, {
      workspaceId: "w",
      accountId: named.id,
      runnerId: "r",
      now: 10,
    });
    db.run(
      "INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES('r','0.1.60',10)",
    );
    recordRunnerAccountCapability(
      db,
      "r",
      { protocol: 1, bindings: [{ bindingId: binding.id, agent: "claude" }] },
      10,
    );
    recordCommandAccount(
      db,
      {
        id: "named",
        runnerId: "r",
        workspaceId: "w",
        issuedAt: 10,
        expiresAt: 20,
        type: "probe",
        profile: { agent: "claude", model: null },
        account: { accountId: named.id, bindingId: binding.id },
      } as RunnerCommand,
      10,
    );
    const applied = () => db.query("SELECT id FROM schema_migration ORDER BY id").all();
    const before = applied();
    migrate(db, { until: "20261102T0055_runner_admin_repositories" });
    expect(applied()).toEqual(before);
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES('r','codex',1)");
    db.run(
      "INSERT INTO runner_command(id,runner_id,kind,envelope,expires_at) VALUES('older','r','probe','{}',30)",
    );
    db.run(
      "INSERT INTO runner_execution_usage(command_id,runner_id,owner_user_id,agent,role,purpose,started_at) VALUES('older','r','u','claude','implementer','check',30)",
    );
    expect(() => db.run("DELETE FROM agent_account WHERE id=?", [named.id])).toThrow(
      "removed, not deleted",
    );
    expect(() => db.run("DELETE FROM runner_command_account")).toThrow("retained");

    migrate(db);
    expect(applied()).toEqual(before);
    expect(
      listAgentAccounts(db, "w")
        .map((row) => row.id)
        .sort(),
    ).toEqual([legacy, legacyAgentAccountId("w", "codex"), named.id].sort());
    expect(
      db.query("SELECT command_id AS id,account_id AS account FROM runner_command_account").all(),
    ).toEqual([{ id: "named", account: named.id }]);

    expect(admitAgentAccounts(db, "w", "claude")).toEqual({
      agent: "claude",
      configured: false,
      eligible: [legacy],
      skipped: [],
    });
  } finally {
    db.close();
  }
});

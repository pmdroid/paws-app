import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { accountAgentEnv } from "../src/acp";
import {
  AgentAccountError,
  admitAgentAccounts,
  bindAgentAccount,
  bindLinearSessionTask,
  consumeWorkspaceBootstrap,
  createAgentAccount,
  insertQueuedItem,
  legacyAgentAccountId,
  legacyAgentBindingId,
  listAgentAccounts,
  listAgentBindings,
  legacyMigrate,
  openDatabase,
  putWorkspaceUser,
  recordCommandAccount,
  recordLinearInstallation,
  recordRunnerAccountCapability,
  sqliteDb,
} from "../src/db";
import { runnerAccountHome } from "../src/runner-execution";
import {
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

async function fixture() {
  const db = openDatabase(join(tempHome(), "paws.sqlite"));
  legacyMigrate(db);
  let clock = Date.now();
  const owner = await putWorkspaceUser(sqliteDb(db), {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(sqliteDb(db), {
    id: workspaceId(),
    organizationId: "org",
    name: "Test",
    userId: owner,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(sqliteDb(db), "org", clock)),
    now: clock,
  });
  await recordLinearInstallation(sqliteDb(db), {
    organizationId: "org",
    oauthClientId: "app-client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: clock,
  });
  const item = insertQueuedItem(db, { id: "item", now: clock, sessionKey: "session" });
  await bindLinearSessionTask(sqliteDb(db), "session", item.delegationId, { actorId: "owner" });
  db.run("UPDATE work_item SET owner_user_id=? WHERE id=?", [owner, item.id]);
  for (const id of ["R1", "R2"]) {
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
      [id, workspace.id, owner, id, clock, clock],
    );
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'claude',1)", [id]);
    db.run(
      "INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES(?,'0.1.61',?)",
      [id, clock],
    );
  }
  const named = async (label: string) =>
    (
      await createAgentAccount(sqliteDb(db), {
        workspaceId: workspace.id,
        agent: "claude",
        label,
        now: clock,
      })
    ).id;
  const accounts = {
    a: await named("A"),
    b: await named("B"),
    legacy: legacyAgentAccountId(workspace.id, "claude"),
  };
  const bind = async (accountId: string, runnerId: string) =>
    (
      await bindAgentAccount(sqliteDb(db), {
        workspaceId: workspace.id,
        accountId,
        runnerId,
        now: clock,
      })
    ).id;
  const bindings = {
    a1: await bind(accounts.a, "R1"),
    a2: await bind(accounts.a, "R2"),
    b1: await bind(accounts.b, "R1"),
  };
  const report = async (runnerId: string, ids: string[]) =>
    await recordRunnerAccountCapability(
      sqliteDb(db),
      runnerId,
      { protocol: 1, bindings: ids.map((bindingId) => ({ bindingId, agent: "claude" })) },
      clock,
    );
  await report("R1", [bindings.a1, bindings.b1]);
  await report("R2", [bindings.a2]);
  return {
    db,
    workspaceId: workspace.id,
    accounts,
    bindings,
    now: () => clock,
  };
}

async function code(run: () => unknown) {
  try {
    await run();
  } catch (error) {
    if (error instanceof AgentAccountError) return error.code;
    throw error;
  }
  return null;
}

test("wrong-account use: a command, result or heartbeat that mixes identities is refused", async () => {
  const f = await fixture();
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
    await code(async () =>
      recordCommandAccount(
        f.db,
        command("x1", "R1", { accountId: f.accounts.a, bindingId: f.bindings.b1 }),
        f.now(),
      ),
    ),
  ).toBe("binding_mismatch");
  expect(
    await code(async () =>
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
});

test("a legacy installation upgrades to default sign-in accounts and rolls back without losing history", async () => {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  try {
    legacyMigrate(db, { until: "20261102T0055_runner_admin_repositories" });
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

    legacyMigrate(db);
    const legacy = legacyAgentAccountId("w", "claude");
    expect(await listAgentAccounts(sqliteDb(db), "w")).toMatchObject([
      { id: legacy, legacy: true, enabled: true },
    ]);
    expect(await listAgentBindings(sqliteDb(db), "w")).toMatchObject([
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
    const named = await createAgentAccount(sqliteDb(db), {
      workspaceId: "w",
      agent: "claude",
      label: "A",
      now: 10,
    });
    const binding = await bindAgentAccount(sqliteDb(db), {
      workspaceId: "w",
      accountId: named.id,
      runnerId: "r",
      now: 10,
    });
    db.run(
      "INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES('r','0.1.61',10)",
    );
    await recordRunnerAccountCapability(
      sqliteDb(db),
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
    legacyMigrate(db, { until: "20261102T0055_runner_admin_repositories" });
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

    legacyMigrate(db);
    expect(applied()).toEqual(before);
    expect((await listAgentAccounts(sqliteDb(db), "w")).map((row) => row.id).sort()).toEqual(
      [legacy, legacyAgentAccountId("w", "codex"), named.id].sort(),
    );
    expect(
      db.query("SELECT command_id AS id,account_id AS account FROM runner_command_account").all(),
    ).toEqual([{ id: "named", account: named.id }]);

    expect(await admitAgentAccounts(sqliteDb(db), "w", "claude")).toEqual({
      agent: "claude",
      eligible: [legacy],
      skipped: [],
    });
  } finally {
    db.close();
  }
});

import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { RunnerCommand } from "../runner-protocol";
import { migration } from "./migrations/20261103T0135_agent_accounts";
import {
  AgentAccountError,
  bindAgentAccount,
  commandAccount,
  createAgentAccount,
  listAgentAccounts,
  listAgentBindings,
  legacyMigrate,
  openDatabase,
  recordCommandAccount,
  recordRunnerAccountCapability,
  removeAgentAccount,
  removeAgentBinding,
  renameAgentAccount,
  setAgentAccountEnabled,
  sqliteDb,
} from "./index";

const NOW = 1_800_000_000_000;

function seed(db: Database, workspace: string, runners: string[]) {
  db.run("INSERT INTO workspace VALUES(?,?,?,?)", [workspace, `org-${workspace}`, workspace, NOW]);
  db.run("INSERT OR IGNORE INTO workspace_user(id,linear_user_id,name,email) VALUES(?,?,?,?)", [
    `user-${workspace}`,
    `linear-${workspace}`,
    "Owner",
    `${workspace}@example.test`,
  ]);
  db.run(
    "INSERT INTO workspace_member(workspace_id,user_id,role,source,active,checked_at) VALUES(?,?,'admin','manual',1,?)",
    [workspace, `user-${workspace}`, NOW],
  );
  for (const runner of runners)
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at) VALUES(?,?,?,?,'active',?)",
      [runner, workspace, `user-${workspace}`, runner, NOW],
    );
}

function fresh() {
  const db = openDatabase(":memory:");
  legacyMigrate(db);
  seed(db, "W1", ["R1", "R2"]);
  seed(db, "W2", ["R3"]);
  return db;
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

const base = { issuedAt: NOW, expiresAt: NOW + 60_000 };
const loginCheck = (
  id: string,
  runnerId: string,
  workspaceId: string,
  account?: { accountId: string; bindingId: string },
): RunnerCommand => ({
  ...base,
  id,
  runnerId,
  workspaceId,
  type: "login_check",
  agent: "claude",
  ...(account ? { account } : {}),
});
const probe = (
  id: string,
  runnerId: string,
  workspaceId: string,
  account?: { accountId: string; bindingId: string },
): RunnerCommand => ({
  ...base,
  id,
  runnerId,
  workspaceId,
  type: "probe",
  profile: { agent: "claude", model: null },
  ...(account ? { account } : {}),
});

test("the migration moves runner+agent rows to legacy bindings and is repeat-safe", () => {
  const db = openDatabase(":memory:");
  legacyMigrate(db, { until: "20261102T0055_runner_admin_repositories" });
  seed(db, "W1", ["R1", "R2"]);
  for (const [runner, agent] of [
    ["R1", "claude"],
    ["R2", "claude"],
    ["R2", "codex"],
  ])
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,?,1)", [
      runner!,
      agent!,
    ]);
  legacyMigrate(db);
  const snapshot = () => ({
    accounts: db
      .query("SELECT id,workspace_id,agent,legacy,enabled FROM agent_account ORDER BY id")
      .all(),
    bindings: db
      .query(
        "SELECT id,account_id,runner_id,agent,legacy,quota_scope FROM agent_account_binding ORDER BY id",
      )
      .all(),
  });
  const before = snapshot();
  expect(before).toEqual({
    accounts: [
      { id: "legacy_claude_W1", workspace_id: "W1", agent: "claude", legacy: 1, enabled: 1 },
      { id: "legacy_codex_W1", workspace_id: "W1", agent: "codex", legacy: 1, enabled: 1 },
    ],
    bindings: [
      {
        id: "legacy_claude_R1",
        account_id: "legacy_claude_W1",
        runner_id: "R1",
        agent: "claude",
        legacy: 1,
        quota_scope: "unknown",
      },
      {
        id: "legacy_claude_R2",
        account_id: "legacy_claude_W1",
        runner_id: "R2",
        agent: "claude",
        legacy: 1,
        quota_scope: "unknown",
      },
      {
        id: "legacy_codex_R2",
        account_id: "legacy_codex_W1",
        runner_id: "R2",
        agent: "codex",
        legacy: 1,
        quota_scope: "unknown",
      },
    ],
  });
  db.run(migration.sql);
  legacyMigrate(db);
  expect(snapshot()).toEqual(before);
  db.close();
});

test("a new runner+agent row gets its legacy binding", async () => {
  const db = fresh();
  db.run("INSERT INTO runner_agent_policy(runner_id,agent) VALUES('R3','grok')");
  expect(await listAgentBindings(sqliteDb(db), "W2")).toMatchObject([
    { id: "legacy_grok_R3", accountId: "legacy_grok_W2", legacy: true, quotaScope: "unknown" },
  ]);
  expect(await listAgentAccounts(sqliteDb(db), "W2")).toMatchObject([
    { id: "legacy_grok_W2", label: "Grok default sign-in", legacy: true, enabled: true },
  ]);
  db.close();
});

test("one account has several bindings and rejects duplicates and foreign workspaces", async () => {
  const db = fresh();
  const a = await createAgentAccount(sqliteDb(db), {
    workspaceId: "W1",
    agent: "claude",
    label: "Team",
    now: NOW,
  });
  expect(
    await code(
      async () =>
        await createAgentAccount(sqliteDb(db), {
          workspaceId: "W1",
          agent: "claude",
          label: " team ",
          now: NOW,
        }),
    ),
  ).toBe("duplicate");
  expect(
    (
      await createAgentAccount(sqliteDb(db), {
        workspaceId: "W1",
        agent: "codex",
        label: "Team",
        now: NOW,
      })
    ).agent,
  ).toBe("codex");
  expect(
    await code(
      async () =>
        await createAgentAccount(sqliteDb(db), {
          workspaceId: "W1",
          agent: "claude",
          label: "",
          now: NOW,
        }),
    ),
  ).toBe("invalid");
  expect(
    await code(
      async () =>
        await createAgentAccount(sqliteDb(db), {
          workspaceId: "nope",
          agent: "claude",
          label: "X",
          now: NOW,
        }),
    ),
  ).toBe("not_found");

  const first = await bindAgentAccount(sqliteDb(db), {
    workspaceId: "W1",
    accountId: a.id,
    runnerId: "R1",
    now: NOW,
  });
  const second = await bindAgentAccount(sqliteDb(db), {
    workspaceId: "W1",
    accountId: a.id,
    runnerId: "R2",
    now: NOW,
  });
  expect([first.quotaScope, second.quotaScope]).toEqual(["account", "account"]);
  expect(
    (await listAgentBindings(sqliteDb(db), "W1", a.id)).map((binding) => binding.runnerId),
  ).toEqual(["R1", "R2"]);
  expect(
    await code(
      async () =>
        await bindAgentAccount(sqliteDb(db), {
          workspaceId: "W1",
          accountId: a.id,
          runnerId: "R1",
          now: NOW,
        }),
    ),
  ).toBe("duplicate");
  expect(
    await code(
      async () =>
        await bindAgentAccount(sqliteDb(db), {
          workspaceId: "W1",
          accountId: a.id,
          runnerId: "R3",
          now: NOW,
        }),
    ),
  ).toBe("foreign_workspace");
  expect(
    await code(
      async () =>
        await bindAgentAccount(sqliteDb(db), {
          workspaceId: "W2",
          accountId: a.id,
          runnerId: "R3",
          now: NOW,
        }),
    ),
  ).toBe("foreign_workspace");
  expect(await code(async () => await listAgentBindings(sqliteDb(db), "W2", a.id))).toBe(
    "foreign_workspace",
  );
  expect(
    await code(
      async () =>
        await renameAgentAccount(sqliteDb(db), {
          workspaceId: "W2",
          accountId: a.id,
          label: "X",
          now: NOW,
        }),
    ),
  ).toBe("foreign_workspace");

  await removeAgentBinding(sqliteDb(db), { workspaceId: "W1", bindingId: first.id, now: NOW + 1 });
  expect(
    (
      await bindAgentAccount(sqliteDb(db), {
        workspaceId: "W1",
        accountId: a.id,
        runnerId: "R1",
        now: NOW + 2,
      })
    ).removedAt,
  ).toBeNull();
  db.close();
});

test("the schema keeps each binding to one workspace, account and agent", async () => {
  const db = fresh();
  const a = await createAgentAccount(sqliteDb(db), {
    workspaceId: "W1",
    agent: "claude",
    label: "A",
    now: NOW,
  });
  const insert = (
    workspace: string,
    agent: string,
    runner: string,
    legacy = 0,
    scope = "account",
  ) =>
    db.run(
      "INSERT INTO agent_account_binding(id,workspace_id,account_id,agent,runner_id,legacy,quota_scope,created_at) VALUES(?,?,?,?,?,?,?,?)",
      [`B-${workspace}-${agent}-${runner}`, workspace, a.id, agent, runner, legacy, scope, NOW],
    );
  expect(() => insert("W1", "codex", "R1")).toThrow(/FOREIGN KEY/);
  expect(() => insert("W2", "claude", "R3")).toThrow(/FOREIGN KEY/);
  expect(() => insert("W1", "claude", "R3")).toThrow(/another workspace/);
  expect(() => insert("W1", "claude", "R1", 1, "account")).toThrow(/CHECK/);
  expect(() => insert("W1", "claude", "missing")).toThrow();
  insert("W1", "claude", "R1");
  expect(() =>
    db.run("UPDATE agent_account_binding SET runner_id='R2' WHERE id='B-W1-claude-R1'"),
  ).toThrow(/immutable/);
  expect(() => db.run("DELETE FROM agent_account_binding")).toThrow(/removed, not deleted/);
  expect(() => db.run("UPDATE agent_account SET workspace_id='W2' WHERE id=?", [a.id])).toThrow(
    /immutable/,
  );
  expect(() => db.run("DELETE FROM agent_account WHERE id=?", [a.id])).toThrow(
    /removed, not deleted/,
  );
  db.close();
});

test("commands without an account record the runner's legacy identity", async () => {
  const db = fresh();
  expect(recordCommandAccount(db, loginCheck("C1", "R1", "W1"), NOW)).toEqual({
    commandId: "C1",
    workspaceId: "W1",
    runnerId: "R1",
    agent: "claude",
    accountId: "legacy_claude_W1",
    bindingId: "legacy_claude_R1",
    named: false,
    recordedAt: NOW,
  });
  recordCommandAccount(db, probe("C2", "R2", "W1"), NOW);
  expect(await commandAccount(sqliteDb(db), "C2")).toMatchObject({
    bindingId: "legacy_claude_R2",
    named: false,
  });
  expect(await commandAccount(sqliteDb(db), "unknown")).toBeNull();
  expect(
    recordCommandAccount(
      db,
      {
        ...base,
        id: "C3",
        runnerId: "R1",
        workspaceId: "W1",
        type: "cancel",
        runId: "run",
        generation: 1,
      },
      NOW,
    ),
  ).toBeNull();
  expect(await code(async () => recordCommandAccount(db, probe("C4", "R3", "W1"), NOW))).toBe(
    "foreign_workspace",
  );
  expect(() => recordCommandAccount(db, probe("C1", "R1", "W1"), NOW)).toThrow(/UNIQUE/);
  db.close();
});

test("a named account is refused unless the runner reports the binding", async () => {
  const db = fresh();
  const a = await createAgentAccount(sqliteDb(db), {
    workspaceId: "W1",
    agent: "claude",
    label: "A",
    now: NOW,
  });
  const bound = await bindAgentAccount(sqliteDb(db), {
    workspaceId: "W1",
    accountId: a.id,
    runnerId: "R1",
    now: NOW,
  });
  const named = { accountId: a.id, bindingId: bound.id };
  const attempt = (id: string, account = named, runner = "R1", workspace = "W1") =>
    code(async () => recordCommandAccount(db, probe(id, runner, workspace, account), NOW));
  expect(await attempt("N1")).toBe("runner_unsupported");
  db.run(
    "INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES('R1','0.1.59',?)",
    [NOW],
  );
  expect(await attempt("N2")).toBe("runner_unsupported");
  db.run("UPDATE runner_host_status SET runner_version='0.1.61' WHERE runner_id='R1'");
  expect(await attempt("N3")).toBe("runner_unsupported");
  await recordRunnerAccountCapability(sqliteDb(db), "R1", { protocol: 1, bindings: [] }, NOW);
  expect(await attempt("N4")).toBe("runner_unsupported");
  await recordRunnerAccountCapability(
    sqliteDb(db),
    "R1",
    { protocol: 1, bindings: [{ bindingId: bound.id, agent: "codex" }] },
    NOW,
  );
  expect(await attempt("N5")).toBe("runner_unsupported");
  await recordRunnerAccountCapability(
    sqliteDb(db),
    "R1",
    { protocol: 1, bindings: [{ bindingId: bound.id, agent: "claude" }] },
    NOW,
  );
  expect(await attempt("N6")).toBeNull();
  expect(await commandAccount(sqliteDb(db), "N6")).toMatchObject({
    accountId: a.id,
    bindingId: bound.id,
    named: true,
  });
  expect(await attempt("N7", { ...named, accountId: "OTHER" })).toBe("binding_mismatch");
  expect(await attempt("N8", named, "R2")).toBe("binding_mismatch");
  expect(await attempt("N9", named, "R3", "W2")).toBe("foreign_workspace");
  expect(await attempt("N10", { ...named, bindingId: "MISSING" })).toBe("not_found");

  await recordRunnerAccountCapability(sqliteDb(db), "R1", undefined, NOW);
  expect(await attempt("N11")).toBe("runner_unsupported");
  db.close();
});

test("identity stays attached after an account is disabled or removed", async () => {
  const db = fresh();
  const a = await createAgentAccount(sqliteDb(db), {
    workspaceId: "W1",
    agent: "claude",
    label: "A",
    now: NOW,
  });
  const bound = await bindAgentAccount(sqliteDb(db), {
    workspaceId: "W1",
    accountId: a.id,
    runnerId: "R1",
    now: NOW,
  });
  db.run(
    "INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES('R1','0.1.61',?)",
    [NOW],
  );
  await recordRunnerAccountCapability(
    sqliteDb(db),
    "R1",
    { protocol: 1, bindings: [{ bindingId: bound.id, agent: "claude" }] },
    NOW,
  );
  const named = { accountId: a.id, bindingId: bound.id };
  recordCommandAccount(db, probe("BEFORE", "R1", "W1", named), NOW);

  await setAgentAccountEnabled(sqliteDb(db), {
    workspaceId: "W1",
    accountId: a.id,
    enabled: false,
    now: NOW,
  });
  expect(
    await code(async () => recordCommandAccount(db, probe("OFF", "R1", "W1", named), NOW)),
  ).toBe("disabled");
  expect(recordCommandAccount(db, loginCheck("CHECK", "R1", "W1", named), NOW)?.named).toBe(true);

  await removeAgentAccount(sqliteDb(db), { workspaceId: "W1", accountId: a.id, now: NOW + 1 });
  expect(
    await code(async () => recordCommandAccount(db, probe("GONE", "R1", "W1", named), NOW)),
  ).toBe("removed");
  expect((await listAgentBindings(sqliteDb(db), "W1", a.id))[0]?.removedAt).toBe(NOW + 1);
  expect(await commandAccount(sqliteDb(db), "BEFORE")).toMatchObject({
    accountId: a.id,
    bindingId: bound.id,
  });
  expect(() => db.run("DELETE FROM runner_command_account")).toThrow(/retained/);
  expect(
    await code(
      async () =>
        await setAgentAccountEnabled(sqliteDb(db), {
          workspaceId: "W1",
          accountId: a.id,
          enabled: true,
          now: NOW,
        }),
    ),
  ).toBe("removed");
  expect(
    (
      await createAgentAccount(sqliteDb(db), {
        workspaceId: "W1",
        agent: "claude",
        label: "A",
        now: NOW + 2,
      })
    ).label,
  ).toBe("A");

  recordCommandAccount(db, loginCheck("LEGACY_CHECK", "R2", "W1"), NOW);
  await setAgentAccountEnabled(sqliteDb(db), {
    workspaceId: "W1",
    accountId: "legacy_claude_W1",
    enabled: false,
    now: NOW,
  });
  expect(await code(async () => recordCommandAccount(db, probe("LEGACY", "R2", "W1"), NOW))).toBe(
    "disabled",
  );
  expect(
    await code(
      async () =>
        await removeAgentAccount(sqliteDb(db), {
          workspaceId: "W1",
          accountId: "legacy_claude_W1",
          now: NOW,
        }),
    ),
  ).toBe("legacy");
  expect(
    await code(
      async () =>
        await bindAgentAccount(sqliteDb(db), {
          workspaceId: "W1",
          accountId: "legacy_claude_W1",
          runnerId: "R1",
          now: NOW,
        }),
    ),
  ).toBe("legacy");
  db.close();
});

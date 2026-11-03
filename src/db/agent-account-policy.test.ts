import { expect, test } from "bun:test";
import {
  admitAgentAccounts,
  bindAgentAccount,
  createAgentAccount,
  listAgentAccountReferences,
  migrate,
  openDatabase,
  recordCommandAccount,
  recordRunnerAccountCapability,
  removeAgentAccount,
  setAgentAccountEnabled,
} from "./index";

const NOW = 1_800_000_000_000;

function fresh() {
  const db = openDatabase(":memory:");
  migrate(db);
  for (const workspace of ["W1", "W2"]) {
    db.run("INSERT INTO workspace VALUES(?,?,?,?)", [
      workspace,
      `org-${workspace}`,
      workspace,
      NOW,
    ]);
    db.run("INSERT INTO workspace_user(id,linear_user_id,name,email) VALUES(?,?,?,?)", [
      `user-${workspace}`,
      `linear-${workspace}`,
      "Owner",
      `${workspace}@example.test`,
    ]);
    db.run(
      "INSERT INTO workspace_member(workspace_id,user_id,role,source,active,checked_at) VALUES(?,?,'admin','manual',1,?)",
      [workspace, `user-${workspace}`, NOW],
    );
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at) VALUES(?,?,?,?,'active',?)",
      [`R-${workspace}`, workspace, `user-${workspace}`, workspace, NOW],
    );
  }
  return db;
}

test("an unconfigured role admits only the workspace's default sign-in", () => {
  const db = fresh();
  expect(admitAgentAccounts(db, "W1", "claude")).toEqual({
    agent: "claude",
    configured: false,
    eligible: ["legacy_claude_W1"],
    skipped: [],
  });
  db.close();
});

test("admission reads accounts now, so disabling or removing overrides a stale list", () => {
  const db = fresh();
  const a = createAgentAccount(db, { workspaceId: "W1", agent: "claude", label: "A", now: NOW });
  const b = createAgentAccount(db, { workspaceId: "W1", agent: "claude", label: "B", now: NOW });
  const c = createAgentAccount(db, { workspaceId: "W1", agent: "claude", label: "C", now: NOW });
  const codex = createAgentAccount(db, { workspaceId: "W1", agent: "codex", label: "X", now: NOW });
  const foreign = createAgentAccount(db, {
    workspaceId: "W2",
    agent: "claude",
    label: "F",
    now: NOW,
  });
  const policy = {
    agent: "claude",
    accounts: [a.id, foreign.id, codex.id, b.id, "01J0000000000000000000000Z", c.id, a.id],
  };
  expect(admitAgentAccounts(db, "W1", "claude", policy).eligible).toEqual([a.id, b.id, c.id]);
  setAgentAccountEnabled(db, { workspaceId: "W1", accountId: a.id, enabled: false, now: NOW });
  removeAgentAccount(db, { workspaceId: "W1", accountId: c.id, now: NOW });
  expect(admitAgentAccounts(db, "W1", "claude", policy)).toEqual({
    agent: "claude",
    configured: true,
    eligible: [b.id],
    skipped: [
      { accountId: a.id, reason: "disabled" },
      { accountId: foreign.id, reason: "foreign_workspace" },
      { accountId: codex.id, reason: "binding_mismatch" },
      { accountId: "01J0000000000000000000000Z", reason: "not_found" },
      { accountId: c.id, reason: "removed" },
    ],
  });
  setAgentAccountEnabled(db, { workspaceId: "W1", accountId: b.id, enabled: false, now: NOW });
  expect(admitAgentAccounts(db, "W1", "claude", policy).eligible).toEqual([]);
  expect(() => admitAgentAccounts(db, "W1", "codex", policy)).toThrow(/another agent/);
  db.close();
});

test("references list every account and each workspace's default sign-in", () => {
  const db = fresh();
  const a = createAgentAccount(db, { workspaceId: "W1", agent: "claude", label: "A", now: NOW });
  setAgentAccountEnabled(db, { workspaceId: "W1", accountId: a.id, enabled: false, now: NOW });
  const references = listAgentAccountReferences(db);
  expect(references).toContainEqual({ id: a.id, agent: "claude", enabled: false, removed: false });
  expect(references).toContainEqual({
    id: "legacy_codex_W2",
    agent: "codex",
    enabled: true,
    removed: false,
  });
  expect(references).toHaveLength(9);
  db.close();
});

test("a command records the account policy revision it was chosen under", () => {
  const db = fresh();
  db.run("INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES(?,?,?)", [
    "R-W1",
    "99.0.0",
    NOW,
  ]);
  const a = createAgentAccount(db, { workspaceId: "W1", agent: "claude", label: "A", now: NOW });
  const binding = bindAgentAccount(db, {
    workspaceId: "W1",
    accountId: a.id,
    runnerId: "R-W1",
    now: NOW,
  });
  recordRunnerAccountCapability(
    db,
    "R-W1",
    { protocol: 1, bindings: [{ bindingId: binding.id, agent: "claude" }] },
    NOW,
  );
  const recorded = recordCommandAccount(
    db,
    {
      id: "C1",
      runnerId: "R-W1",
      workspaceId: "W1",
      issuedAt: NOW,
      expiresAt: NOW + 60_000,
      type: "login_check",
      agent: "claude",
      account: { accountId: a.id, bindingId: binding.id },
    },
    NOW,
    "0123456789abcdef",
  );
  expect(recorded).toMatchObject({ accountId: a.id, policyRevision: "0123456789abcdef" });
  db.close();
});

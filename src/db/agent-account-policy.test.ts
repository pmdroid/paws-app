import { expect, test } from "bun:test";
import {
  admitAgentAccounts,
  createAgentAccount,
  dispatchAccount,
  insertQueuedItem,
  listAgentAccountReferences,
  migrate,
  openDatabase,
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

test("dispatch admits the eligible accounts in order and refuses a list with none", () => {
  const db = fresh();
  db.run("INSERT INTO linear_session(session_id,organization_id,created_at) VALUES(?,?,?)", [
    "S1",
    "org-W1",
    NOW,
  ]);
  insertQueuedItem(db, { id: "I1", now: NOW, sessionKey: "S1" });
  insertQueuedItem(db, { id: "I2", now: NOW });
  const a = createAgentAccount(db, { workspaceId: "W1", agent: "claude", label: "A", now: NOW });
  const legacy = "legacy_claude_W1";
  const policy = (accounts: string[]) => ({ agent: "claude", accounts });
  expect(dispatchAccount(db, { itemId: "I1" }, "claude", policy([legacy, a.id]))).toMatchObject({
    dispatch: true,
    accountId: legacy,
  });
  expect(dispatchAccount(db, { itemId: "I1" }, "claude", policy([a.id, legacy]))).toMatchObject({
    dispatch: true,
    accountId: a.id,
    admission: { eligible: [a.id, legacy] },
  });
  setAgentAccountEnabled(db, { workspaceId: "W1", accountId: a.id, enabled: false, now: NOW });
  expect(dispatchAccount(db, { itemId: "I1" }, "claude", policy([a.id, legacy]))).toMatchObject({
    dispatch: true,
    accountId: legacy,
    admission: { skipped: [{ accountId: a.id, reason: "disabled" }] },
  });
  expect(dispatchAccount(db, { itemId: "I1" }, "claude", policy([a.id]))).toMatchObject({
    dispatch: false,
    reason: "No configured Claude account is eligible",
  });
  expect(
    dispatchAccount(db, { itemId: "I1" }, "claude", policy(["legacy_claude_W2"])),
  ).toMatchObject({
    dispatch: false,
  });
  expect(dispatchAccount(db, { itemId: "I2" }, "claude", policy([legacy]))).toMatchObject({
    dispatch: false,
    admission: null,
  });
  expect(dispatchAccount(db, { sessionId: "S1" }, "claude", policy([a.id, legacy]))).toMatchObject({
    dispatch: true,
    accountId: legacy,
  });
  expect(dispatchAccount(db, { sessionId: "unknown" }, "claude", policy([legacy]))).toMatchObject({
    dispatch: false,
  });
  db.close();
});

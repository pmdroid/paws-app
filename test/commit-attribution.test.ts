import { afterEach, expect, spyOn, test } from "bun:test";
import {
  beginGitHubAttribution,
  bindLinearSessionTask,
  consumeGitHubAttribution,
  githubAttribution,
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  revokeGitHubAttribution,
  saveGitHubAttribution,
  syncWorkspaceMember,
} from "../src/db";
import { delegatorCommitCredit, issueWorkspaceSession } from "../src/workspace";

const fetchSpy = spyOn(globalThis, "fetch");
afterEach(() => fetchSpy.mockClear());

function fixture() {
  const db = openDatabase(":memory:");
  migrate(db);
  const now = Date.now();
  db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',?)", [now]);
  const bindings = new Map<string, { userId: string; workspaceId: string; sessionHash: string }>();
  for (const [index, id] of ["lead", "steerer"].entries()) {
    putWorkspaceUser(db, { id, linearUserId: id, name: id, email: `${id}@example.invalid` });
    syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId: id,
      role: "member",
      active: true,
      teamIds: ["team"],
      now,
    });
    const session = issueWorkspaceSession(db, { workspaceId: "workspace", userId: id, now });
    const binding = {
      workspaceId: "workspace",
      userId: id,
      sessionHash: session.session.tokenHash,
    };
    bindings.set(id, binding);
    beginGitHubAttribution(db, binding, { stateHash: id, browserHash: id, now });
    const revision = consumeGitHubAttribution(db, binding, { stateHash: id, browserHash: id, now });
    saveGitHubAttribution(
      db,
      binding,
      { id: index + 1, login: id, name: id, email: `${index + 1}+${id}@users.noreply.github.com` },
      revision,
      now,
    );
  }
  const item = insertQueuedItem(db, { id: "item", now, sessionKey: "session" });
  recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: now,
  });
  bindLinearSessionTask(db, "session", item.delegationId, { actorId: "steerer" });
  db.run(
    "INSERT INTO work_item_scheduling(item_id,project_id,project_known,priority,project_lead_id) VALUES(?,?,1,0,'lead')",
    [item.id, "project"],
  );
  return { db, now, item, bindings };
}

test("credit is the delegating member's linked GitHub identity, never the project lead", () => {
  const f = fixture();
  try {
    expect(delegatorCommitCredit(f.db, f.item.id)).toEqual({
      id: 2,
      login: "steerer",
      name: "steerer",
      email: "2+steerer@users.noreply.github.com",
    });
    expect(githubAttribution(f.db, "workspace", "lead")).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    f.db.close();
  }
});

test("a delegator who did not link GitHub gets no credit", () => {
  const f = fixture();
  try {
    revokeGitHubAttribution(f.db, f.bindings.get("steerer")!, f.now);
    expect(delegatorCommitCredit(f.db, f.item.id)).toBeNull();
    f.db.run(
      "INSERT INTO workspace_identity_link(workspace_id,user_id,provider,external_id,installation_id,method,status,checked_at) VALUES('workspace','steerer','github','steerer',NULL,'manual','linked',?)",
      [f.now],
    );
    expect(delegatorCommitCredit(f.db, f.item.id)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    f.db.close();
  }
});

for (const scenario of ["no-actor", "unknown-actor", "inactive", "no-workspace"] as const)
  test(`no credit without a permitted delegating member: ${scenario}`, () => {
    const f = fixture();
    try {
      if (scenario === "no-actor")
        f.db.run("UPDATE work_item SET owner_user_id=NULL, delegated_by=NULL");
      if (scenario === "unknown-actor")
        f.db.run("UPDATE work_item SET owner_user_id=NULL, delegated_by='stranger'");
      if (scenario === "inactive")
        f.db.run("UPDATE workspace_member SET active=0 WHERE user_id='steerer'");
      if (scenario === "no-workspace")
        f.db.run("UPDATE linear_session SET organization_id='other'");
      expect(delegatorCommitCredit(f.db, f.item.id)).toBeNull();
    } finally {
      f.db.close();
    }
  });

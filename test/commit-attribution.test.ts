import { expect, test } from "bun:test";
import {
  beginGitHubAttribution,
  bindLinearSessionTask,
  consumeGitHubAttribution,
  getWorkItem,
  githubAttribution,
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  revokeGitHubAttribution,
  saveGitHubAttribution,
  syncWorkspaceMember,
  type VerifiedGitHubAttribution,
} from "../src/db";
import {
  createLinearAttributionReads,
  createLinearClient,
  type LinearAttributionContext,
} from "../src/linear";
import { createCommitPolicyForItem, issueWorkspaceSession } from "../src/workspace";

function fixture() {
  const db = openDatabase(":memory:");
  migrate(db);
  const now = Date.now();
  db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',?)", [now]);
  const bindings = new Map<string, { userId: string; workspaceId: string; sessionHash: string }>();
  for (const id of ["lead", "steerer"]) {
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
    const identity: VerifiedGitHubAttribution = {
      id: id === "lead" ? 1 : 2,
      login: id,
      name: id,
      email: `${id === "lead" ? 1 : 2}+${id}@users.noreply.github.com`,
    };
    saveGitHubAttribution(db, binding, identity, revision, now);
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
  bindLinearSessionTask(db, "session", item.epicId, { actorId: "steerer" });
  let context: LinearAttributionContext = {
    issueId: item.linearIssueId,
    organizationId: "org",
    teamId: "team",
    projectId: "project",
    leadId: "lead",
  };
  let memberReads = 0;
  let active = true;
  let guest = false;
  let onMember = () => {};
  const policy = createCommitPolicyForItem({
    db,
    now: () => now,
    bot: { appId: "123", id: 3, login: "paws[bot]" },
    clientId: "client",
    tracker: {
      async getIssueAttribution() {
        return context;
      },
    },
    memberships: {
      async installation() {
        return { id: "org", name: "Workspace" };
      },
      async member(organizationId, userId) {
        memberReads++;
        onMember();
        return {
          organizationId,
          userId,
          active,
          guest,
          admin: false,
          teamIds: ["team"],
        };
      },
    },
  });
  return {
    db,
    now,
    item,
    policy,
    bindings,
    set active(value: boolean) {
      active = value;
    },
    set guest(value: boolean) {
      guest = value;
    },
    get memberReads() {
      return memberReads;
    },
    set context(value: LinearAttributionContext) {
      context = value;
    },
    get context() {
      return context;
    },
    set onMember(value: () => void) {
      onMember = value;
    },
  };
}

test("trusted policy provider resolves current Linear lead and actual task actor, not manual usernames", async () => {
  const f = fixture();
  try {
    const policy = await f.policy(f.item);
    expect(policy.projectLead).toEqual(githubAttribution(f.db, "workspace", "lead")!);
    expect(policy.taskSteerer).toEqual(githubAttribution(f.db, "workspace", "steerer")!);
    expect(policy.projectLead.id).not.toBe(policy.taskSteerer.id);
    expect(f.memberReads).toBe(2);
    revokeGitHubAttribution(f.db, f.bindings.get("lead")!, f.now);
    f.db.run(
      "INSERT INTO workspace_identity_link(workspace_id,user_id,provider,external_id,installation_id,method,status,checked_at) VALUES('workspace','lead','github','lead',NULL,'manual','linked',?)",
      [f.now],
    );
    await expect(f.policy(f.item)).rejects.toThrow("verifiedConsent");
  } finally {
    f.db.close();
  }
});

test("same lead and actual steerer returns one verified identity at the policy dedup seam", async () => {
  const f = fixture();
  try {
    f.context = { ...f.context, leadId: "steerer" };
    const policy = await f.policy(f.item);
    expect(policy.projectLead).toBe(policy.taskSteerer);
    expect(f.memberReads).toBe(1);
  } finally {
    f.db.close();
  }
});

for (const failure of [
  "project",
  "projectLead",
  "taskSteerer",
  "outsider",
  "team",
  "revoked",
  "changed-actor",
  "changed-item",
  "stale-inactive",
  "stale-guest",
] as const) {
  test(`policy refuses missing or changed ${failure}`, async () => {
    const f = fixture();
    try {
      if (failure === "stale-inactive" || failure === "stale-guest") {
        f.db.run("UPDATE workspace_member SET checked_at=?", [f.now + 1]);
        if (failure === "stale-inactive") f.active = false;
        else f.guest = true;
      }
      if (failure === "project") f.context = { ...f.context, projectId: null, leadId: null };
      if (failure === "projectLead") f.context = { ...f.context, leadId: null };
      if (failure === "taskSteerer") f.db.run("UPDATE linear_session_task SET owner_actor_id=NULL");
      if (failure === "outsider") f.context = { ...f.context, leadId: "unknown" };
      if (failure === "team") f.db.run("UPDATE linear_session SET team_id='other'");
      if (failure === "revoked")
        f.onMember = () => {
          f.db.run("UPDATE workspace_member SET active=0,checked_at=? WHERE user_id='lead'", [
            f.now + 1,
          ]);
        };
      if (failure === "changed-actor")
        f.onMember = () => {
          f.db.run("UPDATE linear_session_task SET owner_actor_id='lead'");
        };
      if (failure === "changed-item")
        f.onMember = () => {
          f.db.run("UPDATE work_item SET version=version+1 WHERE id=?", [f.item.id]);
        };
      await expect(f.policy(f.item)).rejects.toThrow();
      expect(getWorkItem(f.db, f.item.id)).not.toBeNull();
    } finally {
      f.db.close();
    }
  });
}

test("production Linear client reads canonical issue project lead across real HTTP and explicitly preserves absent roles", async () => {
  let project: unknown = { id: "project", lead: { id: "lead", app: false, active: true } };
  const queries: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { query: string; variables: { id: string } };
      expect(body.variables.id).toBe("issue");
      queries.push(body.query);
      return Response.json({
        data: {
          viewer: { app: true, organization: { id: "org" } },
          issue: { id: "issue", team: { id: "team" }, project },
        },
      });
    },
  });
  const client = createLinearClient({
    auth: {
      async ensureFresh() {
        return "fixture-linear";
      },
      async forceRefresh() {
        return "fixture-linear";
      },
      hasToken() {
        return true;
      },
    },
    fetch: (_input, init) => fetch(`http://127.0.0.1:${server.port}`, init),
  });
  const reads = createLinearAttributionReads(client);
  try {
    expect(await reads.getIssueAttribution("issue")).toEqual({
      issueId: "issue",
      organizationId: "org",
      teamId: "team",
      projectId: "project",
      leadId: "lead",
    });
    project = { id: "project", lead: null };
    expect((await reads.getIssueAttribution("issue")).leadId).toBeNull();
    project = null;
    expect((await reads.getIssueAttribution("issue")).projectId).toBeNull();
    project = { id: "project", lead: { id: "app", app: true, active: true } };
    await expect(reads.getIssueAttribution("issue")).rejects.toThrow("human");
    project = { id: "project" };
    await expect(reads.getIssueAttribution("issue")).rejects.toThrow();
    expect(queries.every((query) => query.includes("project { id lead { id app active } }"))).toBe(
      true,
    );
  } finally {
    await server.stop(true);
  }
});

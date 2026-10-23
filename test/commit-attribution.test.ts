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
import {
  IssueAttributionCache,
  createCommitPolicyForItem,
  issueWorkspaceSession,
} from "../src/workspace";

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
  bindLinearSessionTask(db, "session", item.delegationId, { actorId: "steerer" });
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
    expect(policy.projectLead!.id).not.toBe(policy.taskSteerer!.id);
    expect(f.memberReads).toBe(2);
    revokeGitHubAttribution(f.db, f.bindings.get("lead")!, f.now);
    f.db.run(
      "INSERT INTO workspace_identity_link(workspace_id,user_id,provider,external_id,installation_id,method,status,checked_at) VALUES('workspace','lead','github','lead',NULL,'manual','linked',?)",
      [f.now],
    );
    expect((await f.policy(f.item)).projectLead).toBeNull();
  } finally {
    f.db.close();
  }
});

test("App work proceeds without personal GitHub consent", async () => {
  const f = fixture();
  try {
    for (const binding of f.bindings.values()) revokeGitHubAttribution(f.db, binding, f.now);
    expect(await f.policy(f.item)).toEqual({
      bot: { appId: "123", id: 3, login: "paws[bot]" },
      projectLead: null,
      taskSteerer: null,
    });
    expect(f.memberReads).toBe(1);
  } finally {
    f.db.close();
  }
});

test.each([null, "unknown"])(
  "project lead %s does not require a Paws account or credit",
  async (leadId) => {
    const f = fixture();
    try {
      f.context = { ...f.context, leadId };
      const policy = await f.policy(f.item);
      expect(policy.projectLead).toBeNull();
      expect(policy.taskSteerer).not.toBeNull();
      expect(f.memberReads).toBe(1);
    } finally {
      f.db.close();
    }
  },
);

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

test("standalone issues include task steerer credit only while consented", async () => {
  const f = fixture();
  try {
    f.context = { ...f.context, projectId: null, leadId: null };
    revokeGitHubAttribution(f.db, f.bindings.get("lead")!, f.now);
    const policy = await f.policy(f.item);
    expect(policy.projectLead).toBeNull();
    expect(policy.taskSteerer).toEqual(githubAttribution(f.db, "workspace", "steerer")!);
    expect(f.memberReads).toBe(1);
    revokeGitHubAttribution(f.db, f.bindings.get("steerer")!, f.now);
    expect((await f.policy(f.item)).taskSteerer).toBeNull();
  } finally {
    f.db.close();
  }
});

for (const failure of [
  "actor",
  "observer",
  "inactive",
  "guest",
  "team",
  "changed-actor",
] as const) {
  test(`standalone attribution refuses missing or unauthorized ${failure}`, async () => {
    const f = fixture();
    try {
      f.context = { ...f.context, projectId: null, leadId: null };
      if (failure === "actor")
        f.db.run("UPDATE work_item SET owner_user_id=NULL, delegated_by=NULL");
      if (failure === "observer")
        f.db.run("UPDATE workspace_member SET role='observer' WHERE user_id='steerer'");
      if (failure === "inactive") f.active = false;
      if (failure === "guest") f.guest = true;
      if (failure === "team") f.db.run("UPDATE linear_session SET team_id='other'");
      if (failure === "changed-actor")
        f.onMember = () => {
          f.db.run("UPDATE work_item SET owner_user_id='lead'");
        };
      await expect(f.policy(f.item)).rejects.toThrow();
    } finally {
      f.db.close();
    }
  });
}

for (const failure of [
  "taskSteerer",
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
      if (failure === "taskSteerer")
        f.db.run("UPDATE work_item SET owner_user_id=NULL, delegated_by=NULL");
      if (failure === "team") f.db.run("UPDATE linear_session SET team_id='other'");
      if (failure === "revoked")
        f.onMember = () => {
          f.db.run("UPDATE workspace_member SET active=0,checked_at=? WHERE user_id='lead'", [
            f.now + 1,
          ]);
        };
      if (failure === "changed-actor")
        f.onMember = () => {
          f.db.run("UPDATE work_item SET owner_user_id='lead'");
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

test("issue attribution is read once per task across its runs until the issue changes", async () => {
  const reads: string[] = [];
  let failing = false;
  const cache = new IssueAttributionCache({
    async getIssueAttribution(issueId) {
      reads.push(issueId);
      if (failing) throw new Error("Scripted Linear outage");
      return { issueId, organizationId: "org", teamId: "team", projectId: null, leadId: null };
    },
  });
  const run = (runId: string | null) => cache.tracker({ currentRunId: runId });
  for (let i = 0; i < 10; i++) await run("run-1").getIssueAttribution("issue");
  expect(reads).toEqual(["issue"]);
  await run("run-2").getIssueAttribution("issue");
  expect(reads).toHaveLength(1);
  cache.invalidate("another-issue");
  await run("run-2").getIssueAttribution("issue");
  expect(reads).toHaveLength(1);
  cache.invalidate("issue");
  await run("run-2").getIssueAttribution("issue");
  expect(reads).toHaveLength(2);
  cache.invalidate();
  failing = true;
  await expect(run("run-2").getIssueAttribution("issue")).rejects.toThrow("outage");
  failing = false;
  await run("run-2").getIssueAttribution("issue");
  await run("run-3").getIssueAttribution("issue");
  expect(reads).toHaveLength(4);
  cache.invalidate();
  await run(null).getIssueAttribution("issue");
  await run(null).getIssueAttribution("issue");
  expect(reads).toHaveLength(6);
});

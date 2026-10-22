import "../quiet-journal";
import assert from "node:assert/strict";
import { CommandBus, FakeClock } from "../../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  ensureLinearSession,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  syncWorkspaceMember,
} from "../../src/db";
import {
  createFakeTracker,
  type AcceptedLinearEvent,
  type LinearProjectSnapshot,
} from "../../src/linear";
import { Orchestrator } from "../../src/loop";
import { createApprovedProjects } from "../../src/project-execution";

export function createProjectFixture(filename = ":memory:") {
  const db = openDatabase(filename);
  migrate(db);
  const clock = new FakeClock(Date.now());
  if (!db.query("SELECT 1 FROM workspace WHERE id='workspace'").get()) {
    db.run(
      "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('workspace','org','Workspace',0)",
    );
    for (const id of ["actor", "lead"]) {
      putWorkspaceUser(db, { id, linearUserId: id, name: id, email: `${id}@example.test` });
      syncWorkspaceMember(db, {
        workspaceId: "workspace",
        userId: id,
        role: "member",
        active: true,
        teamIds: ["team"],
        now: clock.now(),
      });
    }
    db.run(
      "INSERT INTO workspace_repository(workspace_id,repository,team_id) VALUES('workspace','owner/repo','team')",
    );
  }
  const project: LinearProjectSnapshot = {
    id: "project",
    name: "Project",
    organizationId: "org",
    updatedAt: "2026-10-14T00:00:00Z",
    leadId: "lead",
    issues: ["one", "two", "unapproved"].map((linearIssueId) => ({
      linearIssueId,
      identifier: linearIssueId,
      title: linearIssueId,
      description: "Implement requirements.",
      teamId: "team",
      projectId: "project",
      parentId: null,
      updatedAt: "2026-10-14T00:00:00Z",
      stateType: "unstarted",
    })),
  };
  const tracker = Object.assign(
    createFakeTracker(
      project.issues.map((issue) => ({
        ...issue,
        description: issue.description!,
        subIssues: issue.linearIssueId === "one" ? [project.issues[2]!] : [],
      })),
    ),
    { loadProject: async () => project },
  );
  tracker.deps.set("two", [{ blockerLinearIssueId: "one", blockedLinearIssueId: "two" }]);
  const jobs = new JobLoop(db, clock);
  let orchestrator: Orchestrator;
  const started: string[] = [];
  const intake = { delayed: false };
  const projects = createApprovedProjects({
    db,
    tracker,
    now: () => clock.now(),
    bus: new CommandBus(),
    getPort: () => orchestrator,
    origin: "https://paws.example.test",
    repository: () => ({
      owner: "owner",
      repo: "repo",
      remoteUrl: "https://example.test/owner/repo",
    }),
    saveBlockerPolicies: () => {},
    async resumeSession(sessionId) {
      if (intake.delayed) throw new Error("Intake is temporarily unavailable");
      const issueId = sessionId.slice("session-".length);
      await orchestrator.intakeLinearTask(issueId, sessionId, `task-${issueId}`);
    },
    memberships: {
      installation: async () => ({ id: "org", name: "Workspace" }),
      member: async (organizationId, userId) => ({
        organizationId,
        userId,
        active: true,
        guest: false,
        admin: false,
        teamIds: ["team"],
      }),
    },
    async startSession(target, _url, _signal, accept) {
      const sessionId = `session-${target.id}`;
      const event: AcceptedLinearEvent = {
        action: "created",
        sessionId,
        issueId: target.id,
        dedupeKey: sessionId,
        deliveryId: null,
        source: "poll",
        activityId: null,
        body: null,
        signal: null,
        updatedAtMs: clock.now(),
        payload: "{}",
      };
      accept!(event);
      ensureLinearSession(db, { sessionId, issueId: target.id, creatorId: "app" });
      recordLinearInstallation(db, {
        sessionId,
        organizationId: "org",
        teamId: "team",
        oauthClientId: "client",
        appUserId: "app",
        observedAtMs: clock.now(),
      });
      assert.equal(await projects.authorizeEvent(event), true);
      if (!intake.delayed)
        await orchestrator.intakeLinearTask(target.id, sessionId, `task-${target.id}`);
      started.push(target.id);
      return { id: sessionId, url: null };
    },
  });
  orchestrator = new Orchestrator({
    db,
    clock,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    pawsRoot: "/nonexistent-project-proof",
    tracker,
    dispatchReady() {},
    authorizeLinearIntake: projects.authorizeIntake,
    linearIntakeScope: projects.scope,
    linearIntakeActor: projects.actor,
    onLinearIntake: projects.accepted,
    adoptLinearParent: projects.adoptParent,
  });
  const actor = { workspaceId: "workspace", userId: "actor" };
  const selection = {
    projectId: "project",
    issueIds: ["one", "two"],
    repository: "owner/repo",
    targetBranch: "main",
    leadUserId: "lead",
    steeringRoles: ["member"] as const,
  };
  return {
    db,
    clock,
    projects,
    orchestrator,
    jobs,
    actor,
    selection,
    started,
    intake,
    tracker,
    async close() {
      await orchestrator.shutdown();
      db.close();
    },
  };
}

import "../quiet-journal";
import assert from "node:assert/strict";
import { FakeClock } from "../../src/core";
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
  type LinearIssueOwnership,
} from "../../src/linear";
import { createParentDelegations } from "../../src/intake";
import { Orchestrator } from "../../src/loop";

/** A workspace, a fake Linear tracker and an orchestrator that adopts delegated parents. */
export function createParentFixture(
  filename = ":memory:",
  { authorizeEvents = false, startSessions = true } = {},
) {
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
  const tracker = createFakeTracker([]);
  /** Issues outside the delegation, read when a parent summary names its blockers. */
  const issues = new Map<string, LinearIssueOwnership>();
  const jobs = new JobLoop(db, clock);
  let orchestrator: Orchestrator;
  const started: string[] = [];
  const intake = { delayed: false };
  const parents = createParentDelegations({
    db,
    tracker,
    lifecycle: {
      inspect: async (id) =>
        issues.get(id) ?? {
          id,
          identifier: id,
          teamId: "team",
          assigneeId: null,
          delegateId: null,
          stateType: "unstarted",
        },
    },
    now: () => clock.now(),
    origin: "https://paws.example.test",
    async resumeSession(sessionId) {
      if (intake.delayed) throw new Error("Intake is temporarily unavailable");
      const issueId = sessionId.slice("session-".length);
      await orchestrator.intakeLinearTask(issueId, sessionId, `task-${issueId}`);
    },
    ...(startSessions ? { startSession } : {}),
  });
  async function startSession(
    target: { kind: "issue" | "comment"; id: string },
    _url: string,
    _signal?: AbortSignal,
    accept?: (event: AcceptedLinearEvent) => void,
  ) {
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
    assert.deepEqual(await parents.authorizeEvent(event), { outcome: "accepted" });
    if (!intake.delayed)
      await orchestrator.intakeLinearTask(target.id, sessionId, `task-${target.id}`);
    started.push(target.id);
    return { id: sessionId, url: null };
  }
  const outbox = new OutboxDispatcher(db, clock);
  orchestrator = new Orchestrator({
    db,
    clock,
    jobs: new JobLoop(db, clock),
    outbox,
    pawsRoot: "/nonexistent-project-proof",
    tracker,
    scheduling: () => ({}),
    authorizeLinearIntake: parents.authorizeIntake,
    linearIntakeScope: parents.scope,
    linearIntakeActor: parents.actor,
    onLinearIntake: parents.accepted,
    adoptLinearParent: parents.adoptParent,
    ...(authorizeEvents
      ? {
          authorizeLinearEvent: async (event: AcceptedLinearEvent) =>
            (await parents.authorizeEvent(event)) ?? { outcome: "accepted" as const },
        }
      : {}),
  });
  return {
    db,
    clock,
    parents,
    orchestrator,
    jobs,
    started,
    intake,
    tracker,
    issues,
    outbox,
    async close() {
      await orchestrator.shutdown();
      db.close();
    },
  };
}

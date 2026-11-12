import "../quiet-journal";
import { eq } from "drizzle-orm";
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
  sqliteDb,
  type Db,
} from "../../src/db";
import {
  createFakeTracker,
  type AcceptedLinearEvent,
  type LinearIssueOwnership,
} from "../../src/linear";
import { createParentDelegations } from "../../src/intake";
import { Orchestrator } from "../../src/loop";
import { seed } from "../dialects";
import { tempStore } from "../pglite";

type ParentFixtureOptions = { authorizeEvents?: boolean; startSessions?: boolean };

/** A workspace, a fake Linear tracker and an orchestrator that adopts delegated parents. */
export async function createParentFixture(
  filename = ":memory:",
  options: ParentFixtureOptions = {},
) {
  const db = openDatabase(filename);
  migrate(db);
  return { db, ...(await parentFixture(sqliteDb(db), options, async () => db.close())) };
}

export async function createParentFixturePg(options: ParentFixtureOptions = {}) {
  const { db, close } = await tempStore();
  return { db, ...(await parentFixture(db, options, close)) };
}

async function parentFixture(
  db: Db,
  { authorizeEvents = false, startSessions = true }: ParentFixtureOptions,
  closeDb: () => Promise<void>,
) {
  const clock = new FakeClock(Date.now());
  const existing = await db.run((q) =>
    q.one(
      q.orm
        .select({ id: q.t.workspace.id })
        .from(q.t.workspace)
        .where(eq(q.t.workspace.id, "workspace")),
    ),
  );
  if (!existing) {
    await seed(db, (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: "workspace", linearOrganizationId: "org", name: "Workspace", createdAt: 0 }),
    );
    for (const id of ["actor", "lead"]) {
      await putWorkspaceUser(db, {
        id,
        linearUserId: id,
        name: id,
        email: `${id}@example.test`,
      });
      await syncWorkspaceMember(db, {
        workspaceId: "workspace",
        userId: id,
        role: "member",
        active: true,
        teamIds: ["team"],
        now: clock.now(),
      });
    }
    await seed(db, (q) =>
      q.orm
        .insert(q.t.workspaceRepository)
        .values({ workspaceId: "workspace", repository: "owner/repo", teamId: "team" }),
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
    store: db,
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
    accept?: (event: AcceptedLinearEvent) => Promise<void>,
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
    await accept!(event);
    await ensureLinearSession(db, { sessionId, issueId: target.id, creatorId: "app" });
    await recordLinearInstallation(db, {
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
    store: db,
    clock,
    jobs: new JobLoop(db, clock),
    outbox,
    pawsRoot: "/nonexistent-project-proof",
    tracker,
    scheduling: async () => ({}),
    authorizeLinearIntake: parents.authorizeIntakeSteps,
    linearIntakeScope: parents.scopeSteps,
    linearIntakeActor: parents.actorSteps,
    onLinearIntake: parents.acceptedSteps,
    adoptLinearParent: parents.adoptParentSteps,
    ...(authorizeEvents
      ? {
          authorizeLinearEvent: async (event: AcceptedLinearEvent) =>
            (await parents.authorizeEvent(event)) ?? { outcome: "accepted" as const },
        }
      : {}),
  });
  return {
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
      await closeDb();
    },
  };
}

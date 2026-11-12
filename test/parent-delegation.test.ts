import { confirmFakeMergePg } from "./fake-workspace";
import { expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { ensureLinearSession, listJobs, listOutbox } from "../src/db";
import type { EpicSnapshot } from "../src/linear";
import { json, seed } from "./dialects";
import { createParentFixturePg } from "./local/parent-fixture";

type Fixture = Awaited<ReturnType<typeof createParentFixturePg>>;
type Store = Fixture["db"];

const parent: EpicSnapshot = {
  linearIssueId: "parent",
  identifier: "PAR-1",
  title: "Parent feature",
  description: "Parent body",
  teamId: "team",
  subIssues: [
    {
      linearIssueId: "child-a",
      identifier: "PAR-2",
      title: "First child",
      description: "Do the first part",
      teamId: "team",
      projectId: "linear-project",
    },
    {
      linearIssueId: "child-b",
      identifier: "PAR-3",
      title: "Second child",
      description: "Do the second part",
    },
  ],
};

async function responses(db: Store, orderingKey?: string): Promise<string[]> {
  return (await listOutbox(db, orderingKey))
    .map((row) => row.payload as { kind?: string; body?: string })
    .filter((payload) => payload.kind === "response")
    .map((payload) => payload.body ?? "");
}

const parentResponses = (db: Store) => responses(db, "parent-session");

function workItems(db: Store) {
  return db.run((q) =>
    q.all(
      q.orm
        .select({
          id: q.t.workItem.id,
          linearIssueId: q.t.workItem.linearIssueId,
          ownerUserId: q.t.workItem.ownerUserId,
          delegationId: q.t.workItem.delegationId,
        })
        .from(q.t.workItem)
        .orderBy(asc(q.t.workItem.linearIssueId)),
    ),
  );
}

function parentDelegations(db: Store) {
  return db.run((q) => q.all(q.orm.select().from(q.t.parentDelegation)));
}

function delegatedIssues(db: Store) {
  return db.run((q) =>
    q.all(
      q.orm
        .select()
        .from(q.t.parentDelegationIssue)
        .orderBy(asc(q.t.parentDelegationIssue.position)),
    ),
  );
}

const delegationIds = async (db: Store) =>
  (await parentDelegations(db)).map((row) => row.delegationId);

function publish(tracker: Fixture["tracker"], snapshot: EpicSnapshot) {
  tracker.epics.set(snapshot.linearIssueId, snapshot);
  for (const issue of snapshot.subIssues) {
    tracker.epics.set(issue.linearIssueId, {
      linearIssueId: issue.linearIssueId,
      identifier: issue.identifier,
      title: `${issue.title} live`,
      description: "Live description",
      teamId: "other-team",
      projectId: "other-project",
      subIssues: [{ linearIssueId: "nested", identifier: "NEST", title: "Nested" }],
    });
  }
}

test("a delegated parent records its sub-issues and each sub-issue runs alone in its own session", async () => {
  const fixture = await createParentFixturePg();
  const { db, parents, orchestrator, jobs, tracker, started } = fixture;
  try {
    publish(tracker, parent);
    tracker.deps.set("child-a", [
      { blockerLinearIssueId: "outside", blockedLinearIssueId: "child-a" },
    ]);
    tracker.deps.set("child-b", [
      { blockerLinearIssueId: "child-a", blockedLinearIssueId: "child-b" },
    ]);
    await ensureLinearSession(db, {
      sessionId: "parent-session",
      issueId: "parent",
      organizationId: "org",
      creatorId: "lead",
      now: fixture.clock.now(),
    });
    const admitted = await orchestrator.intakeLinearTask("parent", "parent-session", "parent-task");
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.alreadyExisted).toBe(false);
    expect(admitted.items).toEqual([]);
    expect(admitted.delegation.state).toBe("done");
    expect(
      (await workItems(db)).filter((item) => item.delegationId === admitted.delegation.id),
    ).toHaveLength(0);
    const [adopted] = await parentDelegations(db);
    expect(adopted).toMatchObject({
      delegationId: admitted.delegation.id,
      workspaceId: "workspace",
      organizationId: "org",
      parentIssueId: "parent",
      parentIdentifier: "PAR-1",
      title: "Parent feature",
      sessionId: "parent-session",
      ownerUserId: "lead",
      stoppedAt: null,
    });
    expect(admitted.delegation).toMatchObject({
      linearIdentifier: "PAR-1",
      title: "Parent feature",
    });
    expect(adopted!.edges).toEqual([
      { blockerLinearIssueId: "child-a", blockedLinearIssueId: "child-b" },
    ]);
    expect(
      (await delegatedIssues(db)).map(({ issueId, identifier, position }) => ({
        issueId,
        identifier,
        position,
      })),
    ).toEqual([
      { issueId: "child-a", identifier: "PAR-2", position: 0 },
      { issueId: "child-b", identifier: "PAR-3", position: 1 },
    ]);
    expect(
      await db.run((q) =>
        q.all(
          q.orm
            .select({
              action: q.t.workspaceAccessAudit.action,
              userId: q.t.workspaceAccessAudit.userId,
            })
            .from(q.t.workspaceAccessAudit)
            .where(eq(q.t.workspaceAccessAudit.action, "parent.delegated")),
        ),
      ),
    ).toEqual([{ action: "parent.delegated", userId: "lead" }]);
    expect(tracker.progress.filter((update) => update.sessionId === "parent-session")).toEqual([]);
    const replay = await orchestrator.intakeLinearTask("parent", "parent-session", "parent-task");
    expect(replay.ok && replay.alreadyExisted).toBe(true);
    if (!replay.ok) return;
    expect(replay.items).toEqual([]);
    expect(replay.delegation.id).toBe(admitted.delegation.id);
    expect(tracker.progress.filter((update) => update.sessionId === "parent-session")).toEqual([]);

    await parents.register(jobs);
    await jobs.tick();
    expect(started).toEqual(["child-a"]);
    expect(
      (await parents.progress(admitted.delegation.id)).find((sub) => sub.issueId === "child-b"),
    ).toMatchObject({ sessionId: null, waitingFor: ["PAR-2"] });
    const merged = (await workItems(db)).find((item) => item.linearIssueId === "child-a")!;
    await confirmFakeMergePg(db, merged.id);
    await seed(db, (q) =>
      q.orm.update(q.t.workItem).set({ state: "merged" }).where(eq(q.t.workItem.id, merged.id)),
    );
    fixture.clock.advance(30_000);
    await jobs.tick();
    expect(started).toEqual(["child-a", "child-b"]);
    const items = await workItems(db);
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.linearIssueId)).toEqual(["child-a", "child-b"]);
    for (const item of items) {
      expect(item.ownerUserId).toBe("lead");
      expect(item.delegationId).not.toBe(admitted.delegation.id);
      expect(items.filter((other) => other.delegationId === item.delegationId)).toHaveLength(1);
    }
    expect(
      (await delegatedIssues(db)).map(({ issueId, delegationId, sessionId }) => ({
        issueId,
        delegationId,
        sessionId,
      })),
    ).toEqual(
      items.map((item) => ({
        issueId: item.linearIssueId,
        delegationId: item.delegationId,
        sessionId: `session-${item.linearIssueId}`,
      })),
    );
    expect(await db.run((q) => parents.actorSteps(q, "session-child-a"))).toBe("lead");
    const live = await tracker.loadEpic("child-a");
    expect(
      await parents.scopeSnapshot("session-child-a", {
        ...live,
        title: "Renamed",
        description: "Rewritten",
      }),
    ).toMatchObject({ linearIssueId: "child-a", title: "Renamed", subIssues: [] });
    expect((await parents.scopeSnapshot("session-child-a", live)).subIssues).toEqual([]);
    // Another session cannot take a sub-issue that already runs under the parent.
    await expect(parents.scopeSnapshot("parent-session", live)).rejects.toThrow(
      "This issue already runs as a sub-issue of a delegated parent.",
    );
  } finally {
    await fixture.close();
  }
});

test("a cycle between sub-issues reports the cycle and adopts nothing", async () => {
  const fixture = await createParentFixturePg();
  try {
    const snapshot: EpicSnapshot = {
      linearIssueId: "cycle-parent",
      identifier: "CYC-1",
      title: "Cyclic parent",
      description: null,
      teamId: "team",
      subIssues: [
        { linearIssueId: "c1", identifier: "CYC-2", title: "Left", teamId: "team" },
        { linearIssueId: "c2", identifier: "CYC-3", title: "Right", teamId: "team" },
      ],
    };
    publish(fixture.tracker, snapshot);
    fixture.tracker.deps.set("c1", [
      { blockerLinearIssueId: "c1", blockedLinearIssueId: "c2" },
      { blockerLinearIssueId: "c2", blockedLinearIssueId: "c1" },
    ]);
    await ensureLinearSession(fixture.db, {
      sessionId: "cycle-session",
      issueId: "cycle-parent",
      organizationId: "org",
      creatorId: "lead",
      now: fixture.clock.now(),
    });
    const result = await fixture.orchestrator.intakeLinearTask(
      "cycle-parent",
      "cycle-session",
      "cycle-task",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("cycle");
    expect(result.identifiers).toEqual(["CYC-2", "CYC-3"]);
    expect(result.delegation.state).toBe("stalled");
    expect(await workItems(fixture.db)).toHaveLength(0);
    expect(await parentDelegations(fixture.db)).toHaveLength(0);
    expect(fixture.tracker.progress[0]).toMatchObject({
      sessionId: "cycle-session",
      kind: "error",
      body: "Cycle in blocks relations (CYC-2 → CYC-3). Nothing will run.",
    });
  } finally {
    await fixture.close();
  }
});

test("a reserved sub-issue keeps the multi-item delegation", async () => {
  const fixture = await createParentFixturePg();
  try {
    publish(fixture.tracker, parent);
    await seed(
      fixture.db,
      (q) =>
        q.orm.insert(q.t.parentDelegation).values({
          delegationId: "existing",
          workspaceId: "workspace",
          organizationId: "org",
          parentIssueId: "other",
          parentIdentifier: "OTH-1",
          title: "Other parent",
          sessionId: "other-session",
          ownerUserId: "lead",
          edges: json(fixture.db, []) as string,
          createdAt: 0,
        }),
      (q) =>
        q.orm.insert(q.t.parentDelegationIssue).values({
          parentDelegationId: "existing",
          workspaceId: "workspace",
          issueId: "child-a",
          identifier: "PAR-2",
          title: "First child",
          position: 0,
        }),
    );
    await ensureLinearSession(fixture.db, {
      sessionId: "parent-session",
      issueId: "parent",
      organizationId: "org",
      creatorId: "lead",
      now: fixture.clock.now(),
    });
    const result = await fixture.orchestrator.intakeLinearTask(
      "parent",
      "parent-session",
      "parent-task",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.delegation.state).toBe("running");
    expect(result.items.map((item) => item.linearIdentifier)).toEqual(["PAR-2", "PAR-3"]);
    expect(await delegationIds(fixture.db)).toEqual(["existing"]);
    expect(fixture.tracker.progress.map((update) => update.body)).toEqual([
      "Picked up 2 sub-issues; order: PAR-2 → PAR-3",
    ]);
  } finally {
    await fixture.close();
  }
});

test("a follow-up on an adopted parent session does not queue its sub-issues again", async () => {
  const fixture = await createParentFixturePg();
  try {
    publish(fixture.tracker, parent);
    await ensureLinearSession(fixture.db, {
      sessionId: "parent-session",
      issueId: "parent",
      organizationId: "org",
      creatorId: "lead",
      now: fixture.clock.now(),
    });
    await fixture.orchestrator.intakeLinearTask("parent", "parent-session", "parent-task");
    const followup = await fixture.orchestrator.intakeLinearTask(
      "parent",
      "parent-session",
      "parent-followup",
    );
    expect(followup.ok).toBe(true);
    if (!followup.ok) return;
    expect(followup.items).toEqual([]);
    expect(await workItems(fixture.db)).toEqual([]);
    expect(await parentDelegations(fixture.db)).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test("stopping the parent session stops its adoption so the parent can be delegated again", async () => {
  const fixture = await createParentFixturePg();
  try {
    publish(fixture.tracker, parent);
    await ensureLinearSession(fixture.db, {
      sessionId: "parent-session",
      issueId: "parent",
      organizationId: "org",
      creatorId: "lead",
      now: fixture.clock.now(),
    });
    await fixture.orchestrator.intakeLinearTask("parent", "parent-session", "parent-task");
    await fixture.orchestrator.onLinearEvent({
      dedupeKey: "activity:parent-stop",
      deliveryId: null,
      source: "webhook",
      action: "prompted",
      sessionId: "parent-session",
      issueId: "parent",
      activityId: "parent-stop",
      body: null,
      signal: "stop",
      updatedAtMs: fixture.clock.now(),
      payload: "{}",
    });
    expect((await parentDelegations(fixture.db))[0]?.stoppedAt).not.toBeNull();
    expect(
      (await delegatedIssues(fixture.db)).filter((issue) => issue.releasedAt === null),
    ).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

test("a message on an adopted parent session is answered instead of failing intake", async () => {
  const fixture = await createParentFixturePg();
  try {
    publish(fixture.tracker, parent);
    await ensureLinearSession(fixture.db, {
      sessionId: "parent-session",
      issueId: "parent",
      organizationId: "org",
      creatorId: "lead",
      now: fixture.clock.now(),
    });
    await fixture.orchestrator.intakeLinearTask("parent", "parent-session", "parent-task");
    await fixture.orchestrator.onLinearEvent({
      dedupeKey: "activity:parent-message",
      deliveryId: null,
      source: "webhook",
      action: "prompted",
      sessionId: "parent-session",
      issueId: "parent",
      activityId: "parent-message",
      body: "How is it going?",
      signal: null,
      updatedAtMs: fixture.clock.now(),
      payload: "{}",
    });
    for (let i = 0; i < 20; i++) await fixture.jobs.tick();
    expect(await workItems(fixture.db)).toEqual([]);
    expect(
      (await listJobs(fixture.db)).filter(
        (job) =>
          ["pending", "running", "dead"].includes(job.status) && job.queue !== "scheduler.tick",
      ),
    ).toEqual([]);
    expect(
      (await responses(fixture.db)).some((body) =>
        body.startsWith("Each sub-issue runs in its own session."),
      ),
    ).toBe(true);
  } finally {
    await fixture.close();
  }
});

test("a sub-issue already managed in another session is rejected", async () => {
  const fixture = await createParentFixturePg();
  try {
    publish(fixture.tracker, parent);
    await ensureLinearSession(fixture.db, {
      sessionId: "child-session",
      issueId: "child-a",
      organizationId: "org",
      creatorId: "lead",
      now: fixture.clock.now(),
    });
    await seed(fixture.db, (q) =>
      q.orm.insert(q.t.workItem).values({
        id: "other-item",
        delegationId: "other-epic",
        linearIssueId: "child-a",
        linearIdentifier: "PAR-2",
        title: "Child A",
        state: "running",
        branchName: "paws/par-2",
        position: 0,
        createdAt: 0,
        sessionKey: "child-session",
      }),
    );
    await ensureLinearSession(fixture.db, {
      sessionId: "parent-session",
      issueId: "parent",
      organizationId: "org",
      creatorId: "lead",
      now: fixture.clock.now(),
    });
    await expect(
      fixture.orchestrator.intakeLinearTask("parent", "parent-session", "parent-task"),
    ).rejects.toThrow(
      "PAR-2 has an unfinished attempt in another Paws session. Reply in that session to continue, or stop it before starting a new one.",
    );
    expect((await workItems(fixture.db)).map((item) => item.id)).toEqual(["other-item"]);
    expect(await parentDelegations(fixture.db)).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("without Linear session starts a delegated parent runs its sub-issues in its own session", async () => {
  const fixture = await createParentFixturePg({ startSessions: false });
  try {
    publish(fixture.tracker, parent);
    await ensureLinearSession(fixture.db, {
      sessionId: "parent-session",
      issueId: "parent",
      organizationId: "org",
      creatorId: "lead",
      now: fixture.clock.now(),
    });
    expect(
      await fixture.db.transaction((q) =>
        fixture.parents.adoptParentSteps(q, "parent-session", parent, []),
      ),
    ).toBe(false);
    const result = await fixture.orchestrator.intakeLinearTask(
      "parent",
      "parent-session",
      "parent-task",
    );
    expect(result.ok && result.items.map((item) => item.linearIdentifier)).toEqual([
      "PAR-2",
      "PAR-3",
    ]);
    expect(await parentDelegations(fixture.db)).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("a delegated parent leaves its finished sub-issues out and still starts the issues they block", async () => {
  const fixture = await createParentFixturePg();
  const { db, parents, orchestrator, jobs, tracker, started, issues } = fixture;
  try {
    issues.set("child-a", {
      id: "child-a",
      identifier: "PAR-2",
      teamId: "team",
      assigneeId: null,
      delegateId: null,
      stateType: "completed",
    });
    publish(tracker, {
      ...parent,
      subIssues: [
        { ...parent.subIssues[0]!, stateType: "completed" },
        parent.subIssues[1]!,
        {
          linearIssueId: "child-c",
          identifier: "PAR-4",
          title: "Dropped child",
          description: "No longer needed",
          stateType: "canceled",
        },
      ],
    });
    tracker.deps.set("child-b", [
      { blockerLinearIssueId: "child-a", blockedLinearIssueId: "child-b" },
    ]);
    await ensureLinearSession(db, {
      sessionId: "parent-session",
      issueId: "parent",
      organizationId: "org",
      creatorId: "lead",
      now: fixture.clock.now(),
    });
    const admitted = await orchestrator.intakeLinearTask("parent", "parent-session", "parent-task");
    expect(admitted.ok).toBe(true);
    expect((await delegatedIssues(db)).map((issue) => issue.issueId)).toEqual(["child-b"]);
    expect((await parentDelegations(db))[0]?.edges).toEqual([]);

    await parents.register(jobs);
    await jobs.tick();
    expect(started).toEqual(["child-b"]);
    expect(await parentResponses(db)).toEqual([
      [
        "Started the work in 1 sub-issue. It runs in its own session, so reply there to steer it.",
        "* PAR-3 Second child: started",
        "",
        "Stop this session to stop it.",
      ].join("\n"),
    ]);
  } finally {
    await fixture.close();
  }
});

test("a delegated parent with a chain of sub-issues ends its session with one summary", async () => {
  const fixture = await createParentFixturePg();
  const { db, parents, orchestrator, jobs, tracker, started, outbox, issues } = fixture;
  try {
    const url = (identifier: string) => `https://linear.app/team/issue/${identifier}`;
    tracker.epics.set("chain", {
      linearIssueId: "chain",
      identifier: "PAS-369",
      title: "Move running work between runners",
      description: null,
      teamId: "team",
      subIssues: [
        {
          linearIssueId: "list",
          identifier: "PAS-545",
          title: "List each runner's running sessions",
          teamId: "team",
          url: url("PAS-545"),
        },
        {
          linearIssueId: "move-one",
          identifier: "PAS-546",
          title: "Move one running session",
          teamId: "team",
          url: url("PAS-546"),
        },
        {
          linearIssueId: "move-all",
          identifier: "PAS-547",
          title: "Move all running work",
          teamId: "team",
          url: url("PAS-547"),
        },
      ],
    });
    for (const [id, identifier] of [
      ["list", "PAS-545"],
      ["move-one", "PAS-546"],
      ["move-all", "PAS-547"],
    ] as const)
      tracker.epics.set(id, {
        linearIssueId: id,
        identifier,
        title: identifier,
        description: "Live description",
        teamId: "team",
        subIssues: [],
      });
    tracker.deps.set("move-one", [
      { blockerLinearIssueId: "list", blockedLinearIssueId: "move-one" },
      { blockerLinearIssueId: "outside", blockedLinearIssueId: "move-one" },
      { blockerLinearIssueId: "shipped", blockedLinearIssueId: "move-one" },
    ]);
    tracker.deps.set("move-all", [
      { blockerLinearIssueId: "move-one", blockedLinearIssueId: "move-all" },
    ]);
    const outside = { teamId: "team", assigneeId: null, delegateId: null };
    issues.set("outside", {
      ...outside,
      id: "outside",
      identifier: "PAS-368",
      url: url("PAS-368"),
      stateType: "started",
    });
    issues.set("shipped", {
      ...outside,
      id: "shipped",
      identifier: "PAS-300",
      stateType: "completed",
    });
    await ensureLinearSession(db, {
      sessionId: "parent-session",
      issueId: "chain",
      organizationId: "org",
      creatorId: "lead",
      now: fixture.clock.now(),
    });
    const admitted = await orchestrator.intakeLinearTask("chain", "parent-session", "parent-task");
    expect(admitted.ok).toBe(true);
    expect(await parentResponses(db)).toEqual([]);

    await parents.register(jobs);
    await jobs.tick();
    expect(started).toEqual(["list"]);
    const summary = [
      "Started the work in 3 sub-issues. Each runs in its own session, so reply there to steer it.",
      `* [PAS-545](${url("PAS-545")}) List each runner's running sessions: started`,
      `* [PAS-546](${url("PAS-546")}) Move one running session: waits for [PAS-545](${url("PAS-545")}) and [PAS-368](${url("PAS-368")})`,
      `* [PAS-547](${url("PAS-547")}) Move all running work: waits for [PAS-546](${url("PAS-546")})`,
      "",
      "Stop this session to stop them all.",
    ].join("\n");
    expect(await parentResponses(db)).toEqual([summary]);

    // Later ticks neither repeat the summary nor post progress in the parent session.
    fixture.clock.advance(30_000);
    await jobs.tick();
    fixture.clock.advance(30_000);
    await jobs.tick();
    expect(await parentResponses(db)).toEqual([summary]);
    expect(await listOutbox(db, "parent-session")).toHaveLength(1);

    for (let i = 0; i < 5; i++) {
      await outbox.tick();
      await outbox.idle();
    }
    // A response is Linear's final activity: it completes the parent's session.
    expect(
      tracker.progress
        .filter((update) => update.sessionId === "parent-session")
        .map(({ kind, body }) => ({ kind, body })),
    ).toEqual([{ kind: "response", body: summary }]);
  } finally {
    await fixture.close();
  }
});

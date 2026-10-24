import { expect, test } from "bun:test";
import { ensureLinearSession } from "../src/db";
import type { EpicSnapshot } from "../src/linear";
import { createParentFixture } from "./local/parent-fixture";

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

function parentResponses(db: ReturnType<typeof createParentFixture>["db"]): string[] {
  return db
    .query<{ body: string }, []>(
      `SELECT json_extract(payload,'$.body') AS body FROM outbox
       WHERE ordering_key='parent-session' AND json_extract(payload,'$.kind')='response' ORDER BY id`,
    )
    .all()
    .map((row) => row.body);
}

function publish(
  tracker: ReturnType<typeof createParentFixture>["tracker"],
  snapshot: EpicSnapshot,
) {
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
  const fixture = createParentFixture();
  const { db, parents, orchestrator, jobs, tracker, started } = fixture;
  try {
    publish(tracker, parent);
    tracker.deps.set("child-a", [
      { blockerLinearIssueId: "outside", blockedLinearIssueId: "child-a" },
    ]);
    tracker.deps.set("child-b", [
      { blockerLinearIssueId: "child-a", blockedLinearIssueId: "child-b" },
    ]);
    ensureLinearSession(db, {
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
      db.query("SELECT id FROM work_item WHERE delegation_id=?").all(admitted.delegation.id),
    ).toHaveLength(0);
    const adopted = db
      .query<
        {
          delegation_id: string;
          workspace_id: string;
          organization_id: string;
          parent_issue_id: string;
          parent_identifier: string;
          title: string;
          session_id: string;
          owner_user_id: string;
          edges: string;
          stopped_at: number | null;
        },
        []
      >(
        `SELECT delegation_id,workspace_id,organization_id,parent_issue_id,parent_identifier,title,
         session_id,owner_user_id,edges,stopped_at FROM parent_delegation`,
      )
      .get()!;
    expect(adopted).toMatchObject({
      delegation_id: admitted.delegation.id,
      workspace_id: "workspace",
      organization_id: "org",
      parent_issue_id: "parent",
      parent_identifier: "PAR-1",
      title: "Parent feature",
      session_id: "parent-session",
      owner_user_id: "lead",
      stopped_at: null,
    });
    expect(admitted.delegation).toMatchObject({
      linearIdentifier: "PAR-1",
      title: "Parent feature",
    });
    expect(JSON.parse(adopted.edges)).toEqual([
      { blockerLinearIssueId: "child-a", blockedLinearIssueId: "child-b" },
    ]);
    expect(
      db
        .query("SELECT issue_id,identifier,position FROM parent_delegation_issue ORDER BY position")
        .all(),
    ).toEqual([
      { issue_id: "child-a", identifier: "PAR-2", position: 0 },
      { issue_id: "child-b", identifier: "PAR-3", position: 1 },
    ]);
    expect(db.query("SELECT id FROM project_approval").all()).toEqual([]);
    expect(
      db
        .query<{ action: string; user_id: string }, []>(
          "SELECT action,user_id FROM workspace_access_audit WHERE action='parent.delegated'",
        )
        .all(),
    ).toEqual([{ action: "parent.delegated", user_id: "lead" }]);
    expect(tracker.progress.filter((update) => update.sessionId === "parent-session")).toEqual([]);
    const replay = await orchestrator.intakeLinearTask("parent", "parent-session", "parent-task");
    expect(replay.ok && replay.alreadyExisted).toBe(true);
    if (!replay.ok) return;
    expect(replay.items).toEqual([]);
    expect(replay.delegation.id).toBe(admitted.delegation.id);
    expect(tracker.progress.filter((update) => update.sessionId === "parent-session")).toEqual([]);

    parents.register(jobs);
    await jobs.tick();
    expect(started).toEqual(["child-a"]);
    expect(
      parents.progress(admitted.delegation.id).find((sub) => sub.issueId === "child-b"),
    ).toMatchObject({ sessionId: null, waitingFor: ["PAR-2"] });
    db.run("UPDATE work_item SET state='merged' WHERE linear_issue_id='child-a'");
    fixture.clock.advance(30_000);
    await jobs.tick();
    expect(started).toEqual(["child-a", "child-b"]);
    const items = db
      .query<
        {
          linear_issue_id: string;
          project_approval_id: string | null;
          owner_user_id: string;
          delegation_id: string;
        },
        []
      >(
        "SELECT linear_issue_id,project_approval_id,owner_user_id,delegation_id FROM work_item ORDER BY linear_issue_id",
      )
      .all();
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.linear_issue_id)).toEqual(["child-a", "child-b"]);
    for (const item of items) {
      expect(item.project_approval_id).toBeNull();
      expect(item.owner_user_id).toBe("lead");
      expect(item.delegation_id).not.toBe(admitted.delegation.id);
      expect(
        db.query("SELECT id FROM work_item WHERE delegation_id=?").all(item.delegation_id),
      ).toHaveLength(1);
    }
    expect(
      db
        .query<{ issue_id: string; delegation_id: string; session_id: string }, []>(
          "SELECT issue_id,delegation_id,session_id FROM parent_delegation_issue ORDER BY issue_id",
        )
        .all(),
    ).toEqual(
      items.map((item) => ({
        issue_id: item.linear_issue_id,
        delegation_id: item.delegation_id,
        session_id: `session-${item.linear_issue_id}`,
      })),
    );
    expect(parents.actor("session-child-a")).toBe("lead");
    const live = await tracker.loadEpic("child-a");
    expect(
      parents.scope("session-child-a", {
        ...live,
        title: "Renamed",
        description: "Rewritten",
      }),
    ).toMatchObject({ linearIssueId: "child-a", title: "Renamed", subIssues: [] });
    expect((await parents.scopeSnapshot("session-child-a", live)).subIssues).toEqual([]);
    // Another session cannot take a sub-issue that already runs under the parent.
    expect(() => parents.scope("parent-session", live)).toThrow(
      "This issue already runs as a sub-issue of a delegated parent.",
    );
  } finally {
    await fixture.close();
  }
});

test("a cycle between sub-issues reports the cycle and adopts nothing", async () => {
  const fixture = createParentFixture();
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
    ensureLinearSession(fixture.db, {
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
    expect(fixture.db.query("SELECT id FROM work_item").all()).toHaveLength(0);
    expect(fixture.db.query("SELECT delegation_id FROM parent_delegation").all()).toHaveLength(0);
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
  const fixture = createParentFixture();
  try {
    publish(fixture.tracker, parent);
    fixture.db.run(
      `INSERT INTO parent_delegation(delegation_id,workspace_id,organization_id,parent_issue_id,parent_identifier,title,session_id,owner_user_id,edges,created_at)
       VALUES('existing','workspace','org','other','OTH-1','Other parent','other-session','lead','[]',0)`,
    );
    fixture.db.run(
      `INSERT INTO parent_delegation_issue(parent_delegation_id,workspace_id,issue_id,identifier,title,position)
       VALUES('existing','workspace','child-a','PAR-2','First child',0)`,
    );
    ensureLinearSession(fixture.db, {
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
    expect(fixture.db.query("SELECT delegation_id FROM parent_delegation").all()).toEqual([
      { delegation_id: "existing" },
    ]);
    expect(fixture.tracker.progress.map((update) => update.body)).toEqual([
      "Picked up 2 sub-issues; order: PAR-2 → PAR-3",
    ]);
  } finally {
    await fixture.close();
  }
});

test("a follow-up on an adopted parent session does not queue its sub-issues again", async () => {
  const fixture = createParentFixture();
  try {
    publish(fixture.tracker, parent);
    ensureLinearSession(fixture.db, {
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
    expect(fixture.db.query("SELECT id FROM work_item").all()).toEqual([]);
    expect(fixture.db.query("SELECT delegation_id FROM parent_delegation").all()).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test("stopping the parent session stops its adoption so the parent can be delegated again", async () => {
  const fixture = createParentFixture();
  try {
    publish(fixture.tracker, parent);
    ensureLinearSession(fixture.db, {
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
    expect(
      fixture.db
        .query<{ stopped_at: number | null }, []>("SELECT stopped_at FROM parent_delegation")
        .get()?.stopped_at,
    ).not.toBeNull();
    expect(
      fixture.db
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM parent_delegation_issue WHERE released_at IS NULL",
        )
        .get()?.n,
    ).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("a message on an adopted parent session is answered instead of failing intake", async () => {
  const fixture = createParentFixture();
  try {
    publish(fixture.tracker, parent);
    ensureLinearSession(fixture.db, {
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
    expect(fixture.db.query("SELECT id FROM work_item").all()).toEqual([]);
    expect(
      fixture.db
        .query<{ status: string }, []>(
          "SELECT status FROM job WHERE status IN ('pending','running','dead') AND queue != 'scheduler.tick'",
        )
        .all(),
    ).toEqual([]);
    expect(
      fixture.db
        .query<{ body: string }, []>(
          "SELECT json_extract(payload,'$.body') AS body FROM outbox WHERE json_extract(payload,'$.kind')='response'",
        )
        .all()
        .some((row) => row.body.startsWith("Each sub-issue runs in its own session.")),
    ).toBe(true);
  } finally {
    await fixture.close();
  }
});

test("a sub-issue already managed in another session is rejected", async () => {
  const fixture = createParentFixture();
  try {
    publish(fixture.tracker, parent);
    ensureLinearSession(fixture.db, {
      sessionId: "child-session",
      issueId: "child-a",
      organizationId: "org",
      creatorId: "lead",
      now: fixture.clock.now(),
    });
    fixture.db.run(
      `INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key)
       VALUES('other-item','other-epic','child-a','PAR-2','Child A','running','paws/par-2',0,0,'child-session')`,
    );
    ensureLinearSession(fixture.db, {
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
    expect(
      fixture.db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'epic'")
        .get(),
    ).toBeNull();
    expect(fixture.db.query<{ id: string }, []>("SELECT id FROM work_item").all()).toEqual([
      { id: "other-item" },
    ]);
    expect(fixture.db.query("SELECT delegation_id FROM parent_delegation").all()).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("without Linear session starts a delegated parent runs its sub-issues in its own session", async () => {
  const fixture = createParentFixture(":memory:", { startSessions: false });
  try {
    publish(fixture.tracker, parent);
    ensureLinearSession(fixture.db, {
      sessionId: "parent-session",
      issueId: "parent",
      organizationId: "org",
      creatorId: "lead",
      now: fixture.clock.now(),
    });
    expect(fixture.parents.adoptParent("parent-session", parent, [])).toBe(false);
    const result = await fixture.orchestrator.intakeLinearTask(
      "parent",
      "parent-session",
      "parent-task",
    );
    expect(result.ok && result.items.map((item) => item.linearIdentifier)).toEqual([
      "PAR-2",
      "PAR-3",
    ]);
    expect(fixture.db.query("SELECT delegation_id FROM parent_delegation").all()).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("a delegated parent leaves its finished sub-issues out and still starts the issues they block", async () => {
  const fixture = createParentFixture();
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
    ensureLinearSession(db, {
      sessionId: "parent-session",
      issueId: "parent",
      organizationId: "org",
      creatorId: "lead",
      now: fixture.clock.now(),
    });
    const admitted = await orchestrator.intakeLinearTask("parent", "parent-session", "parent-task");
    expect(admitted.ok).toBe(true);
    expect(
      db.query("SELECT issue_id FROM parent_delegation_issue ORDER BY issue_id").all(),
    ).toEqual([{ issue_id: "child-b" }]);
    expect(
      JSON.parse(
        db.query<{ edges: string }, []>("SELECT edges FROM parent_delegation").get()!.edges,
      ),
    ).toEqual([]);

    parents.register(jobs);
    await jobs.tick();
    expect(started).toEqual(["child-b"]);
    expect(parentResponses(db)).toEqual([
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
  const fixture = createParentFixture();
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
    ensureLinearSession(db, {
      sessionId: "parent-session",
      issueId: "chain",
      organizationId: "org",
      creatorId: "lead",
      now: fixture.clock.now(),
    });
    const admitted = await orchestrator.intakeLinearTask("chain", "parent-session", "parent-task");
    expect(admitted.ok).toBe(true);
    expect(parentResponses(db)).toEqual([]);

    parents.register(jobs);
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
    expect(parentResponses(db)).toEqual([summary]);

    // Later ticks neither repeat the summary nor post progress in the parent session.
    fixture.clock.advance(30_000);
    await jobs.tick();
    fixture.clock.advance(30_000);
    await jobs.tick();
    expect(parentResponses(db)).toEqual([summary]);
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM outbox WHERE ordering_key='parent-session'",
        )
        .get()?.n,
    ).toBe(1);

    for (let i = 0; i < 5; i++) {
      outbox.tick();
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

import { expect, test } from "bun:test";
import { ensureLinearSession } from "../src/db";
import type { EpicSnapshot } from "../src/linear";
import { createProjectExecutionGuard } from "../src/project-execution";
import { createProjectFixture } from "./local/project-fixture";

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

function parentResponses(db: ReturnType<typeof createProjectFixture>["db"]): string[] {
  return db
    .query<{ body: string }, []>(
      `SELECT json_extract(payload,'$.body') AS body FROM outbox
       WHERE ordering_key='parent-session' AND json_extract(payload,'$.kind')='response' ORDER BY id`,
    )
    .all()
    .map((row) => row.body);
}

function publish(
  tracker: ReturnType<typeof createProjectFixture>["tracker"],
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

test("a delegated parent becomes an approved project and each sub-issue runs alone", async () => {
  const fixture = createProjectFixture();
  const { db, projects, orchestrator, jobs, tracker, started } = fixture;
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
    const approval = db
      .query<
        {
          id: string;
          source: string;
          project_id: string;
          actor_id: string;
          lead_user_id: string;
          generation: string;
          created_at: number;
          expires_at: number;
          approved_at: number | null;
          preview: string;
        },
        []
      >(
        `SELECT id,source,project_id,actor_id,lead_user_id,generation,created_at,expires_at,approved_at,preview
         FROM project_approval`,
      )
      .get()!;
    expect(approval.source).toBe("parent");
    expect(approval.project_id).toBe("parent");
    expect(approval.actor_id).toBe("lead");
    expect(approval.lead_user_id).toBe("lead");
    expect(approval.generation).toBe("parent:parent-session");
    expect(approval.approved_at).toBe(approval.created_at);
    expect(approval.expires_at).toBe(approval.created_at);
    const preview = JSON.parse(approval.preview) as {
      selection: {
        projectId: string;
        issueIds: string[];
        repository: string;
        targetBranch: string;
        leadUserId: string;
        steeringRoles: string[];
        blockers: unknown[];
      };
      project: {
        id: string;
        name: string;
        organizationId: string;
        leadId: string | null;
        issues: Array<{
          linearIssueId: string;
          teamId: string;
          projectId: string;
          parentId: string;
          stateType: string;
          updatedAt: string;
        }>;
      };
      generation: string;
      includedIssueIds: string[];
      excludedIssueIds: string[];
      order: string[];
      edges: Array<{ blockerLinearIssueId: string; blockedLinearIssueId: string }>;
      externalBlockerIds: string[];
      problems: string[];
    };
    const updatedAt = new Date(approval.created_at).toISOString();
    expect(preview.selection).toEqual({
      projectId: "parent",
      issueIds: ["child-a", "child-b"],
      repository: "",
      targetBranch: "main",
      leadUserId: "lead",
      steeringRoles: ["admin", "member", "owner"],
      blockers: [],
    });
    expect(preview.project).toMatchObject({
      id: "parent",
      name: "Parent feature",
      organizationId: "org",
      leadId: null,
    });
    expect(preview.project.issues.map((issue) => issue.linearIssueId)).toEqual([
      "child-a",
      "child-b",
    ]);
    expect(preview.project.issues[0]).toMatchObject({
      teamId: "team",
      projectId: "linear-project",
      parentId: "parent",
      stateType: "unstarted",
      updatedAt,
    });
    expect(preview.project.issues[1]).toMatchObject({
      teamId: "team",
      projectId: "",
      parentId: "parent",
      stateType: "unstarted",
      updatedAt,
    });
    expect(preview.generation).toBe("parent:parent-session");
    expect(preview.includedIssueIds).toEqual(["child-a", "child-b"]);
    expect(preview.excludedIssueIds).toEqual([]);
    expect(preview.order).toEqual(["child-a", "child-b"]);
    expect(preview.edges).toEqual([
      { blockerLinearIssueId: "child-a", blockedLinearIssueId: "child-b" },
    ]);
    expect(preview.externalBlockerIds).toEqual([]);
    expect(preview.problems).toEqual([]);
    expect(db.query("SELECT issue_id FROM project_approval_issue ORDER BY issue_id").all()).toEqual(
      [{ issue_id: "child-a" }, { issue_id: "child-b" }],
    );
    expect(
      db
        .query<{ action: string; user_id: string }, []>(
          "SELECT action,user_id FROM workspace_access_audit WHERE action='project.approved'",
        )
        .all(),
    ).toEqual([{ action: "project.approved", user_id: "lead" }]);
    expect(tracker.progress.filter((update) => update.sessionId === "parent-session")).toEqual([]);
    const replay = await orchestrator.intakeLinearTask("parent", "parent-session", "parent-task");
    expect(replay.ok && replay.alreadyExisted).toBe(true);
    if (!replay.ok) return;
    expect(replay.items).toEqual([]);
    expect(replay.delegation.id).toBe(admitted.delegation.id);
    expect(tracker.progress.filter((update) => update.sessionId === "parent-session")).toEqual([]);

    projects.register(jobs);
    await jobs.tick();
    expect(started).toEqual(["child-a"]);
    expect(
      projects.progress(approval.id).find((claim) => claim.issueId === "child-b"),
    ).toMatchObject({ sessionId: null, waitingFor: ["PAR-2"] });
    db.run("UPDATE work_item SET state='merged' WHERE linear_issue_id='child-a'");
    fixture.clock.advance(30_000);
    await jobs.tick();
    expect(started).toEqual(["child-a", "child-b"]);
    const items = db
      .query<
        {
          linear_issue_id: string;
          project_approval_id: string;
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
      expect(item.project_approval_id).toBe(approval.id);
      expect(item.owner_user_id).toBe("lead");
      expect(item.delegation_id).not.toBe(admitted.delegation.id);
      expect(
        db.query("SELECT id FROM work_item WHERE delegation_id=?").all(item.delegation_id),
      ).toHaveLength(1);
    }
    const claims = db
      .query<{ issue_id: string; delegation_id: string }, []>(
        "SELECT issue_id,delegation_id FROM project_approval_issue ORDER BY issue_id",
      )
      .all();
    const blocked = claims.find((claim) => claim.issue_id === "child-b")!;
    const blocker = claims.find((claim) => claim.issue_id === "child-a")!;
    expect(projects.canDispatch(blocker.delegation_id)).toBe(true);
    const live = await tracker.loadEpic("child-a");
    expect(
      projects.scope("session-child-a", {
        ...live,
        title: "Renamed",
        description: "Rewritten",
      }),
    ).toMatchObject({ linearIssueId: "child-a", title: "Renamed", subIssues: [] });
    tracker.deps.set("child-a", [
      { blockerLinearIssueId: "outside", blockedLinearIssueId: "child-a" },
      { blockerLinearIssueId: "later", blockedLinearIssueId: "child-a" },
    ]);
    expect((await projects.scopeSnapshot("session-child-a", live)).subIssues).toEqual([]);
    expect(projects.canDispatch(blocked.delegation_id)).toBe(true);
  } finally {
    await fixture.close();
  }
});

test("a cycle between sub-issues reports the cycle and creates no project", async () => {
  const fixture = createProjectFixture();
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
    expect(fixture.db.query("SELECT id FROM project_approval").all()).toHaveLength(0);
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
  const fixture = createProjectFixture();
  try {
    publish(fixture.tracker, parent);
    fixture.db.run(
      `INSERT INTO project_approval(id,workspace_id,project_id,actor_id,lead_user_id,generation,preview,created_at,expires_at,approved_at)
       VALUES('existing','workspace','other','lead','lead','gen','{}',0,0,0)`,
    );
    fixture.db.run(
      "INSERT INTO project_approval_issue(workspace_id,issue_id,approval_id) VALUES('workspace','child-a','existing')",
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
    expect(fixture.db.query("SELECT id,source FROM project_approval").all()).toEqual([
      { id: "existing", source: "project" },
    ]);
    expect(fixture.tracker.progress.map((update) => update.body)).toEqual([
      "Picked up 2 sub-issues; order: PAR-2 → PAR-3",
    ]);
  } finally {
    await fixture.close();
  }
});

test("a follow-up on an adopted parent session does not queue its sub-issues again", async () => {
  const fixture = createProjectFixture();
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
    expect(fixture.db.query("SELECT id FROM project_approval").all()).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test("stopping the parent session stops its adoption so the parent can be delegated again", async () => {
  const fixture = createProjectFixture();
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
        .query<{ stopped_at: number | null }, []>("SELECT stopped_at FROM project_approval")
        .get()?.stopped_at,
    ).not.toBeNull();
    expect(
      fixture.db
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM project_approval_issue WHERE released_at IS NULL",
        )
        .get()?.n,
    ).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("a message on an adopted parent session is answered instead of failing intake", async () => {
  const fixture = createProjectFixture();
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
  const fixture = createProjectFixture();
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
    expect(fixture.db.query("SELECT id FROM project_approval").all()).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("project execution guard declines parent adoption until runtime is ready", async () => {
  const fixture = createProjectFixture();
  try {
    const guard = createProjectExecutionGuard(fixture.db, () => null);
    expect(guard.adoptParent("parent-session", parent, [])).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("a delegated parent leaves its finished sub-issues out and still starts the issues they block", async () => {
  const fixture = createProjectFixture();
  const { db, projects, orchestrator, jobs, tracker, started, issues } = fixture;
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
    expect(db.query("SELECT issue_id FROM project_approval_issue ORDER BY issue_id").all()).toEqual(
      [{ issue_id: "child-b" }],
    );
    const preview = JSON.parse(
      db.query<{ preview: string }, []>("SELECT preview FROM project_approval").get()!.preview,
    ) as { includedIssueIds: string[]; edges: unknown[] };
    expect(preview.includedIssueIds).toEqual(["child-b"]);
    expect(preview.edges).toEqual([]);

    projects.register(jobs);
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
    const claim = db
      .query<{ delegation_id: string }, []>(
        "SELECT delegation_id FROM project_approval_issue WHERE issue_id='child-b'",
      )
      .get()!;
    expect(projects.canDispatch(claim.delegation_id)).toBe(true);
  } finally {
    await fixture.close();
  }
});

test("a delegated parent with a chain of sub-issues ends its session with one summary", async () => {
  const fixture = createProjectFixture();
  const { db, projects, orchestrator, jobs, tracker, started, outbox, issues } = fixture;
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

    projects.register(jobs);
    await jobs.tick();
    // Only the unblocked sub-issue gets a session; the summary still lists all three.
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

    // Later project ticks neither repeat the summary nor post progress in the parent session.
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

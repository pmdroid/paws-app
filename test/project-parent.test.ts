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
    expect(admitted.epic.state).toBe("done");
    expect(db.query("SELECT id FROM work_item WHERE epic_id=?").all(admitted.epic.id)).toHaveLength(
      0,
    );
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
    expect(tracker.progress).toContainEqual(
      expect.objectContaining({
        sessionId: "parent-session",
        kind: "thought",
        body: "Picked up 2 sub-issues. Each one runs in its own session.",
      }),
    );
    const replay = await orchestrator.intakeLinearTask("parent", "parent-session", "parent-task");
    expect(replay.ok && replay.alreadyExisted).toBe(true);
    if (!replay.ok) return;
    expect(replay.items).toEqual([]);
    expect(replay.epic.id).toBe(admitted.epic.id);
    expect(
      tracker.progress.filter((update) => update.body.startsWith("Picked up 2 sub-issues")),
    ).toHaveLength(1);

    projects.register(jobs);
    await jobs.tick();
    expect(started).toEqual(["child-a", "child-b"]);
    const items = db
      .query<
        {
          linear_issue_id: string;
          project_approval_id: string;
          owner_user_id: string;
          epic_id: string;
        },
        []
      >(
        "SELECT linear_issue_id,project_approval_id,owner_user_id,epic_id FROM work_item ORDER BY linear_issue_id",
      )
      .all();
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.linear_issue_id)).toEqual(["child-a", "child-b"]);
    for (const item of items) {
      expect(item.project_approval_id).toBe(approval.id);
      expect(item.owner_user_id).toBe("lead");
      expect(item.epic_id).not.toBe(admitted.epic.id);
      expect(db.query("SELECT id FROM work_item WHERE epic_id=?").all(item.epic_id)).toHaveLength(
        1,
      );
    }
    const claims = db
      .query<{ issue_id: string; epic_id: string }, []>(
        "SELECT issue_id,epic_id FROM project_approval_issue ORDER BY issue_id",
      )
      .all();
    const blocked = claims.find((claim) => claim.issue_id === "child-b")!;
    const blocker = claims.find((claim) => claim.issue_id === "child-a")!;
    expect(projects.canDispatch(blocker.epic_id)).toBe(true);
    expect(projects.canDispatch(blocked.epic_id)).toBe(false);
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
    db.run("UPDATE work_item SET state='merged' WHERE linear_issue_id='child-a'");
    expect(projects.canDispatch(blocked.epic_id)).toBe(true);
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
    expect(result.epic.state).toBe("stalled");
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

test("a reserved sub-issue keeps the multi-item epic", async () => {
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
    expect(result.epic.state).toBe("running");
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
      `INSERT INTO epic(id,linear_issue_id,linear_identifier,title,state,version,created_at,task_key)
       VALUES('other-epic','child-a','PAR-2','Child A','running',0,0,'initial:child-a')`,
    );
    fixture.db.run(
      `INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key)
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
    ).rejects.toThrow("PAR-2 is already being worked on in another session.");
    expect(fixture.db.query<{ id: string }, []>("SELECT id FROM epic").all()).toEqual([
      { id: "other-epic" },
    ]);
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

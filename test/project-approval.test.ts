import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, putWorkspaceUser, syncWorkspaceMember } from "../src/db";
import type { LinearProjectSnapshot } from "../src/linear";
import {
  createProjectApprovals,
  listProjectApprovals,
  type ProjectSelection,
} from "../src/project-execution";

test("approval binds exact project scope, rejects authorization races and persists one reservation", async () => {
  const db = new Database(":memory:");
  migrate(db);
  let now = 1_000_000;
  db.run(
    "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('workspace','organization','Workspace',0)",
  );
  for (const userId of ["actor", "lead", "outsider"]) {
    putWorkspaceUser(db, {
      id: userId,
      linearUserId: userId,
      name: userId,
      email: `${userId}@example.test`,
    });
    syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId,
      active: true,
      role: "member",
      teamIds: userId === "outsider" ? [] : ["team"],
      now,
    });
  }
  db.run(
    "INSERT INTO workspace_repository(workspace_id,repository,team_id) VALUES('workspace','owner/repo','team')",
  );
  let project: LinearProjectSnapshot = {
    id: "project",
    name: "Project",
    organizationId: "organization",
    updatedAt: "2026-10-14T00:00:00Z",
    leadId: "lead",
    issues: ["one", "two", "excluded"].map((linearIssueId) => ({
      linearIssueId,
      identifier: linearIssueId,
      title: linearIssueId,
      description: "Complete these requirements.",
      teamId: "team",
      projectId: "project",
      parentId: null,
      updatedAt: "2026-10-14T00:00:00Z",
      stateType: "unstarted",
    })),
  };
  let afterRead = () => {};
  let edges = [{ blockerLinearIssueId: "one", blockedLinearIssueId: "two" }];
  let members = ["actor", "teammate"];
  let memberReads = 0;
  const service = createProjectApprovals({
    db,
    now: () => ++now,
    tracker: {
      loadProject: async () => {
        afterRead();
        return structuredClone(project);
      },
      listDeps: async () => edges,
      listProjectMembers: async (id) => {
        memberReads++;
        expect(id).toBe("project");
        return members;
      },
    },
    memberships: {
      installation: async () => ({ id: "organization", name: "Workspace" }),
      member: async (organizationId, userId) => ({
        organizationId,
        userId,
        active: true,
        guest: false,
        admin: false,
        teamIds: userId === "outsider" ? [] : ["team"],
      }),
    },
  });
  const actor = { workspaceId: "workspace", userId: "actor" };
  const selection: ProjectSelection = {
    projectId: "project",
    issueIds: ["one", "two"],
    repository: "owner/repo",
    targetBranch: "main",
    leadUserId: "lead",
    steeringRoles: ["owner", "member"],
  };
  const signal = AbortSignal.timeout(10_000);
  try {
    await expect(
      service.preview({ ...actor, userId: "outsider" }, selection, signal),
    ).rejects.toThrow("authorized teams");
    const preview = await service.preview(actor, selection, signal);
    project = {
      ...project,
      issues: project.issues.map((issue) =>
        issue.linearIssueId === "one" ? { ...issue, description: "Changed requirements." } : issue,
      ),
    };
    await expect(service.approve(actor, preview.id, preview.generation, signal)).rejects.toThrow(
      "changed or expired",
    );
    expect(db.query("SELECT * FROM project_approval_issue").all()).toHaveLength(0);
    const refreshed = await service.preview(actor, selection, signal);
    afterRead = () => db.run("DELETE FROM workspace_repository");
    await expect(
      service.approve(actor, refreshed.id, refreshed.generation, signal),
    ).rejects.toThrow("authorized teams");
    afterRead = () => {};
    db.run(
      "INSERT INTO workspace_repository(workspace_id,repository,team_id) VALUES('workspace','owner/repo','team')",
    );
    db.run(
      "INSERT INTO linear_session(session_id,issue_id,organization_id,created_at) VALUES('existing','two','organization',0)",
    );
    db.run(
      "INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES('existing','existing','two','two','Existing','failed','existing',0,0,'existing')",
    );
    for (const state of ["failed", "exhausted"]) {
      db.run("UPDATE work_item SET state=? WHERE id='existing'", [state]);
      await expect(
        service.approve(actor, refreshed.id, refreshed.generation, signal),
      ).rejects.toThrow("already managed");
      expect(db.query("SELECT * FROM project_approval_issue").all()).toHaveLength(0);
    }
    db.run("UPDATE work_item SET state='cancelled' WHERE id='existing'");
    const approved = await service.approve(actor, refreshed.id, refreshed.generation, signal);
    expect(approved.approvedAt).not.toBeNull();
    const storedMembers = () =>
      db
        .query<{ id: string }, [string]>(
          "SELECT linear_user_id AS id FROM project_approval_member WHERE approval_id=? ORDER BY linear_user_id",
        )
        .all(approved.id)
        .map((row) => row.id);
    expect(storedMembers()).toEqual(["actor", "teammate"]);
    const reads = memberReads;
    members = ["actor", "newcomer"];
    expect((await service.approve(actor, refreshed.id, refreshed.generation, signal)).id).toBe(
      approved.id,
    );
    expect(memberReads).toBe(reads + 1);
    expect(storedMembers()).toEqual(["actor", "newcomer"]);
    expect(db.query("SELECT issue_id FROM project_approval_issue ORDER BY issue_id").all()).toEqual(
      [{ issue_id: "one" }, { issue_id: "two" }],
    );
    expect(listProjectApprovals(db, "workspace")).toHaveLength(1);
    const overlap = await service.preview(
      actor,
      { ...selection, issueIds: ["one", "excluded"] },
      signal,
    );
    await expect(service.approve(actor, overlap.id, overlap.generation, signal)).rejects.toThrow(
      "already managed",
    );
    expect(db.query("SELECT * FROM project_approval_issue").all()).toHaveLength(2);
    expect(
      db.query("SELECT * FROM workspace_access_audit WHERE action='project.approved'").all(),
    ).toHaveLength(1);
    await expect(
      service.approve({ ...actor, userId: "lead" }, approved.id, approved.generation, signal),
    ).rejects.toThrow("current scope");
    edges = [{ blockerLinearIssueId: "external", blockedLinearIssueId: "excluded" }];
    const externalSelection: ProjectSelection = {
      ...selection,
      issueIds: ["excluded"],
      blockers: [
        {
          blockerLinearIssueId: "external",
          outcome: "merge",
          repository: "owner/repo",
          targetBranch: "invalid branch",
          pullRequestNumber: 1,
        },
      ],
    };
    await expect(service.preview(actor, externalSelection, signal)).rejects.toThrow();
    expect(db.query("SELECT * FROM project_approval_issue").all()).toHaveLength(2);
    externalSelection.blockers = [
      {
        blockerLinearIssueId: "external",
        outcome: "merge",
        repository: "owner/repo",
        targetBranch: "main",
        pullRequestNumber: 1,
      },
    ];
    const externalPreview = await service.preview(actor, externalSelection, signal);
    const completion = await service.preview(
      actor,
      {
        ...externalSelection,
        blockers: [{ blockerLinearIssueId: "external", outcome: "completion" }],
      },
      signal,
    );
    expect(completion.generation).not.toBe(externalPreview.generation);
    expect(
      (await service.approve(actor, externalPreview.id, externalPreview.generation, signal))
        .approvedAt,
    ).not.toBeNull();
  } finally {
    db.close();
  }
});

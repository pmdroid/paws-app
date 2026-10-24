import { expect, test } from "bun:test";
import { ensureLinearSession, migrate, openDatabase, recordLinearInstallation } from "../src/db";
import { parentIssueIdSql } from "../src/core";
import type { AcceptedLinearEvent, EpicSnapshot } from "../src/linear";
import { createParentFixture } from "./local/parent-fixture";

type Fixture = ReturnType<typeof createParentFixture>;

async function delegate(f: Fixture, blocked = false) {
  const parent: EpicSnapshot = {
    linearIssueId: "parent",
    identifier: "PAR-1",
    title: "Parent",
    description: "Parent body",
    teamId: "team",
    subIssues: [{ linearIssueId: "a", identifier: "CH-1", title: "First", teamId: "team" }],
  };
  f.tracker.epics.set("parent", parent);
  f.tracker.epics.set("a", { ...parent.subIssues[0]!, description: "Do it", subIssues: [] });
  if (blocked) {
    f.tracker.deps.set("a", [{ blockerLinearIssueId: "outside", blockedLinearIssueId: "a" }]);
    // Linear reports the outside blocker as still in progress.
    const at = f.clock.now();
    f.db.run(
      `INSERT INTO inbox_event(dedupe_key,source,action,updated_at_ms,payload,received_at,handled)
       VALUES(?,'webhook','other',?,?,?,1)`,
      [
        `issue:outside:${at}`,
        at,
        JSON.stringify({
          type: "Issue",
          action: "update",
          organizationId: "org",
          data: { id: "outside", identifier: "OUT-1", state: { type: "started" } },
        }),
        at,
      ],
    );
  }
  ensureLinearSession(f.db, {
    sessionId: "parent-session",
    issueId: "parent",
    organizationId: "org",
    creatorId: "lead",
    now: f.clock.now(),
  });
  const admitted = await f.orchestrator.intakeLinearTask("parent", "parent-session", "parent-task");
  expect(admitted.ok).toBe(true);
  f.parents.register(f.jobs);
  await f.jobs.tick();
}

/** Someone delegates the sub-issue again in Linear, which opens another session on it. */
function created(f: Fixture, sessionId: string): AcceptedLinearEvent {
  if (!f.db.query("SELECT 1 FROM linear_session WHERE session_id=?").get(sessionId)) {
    ensureLinearSession(f.db, { sessionId, issueId: "a", creatorId: "actor" });
    recordLinearInstallation(f.db, {
      sessionId,
      organizationId: "org",
      teamId: "team",
      oauthClientId: "client",
      appUserId: "app",
      observedAtMs: f.clock.now(),
    });
  }
  return {
    action: "created",
    sessionId,
    issueId: "a",
    dedupeKey: sessionId,
    deliveryId: null,
    source: "webhook",
    activityId: null,
    body: null,
    signal: null,
    updatedAtMs: f.clock.now(),
    payload: "{}",
  };
}

test("a second session on a running sub-issue is refused and the first keeps it", async () => {
  const f = createParentFixture();
  try {
    await delegate(f);
    expect(f.started).toEqual(["a"]);
    const decision = await f.parents.authorizeEvent(created(f, "again"));
    expect(decision).toEqual({
      outcome: "refused",
      reason:
        "CH-1 is still running in its earlier Paws session. Paws continues there, so reply in that session to steer it.",
    });
    expect(f.parents.recheckEvent(created(f, "again"))).toBe(false);
    expect(f.parents.recheckEvent(created(f, "session-a"))).toBe(true);
    expect(
      f.db.query("SELECT session_id FROM parent_delegation_issue WHERE issue_id='a'").get(),
    ).toEqual({ session_id: "session-a" });
  } finally {
    await f.close();
  }
});

test("a failed sub-issue starts again in a new session", async () => {
  const f = createParentFixture();
  try {
    await delegate(f);
    f.db.run("UPDATE work_item SET state='failed' WHERE linear_issue_id='a'");
    expect(await f.parents.authorizeEvent(created(f, "again"))).toEqual({ outcome: "accepted" });
    expect(
      f.db
        .query("SELECT session_id,delegation_id FROM parent_delegation_issue WHERE issue_id='a'")
        .get(),
    ).toEqual({ session_id: "again", delegation_id: null });
    expect(f.db.query("SELECT state FROM work_item WHERE linear_issue_id='a'").get()).toEqual({
      state: "cancelled",
    });
    expect(f.parents.actor("again")).toBe("lead");
  } finally {
    await f.close();
  }
});

test("a sub-issue still waiting for its blockers refuses a session of its own", async () => {
  const f = createParentFixture();
  try {
    await delegate(f, true);
    expect(f.started).toEqual([]);
    expect(await f.parents.authorizeEvent(created(f, "early"))).toEqual({
      outcome: "refused",
      reason:
        "CH-1 waits for its blockers under its delegated parent. Paws opens its session when they finish.",
    });
  } finally {
    await f.close();
  }
});

test("the migration carries an active parent adoption over from project_approval", () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    db.run("DROP TABLE parent_delegation_issue");
    db.run("DROP TABLE parent_delegation");
    db.run("DELETE FROM schema_migration WHERE id='128_parent_delegation'");
    db.run(
      "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('workspace','org','Workspace',0)",
    );
    db.run(
      "INSERT INTO workspace_user(id,linear_user_id,name,email) VALUES('lead','lead','Lead','lead@example.test')",
    );
    const preview = {
      project: {
        name: "Parent",
        organizationId: "org",
        issues: [
          { linearIssueId: "a", identifier: "CH-1", title: "First", url: "https://l/CH-1" },
          { linearIssueId: "b", identifier: "CH-2", title: "Second" },
        ],
      },
      order: ["a", "b"],
      edges: [{ blockerLinearIssueId: "a", blockedLinearIssueId: "b" }],
    };
    db.run(
      `INSERT INTO project_approval(id,workspace_id,project_id,actor_id,lead_user_id,generation,preview,created_at,expires_at,approved_at,source)
       VALUES('approval','workspace','parent','lead','lead','parent:parent-session',?,5,5,5,'parent')`,
      [JSON.stringify(preview)],
    );
    db.run(
      `INSERT INTO project_approval(id,workspace_id,project_id,actor_id,lead_user_id,generation,preview,created_at,expires_at,approved_at)
       VALUES('started','workspace','linear-project','lead','lead','gen','{}',5,5,5)`,
    );
    db.run(
      "INSERT INTO project_approval_issue(workspace_id,issue_id,approval_id,session_id,delegation_id) VALUES('workspace','a','approval','session-a','child-delegation')",
    );
    db.run(
      "INSERT INTO project_approval_issue(workspace_id,issue_id,approval_id) VALUES('workspace','b','approval')",
    );
    db.run(
      `INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,project_approval_id)
       VALUES('item-a','child-delegation','a','CH-1','First','running','paws/ch-1',0,0,'approval')`,
    );
    migrate(db);
    expect(db.query("SELECT * FROM parent_delegation").all()).toEqual([
      {
        delegation_id: "approval",
        workspace_id: "workspace",
        organization_id: "org",
        parent_issue_id: "parent",
        parent_identifier: "parent",
        title: "Parent",
        session_id: "parent-session",
        owner_user_id: "lead",
        edges: JSON.stringify(preview.edges),
        created_at: 5,
        stopped_at: null,
        last_error: null,
      },
    ]);
    expect(
      db
        .query(
          "SELECT issue_id,identifier,title,url,position,session_id,delegation_id FROM parent_delegation_issue ORDER BY position",
        )
        .all(),
    ).toEqual([
      {
        issue_id: "a",
        identifier: "CH-1",
        title: "First",
        url: "https://l/CH-1",
        position: 0,
        session_id: "session-a",
        delegation_id: "child-delegation",
      },
      {
        issue_id: "b",
        identifier: "CH-2",
        title: "Second",
        url: null,
        position: 1,
        session_id: null,
        delegation_id: null,
      },
    ]);
    expect(
      db.query(`SELECT ${parentIssueIdSql("work_item")} AS parent FROM work_item`).get(),
    ).toEqual({ parent: "parent" });
  } finally {
    db.close();
  }
});

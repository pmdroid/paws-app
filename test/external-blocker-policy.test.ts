import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { bindLinearSessionTask, migrate, recordLinearInstallation, saveTaskMode } from "../src/db";
import {
  intakeDelegatedIssue,
  readExternalBlockerPolicies,
  readyItems,
  saveExternalBlockerPolicies,
  syncItemDependencies,
  type ExternalBlockerPolicy,
} from "../src/intake";
import { createFakeTracker, createFakeLinearIssueLifecycle } from "../src/linear";
import { inspectPullRequestMerge } from "../src/github";

async function fixture() {
  const db = new Database(":memory:");
  migrate(db);
  const tracker = createFakeTracker([
    {
      linearIssueId: "parent",
      identifier: "DEP-1",
      title: "Parent",
      description: null,
      subIssues: [{ linearIssueId: "b", identifier: "DEP-2", title: "Dependent" }],
    },
  ]);
  const lifecycle = createFakeLinearIssueLifecycle({
    id: "a",
    teamId: "team",
    stateType: "completed",
    assigneeId: null,
    delegateId: null,
  });
  tracker.deps.set("parent", [{ blockerLinearIssueId: "a", blockedLinearIssueId: "b" }]);
  const intake = await intakeDelegatedIssue(db, tracker, { linearIssueId: "parent", now: 1000 });
  if (!intake.ok) throw new Error("Intake failed");
  db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',1000)");
  db.run(
    "INSERT INTO workspace_user VALUES('person','linear-person','Person','person@example.test')",
  );
  db.run(
    "INSERT INTO workspace_member(workspace_id,user_id,role,source,active,checked_at) VALUES('workspace','person','member','linear',1,1000)",
  );
  db.run("INSERT INTO workspace_user_team VALUES('workspace','person','team')");
  db.run("INSERT INTO workspace_repository VALUES('workspace','owner/repo','team')");
  recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: 1000,
  });
  bindLinearSessionTask(db, "session", intake.delegation.id, { actorId: "linear-person" });
  const itemId = intake.items[0]!.id;
  const target = { workspaceId: "workspace", itemId };
  const policyTarget = { workspaceId: "workspace", itemId };
  const policy: ExternalBlockerPolicy = {
    blockerLinearIssueId: "a",
    outcome: "merge",
    repository: "owner/repo",
    targetBranch: "main",
    pullRequestNumber: 12,
  };
  const refresh = () =>
    syncItemDependencies(db, {
      ...target,
      expectedGeneration: readyItems(db, target).generation,
      tracker,
      lifecycle,
    });
  const save = (policies: ExternalBlockerPolicy[]) =>
    saveExternalBlockerPolicies(db, { ...policyTarget, userId: "person", policies });
  return {
    db,
    target,
    tracker,
    lifecycle,
    policy,
    refresh,
    save,
    ready: () => readyItems(db, target).readyItemIds.includes(itemId),
  };
}

test("a policy saved for an item is read back for that item only", async () => {
  const f = await fixture();
  try {
    f.save([f.policy]);
    expect(readExternalBlockerPolicies(f.db, f.target)).toEqual([f.policy]);
    f.db.run(
      "INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES('other-item',?,'other','DEP-9','Other','queued','paws/other',2,1001,'session')",
      [
        f.db
          .query<{ delegationId: string }, [string]>(
            "SELECT delegation_id AS delegationId FROM work_item WHERE id=?",
          )
          .get(f.target.itemId)!.delegationId,
      ],
    );
    expect(
      readExternalBlockerPolicies(f.db, {
        workspaceId: f.target.workspaceId,
        itemId: "other-item",
      }),
    ).toEqual([]);
    expect(
      f.db.query<{ itemId: string }, []>("SELECT item_id AS itemId FROM item_blocker_policy").all(),
    ).toEqual([{ itemId: f.target.itemId }]);
    expect(
      f.db
        .query(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'external_blocker_policy'",
        )
        .get(),
    ).toBeNull();
  } finally {
    f.db.close();
  }
});

test("an outside blocker completed in Linear releases the item", async () => {
  const f = await fixture();
  try {
    f.lifecycle.issue.stateType = "started";
    await f.refresh();
    expect(f.ready()).toBe(false);
    f.lifecycle.issue.stateType = "completed";
    await f.refresh();
    expect(f.ready()).toBe(true);
  } finally {
    f.db.close();
  }
});

test("a canceled outside blocker holds the item", async () => {
  const f = await fixture();
  try {
    f.lifecycle.issue.stateType = "canceled";
    await f.refresh();
    expect(f.ready()).toBe(false);
  } finally {
    f.db.close();
  }
});

test("saved per-project blocker policies no longer decide readiness", async () => {
  const f = await fixture();
  try {
    f.save([f.policy]);
    f.lifecycle.issue.stateType = "started";
    await f.refresh();
    expect(f.ready()).toBe(false);
    f.save([{ blockerLinearIssueId: "a", outcome: "completion" }]);
    f.lifecycle.issue.stateType = "completed";
    await f.refresh();
    expect(f.ready()).toBe(true);
  } finally {
    f.db.close();
  }
});

test("Managed blockers in another delegation require canonical delivery", async () => {
  const f = await fixture();
  try {
    f.tracker.epics.set("a", {
      linearIssueId: "a",
      identifier: "DEP-3",
      title: "Code blocker",
      description: null,
      subIssues: [],
    });
    const intake = await intakeDelegatedIssue(f.db, f.tracker, { linearIssueId: "a", now: 2000 });
    if (!intake.ok) throw new Error("Intake failed");
    recordLinearInstallation(f.db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "other-session",
      teamId: "team",
      observedAtMs: 2000,
    });
    bindLinearSessionTask(f.db, "other-session", intake.delegation.id, {
      actorId: "linear-person",
    });
    const item = intake.items[0]!;
    saveTaskMode(f.db, item.id, "code");
    await f.refresh();
    expect(f.ready()).toBe(false);
    f.db.run("UPDATE work_item SET state='completed' WHERE id=?", [item.id]);
    expect(f.ready()).toBe(false);
    f.db.run("UPDATE work_item SET state='merged' WHERE id=?", [item.id]);
    expect(f.ready()).toBe(false);
    f.db.run("INSERT INTO remote_merge_fact VALUES(?,'owner','repo',12,NULL,?,2000)", [
      item.id,
      "b".repeat(40),
    ]);
    expect(f.ready()).toBe(true);
    f.db.run("UPDATE work_item SET cancel_requested=1 WHERE id=?", [item.id]);
    expect(f.ready()).toBe(false);
  } finally {
    f.db.close();
  }
});

test("A blocker whose Paws tasks were all cancelled follows its Linear state", async () => {
  const f = await fixture();
  try {
    f.tracker.epics.set("a", {
      linearIssueId: "a",
      identifier: "DEP-3",
      title: "Code blocker",
      description: null,
      subIssues: [],
    });
    const intake = await intakeDelegatedIssue(f.db, f.tracker, { linearIssueId: "a", now: 2000 });
    if (!intake.ok) throw new Error("Intake failed");
    recordLinearInstallation(f.db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "other-session",
      teamId: "team",
      observedAtMs: 2000,
    });
    bindLinearSessionTask(f.db, "other-session", intake.delegation.id, {
      actorId: "linear-person",
    });
    f.db.run("UPDATE work_item SET state='cancelled' WHERE id=?", [intake.items[0]!.id]);
    await f.refresh();
    expect(f.ready()).toBe(true);
    f.lifecycle.issue.stateType = "started";
    await f.refresh();
    expect(f.ready()).toBe(false);
  } finally {
    f.db.close();
  }
});

test("Re-delegated managed blockers follow the latest active item", async () => {
  const f = await fixture();
  try {
    f.tracker.epics.set("a", {
      linearIssueId: "a",
      identifier: "DEP-3",
      title: "Code blocker",
      description: null,
      subIssues: [],
    });
    const intake = await intakeDelegatedIssue(f.db, f.tracker, { linearIssueId: "a", now: 2000 });
    if (!intake.ok) throw new Error("Intake failed");
    recordLinearInstallation(f.db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "other-session",
      teamId: "team",
      observedAtMs: 2000,
    });
    bindLinearSessionTask(f.db, "other-session", intake.delegation.id, {
      actorId: "linear-person",
    });
    const newer = intake.items[0]!;
    f.db.run("UPDATE work_item SET state='merged', created_at=3000 WHERE id=?", [newer.id]);
    f.db.run("INSERT INTO remote_merge_fact VALUES(?,'owner','repo',12,NULL,?,3000)", [
      newer.id,
      "b".repeat(40),
    ]);
    f.db.run(
      `INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,task_key,session_key)
       VALUES(?,?,?,?,?,'cancelled',?,?,?,?,?)`,
      [
        "older-blocker",
        intake.delegation.id,
        "a",
        "DEP-3",
        "Code blocker",
        "paws/dep-3-older",
        0,
        1000,
        "initial:a:item:a:reappearance:1",
        "other-session",
      ],
    );
    await f.refresh();
    expect(f.ready()).toBe(true);
    f.db.run("UPDATE work_item SET state='running' WHERE id=?", [newer.id]);
    f.db.run("UPDATE work_item SET state='merged' WHERE id='older-blocker'");
    f.db.run(
      "INSERT INTO remote_merge_fact VALUES('older-blocker','owner','repo',11,NULL,?,1000)",
      ["c".repeat(40)],
    );
    expect(f.ready()).toBe(false);
    f.db.run("UPDATE work_item SET cancel_requested=1 WHERE id=?", [newer.id]);
    expect(f.ready()).toBe(true);
  } finally {
    f.db.close();
  }
});

test("GitHub evidence distinguishes a closed unmerged pull from a real merge", async () => {
  const pull = {
    number: 12,
    state: "closed",
    merged: false,
    merge_commit_sha: "b".repeat(40),
    head: { sha: "a".repeat(40) },
    base: { ref: "main", repo: { full_name: "owner/repo" } },
  };
  const calls: string[] = [];
  const input = {
    repository: "owner/repo",
    targetBranch: "main",
    pullRequestNumber: 12,
    token: "synthetic-token",
    client: {
      async request(request: { path: string }) {
        calls.push(request.path);
        return { status: 200, body: pull };
      },
    },
  };
  expect((await inspectPullRequestMerge(input)).merged).toBe(false);
  pull.merged = true;
  expect((await inspectPullRequestMerge(input)).merged).toBe(true);
  expect(calls).toEqual(["/repos/owner/repo/pulls/12", "/repos/owner/repo/pulls/12"]);
  const abort = new AbortController();
  abort.abort();
  await expect(inspectPullRequestMerge({ ...input, signal: abort.signal })).rejects.toThrow();
  expect(calls.length).toBe(2);
});

test("Linear blocker links require complete attachment pagination and exact issue identity", async () => {
  const { createLinearTracker } = await import("../src/linear");
  let page = 0;
  let wrong = false;
  const tracker = createLinearTracker({
    async query() {
      page++;
      return {
        issue: {
          id: wrong ? "another" : "a",
          attachments: {
            nodes: [
              {
                id: `attachment-${page}`,
                url:
                  page === 1
                    ? "https://example.test/notes"
                    : "https://github.com/owner/repo/pull/12",
              },
            ],
            pageInfo: { hasNextPage: page === 1, endCursor: page === 1 ? "cursor" : null },
          },
        },
      };
    },
  });
  expect(await tracker.listIssuePullRequests!("a")).toEqual([
    { repository: "owner/repo", pullRequestNumber: 12 },
  ]);
  expect(page).toBe(2);
  wrong = true;
  await expect(tracker.listIssuePullRequests!("a")).rejects.toThrow("another blocker");
});

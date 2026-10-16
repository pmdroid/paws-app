import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { bindLinearSessionTask, migrate, recordLinearInstallation, saveTaskMode } from "../src/db";
import {
  intakeDelegatedIssue,
  readyItems,
  saveExternalBlockerPolicies,
  syncItemDependencies,
  type ExternalBlockerPolicy,
  type MergeEvidence,
} from "../src/intake";
import { createFakeTracker, createFakeLinearIssueLifecycle } from "../src/linear";
import { inspectPullRequestMerge } from "../src/github";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
  bindLinearSessionTask(db, "session", intake.epic.id, { actorId: "linear-person" });
  const itemId = intake.items[0]!.id;
  const target = { workspaceId: "workspace", itemId };
  const policyTarget = { workspaceId: "workspace", epicId: intake.epic.id };
  const policy: ExternalBlockerPolicy = {
    blockerLinearIssueId: "a",
    outcome: "merge",
    repository: "owner/repo",
    targetBranch: "main",
    pullRequestNumber: 12,
  };
  tracker.issuePullRequests.set("a", [{ repository: "owner/repo", pullRequestNumber: 12 }]);
  let evidence: MergeEvidence = {
    merged: false,
    repository: "owner/repo",
    targetBranch: "main",
    pullRequestNumber: 12,
    headSha: "a".repeat(40),
    mergeSha: null,
  };
  let outage = false;
  let duringRead: (() => void) | undefined;
  const refresh = () =>
    syncItemDependencies(db, {
      ...target,
      expectedGeneration: readyItems(db, target).generation,
      tracker,
      lifecycle,
      inspectMerge: async () => {
        duringRead?.();
        if (outage) throw new Error("Synthetic outage");
        return evidence;
      },
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
    setEvidence: (value: Partial<MergeEvidence>) => {
      evidence = { ...evidence, ...value };
    },
    setOutage: () => {
      outage = true;
    },
    setDuringRead: (value: () => void) => {
      duringRead = value;
    },
  };
}

test("External code blockers require the approved merged PR and retain evidence", async () => {
  const f = await fixture();
  try {
    f.save([f.policy]);
    await f.refresh();
    expect(f.ready()).toBe(false);
    for (const evidence of [
      { merged: false, mergeSha: "b".repeat(40) },
      { merged: true, mergeSha: null },
      { merged: true, mergeSha: "b".repeat(40), repository: "other/repo" },
      { repository: "owner/repo", targetBranch: "release" },
      { targetBranch: "main", pullRequestNumber: 13 },
    ]) {
      f.setEvidence(evidence);
      await f.refresh();
      expect(f.ready()).toBe(false);
    }
    f.setEvidence({ pullRequestNumber: 12 });
    await f.refresh();
    expect(f.ready()).toBe(true);
    const proof = f.db
      .query<{ external_evidence: string }, []>(
        "SELECT external_evidence FROM item_dependency_snapshot",
      )
      .get()!;
    expect(JSON.parse(proof.external_evidence).a.merge.mergeSha).toBe("b".repeat(40));
    expect(f.ready()).toBe(true);
    f.tracker.issuePullRequests.set("a", [{ repository: "owner/repo", pullRequestNumber: 99 }]);
    await f.refresh();
    expect(f.ready()).toBe(false);
    f.tracker.issuePullRequests.set("a", [{ repository: "owner/repo", pullRequestNumber: 12 }]);
    f.setOutage();
    await f.refresh();
    expect(f.ready()).toBe(false);
  } finally {
    f.db.close();
  }
});

test("Policy changes, permission loss and delayed evidence cannot reuse approvals", async () => {
  const f = await fixture();
  try {
    f.save([f.policy]);
    f.setEvidence({ merged: true, mergeSha: "b".repeat(40) });
    await f.refresh();
    expect(f.ready()).toBe(true);
    f.db.run("UPDATE workspace_member SET active=0");
    expect(f.ready()).toBe(false);
    expect(() => f.save([f.policy])).toThrow("authorized");
    f.db.run("UPDATE workspace_member SET active=1");
    f.setDuringRead(() => f.db.run("DELETE FROM workspace_repository"));
    await expect(f.refresh()).rejects.toThrow("snapshot changed");
    expect(f.ready()).toBe(false);
    expect(() => f.save([f.policy])).toThrow("repository");
    f.db.run("INSERT INTO workspace_repository VALUES('workspace','owner/repo','team')");
    f.save([{ ...f.policy, pullRequestNumber: 14 }]);
    expect(f.ready()).toBe(false);
  } finally {
    f.db.close();
  }
});

test("Explicit completion remains human-approved and cancellation always holds", async () => {
  const f = await fixture();
  try {
    f.save([{ blockerLinearIssueId: "a", outcome: "completion" }]);
    await f.refresh();
    expect(f.ready()).toBe(true);
    expect(
      f.db
        .query("SELECT 1 FROM workspace_access_audit WHERE action='dependency.policy.approved'")
        .get(),
    ).not.toBeNull();
    f.lifecycle.issue.stateType = "canceled";
    await f.refresh();
    expect(f.ready()).toBe(false);
    f.lifecycle.issue.stateType = "started";
    await f.refresh();
    expect(f.ready()).toBe(false);
  } finally {
    f.db.close();
  }
});

test("Managed blockers in another epic require canonical delivery", async () => {
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
    bindLinearSessionTask(f.db, "other-session", intake.epic.id, { actorId: "linear-person" });
    const item = intake.items[0]!;
    saveTaskMode(f.db, item.id, "code");
    f.db.run(
      "INSERT INTO project_approval(id,workspace_id,project_id,actor_id,lead_user_id,generation,preview,created_at,expires_at,approved_at) VALUES('approval','workspace','parent','person','person','1','{}',1000,9000,1000)",
    );
    f.db.run("UPDATE work_item SET project_approval_id='approval'");
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

test("A fresh process retains exact merge evidence and refuses expired snapshots", async () => {
  const f = await fixture();
  const root = mkdtempSync(join(tmpdir(), "paws-blocker-proof-"));
  try {
    f.save([f.policy]);
    f.setEvidence({ merged: true, mergeSha: "b".repeat(40) });
    await f.refresh();
    const database = join(root, "state.sqlite");
    writeFileSync(database, f.db.serialize());
    const run = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `import {Database} from 'bun:sqlite';import {readyItems} from ${JSON.stringify(join(import.meta.dir, "../src/intake/index.ts"))};const db=new Database(process.argv[1]);const target=JSON.parse(process.argv[2]);const before=readyItems(db,target).readyItemIds.length;db.run("UPDATE item_dependency_snapshot SET external_evidence=json_set(external_evidence,'$.a.checkedAt',0)");const after=readyItems(db,target).readyItemIds.length;console.log(JSON.stringify({before,after}));db.close();`,
        database,
        JSON.stringify(f.target),
      ],
      { env: { HOME: root, TMPDIR: root }, stdout: "pipe", stderr: "pipe" },
    );
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout.toString())).toEqual({ before: 1, after: 0 });
  } finally {
    f.db.close();
    rmSync(root, { recursive: true, force: true });
  }
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

import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { bindLinearSessionTask, recordLinearInstallation, saveTaskMode, type Db } from "../src/db";
import { intakeDelegatedIssue, readyItemsSteps, syncItemDependencies } from "../src/intake";
import { createFakeTracker, createFakeLinearIssueLifecycle } from "../src/linear";
import { inspectPullRequestMerge } from "../src/github";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

function setItem(
  db: Db,
  id: string,
  set: { state?: string; createdAt?: number; cancelRequested?: number },
): Promise<void> {
  return seed(db, (q) => q.orm.update(q.t.workItem).set(set).where(eq(q.t.workItem.id, id)));
}

function recordMerge(db: Db, itemId: string, pullNumber: number, sha: string, at: number) {
  return seed(db, (q) =>
    q.orm.insert(q.t.remoteMergeFact).values({
      itemId,
      repositoryOwner: "owner",
      repositoryName: "repo",
      pullNumber,
      mergeSha: sha,
      confirmedAt: at,
    }),
  );
}

async function fixture() {
  const { db, close } = await tempStore();
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
  const intake = await intakeDelegatedIssue(db, tracker, {
    linearIssueId: "parent",
    now: 1000,
  });
  if (!intake.ok) throw new Error("Intake failed");
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.workspace).values({
        id: "workspace",
        linearOrganizationId: "org",
        name: "Workspace",
        createdAt: 1000,
      }),
    (q) =>
      q.orm.insert(q.t.workspaceUser).values({
        id: "person",
        linearUserId: "linear-person",
        name: "Person",
        email: "person@example.test",
      }),
    (q) =>
      q.orm.insert(q.t.workspaceMember).values({
        workspaceId: "workspace",
        userId: "person",
        role: "member",
        source: "linear",
        active: 1,
        checkedAt: 1000,
      }),
    (q) =>
      q.orm
        .insert(q.t.workspaceUserTeam)
        .values({ workspaceId: "workspace", userId: "person", teamId: "team" }),
    (q) =>
      q.orm
        .insert(q.t.workspaceRepository)
        .values({ workspaceId: "workspace", repository: "owner/repo", teamId: "team" }),
  );
  await recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: 1000,
  });
  await bindLinearSessionTask(db, "session", intake.delegation.id, {
    actorId: "linear-person",
  });
  const itemId = intake.items[0]!.id;
  const target = { workspaceId: "workspace", itemId };
  const refresh = async () =>
    syncItemDependencies(db, {
      ...target,
      expectedGeneration: (await db.run((q) => readyItemsSteps(q, target))).generation,
      tracker,
      lifecycle,
    });
  return {
    db,
    close,
    target,
    tracker,
    lifecycle,
    refresh,
    ready: async () =>
      (await db.run((q) => readyItemsSteps(q, target))).readyItemIds.includes(itemId),
  };
}

test("an outside blocker completed in Linear releases the item", async () => {
  const f = await fixture();
  try {
    f.lifecycle.issue.stateType = "started";
    await f.refresh();
    expect(await f.ready()).toBe(false);
    f.lifecycle.issue.stateType = "completed";
    await f.refresh();
    expect(await f.ready()).toBe(true);
  } finally {
    await f.close();
  }
});

test("an outside blocker canceled in Linear releases the item; an open one holds it", async () => {
  const f = await fixture();
  try {
    f.lifecycle.issue.stateType = "started";
    await f.refresh();
    expect(await f.ready()).toBe(false);
    f.lifecycle.issue.stateType = "canceled";
    await f.refresh();
    expect(await f.ready()).toBe(true);
  } finally {
    await f.close();
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
    const intake = await intakeDelegatedIssue(f.db, f.tracker, {
      linearIssueId: "a",
      now: 2000,
    });
    if (!intake.ok) throw new Error("Intake failed");
    await recordLinearInstallation(f.db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "other-session",
      teamId: "team",
      observedAtMs: 2000,
    });
    await bindLinearSessionTask(f.db, "other-session", intake.delegation.id, {
      actorId: "linear-person",
    });
    const item = intake.items[0]!;
    await saveTaskMode(f.db, item.id, "code");
    await f.refresh();
    expect(await f.ready()).toBe(false);
    await setItem(f.db, item.id, { state: "completed" });
    expect(await f.ready()).toBe(false);
    await setItem(f.db, item.id, { state: "merged" });
    expect(await f.ready()).toBe(false);
    await recordMerge(f.db, item.id, 12, "b".repeat(40), 2000);
    expect(await f.ready()).toBe(true);
    await setItem(f.db, item.id, { cancelRequested: 1 });
    expect(await f.ready()).toBe(false);
  } finally {
    await f.close();
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
    const intake = await intakeDelegatedIssue(f.db, f.tracker, {
      linearIssueId: "a",
      now: 2000,
    });
    if (!intake.ok) throw new Error("Intake failed");
    await recordLinearInstallation(f.db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "other-session",
      teamId: "team",
      observedAtMs: 2000,
    });
    await bindLinearSessionTask(f.db, "other-session", intake.delegation.id, {
      actorId: "linear-person",
    });
    await setItem(f.db, intake.items[0]!.id, { state: "cancelled" });
    await f.refresh();
    expect(await f.ready()).toBe(true);
    f.lifecycle.issue.stateType = "started";
    await f.refresh();
    expect(await f.ready()).toBe(false);
  } finally {
    await f.close();
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
    const intake = await intakeDelegatedIssue(f.db, f.tracker, {
      linearIssueId: "a",
      now: 2000,
    });
    if (!intake.ok) throw new Error("Intake failed");
    await recordLinearInstallation(f.db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "other-session",
      teamId: "team",
      observedAtMs: 2000,
    });
    await bindLinearSessionTask(f.db, "other-session", intake.delegation.id, {
      actorId: "linear-person",
    });
    const newer = intake.items[0]!;
    await setItem(f.db, newer.id, { state: "merged", createdAt: 3000 });
    await recordMerge(f.db, newer.id, 12, "b".repeat(40), 3000);
    await seed(f.db, (q) =>
      q.orm.insert(q.t.workItem).values({
        id: "older-blocker",
        delegationId: intake.delegation.id,
        linearIssueId: "a",
        linearIdentifier: "DEP-3",
        title: "Code blocker",
        state: "cancelled",
        branchName: "paws/dep-3-older",
        position: 0,
        createdAt: 1000,
        taskKey: "initial:a:item:a:reappearance:1",
        sessionKey: "other-session",
      }),
    );
    await f.refresh();
    expect(await f.ready()).toBe(true);
    await setItem(f.db, newer.id, { state: "running" });
    await setItem(f.db, "older-blocker", { state: "merged" });
    await recordMerge(f.db, "older-blocker", 11, "c".repeat(40), 1000);
    expect(await f.ready()).toBe(false);
    await setItem(f.db, newer.id, { cancelRequested: 1 });
    expect(await f.ready()).toBe(true);
  } finally {
    await f.close();
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

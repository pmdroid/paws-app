import { expect, test } from "bun:test";
import {
  insertQueuedItem,
  recordReviewFindings,
  listReviewFindings,
  listFindingGroups,
  lastFindingGroupRun,
  markReviewFindingFiled,
  putWorkspaceUser,
  syncWorkspaceMember,
  JobLoop,
} from "../src/db";
import {
  createFindingGrouping,
  createFakeGroupingHelper,
  validateGroups,
  registerFindingGrouping,
  type GroupingInput,
} from "../src/finding-groups";
import { createFakeFindingIssueAdapter } from "../src/linear";
import { handleFindingGroupsRequest } from "../src/web";
import { tempDb } from "./helpers";

const epoch = Date.parse("2026-10-28T06:00:00Z");
function seed() {
  const db = tempDb();
  db.run("INSERT INTO workspace VALUES('ws','org','Workspace',1)");
  insertQueuedItem(db, { id: "item", sessionKey: "session", title: "Task", now: 1 });
  recordReviewFindings(db, {
    itemId: "item",
    repository: "acme/app",
    head: "a".repeat(40),
    seenAt: 1000,
    reviewed: [],
    findings: [
      {
        review: "independent",
        severity: "P1",
        location: "src/auth.ts:4-6",
        text: "Use constant-time comparison",
        bugClass: "timing",
        why: "pre-existing",
      },
      {
        review: "independent",
        severity: "P2",
        location: "src/linear.ts:12",
        text: "Avoid timing leak",
        bugClass: "timing",
        why: "below failOn",
      },
    ],
  });
  const userId = putWorkspaceUser(db, {
    id: "ada",
    linearUserId: "linear-ada",
    name: "Ada",
    email: "ada@example.invalid",
  });
  syncWorkspaceMember(db, {
    workspaceId: "ws",
    userId,
    role: "admin",
    active: true,
    teamIds: [],
    now: 1,
  });
  const sources = (): GroupingInput[] =>
    listReviewFindings(db).map((f) => ({ ...f, teamId: "team", sessionId: "session" }));
  const ids = sources().map((f) => f.id);
  const text = JSON.stringify({
    groups: [
      {
        title: "Use constant-time comparisons",
        summary: "Compare secrets without leaking timing",
        scope: "src/auth and src/linear",
        findingIds: [ids[0], 999, ids[0]],
        suggestedIssue: "PAS-20",
      },
      {
        title: "Another group",
        summary: "Second fix",
        scope: "src",
        findingIds: ids,
        suggestedIssue: "PAS-999",
      },
    ],
  });
  const helper = createFakeGroupingHelper(text);
  const issues = createFakeFindingIssueAdapter([
    { identifier: "PAS-20", title: "Fix timing comparisons", teamId: "team" },
  ]);
  let now = epoch;
  const grouping = createFindingGrouping({
    db,
    sources: () => sources(),
    helper: helper.run,
    issues,
    now: () => now,
  });
  return {
    db,
    sources,
    ids,
    helper,
    issues,
    grouping,
    nextDay: () => {
      now += 86400000;
    },
  };
}

test("daily grouping validates ids, deduplicates membership and limits suggestions to supplied titles", async () => {
  const f = seed();
  try {
    await Promise.all([
      f.grouping.run("ws", new AbortController().signal),
      f.grouping.run("ws", new AbortController().signal),
    ]);
    const groups = listFindingGroups(f.db, "ws");
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.title === "Use constant-time comparisons")!.suggestedIssue).toBe(
      "PAS-20",
    );
    expect(groups.find((g) => g.title === "Another group")!.suggestedIssue).toBeNull();
    expect(groups.flatMap((g) => g.memberIds).sort()).toEqual([...f.ids].sort());
    expect(f.helper.calls).toHaveLength(1);
    expect(f.issues.reads).toEqual([["team"]]);
    const input = f.helper.calls[0]!.prompt;
    for (const key of [
      "repository",
      "path",
      "lines",
      "severity",
      "review",
      "text",
      "bugClass",
      "itemCount",
      "status",
    ])
      expect(input).toContain(`"${key}"`);
    expect(lastFindingGroupRun(f.db, "ws")).toMatchObject({
      status: "completed",
      tokens: 123,
      groupCount: 2,
      startedAt: epoch,
      finishedAt: epoch,
    });
    f.nextDay();
    await f.grouping.run("ws", new AbortController().signal);
    expect(f.helper.calls).toHaveLength(1);
    expect(f.issues.reads).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

test("filed groups survive replacement and are not regrouped", async () => {
  const f = seed();
  try {
    await f.grouping.run("ws", new AbortController().signal);
    const group = listFindingGroups(f.db, "ws")[0]!;
    f.db.run("UPDATE finding_group SET status='filed' WHERE id=?", [group.id]);
    for (const id of group.memberIds)
      markReviewFindingFiled(f.db, {
        key: f.sources().find((r) => r.id === id)!.key,
        issue: "PAS-1",
        by: "Ada",
        now: epoch,
      });
    f.nextDay();
    await f.grouping.run("ws", new AbortController().signal);
    const next = listFindingGroups(f.db, "ws");
    expect(next.find((g) => g.id === group.id)?.status).toBe("filed");
    expect(
      next
        .filter((g) => g.status === "open")
        .flatMap((g) => g.memberIds)
        .some((id) => group.memberIds.includes(id)),
    ).toBe(false);
    expect(f.helper.calls).toHaveLength(2);
  } finally {
    f.db.close();
  }
});

test("empty findings and failed helpers never spend extra turns on the same UTC day", async () => {
  const f = seed();
  try {
    const empty = createFindingGrouping({
      db: f.db,
      sources: () => [],
      issues: f.issues,
      helper: f.helper.run,
      now: () => epoch,
    });
    await empty.run("ws", new AbortController().signal);
    expect(f.helper.calls).toHaveLength(0);
    expect(f.issues.reads).toHaveLength(0);
    const failed = createFindingGrouping({
      db: f.db,
      sources: () => f.sources(),
      issues: f.issues,
      helper: async () => {
        throw new Error("offline");
      },
      now: () => epoch + 86400000,
    });
    await expect(failed.run("ws", new AbortController().signal)).rejects.toThrow("offline");
    await failed.run("ws", new AbortController().signal);
    expect(f.issues.reads).toHaveLength(1);
    expect(lastFindingGroupRun(f.db, "ws")?.status).toBe("failed");
  } finally {
    f.db.close();
  }
});

test("output schema rejects malformed groups and suggestions from another team", () => {
  const f = seed();
  try {
    expect(() => validateGroups('{"groups":[{"title":42}]}', f.sources(), [])).toThrow();
    const groups = validateGroups(
      JSON.stringify({
        groups: [
          {
            title: "Fix",
            summary: "Fix secrets",
            scope: "src",
            findingIds: f.ids,
            suggestedIssue: "OTHER-1",
          },
        ],
      }),
      f.sources(),
      [{ identifier: "OTHER-1", title: "Secrets", teamId: "other" }],
    );
    expect(groups[0]!.suggestedIssue).toBeNull();
  } finally {
    f.db.close();
  }
});

test("scheduler honors HH:MM UTC and manual grouping can run before that time", async () => {
  const f = seed();
  try {
    let now = epoch - 60000;
    const jobs = new JobLoop(f.db, { now: () => now, mono: () => now });
    const calls: string[] = [];
    registerFindingGrouping(jobs, {
      groupingTime: "06:00",
      workspaces: () => ["ws"],
      run: async (id) => {
        calls.push(id);
      },
      now: () => now,
    });
    await jobs.tick(["findings.group.tick"]);
    expect(await jobs.tick(["findings.group"])).toBeNull();
    now = epoch;
    await jobs.tick(["findings.group.tick"]);
    await jobs.tick(["findings.group"]);
    expect(calls).toEqual(["ws"]);
  } finally {
    f.db.close();
  }
});

async function post(f: ReturnType<typeof seed>, body: unknown, sessionIds?: string[]) {
  return (await handleFindingGroupsRequest(
    new Request("http://localhost/api/finding-groups", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    {
      db: f.db,
      principal: { workspaceId: "ws", userId: "ada" },
      services: { issues: f.issues },
      now: () => epoch,
      ...(sessionIds ? { sessionIds } : {}),
    },
  ))!;
}
for (const action of ["file", "add"] as const)
  test(`group ${action} writes once to Linear and files all members`, async () => {
    const f = seed();
    try {
      await f.grouping.run("ws", new AbortController().signal);
      const group = listFindingGroups(f.db, "ws").find((g) => g.suggestedIssue)!;
      const denied = await post(f, { action, id: group.id }, []);
      expect(denied.status).toBe(403);
      expect(f.issues.files).toHaveLength(0);
      expect((await post(f, { action, id: group.id }, ["session"])).status).toBe(200);
      expect((await post(f, { action, id: group.id }, ["session"])).status).toBe(409);
      expect(f.issues.files).toHaveLength(action === "file" ? 1 : 0);
      expect(f.issues.comments).toHaveLength(action === "add" ? 1 : 0);
      const body = action === "file" ? f.issues.files[0]!.description : f.issues.comments[0]!.body;
      expect(body).toContain(group.summary);
      expect(body).toContain("src/linear.ts:12");
      for (const finding of f.sources().filter((r) => group.memberIds.includes(r.id)))
        expect(finding).toMatchObject({
          status: "filed",
          filedIssue: action === "file" ? "PAS-1" : "PAS-20",
        });
    } finally {
      f.db.close();
    }
  });

test("dismissal requires a reason, observers are denied and only admins can run now", async () => {
  const f = seed();
  try {
    await f.grouping.run("ws", new AbortController().signal);
    const group = listFindingGroups(f.db, "ws")[0]!;
    expect((await post(f, { action: "dismiss", id: group.id, reason: " " })).status).toBe(400);
    expect(
      (await post(f, { action: "dismiss", id: group.id, reason: "Intended behavior" })).status,
    ).toBe(200);
    expect(listFindingGroups(f.db, "ws").find((g) => g.id === group.id)).toMatchObject({
      status: "dismissed",
      statusReason: "Intended behavior",
    });
    f.db.run("UPDATE workspace_member SET role='member'");
    expect((await post(f, { action: "run" })).status).toBe(403);
    f.db.run("UPDATE workspace_member SET role='observer'");
    expect((await post(f, { action: "file", id: group.id })).status).toBe(403);
    f.db.run("UPDATE workspace_member SET role='admin'");
    expect((await post(f, { action: "run" })).status).toBe(409);
  } finally {
    f.db.close();
  }
});

test("group actions require the workspace CSRF token and same origin", async () => {
  const { startServer } = await import("../src/server");
  const { createWorkspaceAccess, issueWorkspaceSession, WORKSPACE_COOKIE } =
    await import("../src/workspace");
  const f = seed();
  const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = reservation.port!;
  await reservation.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  f.db.run("UPDATE workspace_member SET source='manual',manual_role='admin'");
  const access = createWorkspaceAccess({
    db: f.db,
    publicUrl: origin,
    clientId: "fixture",
    installedOrganization: { id: "org", name: "Workspace" },
    memberships: {
      installation: async () => ({ id: "org", name: "Workspace" }),
      member: async (organizationId, userId) => ({
        organizationId,
        userId,
        active: true,
        guest: false,
        admin: true,
        teamIds: ["team"],
      }),
    },
  });
  const server = startServer({
    hostname: "127.0.0.1",
    port,
    db: f.db,
    workspaceAccess: access,
    findingGroups: { issues: f.issues },
  });
  try {
    const session = issueWorkspaceSession(f.db, {
      workspaceId: "ws",
      userId: "ada",
      now: Date.now(),
    });
    const headers = {
      cookie: `${WORKSPACE_COOKIE}=${session.token}`,
      origin,
      "content-type": "application/json",
    };
    for (const action of ["file", "add", "dismiss", "run"]) {
      const response = await fetch(`${origin}/api/finding-groups`, {
        method: "POST",
        headers,
        body: JSON.stringify({ action }),
      });
      expect(response.status).toBe(403);
    }
    const response = await fetch(`${origin}/api/finding-groups`, {
      method: "POST",
      headers: { ...headers, "x-paws-csrf": session.session.csrfToken },
      body: JSON.stringify({ action: "run" }),
    });
    expect(response.status).toBe(202);
    const crossOrigin = await fetch(`${origin}/api/finding-groups`, {
      method: "POST",
      headers: {
        ...headers,
        origin: "https://other.invalid",
        "x-paws-csrf": session.session.csrfToken,
      },
      body: JSON.stringify({ action: "run" }),
    });
    expect(crossOrigin.status).toBe(403);
    expect(f.issues.files).toHaveLength(0);
    expect(f.issues.comments).toHaveLength(0);
  } finally {
    await server.stop(true);
    f.db.close();
  }
});

test("a lost Linear reply keeps the action retryable and protects its members during regrouping", async () => {
  const f = seed();
  try {
    await f.grouping.run("ws", new AbortController().signal);
    const group = listFindingGroups(f.db, "ws").find((g) => g.suggestedIssue)!;
    const file = f.issues.file;
    let lost = true;
    f.issues.file = async (input) => {
      const identifier = await file(input);
      if (lost) {
        lost = false;
        throw new Error("Response lost after creation");
      }
      return identifier;
    };
    expect((await post(f, { action: "file", id: group.id })).status).toBe(502);
    expect(listFindingGroups(f.db, "ws").find((g) => g.id === group.id)?.action).toBe("file");
    const { handleFindingsRequest } = await import("../src/web");
    const dismiss = await handleFindingsRequest(
      new Request("http://localhost/api/findings", {
        method: "POST",
        body: JSON.stringify({
          action: "dismiss",
          id: group.memberIds[0],
          reason: "Changed my mind",
        }),
      }),
      { db: f.db, principal: { workspaceId: "ws", userId: "ada" } },
    );
    expect(dismiss!.status).toBe(409);
    f.db.run("UPDATE review_finding SET severity='P3'");
    f.nextDay();
    await f.grouping.run("ws", new AbortController().signal);
    expect(
      listFindingGroups(f.db, "ws").filter((g) =>
        g.memberIds.some((id) => group.memberIds.includes(id)),
      ),
    ).toHaveLength(1);
    expect((await post(f, { action: "file", id: group.id })).status).toBe(200);
    expect(f.issues.files).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

test("large inputs fit the helper schema and rotate overflow without another finding change", async () => {
  const { groupingBatch, groupingPrompt } = await import("../src/finding-groups");
  const f = seed();
  try {
    const source = f.sources()[0]!;
    const findings = Array.from({ length: 300 }, (_, i) => ({
      ...source,
      id: i + 1,
      text: "x".repeat(5000),
    }));
    const issues = Array.from({ length: 500 }, (_, i) => ({
      teamId: "team",
      identifier: `PAS-${i + 1}`,
      title: "Title ".repeat(100),
    }));
    const first = groupingBatch(findings, issues, 100);
    const next = groupingBatch(findings, issues, 101);
    expect(groupingPrompt(first.open, first.issues).length).toBeLessThanOrEqual(65536);
    expect(first.open.length).toBeGreaterThan(0);
    expect(first.partial).toBe(true);
    expect(next.open.map((row) => row.id)).not.toEqual(first.open.map((row) => row.id));
    const helper = createFakeGroupingHelper('{"groups":[]}');
    let now = epoch;
    const grouping = createFindingGrouping({
      db: f.db,
      sources: () => findings,
      issues: f.issues,
      helper: helper.run,
      now: () => now,
    });
    await grouping.run("ws", new AbortController().signal);
    now += 86400000;
    await grouping.run("ws", new AbortController().signal);
    expect(helper.calls).toHaveLength(2);
  } finally {
    f.db.close();
  }
});

test("fenced model JSON parses and interrupted runs recover without spending another daily turn", async () => {
  const { recoverFindingGroupRuns } = await import("../src/db");
  const f = seed();
  try {
    expect(validateGroups('```json\n{"groups":[]}\n```', f.sources(), [])).toEqual([]);
    f.db.run(
      "INSERT INTO finding_group_run(id,workspace_id,day,started_at,fingerprint,status) VALUES('crashed','ws','2026-10-28',?,'old','running')",
      [epoch],
    );
    recoverFindingGroupRuns(f.db, epoch + 12 * 60000);
    expect(lastFindingGroupRun(f.db, "ws")).toMatchObject({
      status: "failed",
      finishedAt: epoch + 12 * 60000,
    });
    await f.grouping.run("ws", new AbortController().signal);
    expect(f.helper.calls).toHaveLength(0);
  } finally {
    f.db.close();
  }
});

test("a definitive Linear refusal releases the group so a member can dismiss it", async () => {
  const f = seed();
  try {
    await f.grouping.run("ws", new AbortController().signal);
    const group = listFindingGroups(f.db, "ws")[0]!;
    f.issues.file = async () => {
      throw Object.assign(new Error("Team has no Triage state"), { noFindingWrite: true });
    };
    expect((await post(f, { action: "file", id: group.id })).status).toBe(502);
    expect(listFindingGroups(f.db, "ws").find((g) => g.id === group.id)?.action).toBeNull();
    expect(
      (await post(f, { action: "dismiss", id: group.id, reason: "Track separately" })).status,
    ).toBe(200);
  } finally {
    f.db.close();
  }
});

test("reopened findings can join new groups while acted-on group history survives", async () => {
  const f = seed();
  try {
    await f.grouping.run("ws", new AbortController().signal);
    const group = listFindingGroups(f.db, "ws")[0]!;
    await post(f, { action: "dismiss", id: group.id, reason: "Already handled" });
    f.db.run("UPDATE review_finding SET status='open',status_at=?", [epoch + 1000]);
    f.nextDay();
    await f.grouping.run("ws", new AbortController().signal);
    const groups = listFindingGroups(f.db, "ws");
    expect(groups.find((g) => g.id === group.id)?.status).toBe("dismissed");
    expect(groups.filter((g) => g.status === "open").flatMap((g) => g.memberIds)).toContain(
      group.memberIds[0]!,
    );
  } finally {
    f.db.close();
  }
});

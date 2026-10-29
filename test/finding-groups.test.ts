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
    expect(validateGroups('{"groups":[{"title":42}]}', f.sources(), [])).toEqual([]);
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

test("claimed Linear actions reconcile even after a review marks members gone", async () => {
  for (const action of ["file", "add"] as const) {
    const f = seed();
    try {
      await f.grouping.run("ws", new AbortController().signal);
      const group = listFindingGroups(f.db, "ws").find((g) => g.suggestedIssue)!;
      let first = true;
      if (action === "file") {
        const file = f.issues.file;
        f.issues.file = async (input) => {
          const id = await file(input);
          if (first) {
            first = false;
            throw new Error("Reply lost");
          }
          return id;
        };
      } else {
        const add = f.issues.add;
        f.issues.add = async (input) => {
          await add(input);
          if (first) {
            first = false;
            throw new Error("Reply lost");
          }
        };
      }
      expect((await post(f, { action, id: group.id })).status).toBe(502);
      f.db.run("UPDATE review_finding SET status='gone'");
      expect((await post(f, { action, id: group.id })).status).toBe(200);
      expect(f.issues.files.length + f.issues.comments.length).toBe(1);
      expect(
        f
          .sources()
          .filter((row) => group.memberIds.includes(row.id))
          .every((row) => row.status === "filed"),
      ).toBe(true);
    } finally {
      f.db.close();
    }
  }
});

test("untouched groups follow individual dismissals immediately and locks are workspace-scoped", async () => {
  const { handleFindingsRequest } = await import("../src/web");
  const f = seed();
  try {
    await f.grouping.run("ws", new AbortController().signal);
    const group = listFindingGroups(f.db, "ws")[0]!;
    f.db.run("DELETE FROM finding_group WHERE id<>?", [group.id]);
    f.db.run("UPDATE finding_group SET member_ids=?", [JSON.stringify(f.ids)]);
    const dismiss = (id: number, workspaceId = "ws") =>
      handleFindingsRequest(
        new Request("http://localhost/api/findings", {
          method: "POST",
          body: JSON.stringify({ action: "dismiss", id, reason: "Handle individually" }),
        }),
        { db: f.db, principal: { workspaceId, userId: "ada" } },
      );
    expect((await dismiss(f.ids[0]!))!.status).toBe(200);
    expect(listFindingGroups(f.db, "ws")[0]!.memberIds).toEqual([f.ids[1]!]);
    expect((await post(f, { action: "file", id: group.id })).status).toBe(200);
    f.db.run("UPDATE finding_group SET status='open',action='file'");
    f.db.run("UPDATE review_finding SET status='open'");
    f.db.run("INSERT INTO workspace VALUES('other','other-org','Other',1)");
    syncWorkspaceMember(f.db, {
      workspaceId: "other",
      userId: "ada",
      role: "admin",
      active: true,
      teamIds: [],
      now: Date.now(),
    });
    expect((await dismiss(f.ids[1]!, "other"))!.status).toBe(200);
    expect((await dismiss(f.ids[1]!))!.status).toBe(409);
  } finally {
    f.db.close();
  }
});

test("schema accepts harmless additional keys, omitted issue suggestions and JSON prose", () => {
  const f = seed();
  try {
    const groups = validateGroups(
      `Here are the groups:\n${JSON.stringify({ groups: [{ title: "Fix", summary: "Shared fix", scope: "src", findingIds: f.ids, reason: "Related comparisons" }] })}\nDone.`,
      f.sources(),
      [],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.suggestedIssue).toBeNull();
  } finally {
    f.db.close();
  }
});

test("overflow advances by a full batch and keeps groups outside the current batch", async () => {
  const f = seed();
  try {
    const source = f.sources()[0]!;
    const rows = Array.from({ length: 80 }, (_, i) => ({
      ...source,
      id: i + 1,
      text: "Detail ".repeat(800),
    }));
    const batches: number[][] = [];
    let now = epoch;
    const grouping = createFindingGrouping({
      db: f.db,
      sources: () => rows,
      issues: f.issues,
      now: () => now,
      helper: async (input) => {
        const json = JSON.parse(input.prompt.split("\n\n").at(-1)!) as {
          findings: { id: number }[];
        };
        const ids = json.findings.map((row) => row.id);
        batches.push(ids);
        return {
          text: JSON.stringify({
            groups: [
              { title: "Shared fix", summary: "Fix this batch", scope: "src", findingIds: ids },
            ],
          }),
        };
      },
    });
    await grouping.run("ws", new AbortController().signal);
    const before = listFindingGroups(f.db, "ws")[0]!;
    now += 86400000;
    await grouping.run("ws", new AbortController().signal);
    expect(batches[1]![0]).toBe(batches[0]!.at(-1)! + 1);
    expect(batches[0]!.some((id) => batches[1]!.includes(id))).toBe(false);
    expect(listFindingGroups(f.db, "ws").find((g) => g.id === before.id)?.memberIds).toEqual(
      before.memberIds,
    );
  } finally {
    f.db.close();
  }
});

test("unchanged runs record why they skipped without reading Linear or spending a turn", async () => {
  const f = seed();
  try {
    await f.grouping.run("ws", new AbortController().signal);
    f.nextDay();
    await f.grouping.run("ws", new AbortController().signal);
    expect(lastFindingGroupRun(f.db, "ws")?.skipReason).toContain("No findings changed");
    expect(f.helper.calls).toHaveLength(1);
    expect(f.issues.reads).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

test("admin grouping covers findings reported by teams outside that admin's membership list", async () => {
  const { recordLinearInstallation } = await import("../src/db");
  const { workspaceGroupingSources } = await import("../src/finding-groups");
  const f = seed();
  try {
    syncWorkspaceMember(f.db, {
      workspaceId: "ws",
      userId: "ada",
      role: "admin",
      active: true,
      teamIds: ["team-x"],
      now: 2,
    });
    for (const [sessionId, teamId] of [
      ["session", "team-x"],
      ["session-y", "team-y"],
    ])
      recordLinearInstallation(f.db, {
        sessionId: sessionId!,
        organizationId: "org",
        oauthClientId: "client",
        appUserId: "app",
        teamId: teamId!,
        observedAtMs: 3,
      });
    insertQueuedItem(f.db, {
      id: "team-y-item",
      sessionKey: "session-y",
      title: "Other team finding",
      now: 3,
    });
    recordReviewFindings(f.db, {
      itemId: "team-y-item",
      repository: "acme/app",
      head: "a".repeat(40),
      seenAt: 4,
      reviewed: [],
      findings: [
        {
          review: "independent",
          severity: "P2",
          location: "src/team-y.ts:10",
          text: "Handle error",
          bugClass: "error",
          why: "pre-existing",
        },
      ],
    });
    const rows = workspaceGroupingSources(f.db, "ws", "client");
    expect(rows.some((row) => row.teamId === "team-x")).toBe(true);
    expect(rows.some((row) => row.teamId === "team-y")).toBe(true);
  } finally {
    f.db.close();
  }
});

test("grouping authority is an admin who owns a runner, not an earlier admin without one", async () => {
  const { recordLinearInstallation } = await import("../src/db");
  const { groupingAuthorityUser, workspaceGroupingSources } = await import("../src/finding-groups");
  const f = seed();
  try {
    putWorkspaceUser(f.db, {
      id: "aaa",
      linearUserId: "linear-aaa",
      name: "Aaa",
      email: "aaa@example.invalid",
    });
    syncWorkspaceMember(f.db, {
      workspaceId: "ws",
      userId: "aaa",
      role: "admin",
      active: true,
      teamIds: [],
      now: 2,
    });
    recordLinearInstallation(f.db, {
      sessionId: "session",
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      teamId: "team",
      observedAtMs: 3,
    });
    f.db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('runner','ws','ada','Runner','active',1,1)",
    );
    expect(groupingAuthorityUser(f.db, "ws")).toBe("ada");
    expect(workspaceGroupingSources(f.db, "ws", "client").length).toBeGreaterThan(0);
  } finally {
    f.db.close();
  }
});

test("a partial grouping cycle processes each finding and then skips unchanged snapshots", async () => {
  const f = seed();
  try {
    const source = f.sources()[0]!;
    const rows = Array.from({ length: 25 }, (_, i) => ({
      ...source,
      id: i + 1,
      text: "Detail ".repeat(800),
    }));
    const covered = new Set<number>();
    let calls = 0;
    let now = epoch;
    const grouping = createFindingGrouping({
      db: f.db,
      sources: () => rows,
      issues: f.issues,
      now: () => now,
      helper: async (input) => {
        const json = JSON.parse(input.prompt.split("\n\n").at(-1)!) as {
          findings: { id: number }[];
        };
        for (const row of json.findings) covered.add(row.id);
        calls++;
        return { text: '{"groups":[]}' };
      },
    });
    while (covered.size < rows.length) {
      await grouping.run("ws", new AbortController().signal);
      now += 86400000;
      if (calls > 10) throw new Error("Batch did not advance");
    }
    const completedCalls = calls;
    await grouping.run("ws", new AbortController().signal);
    expect(calls).toBe(completedCalls);
    expect(lastFindingGroupRun(f.db, "ws")?.skipReason).toContain("No findings changed");
  } finally {
    f.db.close();
  }
});

test("daily finding updates do not reset the overflow cursor", async () => {
  const f = seed();
  try {
    const source = f.sources()[0]!;
    const rows = Array.from({ length: 40 }, (_, i) => ({
      ...source,
      id: i + 1,
      text: "x".repeat(4000),
    }));
    const covered = new Set<number>();
    let now = epoch;
    const grouping = createFindingGrouping({
      db: f.db,
      sources: () => rows,
      issues: f.issues,
      now: () => now,
      helper: async (input) => {
        const json = JSON.parse(input.prompt.split("\n\n").at(-1)!) as {
          findings: { id: number }[];
        };
        json.findings.forEach((row) => covered.add(row.id));
        return { text: '{"groups":[]}' };
      },
    });
    for (let day = 0; day < 6 && covered.size < rows.length; day++) {
      rows[0] = { ...rows[0]!, last: { ...rows[0]!.last, at: now } };
      await grouping.run("ws", new AbortController().signal);
      now += 86400000;
    }
    expect(covered.size).toBe(rows.length);
  } finally {
    f.db.close();
  }
});

test("invalid model groups do not discard valid groups", () => {
  const f = seed();
  try {
    const valid = { title: "Fix", summary: "Shared fix", scope: "src", findingIds: f.ids };
    const groups = validateGroups(
      JSON.stringify({ groups: [{ title: 42 }, { ...valid, title: "x".repeat(230) }, valid] }),
      f.sources(),
      [],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.title).toHaveLength(200);
    expect(groups[0]!.memberIds).toEqual(f.ids);
  } finally {
    f.db.close();
  }
});

test("dismissal conflicts roll back group completion and release the claim", async () => {
  const f = seed();
  try {
    await f.grouping.run("ws", new AbortController().signal);
    const group = listFindingGroups(f.db, "ws")[0]!;
    const member = group.memberIds[0]!;
    f.db.exec(
      `CREATE TEMP TRIGGER member_changed AFTER UPDATE OF action ON finding_group WHEN NEW.action='dismiss' BEGIN UPDATE review_finding SET status='filed' WHERE id=${member}; END`,
    );
    expect((await post(f, { action: "dismiss", id: group.id, reason: "Not needed" })).status).toBe(
      409,
    );
    expect(listFindingGroups(f.db, "ws").find((row) => row.id === group.id)).toMatchObject({
      status: "open",
      action: null,
      statusReason: null,
    });
    expect(f.sources().find((row) => row.id === member)?.status).toBe("filed");
  } finally {
    f.db.close();
  }
});

test("overflow resumes after a stable ID when earlier findings close and wraps into the head", async () => {
  const { groupingBatch } = await import("../src/finding-groups");
  const f = seed();
  try {
    const source = f.sources()[0]!;
    const rows = Array.from({ length: 25 }, (_, i) => ({
      ...source,
      id: (i + 1) * 10,
      text: "x".repeat(4000),
    }));
    const first = groupingBatch(rows, [], 0);
    const remaining = rows.filter((row) => row.id > 30);
    const second = groupingBatch(remaining, [], first.nextFindingCursor);
    expect(second.open[0]!.id).toBe(first.open.at(-1)!.id + 10);
    const tail = groupingBatch(rows, [], 230);
    expect(tail.open.slice(0, 3).map((row) => row.id)).toEqual([240, 250, 10]);
    expect(tail.open.length).toBe(first.open.length);
    expect(tail.cycleComplete).toBe(true);
    expect(tail.nextFindingCursor).toBe(tail.open.at(-1)!.id);
  } finally {
    f.db.close();
  }
});

test("persisted overflow IDs survive closures between daily runs", async () => {
  const f = seed();
  try {
    const source = f.sources()[0]!;
    let rows = Array.from({ length: 25 }, (_, i) => ({
      ...source,
      id: (i + 1) * 10,
      text: "x".repeat(4000),
    }));
    let now = epoch;
    const batches: number[][] = [];
    const grouping = createFindingGrouping({
      db: f.db,
      issues: f.issues,
      sources: () => rows,
      now: () => now,
      helper: async (input) => {
        batches.push(
          (
            JSON.parse(input.prompt.split("\n\n").at(-1)!) as { findings: { id: number }[] }
          ).findings.map((row) => row.id),
        );
        return { text: '{"groups":[]}' };
      },
    });
    await grouping.run("ws", new AbortController().signal);
    rows = rows.slice(3);
    now += 86400000;
    await grouping.run("ws", new AbortController().signal);
    expect(batches[1]![0]).toBe(batches[0]!.at(-1)! + 10);
  } finally {
    f.db.close();
  }
});

test("recovered runs cannot publish groups or overwrite interrupted history", async () => {
  const { recoverFindingGroupRuns } = await import("../src/db");
  const f = seed();
  try {
    await f.grouping.run("ws", new AbortController().signal);
    const before = listFindingGroups(f.db, "ws");
    let now = epoch + 86400000;
    const grouping = createFindingGrouping({
      db: f.db,
      issues: f.issues,
      sources: () => f.sources().map((row) => ({ ...row, text: row.text + " changed" })),
      now: () => now,
      helper: async () => {
        now += 12 * 60000;
        recoverFindingGroupRuns(f.db, now);
        return {
          text: JSON.stringify({
            groups: [{ title: "Fix", summary: "Shared fix", scope: "src", findingIds: f.ids }],
          }),
        };
      },
    });
    await expect(grouping.run("ws", new AbortController().signal)).rejects.toThrow(
      "no longer owns",
    );
    expect(listFindingGroups(f.db, "ws")).toEqual(before);
    expect(lastFindingGroupRun(f.db, "ws")).toMatchObject({
      status: "failed",
      error: "Grouping interrupted before completion",
      finishedAt: now,
    });
  } finally {
    f.db.close();
  }
});

test("a preempted turn consumes the daily allowance and retries on the next UTC day", async () => {
  const f = seed();
  try {
    let now = epoch;
    let attempts = 0;
    const grouping = createFindingGrouping({
      db: f.db,
      issues: f.issues,
      sources: f.sources,
      now: () => now,
      helper: async () => {
        if (++attempts === 1) throw new Error("Grouping helper preempted");
        return { text: '{"groups":[]}' };
      },
    });
    await expect(grouping.run("ws", new AbortController().signal)).rejects.toThrow("preempted");
    expect(lastFindingGroupRun(f.db, "ws")).toMatchObject({
      status: "failed",
      error: "Grouping helper preempted",
    });
    await grouping.run("ws", new AbortController().signal);
    expect(attempts).toBe(1);
    now += 86400000;
    await grouping.run("ws", new AbortController().signal);
    expect(attempts).toBe(2);
    expect(lastFindingGroupRun(f.db, "ws")?.status).toBe("completed");
  } finally {
    f.db.close();
  }
});

test("legacy position cursors start a fresh ID-based pass", async () => {
  const f = seed();
  try {
    f.db.run(
      "INSERT INTO finding_group_run(id,workspace_id,day,started_at,finished_at,fingerprint,status,finding_cursor) VALUES('legacy','ws','2026-10-27',?,?,'legacy-snapshot','completed',100)",
      [epoch - 86400000, epoch - 86400000],
    );
    const source = f.sources()[0]!;
    let firstId = 0;
    const rows = Array.from({ length: 25 }, (_, i) => ({
      ...source,
      id: (i + 1) * 10,
      text: "x".repeat(4000),
    }));
    const grouping = createFindingGrouping({
      db: f.db,
      issues: f.issues,
      sources: () => rows,
      now: () => epoch,
      helper: async (input) => {
        firstId = (JSON.parse(input.prompt.split("\n\n").at(-1)!) as { findings: { id: number }[] })
          .findings[0]!.id;
        return { text: '{"groups":[]}' };
      },
    });
    await grouping.run("ws", new AbortController().signal);
    expect(firstId).toBe(10);
  } finally {
    f.db.close();
  }
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  beginRetroCollection,
  claimImprovementDelivery,
  createRetro,
  freezeRetroInput,
  insertQueuedItem,
  listImprovementCriteria,
  listImprovementDeliveries,
  listImprovementProposals,
  listReviewFindings,
  migrate,
  openDatabase,
  publishRetro,
  recordImprovementProposal,
  putWorkspaceUser,
  recordRetroEvidence,
  recordReviewFindings,
  saveRetroSettingsRevision,
  settleImprovementDelivery,
  startRetroAttempt,
  syncWorkspaceMember,
  writeRetroArtifact,
} from "../src/db";
import { handleFindingGroupsRequest } from "../src/dashboard/src/server/finding-groups";
import { handleFindingsRequest } from "../src/dashboard/src/server/findings";
import {
  createFakeIssueLookup,
  createImprovementsHttp,
  decideInboxItem,
  ingestDailyFindings,
} from "../src/improvements";
import { createRetroReviewHttp, retroReaderAccess } from "../src/retros";
import { createFindingIssueRoute } from "../src/finding-issues";
import { issueWorkspaceSession, type WorkspacePrincipal } from "../src/workspace";

type Json = ReturnType<typeof JSON.parse>;

const A = "acme/a";
const B = "acme/b";
const START = Date.UTC(2026, 9, 22);
const END = Date.UTC(2026, 9, 29);
const ALL = ["session-a", "session-b"];
const ONLY_A = ["session-a"];

function world() {
  const root = mkdtempSync(join(tmpdir(), "paws-improvement-review-"));
  const db = openDatabase(join(root, "paws.db"));
  migrate(db);
  db.run("INSERT INTO workspace VALUES ('ws', 'org', 'Kyku', 0)");
  db.run("INSERT INTO workspace VALUES ('other', 'org-2', 'Other', 0)");
  db.run("INSERT INTO workspace_repository VALUES ('ws', ?, 'team-a')", [A]);
  db.run("INSERT INTO workspace_repository VALUES ('ws', ?, 'team-b')", [B]);
  const people: Record<string, WorkspacePrincipal> = {};
  for (const [name, role, teams] of [
    ["admin", "admin", ["team-a", "team-b"]],
    ["ada", "member", ["team-a"]],
    ["bea", "member", ["team-a"]],
  ] as const) {
    const userId = putWorkspaceUser(db, {
      id: `user-${name}`,
      linearUserId: `linear-${name}`,
      name,
      email: `${name}@example.invalid`,
    });
    syncWorkspaceMember(db, {
      workspaceId: "ws",
      userId,
      role,
      active: true,
      teamIds: teams,
      now: 1,
    });
    people[name] = { workspaceId: "ws", userId, role, authenticatedAt: 1, teamIds: teams };
  }
  for (const [suffix, repository, team] of [
    ["a", A, "team-a"],
    ["b", B, "team-b"],
  ] as const) {
    db.run(
      `INSERT INTO linear_session (session_id, organization_id, oauth_client_id, app_user_id, team_id,
         installation_observed_at, created_at) VALUES (?, 'org', 'client', 'app', ?, 1, 0)`,
      [`session-${suffix}`, team],
    );
    insertQueuedItem(db, { id: `item-${suffix}`, sessionKey: `session-${suffix}`, now: START + 1 });
    const [owner, repo] = repository.split("/");
    db.run("INSERT INTO work_item_repository VALUES (?, ?, ?, 'git@x')", [
      `item-${suffix}`,
      owner!,
      repo!,
    ]);
  }
  const retro = publishTwoRepositoryRetro(db, root);
  const lookup = createFakeIssueLookup([
    { id: "issue-open", identifier: "PAS-60", url: null, teamId: "team-a", state: "open" },
    { id: "issue-closed", identifier: "PAS-61", url: null, teamId: "team-a", state: "closed" },
    { id: "issue-b", identifier: "OPS-7", url: null, teamId: "team-b", state: "open" },
  ]);
  let clock = END + 1_000;
  const now = () => ++clock;
  const improvements = createImprovementsHttp({
    db,
    lookup: lookup.lookup,
    retroEvidence: (principal, sessionIds, retroId) =>
      retroReaderAccess(db, root, principal, sessionIds, retroId)?.readable ?? null,
    now,
  });
  const retros = createRetroReviewHttp({ db, artifactRoot: root, now });
  const call = async (
    handler: typeof improvements,
    who: string,
    path: string,
    body?: unknown,
    sessions: readonly string[] = who === "admin" ? ALL : ONLY_A,
  ) => {
    const response = await handler(
      new Request(`http://paws.test${path}`, {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      people[who]!,
      sessions,
    );
    return { status: response!.status, headers: response!.headers, response: response! };
  };
  const api = async (who: string, path: string, body?: unknown, sessions?: readonly string[]) => {
    const result = await call(improvements, who, path, body, sessions);
    return { ...result, body: (await result.response.json()) as Json };
  };
  const retroApi = (who: string, path: string, sessions?: readonly string[]) =>
    call(retros, who, path, undefined, sessions);
  return { db, root, people, lookup, api, retroApi, retro, now };
}

function publishTwoRepositoryRetro(db: ReturnType<typeof openDatabase>, root: string) {
  const { revision } = saveRetroSettingsRevision(db, {
    workspaceId: "ws",
    prompt: "Review {{period}}.\n\n{{digest}}",
    agentProfile: { agent: "codex" },
    repositories: [A, B],
    outputLimits: { maxItems: 5, workedWell: 3 },
    executionLimits: { activeMinutes: 15, retries: 1 },
    schedule: {},
    createdBy: "user-admin",
    now: 1,
  });
  createRetro(db, {
    id: "r1",
    workspaceId: "ws",
    windowStart: START,
    windowEnd: END,
    origin: "manual",
    settingsRevision: revision,
    now: END,
  });
  beginRetroCollection(db, { retroId: "r1", now: END });
  const records = [
    ["ev-a1", "item-a", "PAS-1", A],
    ["ev-a2", "item-a", "PAS-1", A],
    ["ev-b1", "item-b", "OPS-1", B],
    ["ev-b2", "item-b", "OPS-1", B],
  ] as const;
  recordRetroEvidence(
    db,
    "r1",
    records.map(([evidenceId, itemId, , repository]) => ({
      evidenceId,
      repository,
      sourceKind: "question",
      sourceRef: `question/${evidenceId}`,
      occurredAt: START + 10,
      excerpt: `Answered question in ${repository} for ${itemId}`,
    })),
  );
  const digest = {
    version: 1,
    retroId: "r1",
    sessions: [{ itemId: "item-a" }, { itemId: "item-b" }],
    records: records.map(([evidenceId, itemId, identifier, repository]) => ({
      evidenceId,
      itemId,
      identifier,
      repository,
    })),
  };
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const digestRecord = writeRetroArtifact(db, root, {
    retroId: "r1",
    kind: "digest",
    bytes: encode(digest),
    now: END,
  });
  writeRetroArtifact(db, root, { retroId: "r1", kind: "manifest", bytes: encode({}), now: END });
  writeRetroArtifact(db, root, {
    retroId: "r1",
    kind: "prompt",
    bytes: new TextEncoder().encode(`Review.\n${JSON.stringify(digest)}`),
    now: END,
  });
  freezeRetroInput(db, { retroId: "r1", endCursors: { [A]: 10, [B]: 10 }, now: END });
  const { attempt } = startRetroAttempt(db, {
    retroId: "r1",
    owner: "o",
    now: END,
    leaseMs: 60_000,
  })!;
  const counts = (identifier: string) => ({
    sessions: 1,
    events: 2,
    context: 0,
    byKind: { question: 2 },
    byWorkItem: [{ identifier, events: 2 }],
  });
  const pattern = (itemId: string, repository: string, ids: string[], identifier: string) => ({
    itemId,
    repository,
    area: "Git recovery",
    title: `Recovery repeats in ${repository}`,
    explanation: `People answered the same push question in ${repository}.`,
    hypothesis: "A durable recovery removes the question.",
    expectedBenefit: "Fewer questions.",
    evidenceIds: ids,
    action: { step: "Issue", change: "Make branch-tip recovery durable." },
    verification: "No push-recovery question in the next two retros.",
    existingIssues: [],
    counts: counts(identifier),
    priorWork: [],
  });
  const items = [
    pattern("p1", A, ["ev-a1", "ev-a2"], "PAS-1"),
    pattern("p2", B, ["ev-b1", "ev-b2"], "OPS-1"),
  ];
  const report = {
    version: 1,
    retroId: "r1",
    digestSha256: digestRecord.sha256,
    generation: "model",
    windows: [
      { repository: A, start: START, end: END },
      { repository: B, start: START, end: END },
    ],
    numbers: [{ key: "sessions", label: "sessions", value: 2 }],
    items,
    workedWell: [
      {
        repository: B,
        observation: "Review caught gaps in acme/b.",
        evidenceIds: ["ev-b1"],
        counts: counts("OPS-1"),
      },
    ],
    notes: [],
  };
  const published = publishRetro(db, {
    retroId: "r1",
    attempt,
    owner: "o",
    result: report,
    items: items.map((item) => ({
      itemId: item.itemId,
      repository: item.repository,
      area: item.area,
      actionStep: "issue" as const,
      title: item.title,
      problem: item.explanation,
      proposedChange: item.action.change,
      verificationCriterion: item.verification,
      evidenceIds: item.evidenceIds,
    })),
    now: END,
  });
  if (!published.ok) throw new Error(published.reason);
  const byItem = Object.fromEntries(
    published.items.map((item) => [item.itemId, item.improvementId]),
  );
  return { a: byItem["p1"]!, b: byItem["p2"]! };
}

function seedDaily(db: ReturnType<typeof openDatabase>) {
  recordReviewFindings(db, {
    itemId: "item-a",
    repository: A,
    head: "a".repeat(40),
    seenAt: END,
    reviewed: [],
    findings: ["src/a.ts:1", "src/b.ts:2"].map((location) => ({
      review: "independent",
      severity: "P2" as const,
      location,
      text: `Problem at ${location}`,
      bugClass: "timing",
      why: "pre-existing" as const,
    })),
  });
  const findings = listReviewFindings(db).sort((x, y) => x.id - y.id);
  const run = randomUUID();
  db.run(
    "INSERT INTO finding_group_run(id,workspace_id,day,started_at,fingerprint,status) VALUES(?,?,?,?,?,'completed')",
    [run, "ws", run, 1, "x"],
  );
  const groupId = randomUUID();
  db.run(
    `INSERT INTO finding_group(id,workspace_id,repository,team_id,title,summary,scope,member_ids,created_at,run_id,status)
     VALUES(?,?,?,?,?,?,?,?,?,?,'open')`,
    [
      groupId,
      "ws",
      A,
      "team-a",
      "Shared fix",
      "Summary",
      "src",
      JSON.stringify(findings.map((f) => f.id)),
      1,
      run,
    ],
  );
  ingestDailyFindings(db, "ws", { now: END });
  return { groupId, findings };
}

const accept = (
  version = 1,
  intent: unknown = { kind: "create", teamId: "team-a" },
  extra: Record<string, unknown> = {},
) => ({
  expectedVersion: version,
  decision: { kind: "accept", proposalVersion: 1, intent, ...extra },
});
const reject = (version = 1, reason = "Not recurring") => ({
  expectedVersion: version,
  decision: { kind: "reject", reason },
});

describe("improvement decisions", () => {
  test("two reviewers: the second conflicting decision returns the first one with 409", async () => {
    const w = world();
    const id = w.retro.a;
    const first = await w.api("ada", `/api/improvements/${id}/decision`, accept());
    expect(first.status).toBe(200);
    expect(first.body.item).toMatchObject({ reviewState: "accepted", version: 2 });
    const second = await w.api("bea", `/api/improvements/${id}/decision`, reject());
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ status: "conflict", reason: "stale" });
    expect(second.body.item).toMatchObject({
      reviewState: "accepted",
      decision: { by: "user-ada" },
    });
    const [delivery] = listImprovementDeliveries(w.db, id);
    expect(delivery).toMatchObject({ operation: "create_issue", targetTeamId: "team-a" });
    expect(delivery!.content).toMatchObject({
      proposalVersion: 1,
      title: `Recovery repeats in ${A}`,
      verificationCriterion: "No push-recovery question in the next two retros.",
    });
  });

  test("a repeated accept must match the frozen criterion and accepts the issue identifier", async () => {
    const w = world();
    const id = w.retro.a;
    const path = `/api/improvements/${id}/decision`;
    const link = { kind: "link", issue: "PAS-60" };
    expect((await w.api("ada", path, accept(1, link))).body.status).toBe("decided");
    const again = await w.api("bea", path, accept(1, link));
    expect([again.status, again.body.status]).toEqual([200, "unchanged"]);
    const same = await w.api(
      "bea",
      path,
      accept(1, link, {
        verificationCriterion: "No push-recovery question in the next two retros.",
      }),
    );
    expect(same.body.status).toBe("unchanged");
    const other = await w.api(
      "bea",
      path,
      accept(1, link, { verificationCriterion: "Something else." }),
    );
    expect([other.status, other.body.reason]).toEqual([409, "stale"]);
  });

  test("reject then accept: rejection records the reason and no delivery", async () => {
    const w = world();
    const id = w.retro.a;
    const rejected = await w.api("bea", `/api/improvements/${id}/decision`, reject());
    expect(rejected.body.item).toMatchObject({
      reviewState: "rejected",
      decision: { reason: "Not recurring" },
    });
    expect(listImprovementDeliveries(w.db, id)).toEqual([]);
    const late = await w.api("ada", `/api/improvements/${id}/decision`, accept());
    expect(late.status).toBe(409);
    expect(late.body.item.reviewState).toBe("rejected");
  });

  test("duplicate clicks return the existing result without a second delivery", async () => {
    const w = world();
    const id = w.retro.a;
    const [one, two] = await Promise.all([
      w.api("ada", `/api/improvements/${id}/decision`, accept()),
      w.api("ada", `/api/improvements/${id}/decision`, accept()),
    ]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect([one.body.status, two.body.status].sort()).toEqual(["decided", "unchanged"]);
    expect(listImprovementDeliveries(w.db, id)).toHaveLength(1);
    const again = await w.api("bea", `/api/improvements/${id}/decision`, reject(1));
    expect(again.status).toBe(409);
  });

  test("filing in flight: reject and reopen cannot undo an accepted issue", async () => {
    const w = world();
    const id = w.retro.a;
    await w.api("ada", `/api/improvements/${id}/decision`, accept());
    const [delivery] = listImprovementDeliveries(w.db, id);
    claimImprovementDelivery(w.db, {
      deliveryId: delivery!.id,
      owner: "outbox",
      now: END + 5_000,
      leaseMs: 60_000,
    });
    for (const body of [reject(2), { expectedVersion: 2, decision: { kind: "reopen" } }]) {
      const refused = await w.api("bea", `/api/improvements/${id}/decision`, body);
      expect(refused.status).toBe(409);
      expect(refused.body.reason).toBe("accepted");
    }
    const detail = await w.api("bea", `/api/improvements/${id}`);
    expect(detail.body.item.deliveries[0]).toMatchObject({ status: "pending", issue: null });
  });

  test("a filing failure stays accepted and retry reuses the same delivery", async () => {
    const w = world();
    const id = w.retro.a;
    await w.api("ada", `/api/improvements/${id}/decision`, accept());
    const [delivery] = listImprovementDeliveries(w.db, id);
    claimImprovementDelivery(w.db, {
      deliveryId: delivery!.id,
      owner: "outbox",
      now: END + 5_000,
      leaseMs: 60_000,
    });
    settleImprovementDelivery(w.db, {
      deliveryId: delivery!.id,
      attempt: 1,
      owner: "outbox",
      outcome: "failed",
      error: "Linear is unavailable",
      now: END + 6_000,
    });
    const failed = await w.api("ada", `/api/improvements/${id}`);
    expect(failed.body.item).toMatchObject({ reviewState: "accepted", lifecycle: "pending" });
    expect(failed.body.item.deliveries[0]).toMatchObject({
      status: "retryable",
      error: "Linear is unavailable",
    });
    const path = `/api/improvements/${id}/deliveries/${delivery!.id}/retry`;
    const retried = await w.api("bea", path, {});
    expect(retried.status).toBe(202);
    expect(retried.body.item.reviewState).toBe("accepted");
    expect((await w.api("bea", path, {})).body.status).toBe("in_progress");
    const after = listImprovementDeliveries(w.db, id);
    expect(after.map((d) => [d.id, d.state])).toEqual([[delivery!.id, "pending"]]);

    claimImprovementDelivery(w.db, {
      deliveryId: delivery!.id,
      owner: "outbox",
      now: END + 7_000,
      leaseMs: 60_000,
    });
    settleImprovementDelivery(w.db, {
      deliveryId: delivery!.id,
      attempt: 2,
      owner: "outbox",
      outcome: "unknown",
      now: END + 8_000,
    });
    const unknown = await w.api("bea", path, {});
    expect(unknown.status).toBe(409);
    expect(unknown.body.reason).toBe("reconciling");
  });

  test("link revalidates the issue; a link alone posts no comment", async () => {
    const w = world();
    const id = w.retro.a;
    const decide = (intent: unknown) =>
      w.api("ada", `/api/improvements/${id}/decision`, accept(1, intent));
    w.lookup.setUnavailable(true);
    const down = await decide({ kind: "link", issue: "PAS-60" });
    expect(down.status).toBe(503);
    expect(listImprovementDeliveries(w.db, id)).toEqual([]);
    w.lookup.setUnavailable(false);
    expect((await decide({ kind: "link", issue: "PAS-404" })).body.reason).toBe("issue_not_found");
    const hidden = await decide({ kind: "link", issue: "OPS-7" });
    expect(hidden.body).toMatchObject({ reason: "issue_not_found" });
    expect(JSON.stringify(hidden.body)).not.toContain("team-b");
    const mismatch = await w.api(
      "admin",
      `/api/improvements/${id}/decision`,
      accept(1, { kind: "link", issue: "OPS-7" }),
    );
    expect(mismatch.body.reason).toBe("team_mismatch");
    expect(mismatch.body.issue).toBeUndefined();
    const closed = await decide({ kind: "link", issue: "PAS-61" });
    expect([closed.status, closed.body.reason]).toEqual([409, "issue_closed"]);
    const linked = await decide({ kind: "link", issue: "PAS-60" });
    expect(linked.body.item).toMatchObject({
      reviewState: "accepted",
      decision: { intent: "link", intentIssueId: "issue-open", evidenceComment: false },
    });
    expect(listImprovementDeliveries(w.db, id).map((d) => d.operation)).toEqual(["link_issue"]);
  });

  test("a proposal that changes while Linear is read is not accepted", async () => {
    const w = world();
    const id = w.retro.a;
    const ada = w.people["ada"]!;
    const outcome = await decideInboxItem(w.db, {
      reviewer: { ...ada, repositories: [A, B], sessionIds: ONLY_A },
      improvementId: id,
      expectedVersion: 1,
      request: {
        kind: "accept",
        proposalVersion: 1,
        intent: { kind: "link", issue: "PAS-60" },
      },
      lookup: async (issue) => {
        recordImprovementProposal(w.db, {
          workspaceId: "ws",
          repository: A,
          source: { kind: "retro_item", key: "r1/p1" },
          proposal: {
            title: "Rewritten while you looked",
            problem: "Changed.",
            proposedChange: "Changed.",
            actionStep: "issue",
            verificationCriterion: "Changed.",
            evidence: ["retro:r1:ev-a1", "retro:r1:ev-a2"],
          },
          now: END + 2,
        });
        return (await w.lookup.lookup(issue))!;
      },
      now: w.now,
    });
    expect(outcome).toMatchObject({ status: "conflict", reason: "proposal_changed" });
    expect(listImprovementDeliveries(w.db, id)).toEqual([]);
  });

  test("link and add evidence freezes an explicit comment intent; closed needs explicit consent", async () => {
    const w = world();
    const id = w.retro.a;
    const linked = await w.api(
      "ada",
      `/api/improvements/${id}/decision`,
      accept(1, { kind: "link", issue: "PAS-61", allowClosed: true, addEvidenceComment: true }),
    );
    expect(linked.status).toBe(200);
    const deliveries = listImprovementDeliveries(w.db, id);
    expect(deliveries.map((d) => d.operation).sort()).toEqual(["evidence_comment", "link_issue"]);
    expect(deliveries.every((d) => d.targetIssueId === "issue-closed")).toBe(true);
    expect(deliveries[0]!.content).toMatchObject({
      issue: { identifier: "PAS-61", state: "closed" },
    });
  });

  test("create must name a destination the reviewer is authorized for", async () => {
    const w = world();
    const id = w.retro.a;
    const refused = await w.api(
      "ada",
      `/api/improvements/${id}/decision`,
      accept(1, { kind: "create", teamId: "team-b" }),
    );
    expect([refused.status, refused.body.reason]).toEqual([403, "destination"]);
    const detail = await w.api("ada", `/api/improvements/${id}`);
    expect(detail.body.destinations).toEqual(["team-a"]);
    expect((await w.api("ada", `/api/improvements/${id}/decision`, { decision: {} })).status).toBe(
      400,
    );
  });

  test("access revoked during the Linear lookup refuses the link", async () => {
    const w = world();
    const id = w.retro.a;
    const decideWhile = async (revoke: () => void) => {
      const http = createImprovementsHttp({
        db: w.db,
        lookup: async (issue) => (revoke(), w.lookup.lookup(issue)),
        now: w.now,
      });
      const response = await http(
        new Request(`http://paws.test/api/improvements/${id}/decision`, {
          method: "POST",
          body: JSON.stringify(accept(1, { kind: "link", issue: "PAS-60" })),
        }),
        w.people["ada"]!,
        ONLY_A,
      );
      return { status: response!.status, body: (await response!.json()) as Json };
    };
    let at = 2;
    const member = (active: boolean, teamIds: string[]) =>
      syncWorkspaceMember(w.db, {
        workspaceId: "ws",
        userId: "user-ada",
        role: "member",
        active,
        teamIds,
        now: at++,
      });
    const lostTeam = await decideWhile(() => member(true, []));
    expect([lostTeam.status, lostTeam.body.reason]).toEqual([404, "not_found"]);
    expect(listImprovementDeliveries(w.db, id)).toEqual([]);
    member(true, ["team-a"]);
    const revoked = await decideWhile(() => member(false, ["team-a"]));
    expect([revoked.status, revoked.body.reason]).toEqual([404, "not_found"]);
    expect(listImprovementDeliveries(w.db, id)).toEqual([]);
    member(true, ["team-a"]);
    const kept = await decideWhile(() => {});
    expect(kept.body.status).toBe("decided");
  });

  test("revoked membership loses reads and decisions; another workspace sees nothing", async () => {
    const w = world();
    const id = w.retro.a;
    syncWorkspaceMember(w.db, {
      workspaceId: "ws",
      userId: "user-bea",
      role: "member",
      active: false,
      teamIds: [],
      now: 2,
    });
    expect((await w.api("bea", "/api/improvements")).status).toBe(403);
    expect((await w.api("bea", `/api/improvements/${id}/decision`, accept())).status).toBe(403);
    expect((await w.retroApi("bea", "/api/retros/history")).status).toBe(403);
    expect(listImprovementDeliveries(w.db, id)).toEqual([]);
    w.people["outsider"] = { ...w.people["ada"]!, workspaceId: "other" };
    expect((await w.api("outsider", "/api/improvements")).status).toBe(403);
    expect((await w.api("outsider", `/api/improvements/${id}`)).status).toBe(403);
    expect((await w.retroApi("outsider", "/api/retros/reports/r1")).status).toBe(403);
  });

  test("responses are no-store and missing ids are recoverable 404s", async () => {
    const w = world();
    const list = await w.api("ada", "/api/improvements");
    expect(list.headers.get("cache-control")).toBe("no-store");
    const missing = await w.api("ada", "/api/improvements/01MISSING/decision", accept());
    expect([missing.status, missing.body.reason]).toEqual([404, "not_found"]);
    const retro = await w.retroApi("ada", "/api/retros/reports/01MISSING");
    expect(retro.status).toBe(404);
    expect(retro.headers.get("cache-control")).toBe("no-store");
  });
});

describe("daily findings share legacy claims", () => {
  test("new daily acceptance needs a criterion stored as an annotation", async () => {
    const w = world();
    seedDaily(w.db);
    const list = await w.api("ada", "/api/improvements?source=daily");
    const [daily] = list.body.items;
    expect(daily).toMatchObject({ sourceKind: "daily_finding", criterion: null });
    const path = `/api/improvements/${daily.id}/decision`;
    const proposalVersion = daily.proposal.version;
    const missing = await w.api("ada", path, accept(1, undefined, { proposalVersion }));
    expect([missing.status, missing.body.reason]).toEqual([400, "criterion_required"]);
    const accepted = await w.api(
      "ada",
      path,
      accept(
        1,
        { kind: "create", teamId: "team-a" },
        {
          verificationCriterion: "The daily review stops reporting src/a.ts:1.",
          proposalVersion,
        },
      ),
    );
    expect(accepted.body.item.criterion).toBe("The daily review stops reporting src/a.ts:1.");
    expect(listImprovementCriteria(w.db, daily.id)).toMatchObject([
      { revision: 1, actor: "user-ada" },
    ]);
    expect(
      listImprovementProposals(w.db, daily.id).every((p) => p.verificationCriterion === ""),
    ).toBe(true);
  });

  test("legacy File after inbox Create is refused, and inbox Create after a legacy claim conflicts", async () => {
    const w = world();
    const { groupId } = seedDaily(w.db);
    const [daily] = (await w.api("ada", "/api/improvements?source=daily")).body.items;
    const done = await w.api(
      "ada",
      `/api/improvements/${daily.id}/decision`,
      accept(1, undefined, {
        verificationCriterion: "Gone.",
        proposalVersion: daily.proposal.version,
      }),
    );
    expect(done.body.status).toBe("decided");
    const files: string[] = [];
    const legacy = await handleFindingGroupsRequest(
      new Request("http://paws.test/api/finding-groups", {
        method: "POST",
        body: JSON.stringify({ action: "file", id: groupId }),
      }),
      {
        db: w.db,
        principal: w.people["bea"]!,
        sessionIds: ONLY_A,
        services: {
          issues: {
            file: async (input) => (files.push(input.key), "PAS-99"),
            add: async () => {},
          },
        },
      },
    );
    expect(legacy!.status).toBe(409);
    expect(files).toEqual([]);

    const other = world();
    const seeded = seedDaily(other.db);
    other.db.run("UPDATE finding_group SET action='file' WHERE id=?", [seeded.groupId]);
    const [claimed] = (await other.api("ada", "/api/improvements?source=daily")).body.items;
    expect(claimed.lifecycle).toBe("pending");
    const refused = await other.api(
      "ada",
      `/api/improvements/${claimed.id}/decision`,
      accept(1, undefined, {
        verificationCriterion: "Gone.",
        proposalVersion: claimed.proposal.version,
      }),
    );
    expect([refused.status, refused.body.reason]).toEqual([409, "legacy"]);
  });
});

describe("legacy dismissal after an inbox accept", () => {
  test("neither a group nor a single finding can be dismissed once the inbox accepted it", async () => {
    const w = world();
    const { groupId, findings } = seedDaily(w.db);
    const [daily] = (await w.api("ada", "/api/improvements?source=daily")).body.items;
    const done = await w.api(
      "ada",
      `/api/improvements/${daily.id}/decision`,
      accept(1, undefined, {
        verificationCriterion: "Gone.",
        proposalVersion: daily.proposal.version,
      }),
    );
    expect(done.body.status).toBe("decided");
    const group = await handleFindingGroupsRequest(
      new Request("http://paws.test/api/finding-groups", {
        method: "POST",
        body: JSON.stringify({ action: "dismiss", id: groupId, reason: "Noise" }),
      }),
      { db: w.db, principal: w.people["bea"]!, sessionIds: ONLY_A },
    );
    expect(group!.status).toBe(409);
    const single = await handleFindingsRequest(
      new Request("http://paws.test/api/findings", {
        method: "POST",
        body: JSON.stringify({ action: "dismiss", id: findings[0]!.id, reason: "Noise" }),
      }),
      { db: w.db, principal: w.people["bea"]!, sessionIds: ONLY_A },
    );
    expect(single!.status).toBe(409);
    expect(listReviewFindings(w.db).every((f) => f.status === "open")).toBe(true);
  });
});

describe("individual finding issues share the inbox claim", () => {
  const ORIGIN = "https://paws.example";
  function route(w: ReturnType<typeof world>, file: () => Promise<void> = async () => {}) {
    const filed: string[] = [];
    const handle = createFindingIssueRoute({
      db: w.db,
      reviews: () => [
        {
          id: "independent-review",
          rounds: [
            {
              attempt: 1,
              baseSha: "a1c9e07",
              headSha: "91fd0c4e5b2a",
              failOn: "P1",
              findings: [
                {
                  severity: "P2",
                  location: "src/a.ts:1",
                  explanation: "Problem at src/a.ts:1",
                  evidence: "",
                  preExisting: true,
                  blocking: false,
                  since: "new",
                },
              ],
              fixed: [],
            },
          ],
        },
      ],
      file: async (request) => {
        filed.push(request.key);
        await file();
        return { id: "issue-solo", identifier: "PAS-77", url: null };
      },
      now: () => END + 50,
    });
    const { session } = issueWorkspaceSession(w.db, {
      workspaceId: "ws",
      userId: "user-bea",
      now: END,
    });
    const post = () =>
      handle(
        new Request(`${ORIGIN}/api/review-findings/issues`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: ORIGIN,
            "x-paws-csrf": session.csrfToken,
          },
          body: JSON.stringify({
            itemId: "item-a",
            reviewId: "independent-review",
            location: "src/a.ts:1",
            explanation: "Problem at src/a.ts:1",
          }),
        }),
        {
          principal: { workspaceId: "ws", userId: "user-bea" },
          session,
          origin: ORIGIN,
          sessionIds: ONLY_A,
        },
      );
    return { post, filed };
  }
  const acceptDaily = async (w: ReturnType<typeof world>) => {
    const [daily] = (await w.api("ada", "/api/improvements?source=daily")).body.items;
    return w.api(
      "ada",
      `/api/improvements/${daily.id}/decision`,
      accept(1, undefined, {
        verificationCriterion: "Gone.",
        proposalVersion: daily.proposal.version,
      }),
    );
  };

  test("an inbox accept blocks filing the same finding individually", async () => {
    const w = world();
    seedDaily(w.db);
    expect((await acceptDaily(w)).body.status).toBe("decided");
    const { post, filed } = route(w);
    const refused = await post();
    expect(refused!.status).toBe(409);
    expect(filed).toEqual([]);
  });

  test("an individual filing, finished or in flight, blocks the inbox accept", async () => {
    const w = world();
    seedDaily(w.db);
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { post, filed } = route(w, () => gate);
    const pending = post();
    await Bun.sleep(0);
    expect(filed).toHaveLength(1);
    const during = await acceptDaily(w);
    expect([during.status, during.body.reason]).toEqual([409, "legacy"]);
    release();
    expect((await pending)!.status).toBe(200);
    const after = await acceptDaily(w);
    expect([after.status, after.body.reason]).toEqual([409, "known_issue"]);
    expect(after.body.item).toMatchObject({
      issue: { identifier: "PAS-77", origin: "legacy" },
      legacy: [{ kind: "filed", issue: "PAS-77" }],
    });
    expect(listImprovementDeliveries(w.db, after.body.item.id)).toEqual([]);
  });

  test("an individual filing after a dismissed group still blocks the inbox Create", async () => {
    const w = world();
    const { groupId } = seedDaily(w.db);
    const dismissed = await handleFindingGroupsRequest(
      new Request("http://paws.test/api/finding-groups", {
        method: "POST",
        body: JSON.stringify({ action: "dismiss", id: groupId, reason: "Noise" }),
      }),
      { db: w.db, principal: w.people["bea"]!, sessionIds: ONLY_A },
    );
    expect(dismissed!.status).toBe(200);
    const { post } = route(w);
    expect((await post())!.status).toBe(200);
    const after = await acceptDaily(w);
    expect([after.status, after.body.reason]).toEqual([409, "known_issue"]);
    expect(after.body.item.issue).toMatchObject({ identifier: "PAS-77", origin: "legacy" });
    expect(listImprovementDeliveries(w.db, after.body.item.id)).toEqual([]);
  });
});

describe("partial repository access", () => {
  test("a member who reads only one of two repositories sees only that repository", async () => {
    const w = world();
    const list = await w.api("ada", "/api/improvements");
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([w.retro.a]);
    expect(list.body.counts).toMatchObject({ total: 1, weekly: 1 });
    expect(list.body.repositories).toEqual([A]);
    expect(JSON.stringify(list.body)).not.toContain(B);
    expect((await w.api("ada", `/api/improvements/${w.retro.b}`)).status).toBe(404);
    expect((await w.api("ada", `/api/improvements/${w.retro.b}/decision`, accept())).status).toBe(
      404,
    );
    const admin = await w.api("admin", "/api/improvements");
    expect(admin.body.counts.total).toBe(2);

    const history = await w.retroApi("ada", "/api/retros/history");
    const page = (await history.response.json()) as Json;
    expect(page.retros).toMatchObject([
      { id: "r1", fullAccess: false, repositories: [A], items: { visible: 1 } },
    ]);
    const report = (await (
      await w.retroApi("ada", "/api/retros/reports/r1")
    ).response.json()) as Json;
    expect(report.report.filtered).toBe(true);
    expect(report.report.items.map((i: { itemId: string }) => i.itemId)).toEqual(["p1"]);
    expect(report.report.numbers).toBeUndefined();
    expect(report.report.workedWell).toEqual([]);
    expect(report.coverageGaps).toBeNull();
    expect(JSON.stringify(report)).not.toContain(B);
    expect((await w.retroApi("ada", "/api/retros/reports/r1/items/p2/evidence")).status).toBe(404);
    const evidence = (await (
      await w.retroApi("ada", "/api/retros/reports/r1/items/p1/evidence")
    ).response.json()) as Json;
    expect(evidence.evidence.map((e: { evidenceId: string }) => e.evidenceId)).toEqual([
      "ev-a1",
      "ev-a2",
    ]);
    expect(evidence.evidence[0]).toMatchObject({
      identifier: "PAS-1",
      excerpt: `Answered question in ${A} for item-a`,
    });

    for (const file of ["digest", "report", "prompt"]) {
      const refused = await w.retroApi("ada", `/api/retros/reports/r1/${file}`);
      expect(refused.status).toBe(403);
      expect(JSON.stringify(await refused.response.json())).not.toContain(B);
    }
    expect((await w.retroApi("ada", "/api/retros/history", [])).status).toBe(200);
    const none = (await (
      await w.retroApi("ada", "/api/retros/history", [])
    ).response.json()) as Json;
    expect(none).toMatchObject({ retros: [], total: 0 });
    expect((await w.retroApi("ada", "/api/retros/reports/r1", [])).status).toBe(404);
  });

  test("readable sessions do not replace repository permission for downloads", async () => {
    const w = world();
    for (const file of ["digest", "report", "prompt"])
      expect((await w.retroApi("ada", `/api/retros/reports/r1/${file}`, ALL)).status).toBe(403);
    const report = (await (
      await w.retroApi("ada", "/api/retros/reports/r1", ALL)
    ).response.json()) as Json;
    expect(report.report.filtered).toBe(true);
    expect(JSON.stringify(report)).not.toContain(B);
    const list = await w.api("ada", "/api/improvements", undefined, ALL);
    expect(list.body.repositories).toEqual([A]);
  });

  test("full access downloads the digest, report and rendered prompt", async () => {
    const w = world();
    const digest = await w.retroApi("admin", "/api/retros/reports/r1/digest");
    expect(digest.status).toBe(200);
    expect(digest.headers.get("content-disposition")).toContain("attachment");
    expect(await digest.response.text()).toContain("ev-b1");
    const report = await w.retroApi("admin", "/api/retros/reports/r1/report");
    expect(await report.response.text()).toContain("Recovery repeats in acme/b");
    const prompt = await w.retroApi("admin", "/api/retros/reports/r1/prompt");
    expect(prompt.status).toBe(200);
    const full = (await (
      await w.retroApi("admin", "/api/retros/reports/r1")
    ).response.json()) as Json;
    expect(full.report.filtered).toBe(false);
    expect(full.report.items).toHaveLength(2);
    expect(full.report.items[0].improvement).toMatchObject({
      improvementId: w.retro.a,
      reviewState: "needs_review",
    });
    const audit = w.db
      .query<{ action: string }, []>(
        "SELECT action FROM workspace_access_audit WHERE action LIKE 'retros.%' ORDER BY id",
      )
      .all()
      .map((row) => row.action);
    expect(audit).toEqual([
      "retros.digest.downloaded",
      "retros.report.downloaded",
      "retros.prompt.downloaded",
    ]);
  });
});

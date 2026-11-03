import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  beginRetroCollection,
  claimImprovementDelivery,
  createRetro,
  decideImprovement,
  getImprovement,
  improvementBySource,
  insertQueuedItem,
  listImprovementDecisions,
  listImprovementDeliveries,
  listImprovementProposals,
  listFindingGroups,
  listImprovements,
  listReviewFindings,
  markReviewFindingFiled,
  recordImprovementProposal,
  recordRetroEvidence,
  recordReviewFindings,
  saveRetroSettingsRevision,
  setReviewFindingStatus,
  settleImprovementDelivery,
  type ReviewFindingRecord,
} from "../src/db";
import {
  dailyFindingKey,
  improvementFindings,
  improvementSourceStatus,
  inboxCounts,
  ingestDailyFindings,
  itemsForIssue,
  legacyActions,
  listInboxItems,
  reuseChoice,
} from "../src/improvements";
import { tempDb } from "./helpers";

const REPO = "acme/app";

function seed() {
  const db = tempDb();
  db.run("INSERT INTO workspace VALUES('ws','org','Workspace',1)");
  db.run(
    `INSERT INTO linear_session (session_id, organization_id, oauth_client_id, app_user_id, team_id,
      installation_observed_at, created_at) VALUES ('session', 'org', 'fixture', 'app', 'team', 1, 0)`,
  );
  insertQueuedItem(db, { id: "item", sessionKey: "session", title: "Task", now: 1 });
  recordReviewFindings(db, {
    itemId: "item",
    repository: REPO,
    head: "a".repeat(40),
    seenAt: 1000,
    reviewed: [],
    findings: ["src/a.ts:1", "src/b.ts:2", "src/c.ts:3", "src/d.ts:4"].map((location) => ({
      review: "independent",
      severity: "P2" as const,
      location,
      text: `Problem at ${location}`,
      bugClass: "timing",
      why: "pre-existing" as const,
    })),
  });
  const findings = listReviewFindings(db).sort((a, b) => a.id - b.id);
  return { db, f: findings };
}

function group(
  db: Database,
  members: readonly ReviewFindingRecord[],
  extra: { title?: string; status?: string; issue?: string; reason?: string } = {},
): string {
  const run = randomUUID();
  db.run(
    "INSERT INTO finding_group_run(id,workspace_id,day,started_at,fingerprint,status) VALUES(?,?,?,?,?,'completed')",
    [run, "ws", run, 1, "x"],
  );
  const id = randomUUID();
  db.run(
    `INSERT INTO finding_group(id,workspace_id,repository,team_id,title,summary,scope,member_ids,created_at,run_id,status,filed_issue,status_reason,action)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      "ws",
      REPO,
      "team",
      extra.title ?? "Shared fix",
      "Summary",
      "src",
      JSON.stringify(members.map((f) => f.id)),
      1,
      run,
      extra.status ?? "open",
      extra.issue ?? null,
      extra.reason ?? null,
      extra.status === "filed" ? "file" : extra.status === "dismissed" ? "dismiss" : null,
    ],
  );
  return id;
}

const regroup = (db: Database) =>
  db.run("DELETE FROM finding_group WHERE status='open' AND action IS NULL");
const owner = (db: Database, f: ReviewFindingRecord) =>
  improvementBySource(db, "ws", { kind: "daily_finding", key: dailyFindingKey(f) })?.id;

describe("daily finding sources", () => {
  test("a regrouped finding keeps its improvement when the group UUID changes", () => {
    const { db, f } = seed();
    group(db, [f[0]!, f[1]!]);
    const first = ingestDailyFindings(db, "ws", { now: 1 });
    expect(first.created).toBe(3);
    const id = owner(db, f[0]!);
    expect(owner(db, f[1]!)).toBe(id);
    expect(ingestDailyFindings(db, "ws", { now: 2 })).toMatchObject({ created: 0, changed: 0 });
    regroup(db);
    group(db, [f[0]!, f[1]!], { title: "Renamed fix" });
    expect(ingestDailyFindings(db, "ws", { now: 3 })).toMatchObject({ created: 0, changed: 1 });
    expect(owner(db, f[0]!)).toBe(id);
    expect(listImprovementProposals(db, id!).at(-1)!.title).toBe("Renamed fix");
    expect(listImprovements(db, "ws")).toHaveLength(3);
  });

  test("partial and overlapping groups never put one finding in two improvements", () => {
    const { db, f } = seed();
    group(db, [f[0]!, f[1]!]);
    ingestDailyFindings(db, "ws", { now: 1 });
    const id = owner(db, f[0]!);
    regroup(db);
    group(db, [f[1]!, f[2]!]);
    group(db, [f[0]!]);
    group(db, [f[2]!, f[3]!]);
    const result = ingestDailyFindings(db, "ws", { now: 2 });
    expect(result.split).toBeGreaterThan(0);
    expect(owner(db, f[0]!)).toBe(id);
    expect(owner(db, f[1]!)).toBe(id);
    const sources = listImprovements(db, "ws").flatMap((i) =>
      improvementFindings(db, i.id).map((m) => m.id),
    );
    expect(sources.sort()).toEqual(f.map((x) => x.id).sort());
    expect(ingestDailyFindings(db, "ws", { now: 3 })).toMatchObject({ created: 0, changed: 0 });
  });

  test("an accepted proposal keeps its text and new findings get their own improvement", () => {
    const { db, f } = seed();
    group(db, [f[0]!]);
    ingestDailyFindings(db, "ws", { now: 1 });
    const id = owner(db, f[0]!)!;
    const accepted = decideImprovement(db, {
      improvementId: id,
      expectedVersion: 1,
      review: { kind: "accept", proposalVersion: 1, intent: { kind: "create" } },
      actor: "ada",
      now: 2,
    });
    expect(accepted.ok).toBe(true);
    regroup(db);
    group(db, [f[0]!, f[3]!], { title: "Rewritten" });
    ingestDailyFindings(db, "ws", { now: 3 });
    expect(listImprovementProposals(db, id).map((p) => p.title)).toEqual(["Shared fix"]);
    const other = owner(db, f[3]!)!;
    expect(other).not.toBe(id);
    expect(listImprovementProposals(db, other).at(-1)!.evidence).toEqual([
      `review_finding:${f[3]!.key}`,
    ]);
    expect(listImprovementProposals(db, other).at(-1)!.problem).not.toContain(f[0]!.text);
  });

  test("backfill maps filed and dismissed records without decisions, deliveries or verification", () => {
    const { db, f } = seed();
    const filed = group(db, [f[0]!, f[1]!], { status: "filed", issue: "PAS-20" });
    for (const x of [f[0]!, f[1]!])
      markReviewFindingFiled(db, { key: x.key, issue: "PAS-20", by: "Ada", now: 5 });
    setReviewFindingStatus(db, {
      id: f[2]!.id,
      status: "dismissed",
      reason: "Noise",
      by: "Ada",
      now: 5,
    });
    expect(ingestDailyFindings(db, "ws", { now: 6, limit: 1 })).toMatchObject({
      units: 1,
      remaining: 2,
    });
    expect(ingestDailyFindings(db, "ws", { now: 7, limit: 1 })).toMatchObject({
      created: 1,
      remaining: 1,
    });
    expect(ingestDailyFindings(db, "ws", { now: 8, limit: 1 })).toMatchObject({
      created: 1,
      remaining: 0,
    });
    expect(ingestDailyFindings(db, "ws", { now: 9, limit: 1 })).toMatchObject({
      created: 0,
      changed: 0,
      remaining: 0,
    });
    const items = listInboxItems(db, { workspaceId: "ws" });
    expect(items).toHaveLength(3);
    const linked = items.find((i) => i.members.some((m) => m.findingId === f[0]!.id))!;
    expect(linked.lifecycle).toBe("linked");
    expect(linked.issue).toEqual({ id: null, identifier: "PAS-20", url: null, origin: "legacy" });
    expect(linked.legacy).toEqual([
      expect.objectContaining({ kind: "filed", groupId: filed, issue: "PAS-20" }),
    ]);
    expect(linked.verification).toBe("unknown");
    expect(linked.improvement.reviewState).toBe("needs_review");
    expect(linked.improvement.reviewedBy).toBeNull();
    expect(listImprovementDecisions(db, linked.improvement.id)).toEqual([]);
    expect(listImprovementDeliveries(db, linked.improvement.id)).toEqual([]);
    const dismissed = items.find((i) => i.members.some((m) => m.findingId === f[2]!.id))!;
    expect(dismissed.lifecycle).toBe("rejected");
    expect(dismissed.legacy[0]).toMatchObject({ kind: "dismissed", reason: "Noise", by: "Ada" });
    expect(reuseChoice(linked, "open")).toEqual({ kind: "reuse", issue: linked.issue! });
    expect(reuseChoice(linked, "closed")).toMatchObject({ kind: "review", reason: "closed" });
    expect(reuseChoice(linked, "unknown")).toMatchObject({ kind: "review", reason: "unconfirmed" });
    expect(inboxCounts(items)).toMatchObject({ total: 3, daily: 3, linked: 1, needsReview: 1 });
  });

  test("a claimed legacy action stays pending", () => {
    const { db, f } = seed();
    group(db, [f[0]!]);
    ingestDailyFindings(db, "ws", { now: 1 });
    const id = owner(db, f[0]!)!;
    db.run("UPDATE finding_group SET action='file'");
    const [item] = listInboxItems(db, { workspaceId: "ws" }).filter((i) => i.improvement.id === id);
    expect(item!.lifecycle).toBe("pending");
    expect(legacyActions(improvementFindings(db, id), listFindingGroups(db, "ws"))).toEqual([
      expect.objectContaining({ kind: "claimed", findingIds: [f[0]!.id] }),
    ]);
  });

  test("permission loss hides items before counts", () => {
    const { db, f } = seed();
    group(db, [f[0]!, f[1]!]);
    ingestDailyFindings(db, "ws", { now: 1 });
    expect(listInboxItems(db, { workspaceId: "ws", sessionIds: ["session"] })).toHaveLength(3);
    expect(listInboxItems(db, { workspaceId: "ws", sessionIds: ["other"] })).toEqual([]);
    expect(listInboxItems(db, { workspaceId: "ws", repositories: ["acme/other"] })).toEqual([]);
    expect(inboxCounts(listInboxItems(db, { workspaceId: "other" })).total).toBe(0);
  });
});

describe("daily findings and retros share one inbox", () => {
  test("both sources reuse one known issue and keep separate evidence", () => {
    const { db, f } = seed();
    group(db, [f[0]!], { status: "filed", issue: "PAS-20" });
    markReviewFindingFiled(db, { key: f[0]!.key, issue: "PAS-20", by: "Ada", now: 5 });
    ingestDailyFindings(db, "ws", { now: 6 });
    const { revision } = saveRetroSettingsRevision(db, {
      workspaceId: "ws",
      prompt: "Review {{digest}}",
      agentProfile: {},
      repositories: [REPO],
      outputLimits: {},
      executionLimits: {},
      schedule: {},
      createdBy: "ada",
      now: 1,
    });
    createRetro(db, {
      id: "r1",
      workspaceId: "ws",
      windowStart: 0,
      windowEnd: 10,
      origin: "manual",
      settingsRevision: revision,
      now: 1,
    });
    beginRetroCollection(db, { retroId: "r1", now: 2 });
    recordRetroEvidence(db, "r1", [
      {
        evidenceId: "e1",
        repository: REPO,
        sourceKind: "linear_question",
        sourceRef: "question:1",
        occurredAt: 1,
        excerpt: "Same repair",
      },
    ]);
    const retro = recordImprovementProposal(db, {
      workspaceId: "ws",
      repository: REPO,
      source: { kind: "retro_item", key: "r1/git" },
      proposal: {
        title: "Git recovery",
        problem: "Repeated repair",
        proposedChange: "Durable recovery",
        actionStep: "issue",
        verificationCriterion: "No repair questions",
        evidence: ["retro:r1:e1"],
      },
      now: 7,
    });
    decideImprovement(db, {
      improvementId: retro.improvementId,
      expectedVersion: 1,
      review: { kind: "accept", proposalVersion: 1, intent: { kind: "link", issueId: "issue-20" } },
      actor: "ada",
      now: 8,
    });
    const delivery = listImprovementDeliveries(db, retro.improvementId)[0]!;
    claimImprovementDelivery(db, { deliveryId: delivery.id, owner: "w", now: 9, leaseMs: 100 });
    settleImprovementDelivery(db, {
      deliveryId: delivery.id,
      attempt: 1,
      owner: "w",
      outcome: "succeeded",
      remote: { id: "issue-20", identifier: "PAS-20" },
      now: 10,
    });
    const items = listInboxItems(db, { workspaceId: "ws" });
    const shared = itemsForIssue(items, { identifier: "PAS-20" });
    expect(shared.map((i) => i.sourceKind).sort()).toEqual(["daily_finding", "retro_item"]);
    expect(shared.find((i) => i.sourceKind === "retro_item")!.proposal.evidence).toEqual([
      "retro:r1:e1",
    ]);
    const retroItem = shared.find((i) => i.sourceKind === "retro_item")!;
    expect(retroItem.criterion).toBe("No repair questions");
    expect(reuseChoice(retroItem, "open")).toMatchObject({ kind: "reuse" });
    expect(getImprovement(db, retroItem.improvement.id)!.issue!.id).toBe("issue-20");
    expect(listInboxItems(db, { workspaceId: "ws", repositories: ["acme/other"] })).toEqual([]);
    expect(inboxCounts(items)).toMatchObject({ daily: 4, weekly: 1, missingCriterion: 3 });
    expect(improvementSourceStatus(db, "ws")).toEqual({
      daily: { enabled: true, lastRun: expect.objectContaining({ status: "completed" }) },
      weekly: {
        lastRetro: {
          id: "r1",
          state: "collecting",
          windowStart: 0,
          windowEnd: 10,
          publishedAt: null,
          error: null,
          coverageGaps: 0,
        },
        nextDueAt: null,
      },
    });
  });
});

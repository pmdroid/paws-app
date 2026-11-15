import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  beginRetroCollection,
  claimImprovementDelivery,
  createRetro,
  decideImprovement,
  getImprovement,
  improvementBySource,
  insertQueuedItem,
  listImprovementDeliveries,
  listImprovementProposals,
  listImprovements,
  listReviewFindings,
  recordImprovementProposal,
  recordRetroEvidence,
  recordReviewFindings,
  saveRetroSettingsRevision,
  settleImprovementDelivery,
  insertFindingGroup,
  insertFindingGroupRun,
  type Db,
  type ReviewFindingRecord,
} from "../src/db";
import {
  dailyFindingKey,
  improvementFindings,
  improvementSourceStatus,
  inboxCounts,
  ingestDailyFindings,
  itemsForIssue,
  listInboxItemsSteps,
  reuseChoice,
  type ImprovementAccess,
} from "../src/improvements";
import { tempStore } from "./pglite";

const REPO = "acme/app";

async function seed() {
  const db = (await tempStore()).db;
  await db.run(function* (q) {
    yield* q.exec(
      q.orm
        .insert(q.t.workspace)
        .values({ id: "ws", linearOrganizationId: "org", name: "Workspace", createdAt: 1 }),
    );
    yield* q.exec(
      q.orm.insert(q.t.linearSession).values({
        sessionId: "session",
        organizationId: "org",
        oauthClientId: "fixture",
        appUserId: "app",
        teamId: "team",
        installationObservedAt: 1,
        createdAt: 0,
      }),
    );
  });
  await insertQueuedItem(db, { id: "item", sessionKey: "session", title: "Task", now: 1 });
  await recordReviewFindings(db, {
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
  const findings = (await listReviewFindings(db)).sort((a, b) => a.id - b.id);
  return { db, f: findings };
}

async function group(
  db: Db,
  members: readonly ReviewFindingRecord[],
  extra: { title?: string; status?: string; issue?: string; reason?: string } = {},
): Promise<string> {
  const run = randomUUID();
  await insertFindingGroupRun(db, {
    id: run,
    workspaceId: "ws",
    day: run,
    startedAt: 1,
    fingerprint: "x",
    status: "completed",
  });
  const id = randomUUID();
  await insertFindingGroup(db, {
    id,
    workspaceId: "ws",
    repository: REPO,
    teamId: "team",
    title: extra.title ?? "Shared fix",
    summary: "Summary",
    scope: "src",
    suggestedIssue: null,
    memberIds: members.map((f) => f.id),
    createdAt: 1,
    runId: run,
  });
  await db.run((q) =>
    q.exec(
      q.orm
        .update(q.t.findingGroup)
        .set({
          status: extra.status ?? "open",
          filedIssue: extra.issue ?? null,
          statusReason: extra.reason ?? null,
          action:
            extra.status === "filed" ? "file" : extra.status === "dismissed" ? "dismiss" : null,
        })
        .where(eq(q.t.findingGroup.id, id)),
    ),
  );
  return id;
}

const regroup = (db: Db) =>
  db.run((q) =>
    q.exec(
      q.orm
        .delete(q.t.findingGroup)
        .where(and(eq(q.t.findingGroup.status, "open"), isNull(q.t.findingGroup.action))),
    ),
  );
const listInboxItems = (db: Db, access: ImprovementAccess) =>
  db.run((q) => listInboxItemsSteps(q, access));
const owner = async (db: Db, f: ReviewFindingRecord) =>
  (
    await improvementBySource(db, "ws", {
      kind: "daily_finding",
      key: dailyFindingKey(f),
    })
  )?.id;

describe("daily finding sources", () => {
  test("a regrouped finding keeps its improvement when the group UUID changes", async () => {
    const { db, f } = await seed();
    await group(db, [f[0]!, f[1]!]);
    const first = await ingestDailyFindings(db, "ws", { now: 1 });
    expect(first.created).toBe(3);
    const id = await owner(db, f[0]!);
    expect(await owner(db, f[1]!)).toBe(id);
    expect(await ingestDailyFindings(db, "ws", { now: 2 })).toMatchObject({
      created: 0,
      changed: 0,
    });
    await regroup(db);
    await group(db, [f[0]!, f[1]!], { title: "Renamed fix" });
    expect(await ingestDailyFindings(db, "ws", { now: 3 })).toMatchObject({
      created: 0,
      changed: 1,
    });
    expect(await owner(db, f[0]!)).toBe(id);
    expect((await listImprovementProposals(db, id!)).at(-1)!.title).toBe("Renamed fix");
    expect(await listImprovements(db, "ws")).toHaveLength(3);
  });

  test("partial and overlapping groups never put one finding in two improvements", async () => {
    const { db, f } = await seed();
    await group(db, [f[0]!, f[1]!]);
    await ingestDailyFindings(db, "ws", { now: 1 });
    const id = await owner(db, f[0]!);
    await regroup(db);
    await group(db, [f[1]!, f[2]!]);
    await group(db, [f[0]!]);
    await group(db, [f[2]!, f[3]!]);
    const result = await ingestDailyFindings(db, "ws", { now: 2 });
    expect(result.split).toBeGreaterThan(0);
    expect(await owner(db, f[0]!)).toBe(id);
    expect(await owner(db, f[1]!)).toBe(id);
    const sources: number[] = [];
    for (const i of await listImprovements(db, "ws"))
      sources.push(...(await improvementFindings(db, i.id)).map((m) => m.id));
    expect(sources.sort()).toEqual(f.map((x) => x.id).sort());
    expect(await ingestDailyFindings(db, "ws", { now: 3 })).toMatchObject({
      created: 0,
      changed: 0,
    });
  });

  test("an accepted proposal keeps its text and new findings get their own improvement", async () => {
    const { db, f } = await seed();
    await group(db, [f[0]!]);
    await ingestDailyFindings(db, "ws", { now: 1 });
    const id = (await owner(db, f[0]!))!;
    const accepted = await decideImprovement(db, {
      improvementId: id,
      expectedVersion: 1,
      review: { kind: "accept", proposalVersion: 1, intent: { kind: "create" } },
      actor: "ada",
      now: 2,
    });
    expect(accepted.ok).toBe(true);
    await regroup(db);
    await group(db, [f[0]!, f[3]!], { title: "Rewritten" });
    await ingestDailyFindings(db, "ws", { now: 3 });
    expect((await listImprovementProposals(db, id)).map((p) => p.title)).toEqual(["Shared fix"]);
    const other = (await owner(db, f[3]!))!;
    expect(other).not.toBe(id);
    expect((await listImprovementProposals(db, other)).at(-1)!.evidence).toEqual([
      `review_finding:${f[3]!.key}`,
    ]);
    expect((await listImprovementProposals(db, other)).at(-1)!.problem).not.toContain(f[0]!.text);
  });

  test("a regroup into subsets keeps every owned finding in the proposal", async () => {
    const { db, f } = await seed();
    await group(db, [f[0]!, f[1]!]);
    await ingestDailyFindings(db, "ws", { now: 1 });
    const id = (await owner(db, f[0]!))!;
    await regroup(db);
    await group(db, [f[0]!], { title: "Only A" });
    await group(db, [f[1]!], { title: "Only B" });
    await ingestDailyFindings(db, "ws", { now: 2 });
    expect((await listImprovementProposals(db, id)).at(-1)!.evidence).toEqual([
      `review_finding:${f[0]!.key}`,
      `review_finding:${f[1]!.key}`,
    ]);
    expect(await ingestDailyFindings(db, "ws", { now: 3 })).toMatchObject({
      created: 0,
      changed: 0,
    });
  });

  test("restoring an earlier grouping records it again and reports one change", async () => {
    const { db, f } = await seed();
    await group(db, [f[0]!, f[1]!]);
    await ingestDailyFindings(db, "ws", { now: 1 });
    const id = (await owner(db, f[0]!))!;
    await regroup(db);
    await group(db, [f[1]!], { title: "Only B" });
    expect(await ingestDailyFindings(db, "ws", { now: 2 })).toMatchObject({ changed: 1 });
    expect((await listImprovementProposals(db, id)).at(-1)!.title).toBe("Only B");
    await regroup(db);
    await group(db, [f[0]!, f[1]!]);
    expect(await ingestDailyFindings(db, "ws", { now: 3 })).toMatchObject({ changed: 1 });
    expect((await listImprovementProposals(db, id)).at(-1)!.title).toBe("Shared fix");
    expect(await ingestDailyFindings(db, "ws", { now: 4 })).toMatchObject({ changed: 0 });
  });

  test("permission loss hides items before counts", async () => {
    const { db, f } = await seed();
    await group(db, [f[0]!, f[1]!]);
    await ingestDailyFindings(db, "ws", { now: 1 });
    expect(await listInboxItems(db, { workspaceId: "ws", sessionIds: ["session"] })).toHaveLength(
      3,
    );
    expect(await listInboxItems(db, { workspaceId: "ws", sessionIds: ["other"] })).toEqual([]);
    expect(await listInboxItems(db, { workspaceId: "ws", repositories: ["acme/other"] })).toEqual(
      [],
    );
    expect(inboxCounts(await listInboxItems(db, { workspaceId: "other" })).total).toBe(0);
  });
});

describe("daily findings and retros share one inbox", () => {
  test("both sources reuse one known issue and keep separate evidence", async () => {
    const { db, f } = await seed();
    await group(db, [f[0]!]);
    await ingestDailyFindings(db, "ws", { now: 6 });
    const dailyId = (await owner(db, f[0]!))!;
    await decideImprovement(db, {
      improvementId: dailyId,
      expectedVersion: 1,
      review: { kind: "accept", proposalVersion: 1, intent: { kind: "link", issueId: "issue-20" } },
      actor: "ada",
      now: 7,
    });
    const dailyDelivery = (await listImprovementDeliveries(db, dailyId))[0]!;
    await claimImprovementDelivery(db, {
      deliveryId: dailyDelivery.id,
      owner: "w",
      now: 8,
      leaseMs: 100,
    });
    await settleImprovementDelivery(db, {
      deliveryId: dailyDelivery.id,
      attempt: 1,
      owner: "w",
      outcome: "succeeded",
      remote: { id: "issue-20", identifier: "PAS-20" },
      now: 9,
    });
    const { revision } = await saveRetroSettingsRevision(db, {
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
    await createRetro(db, {
      id: "r1",
      workspaceId: "ws",
      windowStart: 0,
      windowEnd: 10,
      origin: "manual",
      settingsRevision: revision,
      now: 1,
    });
    await beginRetroCollection(db, { retroId: "r1", now: 2 });
    await recordRetroEvidence(db, "r1", [
      {
        evidenceId: "e1",
        repository: REPO,
        sourceKind: "linear_question",
        sourceRef: "question:1",
        occurredAt: 1,
        excerpt: "Same repair",
      },
    ]);
    const retro = await recordImprovementProposal(db, {
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
    await decideImprovement(db, {
      improvementId: retro.improvementId,
      expectedVersion: 1,
      review: { kind: "accept", proposalVersion: 1, intent: { kind: "link", issueId: "issue-20" } },
      actor: "ada",
      now: 8,
    });
    const delivery = (await listImprovementDeliveries(db, retro.improvementId))[0]!;
    await claimImprovementDelivery(db, {
      deliveryId: delivery.id,
      owner: "w",
      now: 9,
      leaseMs: 100,
    });
    await settleImprovementDelivery(db, {
      deliveryId: delivery.id,
      attempt: 1,
      owner: "w",
      outcome: "succeeded",
      remote: { id: "issue-20", identifier: "PAS-20" },
      now: 10,
    });
    const items = await listInboxItems(db, { workspaceId: "ws" });
    const shared = itemsForIssue(items, { identifier: "PAS-20" });
    expect(shared.map((i) => i.sourceKind).sort()).toEqual(["daily_finding", "retro_item"]);
    expect(shared.find((i) => i.sourceKind === "retro_item")!.proposal.evidence).toEqual([
      "retro:r1:e1",
    ]);
    const retroItem = shared.find((i) => i.sourceKind === "retro_item")!;
    expect(retroItem.criterion).toBe("No repair questions");
    expect(reuseChoice(retroItem, "open")).toMatchObject({ kind: "reuse" });
    expect((await getImprovement(db, retroItem.improvement.id))!.issue!.id).toBe("issue-20");
    expect(await listInboxItems(db, { workspaceId: "ws", repositories: ["acme/other"] })).toEqual(
      [],
    );
    expect(inboxCounts(items)).toMatchObject({ daily: 4, weekly: 1, missingCriterion: 3 });
    expect(await improvementSourceStatus(db, "ws")).toEqual({
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

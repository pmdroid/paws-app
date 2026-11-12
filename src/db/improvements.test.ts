import { describe, expect, test } from "bun:test";
import {
  claimImprovementDelivery,
  claimableImprovementDeliveries,
  decideImprovement,
  getImprovement,
  improvementBySource,
  improvementDeliveryId,
  improvementsForIssue,
  listImprovementDecisions,
  listImprovementDeliveries,
  listImprovementDeliveryAttempts,
  listImprovementOutcomes,
  listImprovementProposals,
  recordImprovementOutcome,
  recordImprovementProposal,
  settleImprovementDelivery,
  type ImprovementProposalInput,
  type ImprovementSource,
  type Db,
} from "./index";
import { seed } from "../../test/dialects";
import { tempStore } from "../../test/pglite";

const REPO = "pmdroid/paws-app";

async function harness() {
  const { db } = await tempStore();
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "ws", linearOrganizationId: "org", name: "Kyku", createdAt: 0 }),
  );
  return db;
}

const proposal: ImprovementProposalInput = {
  title: "Git recovery asks for the same repair",
  problem: "Seven issues needed the same push repair.",
  proposedChange: "Complete branch-tip recovery as a durable operation.",
  actionStep: "issue",
  verificationCriterion: "No push-recovery questions in the next two retros.",
  evidence: ["retro:r1:e1"],
};

async function propose(db: Db, source: ImprovementSource, input = proposal, attachTo?: string) {
  return await recordImprovementProposal(db, {
    workspaceId: "ws",
    repository: REPO,
    source,
    proposal: input,
    ...(attachTo === undefined ? {} : { attachTo }),
    now: 1,
  });
}

async function accept(
  db: Db,
  id: string,
  intent: Parameters<typeof decideImprovement>[1]["review"],
) {
  return await decideImprovement(db, {
    improvementId: id,
    expectedVersion: (await getImprovement(db, id))!.version,
    review: intent,
    actor: "user-1",
    now: 5,
  });
}

describe("improvement sources", () => {
  test("a source reference has one improvement and keeps every proposal version", async () => {
    const db = await harness();
    const source = { kind: "daily_finding", key: "finding:42" } as const;
    const first = await propose(db, source);
    expect(await propose(db, source)).toEqual({ ...first, created: false, changed: false });
    const revised = await propose(db, source, { ...proposal, title: "Push repair recurs" });
    expect(revised).toEqual({
      improvementId: first.improvementId,
      version: 2,
      created: false,
      changed: true,
    });
    expect(
      (await listImprovementProposals(db, first.improvementId)).map((row) => row.title),
    ).toEqual([proposal.title, "Push repair recurs"]);
  });

  test("similar text from another source stays a separate improvement", async () => {
    const db = await harness();
    const daily = await propose(db, { kind: "daily_finding", key: "finding:42" });
    const retro = await propose(db, { kind: "retro_item", key: "r1/git-recovery" });
    expect(retro.improvementId).not.toBe(daily.improvementId);
  });

  test("an overlapping group can be attached explicitly without merging evidence", async () => {
    const db = await harness();
    const first = await propose(db, { kind: "daily_finding", key: "finding:42" });
    const overlap = await propose(
      db,
      { kind: "daily_finding", key: "finding:43" },
      { ...proposal, evidence: ["finding:43"] },
      first.improvementId,
    );
    expect(overlap).toEqual({
      improvementId: first.improvementId,
      version: 2,
      created: false,
      changed: true,
    });
    expect(
      (await improvementBySource(db, "ws", { kind: "daily_finding", key: "finding:43" }))!.id,
    ).toBe(first.improvementId);
    expect(
      (await listImprovementProposals(db, first.improvementId)).map((row) => [
        row.source.key,
        row.evidence,
      ]),
    ).toEqual([
      ["finding:42", ["retro:r1:e1"]],
      ["finding:43", ["finding:43"]],
    ]);
    const other = await propose(db, { kind: "daily_finding", key: "finding:44" });
    await expect(
      propose(db, { kind: "daily_finding", key: "finding:44" }, proposal, first.improvementId),
    ).rejects.toThrow(/another improvement/);
    expect(other.created).toBe(true);
  });
});

describe("improvement decisions", () => {
  test("concurrent decisions use compare-and-set and record the actor", async () => {
    const db = await harness();
    const { improvementId } = await propose(db, { kind: "retro_item", key: "r1/a" });
    const expectedVersion = (await getImprovement(db, improvementId))!.version;
    const first = await decideImprovement(db, {
      improvementId,
      expectedVersion,
      review: { kind: "reject", reason: "Already fixed" },
      actor: "user-1",
      now: 5,
    });
    const second = await decideImprovement(db, {
      improvementId,
      expectedVersion,
      review: { kind: "accept", proposalVersion: 1, intent: { kind: "create" } },
      actor: "user-2",
      now: 6,
    });
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, reason: "stale" });
    expect(await getImprovement(db, improvementId)).toMatchObject({
      reviewState: "rejected",
      reviewedBy: "user-1",
      reviewedAt: 5,
      reviewReason: "Already fixed",
    });
    expect(await listImprovementDeliveries(db, improvementId)).toEqual([]);
  });

  test("an accepted item keeps its decision through failed and unknown delivery", async () => {
    const db = await harness();
    const { improvementId } = await propose(db, { kind: "retro_item", key: "r1/a" });
    expect(
      (
        await accept(db, improvementId, {
          kind: "accept",
          proposalVersion: 1,
          intent: { kind: "create" },
        })
      ).ok,
    ).toBe(true);
    expect(
      await accept(db, improvementId, { kind: "reject", reason: "changed my mind" }),
    ).toMatchObject({
      ok: false,
      reason: "accepted",
    });
    const [delivery] = await listImprovementDeliveries(db, improvementId);
    expect(delivery!.id).toBe(improvementDeliveryId(improvementId, "create_issue"));

    const claim = { deliveryId: delivery!.id, owner: "w1", now: 10, leaseMs: 100 };
    expect((await claimImprovementDelivery(db, claim))!.attempts).toBe(1);
    expect(await claimImprovementDelivery(db, { ...claim, owner: "w2" })).toBeNull();
    await settleImprovementDelivery(db, {
      deliveryId: delivery!.id,
      attempt: 1,
      owner: "w1",
      outcome: "failed",
      error: "Linear unavailable",
      now: 11,
    });
    expect((await getImprovement(db, improvementId))!.reviewState).toBe("accepted");

    await claimImprovementDelivery(db, { ...claim, owner: "w2", now: 20 });
    await settleImprovementDelivery(db, {
      deliveryId: delivery!.id,
      attempt: 2,
      owner: "w2",
      outcome: "unknown",
      error: "Response lost",
      now: 21,
    });
    expect((await claimableImprovementDeliveries(db, "ws", 22)).map((row) => row.id)).toEqual([
      delivery!.id,
    ]);
    await claimImprovementDelivery(db, { ...claim, owner: "w3", now: 30 });
    expect(
      await settleImprovementDelivery(db, {
        deliveryId: delivery!.id,
        attempt: 3,
        owner: "w3",
        outcome: "succeeded",
        remote: { id: "issue-1", identifier: "PAS-1100", url: "https://linear.app/x" },
        now: 31,
      }),
    ).toBe(true);
    expect(await listImprovementDeliveries(db, improvementId)).toMatchObject([
      { id: delivery!.id, state: "succeeded", attempts: 3, remoteId: "issue-1" },
    ]);
    expect(await getImprovement(db, improvementId)).toMatchObject({
      reviewState: "accepted",
      issue: { id: "issue-1", identifier: "PAS-1100", confirmedAt: 31 },
    });
    expect(
      (await listImprovementDeliveryAttempts(db, delivery!.id)).map((row) => [
        row.attempt,
        row.owner,
        row.outcome,
        row.error,
        row.settledAt,
      ]),
    ).toEqual([
      [1, "w1", "failed", "Linear unavailable", 11],
      [2, "w2", "unknown", "Response lost", 21],
      [3, "w3", "succeeded", null, 31],
    ]);
    expect(await claimableImprovementDeliveries(db, "ws", 40)).toEqual([]);
    expect(
      (await listImprovementDecisions(db, improvementId)).map((row) => row.reviewState),
    ).toEqual(["accepted"]);
  });

  test("an expired claim can be retaken and the old owner cannot settle it", async () => {
    const db = await harness();
    const { improvementId } = await propose(db, { kind: "retro_item", key: "r1/a" });
    await accept(db, improvementId, {
      kind: "accept",
      proposalVersion: 1,
      intent: { kind: "create" },
    });
    const id = improvementDeliveryId(improvementId, "create_issue");
    await claimImprovementDelivery(db, {
      deliveryId: id,
      owner: "w1",
      now: 10,
      leaseMs: 5,
    });
    expect(
      await claimImprovementDelivery(db, {
        deliveryId: id,
        owner: "w2",
        now: 15,
        leaseMs: 5,
      }),
    ).not.toBeNull();
    expect(
      await settleImprovementDelivery(db, {
        deliveryId: id,
        attempt: 1,
        owner: "w1",
        outcome: "succeeded",
        remote: { id: "issue-1" },
        now: 16,
      }),
    ).toBe(false);
    expect((await listImprovementDeliveryAttempts(db, id)).map((row) => row.outcome)).toEqual([
      "expired",
      "claimed",
    ]);
  });

  test("a late response from an expired attempt cannot settle a retry by the same owner", async () => {
    const db = await harness();
    const { improvementId } = await propose(db, { kind: "retro_item", key: "r1/a" });
    await accept(db, improvementId, {
      kind: "accept",
      proposalVersion: 1,
      intent: { kind: "create" },
    });
    const id = improvementDeliveryId(improvementId, "create_issue");
    await claimImprovementDelivery(db, {
      deliveryId: id,
      owner: "w",
      now: 10,
      leaseMs: 5,
    });
    expect(
      (await claimImprovementDelivery(db, {
        deliveryId: id,
        owner: "w",
        now: 15,
        leaseMs: 5,
      }))!.attempts,
    ).toBe(2);
    const settle = { deliveryId: id, owner: "w", now: 16 };
    expect(
      await settleImprovementDelivery(db, {
        ...settle,
        attempt: 1,
        outcome: "failed",
        error: "late",
      }),
    ).toBe(false);
    expect(
      await settleImprovementDelivery(db, {
        ...settle,
        attempt: 2,
        outcome: "succeeded",
        remote: { id: "issue-1" },
      }),
    ).toBe(true);
    expect((await listImprovementDeliveries(db, improvementId))[0]).toMatchObject({
      state: "succeeded",
      error: null,
    });
  });

  test("two sources link to one issue and keep their own evidence", async () => {
    const db = await harness();
    const daily = await propose(db, { kind: "daily_finding", key: "finding:42" });
    const retro = await propose(
      db,
      { kind: "retro_item", key: "r1/a" },
      { ...proposal, evidence: ["retro:r1:e9"] },
    );
    for (const { improvementId } of [daily, retro]) {
      await accept(db, improvementId, {
        kind: "accept",
        proposalVersion: 1,
        intent: { kind: "link", issueId: "issue-7" },
      });
      const id = improvementDeliveryId(improvementId, "link_issue");
      await claimImprovementDelivery(db, {
        deliveryId: id,
        owner: "w",
        now: 10,
        leaseMs: 5,
      });
      await settleImprovementDelivery(db, {
        deliveryId: id,
        attempt: 1,
        owner: "w",
        outcome: "succeeded",
        remote: { id: "issue-7", identifier: "PAS-860" },
        now: 11,
      });
    }
    expect((await improvementsForIssue(db, "ws", "issue-7")).map((row) => row.id).sort()).toEqual(
      [daily.improvementId, retro.improvementId].sort(),
    );
    expect((await listImprovementProposals(db, retro.improvementId))[0]!.evidence).toEqual([
      "retro:r1:e9",
    ]);
    expect(
      (await listImprovementDeliveries(db, daily.improvementId)).map((row) => row.operation),
    ).toEqual(["link_issue"]);
  });

  test("an evidence comment is a separate delivery only when asked for", async () => {
    const db = await harness();
    const { improvementId } = await propose(db, { kind: "retro_item", key: "r1/a" });
    await accept(db, improvementId, {
      kind: "accept",
      proposalVersion: 1,
      intent: { kind: "link", issueId: "issue-7", addEvidenceComment: true },
    });
    expect(
      (await listImprovementDeliveries(db, improvementId)).map((row) => [
        row.operation,
        row.targetIssueId,
      ]),
    ).toEqual([
      ["evidence_comment", "issue-7"],
      ["link_issue", "issue-7"],
    ]);
    expect((await getImprovement(db, improvementId))!.evidenceComment).toBe(true);
  });
});

describe("improvement outcomes", () => {
  test("implementation and verification evolve independently and stay unknown by default", async () => {
    const db = await harness();
    const { improvementId } = await propose(db, { kind: "retro_item", key: "r1/a" });
    expect(await getImprovement(db, improvementId)).toMatchObject({
      implementationState: "unknown",
      verificationState: "unknown",
    });
    await recordImprovementOutcome(db, {
      improvementId,
      track: "implementation",
      state: "merged",
      evidence: ["pull:1300"],
      actor: "paws",
      now: 10,
    });
    expect(await getImprovement(db, improvementId)).toMatchObject({
      implementationState: "merged",
      verificationState: "unknown",
    });
    await expect(
      recordImprovementOutcome(db, {
        improvementId,
        track: "verification",
        state: "verified",
        evidence: [],
        actor: "user-1",
        now: 11,
      }),
    ).rejects.toThrow(/evidence/);
    await recordImprovementOutcome(db, {
      improvementId,
      track: "verification",
      state: "verified",
      evidence: ["retro:r2:coverage"],
      revision: "abc123",
      actor: "user-1",
      now: 12,
    });
    await recordImprovementOutcome(db, {
      improvementId,
      track: "implementation",
      state: "in_progress",
      evidence: ["issue reopened"],
      actor: "paws",
      now: 13,
    });
    expect(await getImprovement(db, improvementId)).toMatchObject({
      implementationState: "in_progress",
      verificationState: "verified",
      verificationAt: 12,
    });
    expect(
      (await listImprovementOutcomes(db, improvementId)).map((row) => [
        row.track,
        row.state,
        row.revision,
      ]),
    ).toEqual([
      ["implementation", "merged", null],
      ["verification", "verified", "abc123"],
      ["implementation", "in_progress", null],
    ]);
  });
});

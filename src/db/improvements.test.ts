import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
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
  listImprovementOutcomes,
  listImprovementProposals,
  migrate,
  openDatabase,
  recordImprovementOutcome,
  recordImprovementProposal,
  settleImprovementDelivery,
  type ImprovementProposalInput,
  type ImprovementSource,
} from "./index";

const REPO = "pmdroid/paws-app";

function harness(): Database {
  const db = openDatabase(":memory:");
  migrate(db);
  db.run("INSERT INTO workspace VALUES ('ws', 'org', 'Kyku', 0)");
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

function propose(db: Database, source: ImprovementSource, input = proposal, attachTo?: string) {
  return recordImprovementProposal(db, {
    workspaceId: "ws",
    repository: REPO,
    source,
    proposal: input,
    ...(attachTo === undefined ? {} : { attachTo }),
    now: 1,
  });
}

function accept(
  db: Database,
  id: string,
  intent: Parameters<typeof decideImprovement>[1]["review"],
) {
  return decideImprovement(db, {
    improvementId: id,
    expectedVersion: getImprovement(db, id)!.version,
    review: intent,
    actor: "user-1",
    now: 5,
  });
}

describe("improvement sources", () => {
  test("a source reference has one improvement and keeps every proposal version", () => {
    const db = harness();
    const source = { kind: "daily_finding", key: "finding:42" } as const;
    const first = propose(db, source);
    expect(propose(db, source)).toEqual({ ...first, created: false, changed: false });
    const revised = propose(db, source, { ...proposal, title: "Push repair recurs" });
    expect(revised).toEqual({
      improvementId: first.improvementId,
      version: 2,
      created: false,
      changed: true,
    });
    expect(listImprovementProposals(db, first.improvementId).map((row) => row.title)).toEqual([
      proposal.title,
      "Push repair recurs",
    ]);
    expect(() => db.run("UPDATE improvement_proposal SET title = 'x'")).toThrow(/immutable/);
  });

  test("similar text from another source stays a separate improvement", () => {
    const db = harness();
    const daily = propose(db, { kind: "daily_finding", key: "finding:42" });
    const retro = propose(db, { kind: "retro_item", key: "r1/git-recovery" });
    expect(retro.improvementId).not.toBe(daily.improvementId);
  });

  test("an overlapping group can be attached explicitly without merging evidence", () => {
    const db = harness();
    const first = propose(db, { kind: "daily_finding", key: "finding:42" });
    const overlap = propose(
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
    expect(improvementBySource(db, "ws", { kind: "daily_finding", key: "finding:43" })!.id).toBe(
      first.improvementId,
    );
    expect(
      listImprovementProposals(db, first.improvementId).map((row) => [
        row.source.key,
        row.evidence,
      ]),
    ).toEqual([
      ["finding:42", ["retro:r1:e1"]],
      ["finding:43", ["finding:43"]],
    ]);
    const other = propose(db, { kind: "daily_finding", key: "finding:44" });
    expect(() =>
      propose(db, { kind: "daily_finding", key: "finding:44" }, proposal, first.improvementId),
    ).toThrow(/another improvement/);
    expect(other.created).toBe(true);
  });
});

describe("improvement decisions", () => {
  test("concurrent decisions use compare-and-set and record the actor", () => {
    const db = harness();
    const { improvementId } = propose(db, { kind: "retro_item", key: "r1/a" });
    const expectedVersion = getImprovement(db, improvementId)!.version;
    const first = decideImprovement(db, {
      improvementId,
      expectedVersion,
      review: { kind: "reject", reason: "Already fixed" },
      actor: "user-1",
      now: 5,
    });
    const second = decideImprovement(db, {
      improvementId,
      expectedVersion,
      review: { kind: "accept", proposalVersion: 1, intent: { kind: "create" } },
      actor: "user-2",
      now: 6,
    });
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, reason: "stale" });
    expect(getImprovement(db, improvementId)).toMatchObject({
      reviewState: "rejected",
      reviewedBy: "user-1",
      reviewedAt: 5,
      reviewReason: "Already fixed",
    });
    expect(listImprovementDeliveries(db, improvementId)).toEqual([]);
  });

  test("an accepted item keeps its decision through failed and unknown delivery", () => {
    const db = harness();
    const { improvementId } = propose(db, { kind: "retro_item", key: "r1/a" });
    expect(
      accept(db, improvementId, {
        kind: "accept",
        proposalVersion: 1,
        intent: { kind: "create" },
      }).ok,
    ).toBe(true);
    expect(accept(db, improvementId, { kind: "reject", reason: "changed my mind" })).toMatchObject({
      ok: false,
      reason: "accepted",
    });
    const [delivery] = listImprovementDeliveries(db, improvementId);
    expect(delivery!.id).toBe(improvementDeliveryId(improvementId, "create_issue"));

    const claim = { deliveryId: delivery!.id, owner: "w1", now: 10, leaseMs: 100 };
    expect(claimImprovementDelivery(db, claim)!.attempts).toBe(1);
    expect(claimImprovementDelivery(db, { ...claim, owner: "w2" })).toBeNull();
    settleImprovementDelivery(db, {
      deliveryId: delivery!.id,
      owner: "w1",
      outcome: "failed",
      error: "Linear unavailable",
      now: 11,
    });
    expect(getImprovement(db, improvementId)!.reviewState).toBe("accepted");

    claimImprovementDelivery(db, { ...claim, owner: "w2", now: 20 });
    settleImprovementDelivery(db, {
      deliveryId: delivery!.id,
      owner: "w2",
      outcome: "unknown",
      error: "Response lost",
      now: 21,
    });
    expect(claimableImprovementDeliveries(db, "ws", 22).map((row) => row.id)).toEqual([
      delivery!.id,
    ]);
    claimImprovementDelivery(db, { ...claim, owner: "w3", now: 30 });
    expect(
      settleImprovementDelivery(db, {
        deliveryId: delivery!.id,
        owner: "w3",
        outcome: "succeeded",
        remote: { id: "issue-1", identifier: "PAS-1100", url: "https://linear.app/x" },
        now: 31,
      }),
    ).toBe(true);
    expect(listImprovementDeliveries(db, improvementId)).toMatchObject([
      { id: delivery!.id, state: "succeeded", attempts: 3, remoteId: "issue-1" },
    ]);
    expect(getImprovement(db, improvementId)).toMatchObject({
      reviewState: "accepted",
      issue: { id: "issue-1", identifier: "PAS-1100", confirmedAt: 31 },
    });
    expect(claimableImprovementDeliveries(db, "ws", 40)).toEqual([]);
    expect(listImprovementDecisions(db, improvementId).map((row) => row.reviewState)).toEqual([
      "accepted",
    ]);
  });

  test("an expired claim can be retaken and the old owner cannot settle it", () => {
    const db = harness();
    const { improvementId } = propose(db, { kind: "retro_item", key: "r1/a" });
    accept(db, improvementId, { kind: "accept", proposalVersion: 1, intent: { kind: "create" } });
    const id = improvementDeliveryId(improvementId, "create_issue");
    claimImprovementDelivery(db, { deliveryId: id, owner: "w1", now: 10, leaseMs: 5 });
    expect(
      claimImprovementDelivery(db, { deliveryId: id, owner: "w2", now: 15, leaseMs: 5 }),
    ).not.toBeNull();
    expect(
      settleImprovementDelivery(db, {
        deliveryId: id,
        owner: "w1",
        outcome: "succeeded",
        remote: { id: "issue-1" },
        now: 16,
      }),
    ).toBe(false);
  });

  test("two sources link to one issue and keep their own evidence", () => {
    const db = harness();
    const daily = propose(db, { kind: "daily_finding", key: "finding:42" });
    const retro = propose(
      db,
      { kind: "retro_item", key: "r1/a" },
      { ...proposal, evidence: ["retro:r1:e9"] },
    );
    for (const { improvementId } of [daily, retro]) {
      accept(db, improvementId, {
        kind: "accept",
        proposalVersion: 1,
        intent: { kind: "link", issueId: "issue-7" },
      });
      const id = improvementDeliveryId(improvementId, "link_issue");
      claimImprovementDelivery(db, { deliveryId: id, owner: "w", now: 10, leaseMs: 5 });
      settleImprovementDelivery(db, {
        deliveryId: id,
        owner: "w",
        outcome: "succeeded",
        remote: { id: "issue-7", identifier: "PAS-860" },
        now: 11,
      });
    }
    expect(
      improvementsForIssue(db, "ws", "issue-7")
        .map((row) => row.id)
        .sort(),
    ).toEqual([daily.improvementId, retro.improvementId].sort());
    expect(listImprovementProposals(db, retro.improvementId)[0]!.evidence).toEqual(["retro:r1:e9"]);
    expect(listImprovementDeliveries(db, daily.improvementId).map((row) => row.operation)).toEqual([
      "link_issue",
    ]);
  });

  test("an evidence comment is a separate delivery only when asked for", () => {
    const db = harness();
    const { improvementId } = propose(db, { kind: "retro_item", key: "r1/a" });
    accept(db, improvementId, {
      kind: "accept",
      proposalVersion: 1,
      intent: { kind: "link", issueId: "issue-7", addEvidenceComment: true },
    });
    expect(
      listImprovementDeliveries(db, improvementId).map((row) => [row.operation, row.targetIssueId]),
    ).toEqual([
      ["evidence_comment", "issue-7"],
      ["link_issue", "issue-7"],
    ]);
    expect(getImprovement(db, improvementId)!.evidenceComment).toBe(true);
  });
});

describe("improvement outcomes", () => {
  test("implementation and verification evolve independently and stay unknown by default", () => {
    const db = harness();
    const { improvementId } = propose(db, { kind: "retro_item", key: "r1/a" });
    expect(getImprovement(db, improvementId)).toMatchObject({
      implementationState: "unknown",
      verificationState: "unknown",
    });
    recordImprovementOutcome(db, {
      improvementId,
      track: "implementation",
      state: "merged",
      evidence: ["pull:1300"],
      actor: "paws",
      now: 10,
    });
    expect(getImprovement(db, improvementId)).toMatchObject({
      implementationState: "merged",
      verificationState: "unknown",
    });
    expect(() =>
      recordImprovementOutcome(db, {
        improvementId,
        track: "verification",
        state: "verified",
        evidence: [],
        actor: "user-1",
        now: 11,
      }),
    ).toThrow(/evidence/);
    recordImprovementOutcome(db, {
      improvementId,
      track: "verification",
      state: "verified",
      evidence: ["retro:r2:coverage"],
      revision: "abc123",
      actor: "user-1",
      now: 12,
    });
    recordImprovementOutcome(db, {
      improvementId,
      track: "implementation",
      state: "in_progress",
      evidence: ["issue reopened"],
      actor: "paws",
      now: 13,
    });
    expect(getImprovement(db, improvementId)).toMatchObject({
      implementationState: "in_progress",
      verificationState: "verified",
      verificationAt: 12,
    });
    expect(
      listImprovementOutcomes(db, improvementId).map((row) => [row.track, row.state, row.revision]),
    ).toEqual([
      ["implementation", "merged", null],
      ["verification", "verified", "abc123"],
      ["implementation", "in_progress", null],
    ]);
    expect(() => db.run("UPDATE improvement_outcome SET state = 'x'")).toThrow(/immutable/);
  });
});

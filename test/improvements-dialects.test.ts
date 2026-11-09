import { expect, test } from "bun:test";
import {
  acceptedImprovementsForFindingsSteps,
  cancelImprovementEvidenceCommentSteps,
  claimableImprovementDeliveriesSteps,
  claimImprovementDeliverySteps,
  decideImprovementSteps,
  getImprovementSteps,
  improvementBySourceSteps,
  improvementDeliveryId,
  improvementDeliveryWorkspacesSteps,
  improvementsForIssueSteps,
  improvementWithdrawableSteps,
  listImprovementCriteriaSteps,
  listImprovementDecisionsSteps,
  listImprovementDeliveriesSteps,
  listImprovementDeliveryAttemptsSteps,
  listImprovementOutcomesSteps,
  listImprovementProposalsSteps,
  listImprovementsSteps,
  recordImprovementOutcomeSteps,
  recordImprovementProposalSteps,
  repairImprovementDestinationSteps,
  requeueImprovementDeliverySteps,
  reserveImprovementDeliveryRemoteSteps,
  settleImprovementDeliverySteps,
  type Db,
  type ImprovementProposalInput,
  type ImprovementSource,
} from "../src/db";
import { forEachDialect, seed } from "./dialects";

const proposal: ImprovementProposalInput = {
  title: "Run the formatter first",
  problem: "Format checks fail late",
  proposedChange: "Format before the first check",
  actionStep: "rule",
  verificationCriterion: "No format failure in a week",
  evidence: ["run-1", "run-2"],
};

function seedWorkspace(db: Db, id = "ws") {
  return seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id, linearOrganizationId: `org-${id}`, name: id, createdAt: 0 }),
  );
}

function propose(
  db: Db,
  source: ImprovementSource,
  extra: { attachTo?: string; now?: number } = {},
) {
  return db.transaction((q) =>
    recordImprovementProposalSteps(q, {
      workspaceId: "ws",
      repository: "acme/app",
      source,
      proposal,
      now: 1_000,
      ...extra,
    }),
  );
}

async function accepted(db: Db, intent: "create" | "link", now = 2_000) {
  const { improvementId } = await propose(db, { kind: "retro_item", key: `item-${intent}` });
  const result = await db.transaction((q) =>
    decideImprovementSteps(q, {
      improvementId,
      expectedVersion: 1,
      review: {
        kind: "accept",
        proposalVersion: 1,
        intent:
          intent === "create"
            ? { kind: "create", teamId: "team" }
            : { kind: "link", issueId: "issue-1", addEvidenceComment: true },
      },
      actor: "ada",
      now,
      content: { title: "T", nested: { list: [1, null] } },
      criterion: "Check it",
    }),
  );
  if (!result.ok) throw new Error(result.reason);
  return improvementId;
}

forEachDialect((open) => {
  test("a proposal creates an improvement once and versions a changed one", async () => {
    const { db, close } = await open();
    try {
      await seedWorkspace(db);
      const source = { kind: "daily_finding", key: "f#7:a" } as const;
      const first = await propose(db, source);
      expect(first).toMatchObject({ version: 1, created: true, changed: true });
      expect(await propose(db, source)).toEqual({ ...first, created: false, changed: false });
      const attached = await propose(
        db,
        { kind: "retro_item", key: "r" },
        {
          attachTo: first.improvementId,
        },
      );
      expect(attached).toEqual({ ...first, version: 2, created: false, changed: true });
      expect(propose(db, source, { attachTo: "other" })).rejects.toThrow("another improvement");

      const improvement = await db.run((q) => getImprovementSteps(q, first.improvementId));
      expect(improvement).toMatchObject({
        workspaceId: "ws",
        repository: "acme/app",
        createdAt: 1_000,
        version: 1,
        reviewState: "needs_review",
        evidenceComment: false,
        issue: null,
        implementationState: "unknown",
      });
      expect(await db.run((q) => getImprovementSteps(q, "missing"))).toBeNull();
      expect(await db.run((q) => improvementBySourceSteps(q, "ws", source))).toEqual(improvement);
      expect(await db.run((q) => listImprovementsSteps(q, "ws"))).toEqual([improvement!]);
      const proposals = await db.run((q) => listImprovementProposalsSteps(q, first.improvementId));
      expect(proposals.map((row) => [row.version, row.source.key, row.evidence])).toEqual([
        [1, "f#7:a", ["run-1", "run-2"]],
        [2, "r", ["run-1", "run-2"]],
      ]);
    } finally {
      await close();
    }
  });

  test("an accepted link records its decision, deliveries and criterion", async () => {
    const { db, close } = await open();
    try {
      await seedWorkspace(db);
      const id = await accepted(db, "link");
      expect(await db.run((q) => getImprovementSteps(q, id))).toMatchObject({
        version: 2,
        reviewState: "accepted",
        intent: "link",
        intentIssueId: "issue-1",
        evidenceComment: true,
      });
      expect(await db.run((q) => listImprovementDecisionsSteps(q, id))).toEqual([
        {
          improvementId: id,
          version: 2,
          reviewState: "accepted",
          proposalVersion: 1,
          intent: "link",
          intentIssueId: "issue-1",
          evidenceComment: true,
          reason: null,
          actor: "ada",
          at: 2_000,
        },
      ]);
      expect(await db.run((q) => listImprovementCriteriaSteps(q, id))).toEqual([
        { revision: 1, proposalVersion: 1, criterion: "Check it", actor: "ada", at: 2_000 },
      ]);
      const deliveries = await db.run((q) => listImprovementDeliveriesSteps(q, id));
      expect(deliveries.map((d) => [d.operation, d.state, d.content])).toEqual([
        ["evidence_comment", "pending", { title: "T", nested: { list: [1, null] } }],
        ["link_issue", "pending", { title: "T", nested: { list: [1, null] } }],
      ]);
      expect(deliveries[1]!.id).toBe(improvementDeliveryId(id, "link_issue"));
      const stale = await db.transaction((q) =>
        decideImprovementSteps(q, {
          improvementId: id,
          expectedVersion: 1,
          review: { kind: "reject", reason: "no" },
          actor: "ada",
          now: 3_000,
        }),
      );
      expect(stale).toMatchObject({ ok: false, reason: "stale" });
    } finally {
      await close();
    }
  });

  test("a blocked link can be withdrawn and its evidence comment cancelled", async () => {
    const { db, close } = await open();
    try {
      await seedWorkspace(db);
      const id = await accepted(db, "link");
      const link = improvementDeliveryId(id, "link_issue");
      const comment = improvementDeliveryId(id, "evidence_comment");
      expect(await db.run((q) => improvementWithdrawableSteps(q, id))).toBe(false);
      await db.transaction((q) =>
        claimImprovementDeliverySteps(q, { deliveryId: link, owner: "o", now: 3_000, leaseMs: 10 }),
      );
      await db.transaction((q) =>
        settleImprovementDeliverySteps(q, {
          deliveryId: link,
          attempt: 1,
          owner: "o",
          outcome: "failed",
          blocked: "unauthorized",
          error: "denied",
          now: 3_001,
        }),
      );
      expect(await db.run((q) => improvementWithdrawableSteps(q, id))).toBe(true);
      expect(await db.transaction((q) => cancelImprovementEvidenceCommentSteps(q, comment))).toBe(
        null,
      );
      const reopened = await db.transaction((q) =>
        decideImprovementSteps(q, {
          improvementId: id,
          expectedVersion: 2,
          review: { kind: "reopen" },
          actor: "ada",
          now: 4_000,
        }),
      );
      expect(reopened).toMatchObject({ ok: true, improvement: { reviewState: "needs_review" } });
      expect(await db.run((q) => listImprovementDeliveriesSteps(q, id))).toEqual([]);
    } finally {
      await close();
    }
  });

  test("a delivery is claimed, reserved, settled and recorded on the improvement", async () => {
    const { db, close } = await open();
    try {
      await seedWorkspace(db);
      const id = await accepted(db, "create");
      const delivery = improvementDeliveryId(id, "create_issue");
      expect(await db.run((q) => improvementDeliveryWorkspacesSteps(q, 2_000))).toEqual(["ws"]);
      expect(
        (await db.run((q) => claimableImprovementDeliveriesSteps(q, "ws", 2_000))).map((d) => d.id),
      ).toEqual([delivery]);
      const claim = { deliveryId: delivery, owner: "o", now: 3_000, leaseMs: 100 };
      expect(await db.transaction((q) => claimImprovementDeliverySteps(q, claim))).toMatchObject({
        state: "claimed",
        claimOwner: "o",
        claimExpiresAt: 3_100,
        attempts: 1,
      });
      expect(await db.transaction((q) => claimImprovementDeliverySteps(q, claim))).toBeNull();
      expect(await db.run((q) => claimableImprovementDeliveriesSteps(q, "ws", 3_050))).toEqual([]);
      const reserve = { deliveryId: delivery, owner: "o", attempt: 1, remoteId: "r-1" };
      expect(await db.run((q) => reserveImprovementDeliveryRemoteSteps(q, reserve))).toBe(true);
      expect(
        await db.run((q) =>
          reserveImprovementDeliveryRemoteSteps(q, { ...reserve, remoteId: "x" }),
        ),
      ).toBe(false);
      const settle = {
        deliveryId: delivery,
        attempt: 1,
        owner: "o",
        outcome: "succeeded",
        remote: { id: "r-1", identifier: "PAS-1", url: "https://linear/PAS-1" },
        now: 3_010,
      } as const;
      expect(await db.transaction((q) => settleImprovementDeliverySteps(q, settle))).toBe(true);
      expect(await db.transaction((q) => settleImprovementDeliverySteps(q, settle))).toBe(false);
      expect(await db.run((q) => listImprovementDeliveryAttemptsSteps(q, delivery))).toEqual([
        {
          attempt: 1,
          owner: "o",
          claimedAt: 3_000,
          claimExpiresAt: 3_100,
          outcome: "succeeded",
          remoteId: "r-1",
          remoteIdentifier: "PAS-1",
          remoteUrl: "https://linear/PAS-1",
          error: null,
          settledAt: 3_010,
        },
      ]);
      const improvement = await db.run((q) => getImprovementSteps(q, id));
      expect(improvement!.issue).toEqual({
        id: "r-1",
        identifier: "PAS-1",
        url: "https://linear/PAS-1",
        confirmedAt: 3_010,
      });
      expect(await db.run((q) => improvementsForIssueSteps(q, "ws", "r-1"))).toEqual([
        improvement!,
      ]);
      expect(await db.run((q) => improvementDeliveryWorkspacesSteps(q, 9_000))).toEqual([]);
    } finally {
      await close();
    }
  });

  test("a blocked delivery requeues, and a destination repair targets another team", async () => {
    const { db, close } = await open();
    try {
      await seedWorkspace(db);
      const id = await accepted(db, "create");
      const delivery = improvementDeliveryId(id, "create_issue");
      const repair = { deliveryId: delivery, teamId: "team-2", now: 3_500 };
      expect(await db.transaction((q) => repairImprovementDestinationSteps(q, repair))).toBeNull();
      await db.transaction((q) =>
        claimImprovementDeliverySteps(q, {
          deliveryId: delivery,
          owner: "o",
          now: 3_000,
          leaseMs: 1,
        }),
      );
      await db.transaction((q) =>
        settleImprovementDeliverySteps(q, {
          deliveryId: delivery,
          attempt: 1,
          owner: "o",
          outcome: "failed",
          blocked: "destination",
          error: "no team",
          retryAt: 9_000,
          now: 3_001,
        }),
      );
      expect(
        await db.transaction((q) => repairImprovementDestinationSteps(q, repair)),
      ).toMatchObject({
        targetTeamId: "team-2",
        state: "pending",
        blocked: null,
        nextAttemptAt: null,
        retryBase: 1,
        error: null,
        updatedAt: 3_500,
      });
      const requeue = { deliveryId: delivery, now: 4_000 };
      expect(await db.run((q) => requeueImprovementDeliverySteps(q, requeue))).toBeNull();
      await db.transaction((q) =>
        claimImprovementDeliverySteps(q, {
          deliveryId: delivery,
          owner: "o",
          now: 4_000,
          leaseMs: 1,
        }),
      );
      await db.transaction((q) =>
        settleImprovementDeliverySteps(q, {
          deliveryId: delivery,
          attempt: 2,
          owner: "o",
          outcome: "unknown",
          blocked: "attempts",
          now: 4_001,
        }),
      );
      expect(
        await db.run((q) => requeueImprovementDeliverySteps(q, { ...requeue, now: 5_000 })),
      ).toMatchObject({ state: "unknown", blocked: null, retryBase: 2, updatedAt: 5_000 });
    } finally {
      await close();
    }
  });

  test("an accepted improvement is found by the finding ids in its source key", async () => {
    const { db, close } = await open();
    try {
      await seedWorkspace(db);
      const { improvementId } = await propose(db, { kind: "daily_finding", key: "g#12:#30:" });
      await db.transaction((q) =>
        decideImprovementSteps(q, {
          improvementId,
          expectedVersion: 1,
          review: { kind: "accept", proposalVersion: 1, intent: { kind: "create" } },
          actor: "ada",
          now: 2_000,
        }),
      );
      const find = (ids: number[]) =>
        db.run((q) => acceptedImprovementsForFindingsSteps(q, "ws", ids));
      expect((await find([30, 4])).map((row) => row.id)).toEqual([improvementId]);
      expect((await find([12, 30])).map((row) => row.id)).toEqual([improvementId]);
      expect(await find([1, 3])).toEqual([]);
      expect(await find([])).toEqual([]);
    } finally {
      await close();
    }
  });

  test("an outcome updates its track and lists with its evidence", async () => {
    const { db, close } = await open();
    try {
      await seedWorkspace(db);
      const { improvementId } = await propose(db, { kind: "retro_item", key: "r" });
      const outcome = (
        track: "implementation" | "verification",
        state: string,
        evidence: string[],
        id = improvementId,
      ) =>
        db.transaction((q) =>
          recordImprovementOutcomeSteps(q, {
            improvementId: id,
            track,
            state,
            evidence,
            revision: "abc",
            actor: "ada",
            now: 3_000,
          } as Parameters<typeof recordImprovementOutcomeSteps>[1]),
        );
      expect(outcome("verification", "verified", [])).rejects.toThrow("Verified needs evidence");
      expect(outcome("implementation", "merged", [], "missing")).rejects.toThrow();
      const first = await outcome("implementation", "merged", ["pr-1"]);
      const second = await outcome("verification", "verified", ["ci"]);
      expect(second.id).toBeGreaterThan(first.id);
      expect(await db.run((q) => listImprovementOutcomesSteps(q, improvementId))).toEqual([
        first,
        second,
      ]);
      expect(first).toEqual({
        id: first.id,
        improvementId,
        track: "implementation",
        state: "merged",
        evidence: ["pr-1"],
        revision: "abc",
        deployment: null,
        actor: "ada",
        recordedAt: 3_000,
      });
      expect(await db.run((q) => getImprovementSteps(q, improvementId))).toMatchObject({
        implementationState: "merged",
        implementationAt: 3_000,
        verificationState: "verified",
        verificationAt: 3_000,
      });
    } finally {
      await close();
    }
  });
});

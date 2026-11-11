import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  changeWorkspaceRevocation,
  claimImprovementDelivery,
  listImprovementCriteria,
  listImprovementDeliveries,
  listImprovementProposals,
  listReviewFindings,
  recordImprovementProposal,
  reserveImprovementDeliveryRemote,
  requeueImprovementDelivery,
  settleImprovementDelivery,
  syncWorkspaceMember,
  sqliteDb,
} from "../src/db";
import { handleFindingGroupsRequest } from "../src/dashboard/src/server/finding-groups";
import { handleFindingsRequest } from "../src/dashboard/src/server/findings";
import { createImprovementsHttp, decideInboxItem } from "../src/improvements";
import { createFindingIssueRoute } from "../src/finding-issues";
import { issueWorkspaceSession } from "../src/workspace";

import {
  A,
  ALL,
  accept,
  B,
  END,
  ONLY_A,
  reject,
  seedDaily,
  world,
  type Json,
} from "./improvement-fixtures";

describe("improvement decisions", () => {
  test("two reviewers: the second conflicting decision returns the first one with 409", async () => {
    const w = await world();
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
    const [delivery] = await listImprovementDeliveries(sqliteDb(w.db), id);
    expect(delivery).toMatchObject({ operation: "create_issue", targetTeamId: "team-a" });
    expect(delivery!.content).toMatchObject({
      proposalVersion: 1,
      title: `Recovery repeats in ${A}`,
      verificationCriterion: "No push-recovery question in the next two retros.",
    });
  });

  test("a repeated accept must match the frozen criterion and accepts the issue identifier", async () => {
    const w = await world();
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
    const w = await world();
    const id = w.retro.a;
    const rejected = await w.api("bea", `/api/improvements/${id}/decision`, reject());
    expect(rejected.body.item).toMatchObject({
      reviewState: "rejected",
      decision: { reason: "Not recurring" },
    });
    expect(await listImprovementDeliveries(sqliteDb(w.db), id)).toEqual([]);
    const late = await w.api("ada", `/api/improvements/${id}/decision`, accept());
    expect(late.status).toBe(409);
    expect(late.body.item.reviewState).toBe("rejected");
  });

  test("duplicate clicks return the existing result without a second delivery", async () => {
    const w = await world();
    const id = w.retro.a;
    const [one, two] = await Promise.all([
      w.api("ada", `/api/improvements/${id}/decision`, accept()),
      w.api("ada", `/api/improvements/${id}/decision`, accept()),
    ]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect([one.body.status, two.body.status].sort()).toEqual(["decided", "unchanged"]);
    expect(await listImprovementDeliveries(sqliteDb(w.db), id)).toHaveLength(1);
    const again = await w.api("bea", `/api/improvements/${id}/decision`, reject(1));
    expect(again.status).toBe(409);
  });

  test("filing in flight: reject and reopen cannot undo an accepted issue", async () => {
    const w = await world();
    const id = w.retro.a;
    await w.api("ada", `/api/improvements/${id}/decision`, accept());
    const [delivery] = await listImprovementDeliveries(sqliteDb(w.db), id);
    await claimImprovementDelivery(sqliteDb(w.db), {
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
    const w = await world();
    const id = w.retro.a;
    await w.api("ada", `/api/improvements/${id}/decision`, accept());
    const [delivery] = await listImprovementDeliveries(sqliteDb(w.db), id);
    await claimImprovementDelivery(sqliteDb(w.db), {
      deliveryId: delivery!.id,
      owner: "outbox",
      now: END + 5_000,
      leaseMs: 60_000,
    });
    await settleImprovementDelivery(sqliteDb(w.db), {
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
    const after = await listImprovementDeliveries(sqliteDb(w.db), id);
    expect(after.map((d) => [d.id, d.state])).toEqual([[delivery!.id, "pending"]]);

    await claimImprovementDelivery(sqliteDb(w.db), {
      deliveryId: delivery!.id,
      owner: "outbox",
      now: END + 7_000,
      leaseMs: 60_000,
    });
    await settleImprovementDelivery(sqliteDb(w.db), {
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

  test("an unfiled create chooses another mapped team; an uncertain one only reconciles", async () => {
    const w = await world();
    const id = w.retro.a;
    await w.api("ada", `/api/improvements/${id}/decision`, accept());
    const [delivery] = await listImprovementDeliveries(sqliteDb(w.db), id);
    const base = `/api/improvements/${id}/deliveries/${delivery!.id}`;
    w.db.run("INSERT INTO workspace_repository VALUES ('ws', ?, 'team-b')", [A]);
    w.db.run("DELETE FROM workspace_repository WHERE repository = ? AND team_id = 'team-a'", [A]);
    await claimImprovementDelivery(sqliteDb(w.db), {
      deliveryId: delivery!.id,
      owner: "outbox",
      now: END + 5_000,
      leaseMs: 60_000,
    });
    await settleImprovementDelivery(sqliteDb(w.db), {
      deliveryId: delivery!.id,
      attempt: 1,
      owner: "outbox",
      outcome: "failed",
      blocked: "destination",
      error: "The chosen Linear team is no longer mapped to this repository.",
      now: END + 6_000,
    });
    const blocked = await w.api("admin", `/api/improvements/${id}`);
    expect(blocked.body.item.deliveries[0]).toMatchObject({
      status: "retryable",
      blocked: "destination",
      recovery: "choose_destination",
    });
    expect(blocked.body.destinations).toEqual(["team-b"]);
    expect((await w.api("admin", `${base}/destination`, { teamId: "team-a" })).status).toBe(403);
    const moved = await w.api("admin", `${base}/destination`, { teamId: "team-b" });
    expect(moved.status).toBe(202);
    expect(moved.body.item.deliveries[0]).toMatchObject({
      status: "pending",
      targetTeamId: "team-b",
      blocked: null,
    });

    await claimImprovementDelivery(sqliteDb(w.db), {
      deliveryId: delivery!.id,
      owner: "outbox",
      now: END + 7_000,
      leaseMs: 60_000,
    });
    await reserveImprovementDeliveryRemote(sqliteDb(w.db), {
      deliveryId: delivery!.id,
      owner: "outbox",
      attempt: 2,
      remoteId: randomUUID(),
    });
    await settleImprovementDelivery(sqliteDb(w.db), {
      deliveryId: delivery!.id,
      attempt: 2,
      owner: "outbox",
      outcome: "unknown",
      blocked: "destination",
      now: END + 8_000,
    });
    const frozen = await w.api("admin", `${base}/destination`, { teamId: "team-b" });
    expect(frozen.status).toBe(409);
    expect(frozen.body.reason).toBe("destination_frozen");
    const retried = await w.api("admin", `${base}/retry`, {});
    expect(retried.status).toBe(202);
    expect((await listImprovementDeliveries(sqliteDb(w.db), id))[0]).toMatchObject({
      state: "unknown",
      blocked: null,
      targetTeamId: "team-b",
    });
  });

  test("a blocked link reopens for a new choice; a stranded evidence comment can be cancelled", async () => {
    const w = await world();
    const id = w.retro.a;
    const decision = `/api/improvements/${id}/decision`;
    const settle = async (
      operation: string,
      attempt: number,
      outcome: "succeeded" | "failed",
      blocked?: "conflict",
    ) => {
      const target = (await listImprovementDeliveries(sqliteDb(w.db), id)).find(
        (d) => d.operation === operation,
      )!;
      await claimImprovementDelivery(sqliteDb(w.db), {
        deliveryId: target.id,
        owner: "outbox",
        now: END + attempt * 1_000,
        leaseMs: 60_000,
      });
      await settleImprovementDelivery(sqliteDb(w.db), {
        deliveryId: target.id,
        attempt,
        owner: "outbox",
        outcome,
        ...(outcome === "succeeded" ? { remote: { id: "issue-open" } } : {}),
        ...(blocked
          ? { blocked, error: "The linked issue was closed after it was accepted." }
          : {}),
        now: END + attempt * 1_000 + 500,
      });
      return target;
    };
    const recoveries = (body: {
      item: { deliveries: { operation: string; recovery: string | null }[] };
    }) => Object.fromEntries(body.item.deliveries.map((d) => [d.operation, d.recovery]));
    const linkWithComment = { kind: "link", issue: "PAS-60", addEvidenceComment: true };
    expect((await w.api("ada", decision, accept(1, linkWithComment))).body.status).toBe("decided");
    await settle("link_issue", 1, "failed", "conflict");
    const blocked = await w.api("ada", `/api/improvements/${id}`);
    expect(recoveries(blocked.body)).toEqual({ link_issue: "reopen", evidence_comment: null });
    const reopened = await w.api("bea", decision, {
      expectedVersion: 2,
      decision: { kind: "reopen" },
    });
    expect([reopened.status, reopened.body.status]).toEqual([200, "decided"]);
    expect(reopened.body.item).toMatchObject({ reviewState: "needs_review", deliveries: [] });

    expect((await w.api("ada", decision, accept(3, linkWithComment))).body.status).toBe("decided");
    await settle("link_issue", 1, "succeeded");
    const transient = await settle("evidence_comment", 1, "failed");
    const cancel = `/api/improvements/${id}/deliveries/${transient.id}/cancel`;
    const early = await w.api("ada", cancel, {});
    expect([early.status, early.body.reason]).toEqual([409, "cancel_comment"]);
    await requeueImprovementDelivery(sqliteDb(w.db), {
      deliveryId: transient.id,
      now: END + 3_000,
    });
    await settle("evidence_comment", 2, "failed", "conflict");
    const stranded = await w.api("ada", `/api/improvements/${id}`);
    expect(recoveries(stranded.body)).toEqual({
      link_issue: null,
      evidence_comment: "cancel_comment",
    });
    const refused = await w.api("bea", decision, {
      expectedVersion: 4,
      decision: { kind: "reopen" },
    });
    expect([refused.status, refused.body.reason]).toEqual([409, "accepted"]);
    const cancelled = await w.api("ada", cancel, {});
    expect([cancelled.status, cancelled.body.status]).toEqual([200, "cancelled"]);
    expect(cancelled.body.item).toMatchObject({
      reviewState: "accepted",
      decision: { evidenceComment: false },
    });
    expect((await listImprovementDeliveries(sqliteDb(w.db), id)).map((d) => d.operation)).toEqual([
      "link_issue",
    ]);
    expect((await w.api("ada", cancel, {})).status).toBe(404);
  });

  test("link revalidates the issue; a link alone posts no comment", async () => {
    const w = await world();
    const id = w.retro.a;
    const decide = (intent: unknown) =>
      w.api("ada", `/api/improvements/${id}/decision`, accept(1, intent));
    w.lookup.setUnavailable(true);
    const down = await decide({ kind: "link", issue: "PAS-60" });
    expect(down.status).toBe(503);
    expect(await listImprovementDeliveries(sqliteDb(w.db), id)).toEqual([]);
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
    expect((await listImprovementDeliveries(sqliteDb(w.db), id)).map((d) => d.operation)).toEqual([
      "link_issue",
    ]);
  });

  test("a proposal that changes while Linear is read is not accepted", async () => {
    const w = await world();
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
        await recordImprovementProposal(sqliteDb(w.db), {
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
    expect(await listImprovementDeliveries(sqliteDb(w.db), id)).toEqual([]);
  });

  test("link and add evidence freezes an explicit comment intent; closed needs explicit consent", async () => {
    const w = await world();
    const id = w.retro.a;
    const linked = await w.api(
      "ada",
      `/api/improvements/${id}/decision`,
      accept(1, { kind: "link", issue: "PAS-61", allowClosed: true, addEvidenceComment: true }),
    );
    expect(linked.status).toBe(200);
    const deliveries = await listImprovementDeliveries(sqliteDb(w.db), id);
    expect(deliveries.map((d) => d.operation).sort()).toEqual(["evidence_comment", "link_issue"]);
    expect(deliveries.every((d) => d.targetIssueId === "issue-closed")).toBe(true);
    expect(deliveries[0]!.content).toMatchObject({
      issue: { identifier: "PAS-61", state: "closed" },
    });
  });

  test("create must name a destination the reviewer is authorized for", async () => {
    const w = await world();
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
    const w = await world();
    const id = w.retro.a;
    const decideWhile = async (revoke: () => unknown) => {
      const http = createImprovementsHttp({
        db: w.db,
        lookup: async (issue) => {
          await revoke();
          return w.lookup.lookup(issue);
        },
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
    const member = async (active: boolean, teamIds: string[]) =>
      await syncWorkspaceMember(sqliteDb(w.db), {
        workspaceId: "ws",
        userId: "user-ada",
        role: "member",
        active,
        teamIds,
        now: at++,
      });
    const lostTeam = await decideWhile(async () => await member(true, []));
    expect([lostTeam.status, lostTeam.body.reason]).toEqual([404, "not_found"]);
    expect(await listImprovementDeliveries(sqliteDb(w.db), id)).toEqual([]);
    await member(true, ["team-a"]);
    const revoked = await decideWhile(async () => await member(false, ["team-a"]));
    expect([revoked.status, revoked.body.reason]).toEqual([404, "not_found"]);
    expect(await listImprovementDeliveries(sqliteDb(w.db), id)).toEqual([]);
    await member(true, ["team-a"]);
    const kept = await decideWhile(() => {});
    expect(kept.body.status).toBe("decided");
  });

  test("revoked membership loses reads and decisions; another workspace sees nothing", async () => {
    const w = await world();
    const id = w.retro.a;
    await syncWorkspaceMember(sqliteDb(w.db), {
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
    expect(await listImprovementDeliveries(sqliteDb(w.db), id)).toEqual([]);
    w.people["outsider"] = { ...w.people["ada"]!, workspaceId: "other" };
    expect((await w.api("outsider", "/api/improvements")).status).toBe(403);
    expect((await w.api("outsider", `/api/improvements/${id}`)).status).toBe(403);
    expect((await w.retroApi("outsider", "/api/retros/reports/r1")).status).toBe(403);
  });

  test("an admin-revoked member loses reads and decisions", async () => {
    const w = await world();
    const id = w.retro.a;
    changeWorkspaceRevocation(w.db, {
      workspaceId: "ws",
      actorId: "user-admin",
      userId: "user-bea",
      revoked: true,
      now: 3,
    });
    expect((await w.api("bea", "/api/improvements")).status).toBe(403);
    expect((await w.api("bea", `/api/improvements/${id}/decision`, accept())).status).toBe(403);
    expect((await w.retroApi("bea", "/api/retros/history")).status).toBe(403);
    expect(await listImprovementDeliveries(sqliteDb(w.db), id)).toEqual([]);
  });

  test("responses are no-store and missing ids are recoverable 404s", async () => {
    const w = await world();
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
    const w = await world();
    await seedDaily(w.db);
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
    expect(await listImprovementCriteria(sqliteDb(w.db), daily.id)).toMatchObject([
      { revision: 1, actor: "user-ada" },
    ]);
    expect(
      (await listImprovementProposals(sqliteDb(w.db), daily.id)).every(
        (p) => p.verificationCriterion === "",
      ),
    ).toBe(true);
  });

  test("legacy File after inbox Create is refused, and inbox Create after a legacy claim conflicts", async () => {
    const w = await world();
    const { groupId } = await seedDaily(w.db);
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

    const other = await world();
    const seeded = await seedDaily(other.db);
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
    const w = await world();
    const { groupId, findings } = await seedDaily(w.db);
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
    expect((await listReviewFindings(sqliteDb(w.db))).every((f) => f.status === "open")).toBe(true);
  });
});

describe("individual finding issues share the inbox claim", () => {
  const ORIGIN = "https://paws.example";
  async function route(
    w: Awaited<ReturnType<typeof world>>,
    file: () => Promise<void> = async () => {},
  ) {
    const filed: string[] = [];
    const handle = createFindingIssueRoute({
      db: w.db,
      reviews: async () => [
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
    const { session } = await issueWorkspaceSession(w.db, {
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
  const acceptDaily = async (w: Awaited<ReturnType<typeof world>>) => {
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
    const w = await world();
    await seedDaily(w.db);
    expect((await acceptDaily(w)).body.status).toBe("decided");
    const { post, filed } = await route(w);
    const refused = await post();
    expect(refused!.status).toBe(409);
    expect(filed).toEqual([]);
  });

  test("an individual filing, finished or in flight, blocks the inbox accept", async () => {
    const w = await world();
    await seedDaily(w.db);
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { post, filed } = await route(w, () => gate);
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
    expect(await listImprovementDeliveries(sqliteDb(w.db), after.body.item.id)).toEqual([]);
  });

  test("an individual filing after a dismissed group still blocks the inbox Create", async () => {
    const w = await world();
    const { groupId } = await seedDaily(w.db);
    const dismissed = await handleFindingGroupsRequest(
      new Request("http://paws.test/api/finding-groups", {
        method: "POST",
        body: JSON.stringify({ action: "dismiss", id: groupId, reason: "Noise" }),
      }),
      { db: w.db, principal: w.people["bea"]!, sessionIds: ONLY_A },
    );
    expect(dismissed!.status).toBe(200);
    const { post } = await route(w);
    expect((await post())!.status).toBe(200);
    const after = await acceptDaily(w);
    expect([after.status, after.body.reason]).toEqual([409, "known_issue"]);
    expect(after.body.item.issue).toMatchObject({ identifier: "PAS-77", origin: "legacy" });
    expect(await listImprovementDeliveries(sqliteDb(w.db), after.body.item.id)).toEqual([]);
  });
});

describe("partial repository access", () => {
  test("a member who reads only one of two repositories sees only that repository", async () => {
    const w = await world();
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
    const w = await world();
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
    const w = await world();
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

import { describe, expect, test } from "bun:test";
import {
  claimImprovementDelegation,
  claimImprovementDelivery,
  getImprovement,
  insertQueuedItem,
  listImprovementActions,
  listImprovementDeliveries,
  listImprovementOutcomes,
  recordImprovementIssueSync,
  settleImprovementDelivery,
  syncWorkspaceMember,
} from "../src/db";
import {
  improvementFollowThrough,
  IMPROVEMENT_OUTCOME_LIMITS,
  syncImprovementOutcomes,
  type StartIssueSession,
} from "../src/improvements";
import { createFakeImprovementLinear } from "../src/linear";
import { accept, END, seedDaily, world } from "./improvement-fixtures";

const ISSUE = "issue-x";
const MERGE = "c0ffee1234567890c0ffee1234567890c0ffee12";

function sessions() {
  const calls: string[] = [];
  let failing = false;
  const start: StartIssueSession = async (target) => {
    calls.push(target.id);
    if (failing) throw new Error("Linear refused");
    return { id: `session-${calls.length}`, url: null };
  };
  return {
    start,
    calls,
    fail(value: boolean) {
      failing = value;
    },
  };
}

async function linked(options: { delegated?: boolean; stateType?: string } = {}) {
  const linear = createFakeImprovementLinear();
  const starter = sessions();
  const w = world({ linear, startSession: starter.start, dashboardUrl: "https://paws.test/" });
  const id = w.retro.a;
  const decided = await w.api("ada", `/api/improvements/${id}/decision`, accept());
  expect(decided.body.status).toBe("decided");
  const delivery = listImprovementDeliveries(w.db, id)[0]!;
  claimImprovementDelivery(w.db, {
    deliveryId: delivery.id,
    owner: "outbox",
    now: END + 2_000,
    leaseMs: 60_000,
  });
  settleImprovementDelivery(w.db, {
    deliveryId: delivery.id,
    attempt: 1,
    owner: "outbox",
    outcome: "succeeded",
    remote: { id: ISSUE, identifier: "PAS-70", url: "https://linear.app/x/PAS-70" },
    now: END + 2_001,
  });
  linear.issues.set(ISSUE, {
    id: ISSUE,
    identifier: "PAS-70",
    url: null,
    teamId: "team-a",
    state:
      options.stateType === "completed" || options.stateType === "canceled" ? "closed" : "open",
    stateType: options.stateType ?? "unstarted",
    delegated: options.delegated ?? false,
  });
  const sync = () =>
    syncImprovementOutcomes({ db: w.db, linearFor: async () => linear, now: w.now });
  const follow = async (who = "ada") => {
    const response = await w.api(who, `/api/improvements/${id}/follow-through`);
    return response.body.followThrough;
  };
  const post = (action: string, body: unknown, who = "ada") =>
    w.api(who, `/api/improvements/${id}/${action}`, body);
  const version = () => getImprovement(w.db, id)!.version;
  const setIssue = (change: Record<string, unknown>) =>
    linear.issues.set(ISSUE, { ...linear.issues.get(ISSUE)!, ...change });
  const work = (state: string) => {
    if (!w.db.query("SELECT 1 FROM work_item WHERE id = 'work-x'").get()) {
      insertQueuedItem(w.db, { id: "work-x", sessionKey: "session-a", now: END });
      w.db.run("UPDATE work_item SET linear_issue_id = ? WHERE id = 'work-x'", [ISSUE]);
    }
    w.db.run("UPDATE work_item SET state = ? WHERE id = 'work-x'", [state]);
  };
  const merge = () => {
    work("merged");
    w.db.run("INSERT INTO item_pull_request VALUES ('work-x', 42, 'https://gh/pull/42', ?)", [END]);
    w.db.run(
      "INSERT INTO remote_merge_fact VALUES ('work-x', 'acme', 'a', 42, 'https://gh/pull/42', ?, ?)",
      [MERGE, END + 3_000],
    );
  };
  return { w, id, linear, starter, sync, follow, post, version, setIssue, work, merge };
}

const verify = (expectedVersion: number, extra: Record<string, unknown> = {}) => ({
  expectedVersion,
  outcome: "verified",
  check: "Weekly retro push-recovery questions",
  result: "No push-recovery question in the two retros after the merge.",
  evidence: { kind: "attestation", url: "https://linear.app/x/retro" },
  ...extra,
});

describe("follow-through from create to verified", () => {
  test("create → explicit delegation → merge → verification due → evidence-backed verified", async () => {
    const t = await linked();
    expect(await t.follow()).toMatchObject({
      attention: "ready_to_delegate",
      delegate: { offered: true },
      implementation: { state: "unknown" },
    });
    expect(t.starter.calls).toEqual([]);

    const delegated = await t.post("delegate", { expectedVersion: t.version() });
    expect([delegated.status, delegated.body.status]).toEqual([201, "delegated"]);
    expect(t.starter.calls).toEqual([ISSUE]);
    const again = await t.post("delegate", { expectedVersion: 2 });
    expect(again.body.status).toBe("unchanged");
    expect(t.starter.calls).toEqual([ISSUE]);

    t.work("running");
    await t.sync();
    expect(await t.follow()).toMatchObject({
      attention: "working",
      implementation: { state: "in_progress", source: "paws" },
      work: { itemId: "work-x", state: "running" },
    });

    t.merge();
    t.setIssue({ state: "closed", stateType: "completed" });
    await t.sync();
    await t.sync();
    const merged = await t.follow();
    expect(merged).toMatchObject({
      attention: "awaiting_verification",
      implementation: { state: "merged" },
      verification: { state: "due" },
      work: { merge: { number: 42, sha: MERGE } },
    });
    const tracks = listImprovementOutcomes(t.w.db, t.id).map((o) => `${o.track}:${o.state}`);
    expect(tracks).toEqual([
      "implementation:in_progress",
      "implementation:merged",
      "verification:due",
    ]);

    const noRevision = await t.post("verification", verify(t.version()));
    expect([noRevision.status, noRevision.body.reason]).toEqual([400, "revision_required"]);
    const wrong = await t.post("verification", verify(t.version(), { revision: "deadbeef" }));
    expect(wrong.body.reason).toBe("revision_mismatch");
    const stale = await t.post("verification", verify(1, { revision: MERGE }));
    expect([stale.status, stale.body.reason]).toEqual([409, "stale"]);

    const done = await t.post(
      "verification",
      verify(t.version(), { revision: MERGE.slice(0, 12) }),
    );
    expect(done.body).toMatchObject({ status: "recorded", item: { attention: "verified" } });
    const recorded = listImprovementOutcomes(t.w.db, t.id).at(-1)!;
    expect(recorded).toMatchObject({
      track: "verification",
      state: "verified",
      revision: MERGE.slice(0, 12),
      actor: "user-ada",
    });
    expect(recorded.evidence).toContain("check:Weekly retro push-recovery questions");
    const audit = listImprovementActions(t.w.db, t.id).map((a) => [a.action, a.prior]);
    expect(audit).toEqual([
      ["delegate", { delegation: null, implementation: "not_started", work: null }],
      ["verify", { verification: "due", verificationAt: expect.any(Number) }],
    ]);

    await t.sync();
    expect((await t.follow()).attention).toBe("verified");
  });

  test("an existing delegate or work item is shown instead of a second run", async () => {
    const delegated = await linked({ delegated: true });
    const response = await delegated.post("delegate", { expectedVersion: delegated.version() });
    expect(response.body.status).toBe("existing");
    expect(delegated.starter.calls).toEqual([]);
    expect(response.body.item.attention).toBe("working");

    const owned = await linked();
    owned.work("queued");
    const shown = await owned.post("delegate", { expectedVersion: owned.version() });
    expect(shown.body).toMatchObject({ status: "existing", item: { work: { itemId: "work-x" } } });
    expect(owned.starter.calls).toEqual([]);
  });
});

describe("lost, duplicate and out-of-order events", () => {
  test("an older Linear read arriving after a newer one does not regress progress", async () => {
    const t = await linked();
    const at = END + 50_000;
    const write = (stateType: string, observedAt: number) =>
      recordImprovementIssueSync(t.w.db, {
        improvementId: t.id,
        issueId: ISSUE,
        status: "available",
        stateType,
        teamId: "team-a",
        delegated: false,
        observedAt,
      });
    expect(write("canceled", at)).toBe(true);
    expect(write("unstarted", at - 1)).toBe(false);
    expect(write("canceled", at)).toBe(false);
    const view = improvementFollowThrough(t.w.db, { workspaceId: "ws" }, t.id, at)!;
    expect(view.followThrough).toMatchObject({
      attention: "canceled",
      implementation: { state: "canceled", source: "linear" },
    });
  });

  test("a lost delegation response reconciles the same issue after restart", async () => {
    const t = await linked();
    claimImprovementDelegation(t.w.db, {
      improvementId: t.id,
      issueId: ISSUE,
      actor: "user-ada",
      now: END,
      leaseMs: 1,
    });
    expect((await t.post("delegate", { expectedVersion: t.version() })).body.status).toBe(
      "in_progress",
    );
    t.work("queued");
    await t.sync();
    expect((await t.follow()).delegation).toMatchObject({ state: "existing", attempts: 1 });
    expect(t.starter.calls).toEqual([]);
  });

  test("a delegation nobody heard back from fails visibly and an explicit retry starts once", async () => {
    const t = await linked();
    claimImprovementDelegation(t.w.db, {
      improvementId: t.id,
      issueId: ISSUE,
      actor: "user-ada",
      now: END,
      leaseMs: 1,
    });
    await t.sync();
    expect(await t.follow()).toMatchObject({
      attention: "blocked",
      delegation: { state: "failed" },
    });
    t.starter.fail(true);
    const failed = await t.post("delegate", { expectedVersion: t.version() });
    expect([failed.status, failed.body.reason]).toEqual([502, "delegation_failed"]);
    t.starter.fail(false);
    const retried = await t.post("delegate", { expectedVersion: t.version() });
    expect(retried.body.status).toBe("delegated");
    expect(t.starter.calls).toEqual([ISSUE, ISSUE]);
  });

  test("Linear Done without a deploy never verifies, however often it syncs", async () => {
    const t = await linked({ stateType: "completed" });
    for (let i = 0; i < 3; i++) await t.sync();
    expect(await t.follow()).toMatchObject({
      attention: "awaiting_verification",
      implementation: { state: "completed", source: "linear" },
      verification: { state: "due" },
    });
    expect(listImprovementOutcomes(t.w.db, t.id).filter((o) => o.state === "verified")).toEqual([]);
  });

  test("a closed pull request on cancelled work is not fixed", async () => {
    const t = await linked();
    t.work("cancelled");
    t.w.db.run("INSERT INTO item_pull_request VALUES ('work-x', 43, null, ?)", [END]);
    await t.sync();
    const view = await t.follow();
    expect(view).toMatchObject({ attention: "canceled", implementation: { state: "canceled" } });
    expect(view.recovery).toEqual(["acknowledge", "redelegate", "return_to_review"]);
  });

  test("reopening a verified issue marks verification stale without launching work", async () => {
    const t = await linked({ stateType: "completed" });
    await t.sync();
    const done = await t.post("verification", verify(t.version(), { deployment: "v1.4.2" }));
    expect(done.body.item.attention).toBe("verified");
    t.setIssue({ state: "open", stateType: "started" });
    await t.sync();
    expect(await t.follow()).toMatchObject({
      attention: "verification_stale",
      verification: { state: "contradicted" },
    });
    expect(listImprovementOutcomes(t.w.db, t.id).at(-1)).toMatchObject({
      track: "verification",
      state: "contradicted",
      actor: "paws",
    });
    expect(t.starter.calls).toEqual([]);
    expect(t.linear.created).toEqual([]);
  });
});

describe("daily findings", () => {
  test("a finding that disappears does not verify; a recurrence after verification is stale", async () => {
    const linear = createFakeImprovementLinear();
    const w = world({ linear });
    const { findings } = seedDaily(w.db);
    const [daily] = (await w.api("ada", "/api/improvements?source=daily")).body.items;
    const id: string = daily.id;
    const decided = await w.api(
      "ada",
      `/api/improvements/${id}/decision`,
      accept(
        1,
        { kind: "create", teamId: "team-a" },
        {
          verificationCriterion: "No timing finding in src for a week.",
          proposalVersion: daily.proposal.version,
        },
      ),
    );
    expect(decided.body.status).toBe("decided");
    const delivery = listImprovementDeliveries(w.db, id)[0]!;
    claimImprovementDelivery(w.db, { deliveryId: delivery.id, owner: "o", now: END, leaseMs: 1 });
    settleImprovementDelivery(w.db, {
      deliveryId: delivery.id,
      attempt: 1,
      owner: "o",
      outcome: "succeeded",
      remote: { id: ISSUE, identifier: "PAS-71" },
      now: END + 1,
    });
    linear.issues.set(ISSUE, {
      id: ISSUE,
      identifier: "PAS-71",
      url: null,
      teamId: "team-a",
      state: "closed",
      stateType: "completed",
      delegated: false,
    });
    const sync = () =>
      syncImprovementOutcomes({ db: w.db, linearFor: async () => linear, now: w.now });
    const follow = async () =>
      (await w.api("ada", `/api/improvements/${id}/follow-through`)).body.followThrough;
    await sync();
    w.db.run("UPDATE review_finding SET status = 'gone'");
    await sync();
    expect((await follow()).attention).toBe("awaiting_verification");
    const version = getImprovement(w.db, id)!.version;
    expect(
      (
        await w.api(
          "ada",
          `/api/improvements/${id}/verification`,
          verify(version, { deployment: "v5" }),
        )
      ).body.status,
    ).toBe("recorded");
    w.db.run("UPDATE review_finding SET status = 'open', last_seen_at = ? WHERE id = ?", [
      w.now() + 10_000,
      findings[0]!.id,
    ]);
    expect(await follow()).toMatchObject({
      attention: "verification_stale",
      verification: { stale: "recurred" },
    });
    await sync();
    expect(listImprovementOutcomes(w.db, id).at(-1)).toMatchObject({
      state: "contradicted",
      evidence: [`review_finding:${findings[0]!.key}`],
    });
    expect(linear.created).toEqual([]);
  });
});

describe("evidence must match the criterion", () => {
  test("a Closeout check qualifies only when the criterion names it", async () => {
    const t = await linked();
    t.merge();
    await t.sync();
    t.w.db.run(
      `INSERT INTO closeout_progress (id, item_id, task_id, base, head, policy_digest, started_at,
         updated_at) VALUES ('p1', 'work-x', 't', 'b', ?, 'd', 1, 1)`,
      [MERGE],
    );
    t.w.db.run(
      `INSERT INTO closeout_step (progress_id, step_id, kind, state, command, attempt, ordinal)
       VALUES ('p1', 'retro-recovery', 'command', 'passed', 'bun test test/retro.test.ts', 1, 0)`,
    );
    const evidence = { kind: "closeout_step", progressId: "p1", stepId: "retro-recovery" };
    const unnamed = await t.post("verification", verify(t.version(), { evidence }));
    expect(unnamed.body.reason).toBe("not_applicable");
    const other = await t.post("verification", {
      ...verify(t.version()),
      evidence: { kind: "closeout_step", progressId: "p1", stepId: "missing" },
    });
    expect(other.body.reason).toBe("evidence_not_found");
    const annotated = await t.post("criterion", {
      expectedVersion: t.version(),
      criterion: "The retro-recovery check passes on the merged revision.",
    });
    expect(annotated.body.item.verification.criterion).toContain("retro-recovery");
    const verified = await t.post("verification", verify(t.version(), { evidence }));
    expect(verified.body.item.attention).toBe("verified");
    expect(listImprovementOutcomes(t.w.db, t.id).at(-1)!.revision).toBe(MERGE);
  });

  test("verification needs merged or completed work", async () => {
    const t = await linked();
    const early = await t.post("verification", verify(t.version(), { revision: MERGE }));
    expect(early.body.reason).toBe("not_implemented");
  });
});

describe("manual recovery", () => {
  test("a canceled issue offers acknowledge or return to review, keeping the audit trail", async () => {
    const t = await linked({ stateType: "canceled" });
    await t.sync();
    expect((await t.follow()).recovery).toEqual(["acknowledge", "return_to_review"]);
    const acknowledged = await t.post("recovery", {
      expectedVersion: t.version(),
      choice: "acknowledge",
      reason: "Superseded by another approach",
    });
    expect(acknowledged.body.item.attention).toBe("closed");

    const s = await linked({ stateType: "canceled" });
    await s.sync();
    const v = s.version();
    const [first, second] = await Promise.all([
      s.post("recovery", { expectedVersion: v, choice: "return_to_review", reason: "Wrong issue" }),
      s.post("verification", { ...verify(v, { deployment: "v2" }), outcome: "contradicted" }),
    ]);
    expect([first.body.status, second.status]).toEqual(["recorded", 409]);
    expect(first.body.item).toMatchObject({ attention: "needs_review", issue: null });
    expect(listImprovementDeliveries(s.w.db, s.id)).toEqual([]);
    const audit = listImprovementActions(s.w.db, s.id).at(-1)!;
    expect(audit).toMatchObject({
      action: "return_to_review",
      prior: { attention: "canceled", issue: { id: ISSUE, identifier: "PAS-70" } },
      detail: { reason: "Wrong issue", createdIssue: { id: ISSUE } },
    });
    const recreate = await s.w.api(
      "ada",
      `/api/improvements/${s.id}/decision`,
      accept(s.version()),
    );
    expect([recreate.status, recreate.body.reason]).toEqual([409, "recovered_issue"]);
  });
});

describe("access", () => {
  test("revoked Linear access shows unavailable with the last confirmed time", async () => {
    const t = await linked();
    await t.sync();
    const confirmed = (await t.follow()).issue.sync.confirmedAt;
    t.linear.fail("findIssue", { ok: false, failure: "unauthorized", message: "no" });
    await t.sync();
    expect(await t.follow()).toMatchObject({
      attention: "unavailable",
      issue: { sync: { status: "unauthorized", confirmedAt: confirmed } },
      delegate: { offered: false },
    });
  });

  test("revoked membership and other repositories cannot delegate or verify", async () => {
    const t = await linked();
    syncWorkspaceMember(t.w.db, {
      workspaceId: "ws",
      userId: "user-ada",
      role: "member",
      active: true,
      teamIds: [],
      now: 5,
    });
    const lost = await t.post("delegate", { expectedVersion: t.version() });
    expect(lost.status).toBe(404);
    syncWorkspaceMember(t.w.db, {
      workspaceId: "ws",
      userId: "user-ada",
      role: "member",
      active: false,
      teamIds: ["team-a"],
      now: 6,
    });
    expect((await t.post("delegate", { expectedVersion: t.version() })).status).toBe(403);
    expect((await t.post("verification", verify(t.version()))).status).toBe(403);
    expect(t.starter.calls).toEqual([]);
    const other = await t.w.api("bea", `/api/improvements/${t.w.retro.b}/follow-through`);
    expect(other.status).toBe(404);
  });

  test("stale sync is an explicit outcome", async () => {
    const t = await linked();
    await t.sync();
    const later = END + 2 * IMPROVEMENT_OUTCOME_LIMITS.staleSyncMs;
    const view = improvementFollowThrough(t.w.db, { workspaceId: "ws" }, t.id, later)!;
    expect(view.followThrough).toMatchObject({ attention: "stale_sync", issue: { fresh: false } });
  });
});

describe("attention and activity", () => {
  test("counts, batched activity and metrics respect repository access", async () => {
    const t = await linked({ stateType: "completed" });
    await t.sync();
    const read = async (who: string) => (await t.w.api(who, "/api/improvements/attention")).body;
    const admin = await read("admin");
    expect(admin.counts).toMatchObject({ newReview: 1, verificationDue: 1 });
    expect(admin.activity.map((a: { kind: string; count: number }) => [a.kind, a.count])).toEqual(
      expect.arrayContaining([
        ["review", 1],
        ["verification", 1],
      ]),
    );
    const ada = await read("ada");
    expect(ada.counts).toMatchObject({ newReview: 0, verificationDue: 1 });
    expect(ada.items).toEqual([{ id: t.id, attention: "awaiting_verification" }]);
    expect(ada.metrics).toMatchObject({
      awaitingFiling: 0,
      implementationCompleted: 1,
      verified: 0,
    });
    expect(JSON.stringify(ada)).not.toContain("user-");
    const repeated = await read("ada");
    expect(repeated.activity.map((a: { key: string }) => a.key)).toEqual(
      ada.activity.map((a: { key: string }) => a.key),
    );
    await t.post("verification", verify(t.version(), { deployment: "v3" }));
    const after = await read("ada");
    expect(after.counts.verificationDue).toBe(0);
    expect(after.metrics.verified).toBe(1);
  });

  test("a failed filing is a filing error entry", async () => {
    const w = world();
    const id = w.retro.a;
    await w.api("ada", `/api/improvements/${id}/decision`, accept());
    const delivery = listImprovementDeliveries(w.db, id)[0]!;
    claimImprovementDelivery(w.db, { deliveryId: delivery.id, owner: "o", now: END, leaseMs: 1 });
    settleImprovementDelivery(w.db, {
      deliveryId: delivery.id,
      attempt: 1,
      owner: "o",
      outcome: "failed",
      error: "Linear is down",
      now: END + 1,
    });
    const body = (await w.api("ada", "/api/improvements/attention")).body;
    expect(body.counts.filingErrors).toBe(1);
    expect(body.activity[0]).toMatchObject({ kind: "filing", count: 1, improvementIds: [id] });
  });
});

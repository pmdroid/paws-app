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
  sqliteDb,
} from "../src/db";
import {
  createFakeIssueLookup,
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
  const w = await world({
    linear,
    startSession: starter.start,
    dashboardUrl: "https://paws.test/",
  });
  const id = w.retro.a;
  const decided = await w.api("ada", `/api/improvements/${id}/decision`, accept());
  expect(decided.body.status).toBe("decided");
  const delivery = (await listImprovementDeliveries(sqliteDb(w.db), id))[0]!;
  await claimImprovementDelivery(sqliteDb(w.db), {
    deliveryId: delivery.id,
    owner: "outbox",
    now: END + 2_000,
    leaseMs: 60_000,
  });
  await settleImprovementDelivery(sqliteDb(w.db), {
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
  const version = async () => (await getImprovement(sqliteDb(w.db), id))!.version;
  const setIssue = (change: Record<string, unknown>) =>
    linear.issues.set(ISSUE, { ...linear.issues.get(ISSUE)!, ...change });
  const work = async (state: string) => {
    if (!w.db.query("SELECT 1 FROM work_item WHERE id = 'work-x'").get()) {
      await insertQueuedItem(w.db, { id: "work-x", sessionKey: "session-a", now: END + 2_500 });
      w.db.run("UPDATE work_item SET linear_issue_id = ? WHERE id = 'work-x'", [ISSUE]);
    }
    w.db.run("UPDATE work_item SET state = ? WHERE id = 'work-x'", [state]);
  };
  const merge = async () => {
    await work("merged");
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

    const delegated = await t.post("delegate", { expectedVersion: await t.version() });
    expect([delegated.status, delegated.body.status]).toEqual([201, "delegated"]);
    expect(t.starter.calls).toEqual([ISSUE]);
    const again = await t.post("delegate", { expectedVersion: 2 });
    expect(again.body.status).toBe("unchanged");
    expect(t.starter.calls).toEqual([ISSUE]);

    await t.work("running");
    await t.sync();
    expect(await t.follow()).toMatchObject({
      attention: "working",
      implementation: { state: "in_progress", source: "paws" },
      work: { itemId: "work-x", state: "running" },
    });

    await t.merge();
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
    const tracks = (await listImprovementOutcomes(sqliteDb(t.w.db), t.id)).map(
      (o) => `${o.track}:${o.state}`,
    );
    expect(tracks).toEqual([
      "implementation:not_started",
      "implementation:in_progress",
      "implementation:merged",
      "verification:due",
    ]);

    const noRevision = await t.post("verification", verify(await t.version()));
    expect([noRevision.status, noRevision.body.reason]).toEqual([400, "revision_required"]);
    const wrong = await t.post("verification", verify(await t.version(), { revision: "deadbeef" }));
    expect(wrong.body.reason).toBe("revision_mismatch");
    const stale = await t.post("verification", verify(1, { revision: MERGE }));
    expect([stale.status, stale.body.reason]).toEqual([409, "stale"]);

    const done = await t.post(
      "verification",
      verify(await t.version(), { revision: MERGE.slice(0, 12) }),
    );
    expect(done.body).toMatchObject({ status: "recorded", item: { attention: "verified" } });
    const recorded = (await listImprovementOutcomes(sqliteDb(t.w.db), t.id)).at(-1)!;
    expect(recorded).toMatchObject({
      track: "verification",
      state: "verified",
      revision: MERGE.slice(0, 12),
      actor: "user-ada",
    });
    expect(recorded.evidence).toContain("check:Weekly retro push-recovery questions");
    const audit = (await listImprovementActions(sqliteDb(t.w.db), t.id)).map((a) => [
      a.action,
      a.prior,
    ]);
    expect(audit).toEqual([
      ["delegate", { delegation: null, implementation: "not_started", work: null }],
      ["follow_work", { work: null, state: null }],
      ["verify", { verification: "due", verificationAt: expect.any(Number) }],
    ]);

    await t.sync();
    expect((await t.follow()).attention).toBe("verified");
  });

  test("an existing delegate or work item is shown instead of a second run", async () => {
    const delegated = await linked({ delegated: true });
    const response = await delegated.post("delegate", {
      expectedVersion: await delegated.version(),
    });
    expect(response.body.status).toBe("existing");
    expect(delegated.starter.calls).toEqual([]);
    expect(response.body.item.attention).toBe("working");

    const owned = await linked();
    await owned.work("queued");
    const shown = await owned.post("delegate", { expectedVersion: await owned.version() });
    expect(shown.body).toMatchObject({ status: "existing", item: { work: { itemId: "work-x" } } });
    expect(owned.starter.calls).toEqual([]);
  });
});

describe("lost, duplicate and out-of-order events", () => {
  test("an older Linear read arriving after a newer one does not regress progress", async () => {
    const t = await linked();
    const at = END + 50_000;
    const write = async (stateType: string, observedAt: number) =>
      await recordImprovementIssueSync(sqliteDb(t.w.db), {
        improvementId: t.id,
        issueId: ISSUE,
        status: "available",
        stateType,
        teamId: "team-a",
        delegated: false,
        observedAt,
      });
    expect(await write("canceled", at)).toBe(true);
    expect(await write("unstarted", at - 1)).toBe(false);
    expect(await write("canceled", at)).toBe(false);
    const view = (await improvementFollowThrough(t.w.db, { workspaceId: "ws" }, t.id, at))!;
    expect(view.followThrough).toMatchObject({
      attention: "canceled",
      implementation: { state: "canceled", source: "linear" },
    });
  });

  test("a lost delegation response reconciles the same issue after restart", async () => {
    const t = await linked();
    await claimImprovementDelegation(sqliteDb(t.w.db), {
      improvementId: t.id,
      issueId: ISSUE,
      actor: "user-ada",
      now: END,
      leaseMs: 1,
    });
    expect((await t.post("delegate", { expectedVersion: await t.version() })).body.status).toBe(
      "in_progress",
    );
    await t.work("queued");
    await t.sync();
    expect((await t.follow()).delegation).toMatchObject({ state: "existing", attempts: 1 });
    expect(t.starter.calls).toEqual([]);
  });

  test("a delegation nobody heard back from fails visibly and an explicit retry starts once", async () => {
    const t = await linked();
    await claimImprovementDelegation(sqliteDb(t.w.db), {
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
    const failed = await t.post("delegate", { expectedVersion: await t.version() });
    expect([failed.status, failed.body.reason]).toEqual([502, "delegation_failed"]);
    t.starter.fail(false);
    const retried = await t.post("delegate", { expectedVersion: await t.version() });
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
    expect(
      (await listImprovementOutcomes(sqliteDb(t.w.db), t.id)).filter((o) => o.state === "verified"),
    ).toEqual([]);
  });

  test("a closed pull request on cancelled work is not fixed", async () => {
    const t = await linked();
    await t.work("cancelled");
    t.w.db.run("INSERT INTO item_pull_request VALUES ('work-x', 43, null, ?)", [END]);
    await t.sync();
    const view = await t.follow();
    expect(view).toMatchObject({ attention: "canceled", implementation: { state: "canceled" } });
    expect(view.recovery).toEqual(["acknowledge", "redelegate", "return_to_review"]);
  });

  test("reopening a verified issue marks verification stale without launching work", async () => {
    const t = await linked({ stateType: "completed" });
    await t.sync();
    const done = await t.post("verification", verify(await t.version(), { deployment: "v1.4.2" }));
    expect(done.body.item.attention).toBe("verified");
    t.setIssue({ state: "open", stateType: "started" });
    await t.sync();
    expect(await t.follow()).toMatchObject({
      attention: "verification_stale",
      verification: { state: "contradicted" },
    });
    expect((await listImprovementOutcomes(sqliteDb(t.w.db), t.id)).at(-1)).toMatchObject({
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
    const w = await world({ linear });
    const { findings } = await seedDaily(w.db);
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
    const delivery = (await listImprovementDeliveries(sqliteDb(w.db), id))[0]!;
    await claimImprovementDelivery(sqliteDb(w.db), {
      deliveryId: delivery.id,
      owner: "o",
      now: END,
      leaseMs: 1,
    });
    await settleImprovementDelivery(sqliteDb(w.db), {
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
    const version = (await getImprovement(sqliteDb(w.db), id))!.version;
    expect(
      (
        await w.api(
          "ada",
          `/api/improvements/${id}/verification`,
          verify(version, { deployment: "v5" }),
        )
      ).body.status,
    ).toBe("recorded");
    const form = (await getImprovement(sqliteDb(w.db), id))!.version;
    w.db.run("UPDATE review_finding SET status = 'open', last_seen_at = ? WHERE id = ?", [
      w.now() + 10_000,
      findings[0]!.id,
    ]);
    expect(await follow()).toMatchObject({
      attention: "verification_stale",
      verification: { stale: "recurred" },
    });
    const replayed = await w.api(
      "ada",
      `/api/improvements/${id}/verification`,
      verify(form, { deployment: "v6" }),
    );
    expect([replayed.status, replayed.body.reason]).toEqual([409, "stale"]);
    expect((await getImprovement(sqliteDb(w.db), id))!.verificationState).toBe("contradicted");
    await sync();
    expect((await listImprovementOutcomes(sqliteDb(w.db), id)).at(-1)).toMatchObject({
      state: "contradicted",
      evidence: [`review_finding:${findings[0]!.key}`],
    });
    expect(linear.created).toEqual([]);
  });
});

describe("evidence must match the criterion", () => {
  test("a Closeout check qualifies only when the criterion names it", async () => {
    const t = await linked();
    await t.merge();
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
    const unnamed = await t.post("verification", verify(await t.version(), { evidence }));
    expect(unnamed.body.reason).toBe("not_applicable");
    const other = await t.post("verification", {
      ...verify(await t.version()),
      evidence: { kind: "closeout_step", progressId: "p1", stepId: "missing" },
    });
    expect(other.body.reason).toBe("evidence_not_found");
    const annotated = await t.post("criterion", {
      expectedVersion: await t.version(),
      criterion: "The retro-recovery check passes on the merged revision.",
    });
    expect(annotated.body.item.verification.criterion).toContain("retro-recovery");
    t.w.db.run(
      `INSERT INTO closeout_progress (id, item_id, task_id, base, head, policy_digest, started_at,
         updated_at) VALUES ('p0', 'work-x', 't', 'b', ?, 'd', 0, 0)`,
      ["0".repeat(40)],
    );
    t.w.db.run(
      `INSERT INTO closeout_step (progress_id, step_id, kind, state, command, attempt, ordinal)
       VALUES ('p0', 'retro-recovery', 'command', 'passed', 'bun test test/retro.test.ts', 1, 0)`,
    );
    t.w.db.run("UPDATE work_item SET accepted_head = ? WHERE id = 'work-x'", [MERGE]);
    const older = await t.post("verification", {
      ...verify(await t.version()),
      evidence: { kind: "closeout_step", progressId: "p0", stepId: "retro-recovery" },
    });
    expect(older.body.reason).toBe("evidence_outdated");
    const verified = await t.post("verification", verify(await t.version(), { evidence }));
    expect(verified.body.item.attention).toBe("verified");
    expect((await listImprovementOutcomes(sqliteDb(t.w.db), t.id)).at(-1)!.revision).toBe(MERGE);
  });

  test("verification needs merged or completed work", async () => {
    const t = await linked();
    const early = await t.post("verification", verify(await t.version(), { revision: MERGE }));
    expect(early.body.reason).toBe("not_implemented");
  });
});

describe("review fixes", () => {
  test("delegation authorizes the issue's current team, not the one captured at link time", async () => {
    const t = await linked();
    t.setIssue({ teamId: "team-b" });
    const moved = await t.post("delegate", { expectedVersion: await t.version() });
    expect([moved.status, moved.body.reason]).toEqual([403, "destination"]);
    expect(t.starter.calls).toEqual([]);
  });

  test("reopening the Linear issue after a verified merge makes verification stale", async () => {
    const t = await linked();
    await t.merge();
    t.setIssue({ state: "closed", stateType: "completed" });
    await t.sync();
    const done = await t.post("verification", verify(await t.version(), { revision: MERGE }));
    expect(done.body.item.attention).toBe("verified");
    t.setIssue({ state: "open", stateType: "started" });
    await t.sync();
    expect(await t.follow()).toMatchObject({
      attention: "verification_stale",
      verification: { state: "contradicted" },
    });
  });

  test("acknowledging failed work stays closed after reconciliation", async () => {
    const t = await linked();
    await t.work("failed");
    await t.sync();
    expect((await t.follow()).attention).toBe("blocked");
    const done = await t.post("recovery", {
      expectedVersion: await t.version(),
      choice: "acknowledge",
      reason: "Not worth pursuing",
    });
    expect(done.body.item.attention).toBe("closed");
    const before = (await listImprovementOutcomes(sqliteDb(t.w.db), t.id)).length;
    await t.sync();
    await t.sync();
    expect((await t.follow()).attention).toBe("closed");
    expect((await listImprovementOutcomes(sqliteDb(t.w.db), t.id)).length).toBe(before);
  });

  test("access revoked while the request body streams refuses the mutation", async () => {
    const t = await linked();
    const version = await t.version();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent) return controller.close();
        sent = true;
        await syncWorkspaceMember(sqliteDb(t.w.db), {
          workspaceId: "ws",
          userId: "user-ada",
          role: "member",
          active: false,
          teamIds: ["team-a"],
          now: 7,
        });
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ expectedVersion: version, choice: "return_to_review", reason: "x" }),
          ),
        );
      },
    });
    const response = await t.w.improvements(
      new Request(`http://paws.test/api/improvements/${t.id}/recovery`, {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit),
      t.w.people["ada"]!,
      ["session-a"],
    );
    expect(response!.status).toBe(403);
    expect((await getImprovement(sqliteDb(t.w.db), t.id))!.version).toBe(version);
  });

  test("a wrong open issue can return to review; active Paws work cannot", async () => {
    const t = await linked();
    await t.sync();
    expect(await t.follow()).toMatchObject({
      attention: "ready_to_delegate",
      recovery: ["return_to_review"],
    });
    const back = await t.post("recovery", {
      expectedVersion: await t.version(),
      choice: "return_to_review",
      reason: "Linked the wrong issue",
    });
    expect(back.body.item).toMatchObject({ attention: "needs_review", issue: null });

    const busy = await linked();
    await busy.work("running");
    await busy.sync();
    expect((await busy.follow()).recovery).toEqual([]);
  });
});

describe("second review fixes", () => {
  test("a contradiction from the sweep makes an open verification form stale", async () => {
    const t = await linked({ stateType: "completed" });
    await t.sync();
    await t.post("verification", verify(await t.version(), { deployment: "v1" }));
    const form = await t.version();
    t.setIssue({ state: "open", stateType: "started" });
    await t.sync();
    expect(await t.version()).toBeGreaterThan(form);
    const replayed = await t.post("verification", verify(form, { deployment: "v1" }));
    expect([replayed.status, replayed.body.reason]).toEqual([409, "stale"]);
    expect((await getImprovement(sqliteDb(t.w.db), t.id))!.verificationState).toBe("contradicted");
  });

  test("a redelegated issue follows its replacement work item, not the cancelled one", async () => {
    const t = await linked();
    await t.work("cancelled");
    await insertQueuedItem(t.w.db, { id: "work-y", sessionKey: "session-a", now: END + 2_600 });
    t.w.db.run("UPDATE work_item SET linear_issue_id = ?, state = 'running' WHERE id = 'work-y'", [
      ISSUE,
    ]);
    await t.sync();
    expect(await t.follow()).toMatchObject({
      attention: "working",
      work: { itemId: "work-y", state: "running" },
    });
  });

  test("two improvements linked to one issue delegate it once", async () => {
    const t = await linked();
    const other = t.w.retro.b;
    t.w.db.run("INSERT INTO workspace_repository VALUES ('ws', 'acme/b', 'team-a')");
    t.w.db.run(
      `UPDATE improvement SET review_state = 'accepted', reviewed_proposal = 1, intent = 'link',
         intent_issue_id = ?, issue_id = ?, issue_identifier = 'PAS-70', issue_confirmed_at = ?
       WHERE id = ?`,
      [ISSUE, ISSUE, END, other],
    );
    const first = await t.post("delegate", { expectedVersion: await t.version() });
    expect(first.body.status).toBe("delegated");
    const view = await t.w.api("admin", `/api/improvements/${other}/follow-through`);
    expect(view.body.followThrough).toMatchObject({
      attention: "working",
      delegate: { offered: false },
    });
    const second = await t.w.api("admin", `/api/improvements/${other}/delegate`, {
      expectedVersion: (await getImprovement(sqliteDb(t.w.db), other))!.version,
    });
    expect(second.body.status).toBe("existing");
    expect(t.starter.calls).toEqual([ISSUE]);
  });

  test("a delayed read for a replaced issue is not recorded", async () => {
    const t = await linked();
    const stale = await recordImprovementIssueSync(sqliteDb(t.w.db), {
      improvementId: t.id,
      issueId: "issue-old",
      status: "available",
      stateType: "canceled",
      observedAt: END + 99_000,
    });
    expect(stale).toBe(false);
    expect((await t.follow()).issue.sync).toBeNull();
  });

  test("a workspace without a Linear connection still advances and shows unavailable", async () => {
    const t = await linked();
    await syncImprovementOutcomes({ db: t.w.db, linearFor: async () => null, now: t.w.now });
    expect(await t.follow()).toMatchObject({
      attention: "unavailable",
      issue: { sync: { status: "unavailable" } },
    });
  });
});

describe("one bound work item", () => {
  const second = async (t: Awaited<ReturnType<typeof linked>>, state: string, repo?: string) => {
    await insertQueuedItem(t.w.db, { id: "work-y", sessionKey: "session-a", now: END + 2_600 });
    t.w.db.run("UPDATE work_item SET linear_issue_id = ?, state = ? WHERE id = 'work-y'", [
      ISSUE,
      state,
    ]);
    if (repo)
      t.w.db.run("INSERT INTO work_item_repository VALUES ('work-y', 'acme', ?, 'x')", [repo]);
  };

  test("a newer run on the issue replaces verified merged work and makes verification stale", async () => {
    const t = await linked();
    await t.merge();
    await t.sync();
    await t.post("verification", verify(await t.version(), { revision: MERGE }));
    await second(t, "running");
    await t.sync();
    expect(await t.follow()).toMatchObject({
      attention: "verification_stale",
      work: { itemId: "work-y", state: "running" },
    });
    expect(t.starter.calls).toEqual([]);
  });

  test("work that finished before the issue was linked is not this improvement's work", async () => {
    const t = await linked();
    await insertQueuedItem(t.w.db, { id: "work-old", sessionKey: "session-a", now: END });
    t.w.db.run("UPDATE work_item SET linear_issue_id = ?, state = 'merged' WHERE id = 'work-old'", [
      ISSUE,
    ]);
    await t.sync();
    expect(await t.follow()).toMatchObject({
      work: null,
      attention: "ready_to_delegate",
      delegate: { offered: true },
    });
    const early = await t.post("verification", verify(await t.version(), { revision: MERGE }));
    expect(early.body.reason).toBe("not_implemented");
  });

  test("returning to review and relinking does not reuse the old merged work as proof", async () => {
    const linear = createFakeImprovementLinear();
    const starter = sessions();
    const lookup = createFakeIssueLookup([
      { id: ISSUE, identifier: "PAS-70", url: null, teamId: "team-a", state: "open" },
    ]);
    const w = await world({
      linear,
      startSession: starter.start,
      dashboardUrl: "https://paws.test/",
      lookup: lookup.lookup,
    });
    const id = w.retro.a;
    const settle = async (at: number) => {
      const d = (await listImprovementDeliveries(sqliteDb(w.db), id)).find(
        (x) => x.state !== "succeeded",
      )!;
      await claimImprovementDelivery(sqliteDb(w.db), {
        deliveryId: d.id,
        owner: "o",
        now: at,
        leaseMs: 60_000,
      });
      await settleImprovementDelivery(sqliteDb(w.db), {
        deliveryId: d.id,
        attempt: 1,
        owner: "o",
        outcome: "succeeded",
        remote: { id: ISSUE, identifier: "PAS-70", url: "https://linear.app/x/PAS-70" },
        now: at + 1,
      });
    };
    const version = async () => (await getImprovement(sqliteDb(w.db), id))!.version;
    const post = (action: string, body: unknown) =>
      w.api("ada", `/api/improvements/${id}/${action}`, body);
    const sync = () =>
      syncImprovementOutcomes({ db: w.db, linearFor: async () => linear, now: w.now });
    await w.api("ada", `/api/improvements/${id}/decision`, accept());
    await settle(END + 2_000);
    linear.issues.set(ISSUE, {
      id: ISSUE,
      identifier: "PAS-70",
      url: null,
      teamId: "team-a",
      state: "closed",
      stateType: "completed",
      delegated: false,
    });
    await insertQueuedItem(w.db, { id: "work-x", sessionKey: "session-a", now: END + 2_500 });
    w.db.run("UPDATE work_item SET linear_issue_id = ?, state = 'merged' WHERE id = 'work-x'", [
      ISSUE,
    ]);
    w.db.run(
      "INSERT INTO remote_merge_fact VALUES ('work-x', 'acme', 'a', 42, 'https://gh/pull/42', ?, ?)",
      [MERGE, END + 3_000],
    );
    await sync();
    expect(
      (await post("verification", verify(await version(), { revision: MERGE }))).body.item
        .attention,
    ).toBe("verified");
    linear.issues.set(ISSUE, { ...linear.issues.get(ISSUE)!, state: "open", stateType: "started" });
    await sync();
    const back = await post("recovery", {
      expectedVersion: await version(),
      choice: "return_to_review",
      reason: "The fix did not hold",
    });
    expect(back.body.item.attention).toBe("needs_review");
    const relinked = await w.api(
      "ada",
      `/api/improvements/${id}/decision`,
      accept(await version(), { kind: "link", issue: "PAS-70" }),
    );
    expect(relinked.body.status).toBe("decided");
    await settle(END + 9_000);
    await sync();
    const view = (await w.api("ada", `/api/improvements/${id}/follow-through`)).body.followThrough;
    expect(view).toMatchObject({
      work: null,
      attention: "ready_to_delegate",
      delegate: { offered: true },
    });
    const reused = await post("verification", verify(await version(), { revision: MERGE }));
    expect(reused.body.reason).toBe("not_implemented");
    expect((await post("delegate", { expectedVersion: await version() })).body.status).toBe(
      "delegated",
    );
    expect(starter.calls).toEqual([ISSUE]);
  });

  test("an older run still active at link time is shown instead of a second run", async () => {
    const t = await linked();
    await insertQueuedItem(t.w.db, { id: "work-old", sessionKey: "session-a", now: END });
    t.w.db.run(
      "UPDATE work_item SET linear_issue_id = ?, state = 'running' WHERE id = 'work-old'",
      [ISSUE],
    );
    const shown = await t.post("delegate", { expectedVersion: await t.version() });
    expect(shown.body).toMatchObject({
      status: "existing",
      item: { work: { itemId: "work-old" } },
    });
    expect(t.starter.calls).toEqual([]);
  });

  test("replacement work is adopted once, audited, and stales an open form", async () => {
    const t = await linked();
    await t.work("cancelled");
    await t.sync();
    const form = await t.version();
    await second(t, "merged");
    await t.sync();
    await t.sync();
    expect(await t.follow()).toMatchObject({ work: { itemId: "work-y" } });
    const follows = (await listImprovementActions(sqliteDb(t.w.db), t.id)).filter(
      (a) => a.action === "follow_work",
    );
    expect(follows.map((a) => [a.prior["work"], a.detail["work"]])).toEqual([
      [null, "work-x"],
      ["work-x", "work-y"],
    ]);
    const replayed = await t.post("verification", verify(form, { deployment: "v1" }));
    expect([replayed.status, replayed.body.reason]).toEqual([409, "stale"]);
  });

  test("work for the same issue in another repository is never followed", async () => {
    const t = await linked();
    await second(t, "merged", "b");
    await t.sync();
    expect(await t.follow()).toMatchObject({ work: null, attention: "ready_to_delegate" });
  });

  test("an expired redelegation is not settled by the work it replaced", async () => {
    const t = await linked();
    await t.work("cancelled");
    await t.sync();
    await claimImprovementDelegation(sqliteDb(t.w.db), {
      improvementId: t.id,
      issueId: ISSUE,
      actor: "user-ada",
      now: END + 5_000,
      leaseMs: 1,
    });
    await syncImprovementOutcomes({
      db: t.w.db,
      linearFor: async () => t.linear,
      now: () => END + 10_000,
    });
    expect((await t.follow()).delegation).toMatchObject({ state: "failed" });
  });

  test("failed work offers no redelegation that intake would refuse", async () => {
    const t = await linked();
    await t.work("failed");
    await t.sync();
    expect((await t.follow()).recovery).toEqual(["acknowledge", "return_to_review"]);
  });

  test("an acknowledged item stays closed after a later criterion", async () => {
    const t = await linked();
    await t.work("failed");
    await t.sync();
    await t.post("recovery", {
      expectedVersion: await t.version(),
      choice: "acknowledge",
      reason: "No",
    });
    const annotated = await t.post("criterion", {
      expectedVersion: await t.version(),
      criterion: "The retro-recovery check passes.",
    });
    expect(annotated.body.item.attention).toBe("closed");
    await t.sync();
    expect((await t.follow()).attention).toBe("closed");
  });

  test("a Closeout step only matches the criterion as a whole word", async () => {
    const t = await linked();
    await t.merge();
    t.w.db.run("UPDATE work_item SET accepted_head = ? WHERE id = 'work-x'", [MERGE]);
    await t.sync();
    t.w.db.run(
      `INSERT INTO closeout_progress (id, item_id, task_id, base, head, policy_digest, started_at,
         updated_at) VALUES ('p1', 'work-x', 't', 'b', ?, 'd', 1, 1)`,
      [MERGE],
    );
    t.w.db.run(
      `INSERT INTO closeout_step (progress_id, step_id, kind, state, command, attempt, ordinal)
       VALUES ('p1', 'test', 'command', 'passed', 'bun run unit', 1, 0)`,
    );
    await t.post("criterion", {
      expectedVersion: await t.version(),
      criterion: "The latest weekly retro shows no push-recovery question.",
    });
    const loose = await t.post(
      "verification",
      verify(await t.version(), {
        evidence: { kind: "closeout_step", progressId: "p1", stepId: "test" },
      }),
    );
    expect(loose.body.reason).toBe("not_applicable");
  });
});

describe("settled before every mutation", () => {
  const share = (t: Awaited<ReturnType<typeof linked>>) => {
    const other = t.w.retro.b;
    t.w.db.run("INSERT INTO workspace_repository VALUES ('ws', 'acme/b', 'team-a')");
    t.w.db.run(
      `UPDATE improvement SET review_state = 'accepted', reviewed_proposal = 1, intent = 'link',
         intent_issue_id = ?, issue_id = ?, issue_identifier = 'PAS-70', issue_confirmed_at = ?
       WHERE id = ?`,
      [ISSUE, ISSUE, END, other],
    );
    return other;
  };

  test("a delegation answer carries the version the next mutation needs", async () => {
    const t = await linked();
    t.starter.fail(true);
    const failed = await t.post("delegate", { expectedVersion: await t.version() });
    expect(failed.body.reason).toBe("delegation_failed");
    expect(failed.body.item.version).toBe(await t.version());
    t.starter.fail(false);
    const delegated = await t.post("delegate", { expectedVersion: failed.body.item.version });
    expect(delegated.body.status).toBe("delegated");
    expect(delegated.body.item.version).toBe(await t.version());
    const annotated = await t.post("criterion", {
      expectedVersion: delegated.body.item.version,
      criterion: "The retro-recovery check passes.",
    });
    expect(annotated.body.status).toBe("recorded");
  });

  test("another improvement's finished delegation does not block redelegating the issue", async () => {
    const t = await linked();
    const other = share(t);
    expect((await t.post("delegate", { expectedVersion: await t.version() })).body.status).toBe(
      "delegated",
    );
    await t.work("cancelled");
    await t.sync();
    const view = (await t.w.api("admin", `/api/improvements/${other}/follow-through`)).body
      .followThrough;
    expect(view.recovery).toContain("redelegate");
    const again = await t.w.api("admin", `/api/improvements/${other}/recovery`, {
      expectedVersion: view.version,
      choice: "redelegate",
      reason: "The first run was cancelled",
    });
    expect(again.body.status).toBe("delegated");
    expect(t.starter.calls).toEqual([ISSUE, ISSUE]);
  });

  test("a workspace whose reads keep failing does not starve the next one", async () => {
    const t = await linked();
    const other = t.w.retro.b;
    t.w.db.run(
      `UPDATE improvement SET review_state = 'accepted', reviewed_proposal = 1, intent = 'link',
         intent_issue_id = 'issue-y', issue_id = 'issue-y', issue_identifier = 'PAS-80',
         issue_confirmed_at = ? WHERE id = ?`,
      [END, other],
    );
    const reader = {
      async findIssue(id: string) {
        if (id === ISSUE) return { ok: false as const, failure: "rate_limited" as const };
        return {
          ok: true as const,
          value: { id, teamId: "team-a", state: "open" as const, delegated: false },
        };
      },
    };
    for (let i = 0; i < 2; i++)
      await syncImprovementOutcomes({
        db: t.w.db,
        linearFor: async () => reader,
        now: t.w.now,
        limit: 1,
      });
    expect(
      t.w.db.query("SELECT status FROM improvement_issue_sync WHERE improvement_id = ?").get(other),
    ).toEqual({ status: "available" });
  });
});

describe("manual recovery", () => {
  test("a canceled issue offers acknowledge or return to review, keeping the audit trail", async () => {
    const t = await linked({ stateType: "canceled" });
    await t.sync();
    expect((await t.follow()).recovery).toEqual(["acknowledge", "return_to_review"]);
    const acknowledged = await t.post("recovery", {
      expectedVersion: await t.version(),
      choice: "acknowledge",
      reason: "Superseded by another approach",
    });
    expect(acknowledged.body.item.attention).toBe("closed");

    const s = await linked({ stateType: "canceled" });
    await s.sync();
    const v = await s.version();
    const [first, second] = await Promise.all([
      s.post("recovery", { expectedVersion: v, choice: "return_to_review", reason: "Wrong issue" }),
      s.post("verification", { ...verify(v, { deployment: "v2" }), outcome: "contradicted" }),
    ]);
    expect([first.body.status, second.status]).toEqual(["recorded", 409]);
    expect(first.body.item).toMatchObject({ attention: "needs_review", issue: null });
    expect(await listImprovementDeliveries(sqliteDb(s.w.db), s.id)).toEqual([]);
    const audit = (await listImprovementActions(sqliteDb(s.w.db), s.id)).at(-1)!;
    expect(audit).toMatchObject({
      action: "return_to_review",
      prior: { attention: "canceled", issue: { id: ISSUE, identifier: "PAS-70" } },
      detail: { reason: "Wrong issue", createdIssue: { id: ISSUE } },
    });
    const recreate = await s.w.api(
      "ada",
      `/api/improvements/${s.id}/decision`,
      accept(await s.version()),
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
    await syncWorkspaceMember(sqliteDb(t.w.db), {
      workspaceId: "ws",
      userId: "user-ada",
      role: "member",
      active: true,
      teamIds: [],
      now: 5,
    });
    const lost = await t.post("delegate", { expectedVersion: await t.version() });
    expect(lost.status).toBe(404);
    await syncWorkspaceMember(sqliteDb(t.w.db), {
      workspaceId: "ws",
      userId: "user-ada",
      role: "member",
      active: false,
      teamIds: ["team-a"],
      now: 6,
    });
    expect((await t.post("delegate", { expectedVersion: await t.version() })).status).toBe(403);
    expect((await t.post("verification", verify(await t.version()))).status).toBe(403);
    expect(t.starter.calls).toEqual([]);
    const other = await t.w.api("bea", `/api/improvements/${t.w.retro.b}/follow-through`);
    expect(other.status).toBe(404);
  });

  test("stale sync is an explicit outcome", async () => {
    const t = await linked();
    await t.sync();
    const later = END + 2 * IMPROVEMENT_OUTCOME_LIMITS.staleSyncMs;
    const view = (await improvementFollowThrough(t.w.db, { workspaceId: "ws" }, t.id, later))!;
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
    await t.post("verification", verify(await t.version(), { deployment: "v3" }));
    const after = await read("ada");
    expect(after.counts.verificationDue).toBe(0);
    expect(after.metrics.verified).toBe(1);
  });

  test("a failed filing is a filing error entry", async () => {
    const w = await world();
    const id = w.retro.a;
    await w.api("ada", `/api/improvements/${id}/decision`, accept());
    const delivery = (await listImprovementDeliveries(sqliteDb(w.db), id))[0]!;
    await claimImprovementDelivery(sqliteDb(w.db), {
      deliveryId: delivery.id,
      owner: "o",
      now: END,
      leaseMs: 1,
    });
    await settleImprovementDelivery(sqliteDb(w.db), {
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

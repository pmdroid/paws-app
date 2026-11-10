import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelImprovementEvidenceComment,
  claimImprovementDelivery,
  decideImprovement,
  getImprovement,
  insertQueuedItem,
  listImprovementDeliveries,
  listImprovementDeliveryAttempts,
  listImprovementProposals,
  listReviewFindings,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordImprovementProposal,
  recordReviewFindings,
  repairImprovementDestination,
  requeueImprovementDelivery,
  reserveImprovementDeliveryRemote,
  syncWorkspaceMember,
  type ImprovementActionStep,
} from "../src/db";
import {
  dailyFindingKey,
  deliverImprovements,
  improvementCommentUuid,
  improvementIssueMarker,
  improvementIssueUuid,
  improvementView,
} from "../src/improvements";
import { createFakeImprovementLinear } from "../src/linear";

const REPO = "acme/app";
const MINUTE = 60_000;

function world() {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "paws-improvement-delivery-")), "db"));
  migrate(db);
  db.run("INSERT INTO workspace VALUES ('ws', 'org', 'Kyku', 0)");
  db.run("INSERT INTO workspace VALUES ('other', 'org-2', 'Other', 0)");
  db.run("INSERT INTO workspace_repository VALUES ('ws', ?, 'team-a')", [REPO]);
  db.run("INSERT INTO workspace_repository VALUES ('ws', ?, 'team-b')", [REPO]);
  db.run("INSERT INTO workspace_repository VALUES ('other', ?, 'team-x')", [REPO]);
  const userId = putWorkspaceUser(db, {
    id: "user-ada",
    linearUserId: "linear-ada",
    name: "Ada",
    email: "ada@example.invalid",
  });
  syncWorkspaceMember(db, {
    workspaceId: "ws",
    userId,
    role: "admin",
    active: true,
    teamIds: ["team-a", "team-b"],
    now: 1,
  });
  const linear = createFakeImprovementLinear({
    issues: [
      {
        id: "issue-open",
        identifier: "PAS-60",
        url: "https://linear.app/x/PAS-60",
        teamId: "team-a",
        state: "open",
        delegated: false,
      },
      {
        id: "issue-elsewhere",
        identifier: "OPS-9",
        url: null,
        teamId: "team-z",
        state: "open",
        delegated: false,
      },
    ],
  });
  let clock = 1_000_000;
  const now = () => clock;
  const advance = (ms: number) => {
    clock += ms;
  };
  const run = (
    options: { owner?: string; linearFor?: (workspaceId: string) => typeof linear | null } = {},
  ) =>
    deliverImprovements({
      db,
      owner: options.owner ?? "worker-1",
      now,
      sourceUrl: (id) => `https://paws.test/dashboard/improvements/${id}`,
      linearFor: async (workspaceId) =>
        options.linearFor ? options.linearFor(workspaceId) : workspaceId === "ws" ? linear : null,
    });
  return { db, linear, now, advance, run };
}

type World = ReturnType<typeof world>;

function proposal(step: ImprovementActionStep, title = `Fix ${step}`) {
  return {
    title,
    problem: `People answered the same ${step} question.`,
    proposedChange: `Make the ${step} change durable.`,
    actionStep: step,
    verificationCriterion: "No such question in the next two retros.",
    evidence: [`retro_evidence:r1:${step}-1`, `retro_evidence:r1:${step}-2`],
  };
}

function acceptRetro(
  w: World,
  options: {
    step?: ImprovementActionStep;
    key?: string;
    workspaceId?: string;
    intent?:
      | { kind: "create"; teamId: string }
      | { kind: "link"; issueId: string; teamId?: string; addEvidenceComment?: boolean };
  } = {},
) {
  const step = options.step ?? "issue";
  const workspaceId = options.workspaceId ?? "ws";
  const { improvementId } = recordImprovementProposal(w.db, {
    workspaceId,
    repository: REPO,
    source: { kind: "retro_item", key: options.key ?? `r1/${step}` },
    proposal: proposal(step),
    now: w.now(),
  });
  const p = proposal(step);
  const requested = options.intent ?? { kind: "create", teamId: "team-a" };
  const linked = requested.kind === "link" ? w.linear.issues.get(requested.issueId) : undefined;
  const intent =
    requested.kind === "link" && requested.teamId === undefined && linked
      ? { ...requested, teamId: linked.teamId }
      : requested;
  const decided = decideImprovement(w.db, {
    improvementId,
    expectedVersion: 1,
    review: { kind: "accept", proposalVersion: 1, intent },
    actor: "user-ada",
    now: w.now(),
    content: {
      proposalVersion: 1,
      repository: REPO,
      sourceKind: "retro_item",
      sourceKeys: [options.key ?? `r1/${step}`],
      title: p.title,
      problem: p.problem,
      proposedChange: p.proposedChange,
      actionStep: p.actionStep,
      verificationCriterion: p.verificationCriterion,
      evidence: p.evidence,
      ...(intent.kind === "link"
        ? {
            issue: {
              id: intent.issueId,
              ...(intent.teamId ? { teamId: intent.teamId } : {}),
              state: linked?.state ?? "open",
            },
          }
        : {}),
    },
  });
  if (!decided.ok) throw new Error(decided.reason);
  return improvementId;
}

const view = (w: World, id: string) =>
  improvementView(w.db, {
    improvement: getImprovement(w.db, id)!,
    sourceKind: "retro_item",
    sourceKeys: [],
    proposal: listImprovementProposals(w.db, id).at(-1)!,
    criterion: null,
    lifecycle: "pending",
    issue: null,
    legacy: [],
    undecided: [],
    verification: "unknown",
    members: [],
  });

const delivery = (w: World, improvementId: string, operation = "create_issue") =>
  listImprovementDeliveries(w.db, improvementId).find((d) => d.operation === operation)!;

const recovery = async (w: World, improvementId: string, operation: string) =>
  (await view(w, improvementId)).deliveries.find((d) => d.operation === operation)!.recovery;

const reopen = (w: World, improvementId: string) =>
  decideImprovement(w.db, {
    improvementId,
    expectedVersion: getImprovement(w.db, improvementId)!.version,
    review: { kind: "reopen" },
    actor: "user-ada",
    now: w.now(),
  });

describe("improvement delivery", () => {
  test("every action step creates one undelegated issue with its frozen evidence", async () => {
    const w = world();
    const steps: ImprovementActionStep[] = ["automatic", "rule", "convention", "decision", "issue"];
    const ids = steps.map((step) => acceptRetro(w, { step }));
    await w.run();
    await w.run();
    expect(w.linear.created).toHaveLength(5);
    for (const [index, id] of ids.entries()) {
      const created = w.linear.created.find(
        (input) => input.id === improvementIssueUuid("ws", id),
      )!;
      expect(created.teamId).toBe("team-a");
      expect(created.label).toBe("paws retro");
      expect(created.description).toContain("`acme/app`");
      expect(created.description).toContain("**Source:** Weekly retro");
      expect(created.description).toContain(
        `**Action step:** ${["Automatic", "Rule", "Convention", "Decision", "Issue"][index]}`,
      );
      expect(created.description).toContain(`Make the ${steps[index]} change durable.`);
      expect(created.description).toContain("No such question in the next two retros.");
      expect(created.description).toContain("2 evidence excerpts from 2 sources");
      expect(created.description).toContain(`https://paws.test/dashboard/improvements/${id}`);
      expect(created.description).toContain("accepted by Ada");
      expect(created.description).toContain("Paws has not delegated this issue.");
      const improvement = getImprovement(w.db, id)!;
      expect(improvement.reviewState).toBe("accepted");
      expect(improvement.issue).toMatchObject({
        id: improvementIssueUuid("ws", id),
        identifier: w.linear.issues.get(improvementIssueUuid("ws", id))!.identifier,
      });
      expect(improvement.issue!.url).toStartWith("https://linear.app/fake/issue/");
    }
    expect([...w.linear.issues.values()].every((issue) => !issue.delegated)).toBe(true);
  });

  test("a daily finding files as a review finding and its source findings carry the issue", async () => {
    const w = world();
    insertQueuedItem(w.db, { id: "item-a", sessionKey: "s", now: 1 });
    recordReviewFindings(w.db, {
      itemId: "item-a",
      repository: REPO,
      head: "a".repeat(40),
      seenAt: 2,
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
    const findings = listReviewFindings(w.db).sort((x, y) => x.id - y.id);
    let improvementId = "";
    for (const finding of findings)
      improvementId = recordImprovementProposal(w.db, {
        workspaceId: "ws",
        repository: REPO,
        source: { kind: "daily_finding", key: dailyFindingKey(finding) },
        proposal: {
          title: "Shared fix",
          problem: "Two findings",
          proposedChange: "Scope: src",
          actionStep: "issue",
          verificationCriterion: "",
          evidence: findings.map((f) => `review_finding:${f.key}`),
        },
        ...(improvementId ? { attachTo: improvementId } : {}),
        now: 3,
      }).improvementId;
    decideImprovement(w.db, {
      improvementId,
      expectedVersion: 1,
      review: {
        kind: "accept",
        proposalVersion: findings.length,
        intent: { kind: "create", teamId: "team-a" },
      },
      actor: "user-ada",
      now: 4,
      content: {
        proposalVersion: findings.length,
        repository: REPO,
        sourceKind: "daily_finding",
        sourceKeys: findings.map(dailyFindingKey),
        title: "Shared fix",
        problem: "Two findings",
        proposedChange: "Scope: src",
        actionStep: "issue",
        verificationCriterion: "Both findings are gone from the next review.",
        evidence: findings.map((f) => `review_finding:${f.key}`),
      },
    });
    // Marking the source findings fails once: the delivery's success rolls back with it,
    // and the next claim reconciles the same issue and files both findings together.
    w.db.run(`CREATE TRIGGER fail_filing BEFORE UPDATE ON review_finding
      BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    await w.run();
    expect(delivery(w, improvementId).state).toBe("claimed");
    expect(getImprovement(w.db, improvementId)!.issue).toBeNull();
    expect(listReviewFindings(w.db).map((f) => f.status)).toEqual(["open", "open"]);
    w.db.run("DROP TRIGGER fail_filing");
    w.advance(10 * MINUTE);
    await w.run();
    expect(delivery(w, improvementId).state).toBe("succeeded");
    expect(w.linear.created).toHaveLength(1);
    const created = w.linear.created[0]!;
    expect(created.label).toBe("review finding");
    expect(created.description).toContain("**Source:** Daily review findings");
    expect(created.description).not.toContain("Weekly retro");
    expect(created.description).toContain("2 review findings");
    const identifier = getImprovement(w.db, improvementId)!.issue!.identifier;
    expect(listReviewFindings(w.db).map((f) => [f.status, f.filedIssue])).toEqual([
      ["filed", identifier],
      ["filed", identifier],
    ]);
  });

  test("the issue UUID is reserved before the request and a lost response reconciles it", async () => {
    const w = world();
    const id = acceptRetro(w);
    w.linear.fail("createIssue", "lose");
    await w.run();
    const lost = delivery(w, id);
    expect(lost.state).toBe("unknown");
    expect(lost.remoteId).toBe(improvementIssueUuid("ws", id));
    expect(getImprovement(w.db, id)!.reviewState).toBe("accepted");
    expect((await view(w, id)).deliveries[0]).toMatchObject({ status: "unknown", recovery: null });
    await w.run();
    expect(delivery(w, id).state).toBe("unknown");
    w.advance(10 * MINUTE);
    await w.run();
    expect(delivery(w, id).state).toBe("succeeded");
    expect(w.linear.created).toHaveLength(1);
    expect(w.linear.calls.filter((c) => c.method === "createIssue")).toHaveLength(1);
    expect(getImprovement(w.db, id)!.issue!.id).toBe(improvementIssueUuid("ws", id));
  });

  test("a double click, a crashed worker and duplicate dispatch leave one issue", async () => {
    const w = world();
    const id = acceptRetro(w);
    const again = decideImprovement(w.db, {
      improvementId: id,
      expectedVersion: 1,
      review: { kind: "accept", proposalVersion: 1, intent: { kind: "create", teamId: "team-a" } },
      actor: "user-ada",
      now: w.now(),
    });
    expect(again.ok).toBe(false);
    const crashed = claimImprovementDelivery(w.db, {
      deliveryId: delivery(w, id).id,
      owner: "crashed",
      now: w.now(),
      leaseMs: 1_000,
    })!;
    reserveImprovementDeliveryRemote(w.db, {
      deliveryId: crashed.id,
      owner: "crashed",
      attempt: crashed.attempts,
      remoteId: improvementIssueUuid("ws", id),
    });
    await w.linear.createIssue({
      id: improvementIssueUuid("ws", id),
      teamId: "team-a",
      title: "t",
      description: `Paws reference: \`${improvementIssueMarker(getImprovement(w.db, id)!)}\``,
      label: "paws retro",
    });
    await w.run();
    expect(delivery(w, id).state).toBe("claimed");
    w.advance(2_000);
    await Promise.all([w.run({ owner: "worker-1" }), w.run({ owner: "worker-2" })]);
    expect(delivery(w, id).state).toBe("succeeded");
    expect(w.linear.created).toHaveLength(1);
    expect(listImprovementDeliveryAttempts(w.db, delivery(w, id).id).map((a) => a.outcome)).toEqual(
      ["expired", "succeeded"],
    );
  });

  test("rate limiting keeps the decision and waits for Linear's retry time", async () => {
    const w = world();
    const id = acceptRetro(w);
    w.linear.fail("findIssue", {
      ok: false,
      failure: "rate_limited",
      retryAfterMs: 5 * MINUTE,
      message: "RATELIMITED",
    });
    await w.run();
    const limited = delivery(w, id);
    expect(limited.state).toBe("failed");
    expect(limited.blocked).toBeNull();
    expect(limited.nextAttemptAt).toBe(w.now() + 5 * MINUTE);
    expect(getImprovement(w.db, id)!.reviewState).toBe("accepted");
    w.advance(4 * MINUTE);
    const calls = w.linear.calls.length;
    await w.run();
    expect(w.linear.calls).toHaveLength(calls);
    w.advance(MINUTE);
    await w.run();
    expect(delivery(w, id).state).toBe("succeeded");
  });

  test("revoked access blocks until a person retries; transient outages are bounded", async () => {
    const w = world();
    const id = acceptRetro(w);
    w.linear.fail("findIssue", { ok: false, failure: "unauthorized", message: "401" });
    await w.run();
    expect(delivery(w, id)).toMatchObject({ state: "failed", blocked: "unauthorized" });
    w.advance(24 * 60 * MINUTE);
    await w.run();
    expect(delivery(w, id).state).toBe("failed");
    expect(getImprovement(w.db, id)!.reviewState).toBe("accepted");
    requeueImprovementDelivery(w.db, { deliveryId: delivery(w, id).id, now: w.now() });
    await w.run();
    expect(delivery(w, id).state).toBe("succeeded");

    const other = acceptRetro(w, { key: "r1/other" });
    for (let i = 0; i < 8; i++) {
      w.linear.fail("findIssue", { ok: false, failure: "unavailable", message: "502" });
      await w.run();
      w.advance(2 * 60 * MINUTE);
    }
    expect(delivery(w, other)).toMatchObject({ state: "failed", blocked: "attempts", attempts: 8 });
    expect(w.linear.created).toHaveLength(1);
  });

  test("a removed destination mapping is accepted but unfiled until a person repairs it", async () => {
    const w = world();
    const id = acceptRetro(w);
    w.db.run("DELETE FROM workspace_repository WHERE team_id = 'team-a'");
    await w.run();
    expect(delivery(w, id)).toMatchObject({ state: "failed", blocked: "destination" });
    expect(w.linear.calls).toHaveLength(0);
    expect((await view(w, id)).deliveries[0]).toMatchObject({
      status: "retryable",
      blocked: "destination",
      recovery: "choose_destination",
    });
    expect(
      repairImprovementDestination(w.db, {
        deliveryId: delivery(w, id).id,
        teamId: "team-b",
        now: w.now(),
      }),
    ).not.toBeNull();
    await w.run();
    expect(w.linear.created[0]).toMatchObject({
      id: improvementIssueUuid("ws", id),
      teamId: "team-b",
    });
  });

  test("an unknown outcome never reroutes, even after its mapping is removed", async () => {
    const w = world();
    const id = acceptRetro(w);
    w.linear.fail("createIssue", { ok: false, failure: "unknown", message: "timeout" });
    await w.run();
    w.db.run("DELETE FROM workspace_repository WHERE team_id = 'team-a'");
    w.advance(10 * MINUTE);
    await w.run();
    expect(delivery(w, id)).toMatchObject({ state: "unknown", blocked: "destination" });
    expect(
      repairImprovementDestination(w.db, {
        deliveryId: delivery(w, id).id,
        teamId: "team-b",
        now: w.now(),
      }),
    ).toBeNull();
    expect(() =>
      w.db.run("UPDATE improvement_delivery SET target_team_id = 'team-b' WHERE id = ?", [
        delivery(w, id).id,
      ]),
    ).toThrow("frozen");
    expect(w.linear.created).toHaveLength(0);
  });

  test("a pre-existing issue id in another team is not linked", async () => {
    const w = world();
    const id = acceptRetro(w);
    w.linear.issues.set(improvementIssueUuid("ws", id), {
      id: improvementIssueUuid("ws", id),
      identifier: "ODD-1",
      url: null,
      teamId: "team-z",
      state: "open",
      delegated: false,
    });
    await w.run();
    expect(delivery(w, id)).toMatchObject({ state: "failed", blocked: "conflict" });
    expect(getImprovement(w.db, id)!.issue).toBeNull();
  });

  test("an issue under this improvement's id without its Paws reference is not linked", async () => {
    const w = world();
    const id = acceptRetro(w);
    const other = acceptRetro(w, { key: "r2/issue" });
    w.linear.issues.set(improvementIssueUuid("ws", id), {
      id: improvementIssueUuid("ws", id),
      identifier: "PAS-77",
      url: null,
      teamId: "team-a",
      state: "open",
      delegated: false,
      description: `Paws reference: \`${improvementIssueMarker(getImprovement(w.db, other)!)}\``,
    });
    await w.run();
    expect(delivery(w, id)).toMatchObject({ state: "failed", blocked: "conflict" });
    expect(getImprovement(w.db, id)!.issue).toBeNull();
    expect(delivery(w, other).state).toBe("succeeded");
    expect(w.linear.created.at(-1)!.description).toContain(
      improvementIssueMarker(getImprovement(w.db, other)!),
    );
  });

  test("each workspace delivers only through its own Linear connection", async () => {
    const w = world();
    const mine = acceptRetro(w);
    const theirs = acceptRetro(w, {
      workspaceId: "other",
      key: "r9/x",
      intent: { kind: "create", teamId: "team-x" },
    });
    await w.run();
    expect(delivery(w, mine).state).toBe("succeeded");
    expect(delivery(w, theirs)).toMatchObject({ state: "failed", blocked: "workspace" });
    expect(w.linear.calls.some((c) => c.id === improvementIssueUuid("other", theirs))).toBe(false);
    expect(improvementIssueUuid("ws", mine)).not.toBe(improvementIssueUuid("other", mine));
  });

  test("link only records the association and writes nothing to Linear", async () => {
    const w = world();
    const id = acceptRetro(w, { intent: { kind: "link", issueId: "issue-open" } });
    await w.run();
    await w.run();
    expect(delivery(w, id, "link_issue").state).toBe("succeeded");
    expect(getImprovement(w.db, id)!.issue).toMatchObject({
      id: "issue-open",
      identifier: "PAS-60",
      url: "https://linear.app/x/PAS-60",
    });
    expect(w.linear.calls.map((c) => c.method)).toEqual(["findIssue"]);
    expect(w.linear.comments.size).toBe(0);
  });

  test("a link to an unavailable or unmapped issue never falls back to creating one", async () => {
    const w = world();
    const gone = acceptRetro(w, { key: "r1/gone", intent: { kind: "link", issueId: "missing" } });
    const away = acceptRetro(w, {
      key: "r1/away",
      intent: { kind: "link", issueId: "issue-elsewhere" },
    });
    await w.run();
    expect(delivery(w, gone, "link_issue")).toMatchObject({
      state: "failed",
      blocked: "unavailable",
    });
    expect(delivery(w, away, "link_issue")).toMatchObject({
      state: "failed",
      blocked: "destination",
    });
    expect(w.linear.calls.some((c) => c.method === "createIssue")).toBe(false);
    expect(listImprovementDeliveries(w.db, gone).map((d) => d.operation)).toEqual(["link_issue"]);
  });

  test("a linked issue that moved to another mapped team is not followed", async () => {
    const w = world();
    const id = acceptRetro(w, {
      intent: { kind: "link", issueId: "issue-open", addEvidenceComment: true },
    });
    expect(delivery(w, id, "link_issue").targetTeamId).toBe("team-a");
    expect(delivery(w, id, "evidence_comment").targetTeamId).toBe("team-a");
    w.linear.issues.set("issue-open", { ...w.linear.issues.get("issue-open")!, teamId: "team-b" });
    await w.run();
    expect(delivery(w, id, "link_issue")).toMatchObject({
      state: "failed",
      blocked: "destination",
    });
    expect(w.linear.comments.size).toBe(0);
    expect(getImprovement(w.db, id)!.issue).toBeNull();
    expect(await recovery(w, id, "link_issue")).toBe("reopen");

    expect(reopen(w, id).ok).toBe(true);
    expect(getImprovement(w.db, id)).toMatchObject({ reviewState: "needs_review", intent: null });
    expect(listImprovementDeliveries(w.db, id)).toEqual([]);
    const relinked = decideImprovement(w.db, {
      improvementId: id,
      expectedVersion: getImprovement(w.db, id)!.version,
      review: {
        kind: "accept",
        proposalVersion: 1,
        intent: { kind: "link", issueId: "issue-open", teamId: "team-b" },
      },
      actor: "user-ada",
      now: w.now(),
      content: { issue: { id: "issue-open", teamId: "team-b", state: "open" } },
    });
    expect(relinked.ok).toBe(true);
    await w.run();
    expect(delivery(w, id, "link_issue").state).toBe("succeeded");
    expect(getImprovement(w.db, id)!.issue!.id).toBe("issue-open");
  });

  test("a legacy link without a frozen team can be reopened and linked again", async () => {
    const w = world();
    const id = acceptRetro(w, { intent: { kind: "link", issueId: "issue-open" } });
    w.db.run("DROP TRIGGER improvement_delivery_intent_frozen");
    w.db.run("UPDATE improvement_delivery SET target_team_id = NULL, content = '{}'");
    await w.run();
    expect(delivery(w, id, "link_issue")).toMatchObject({
      state: "failed",
      blocked: "destination",
    });
    expect(await recovery(w, id, "link_issue")).toBe("reopen");
    expect(reopen(w, id).ok).toBe(true);
    expect(getImprovement(w.db, id)!.reviewState).toBe("needs_review");
  });

  test("reopen is refused once anything may have reached Linear", async () => {
    const w = world();
    const created = acceptRetro(w, { key: "r1/create" });
    w.linear.fail("createIssue", { ok: false, failure: "unauthorized", message: "401" });
    await w.run();
    expect(delivery(w, created).blocked).toBe("unauthorized");
    expect(reopen(w, created)).toMatchObject({ ok: false, reason: "accepted" });

    const linked = acceptRetro(w, {
      key: "r1/link",
      intent: { kind: "link", issueId: "issue-open", addEvidenceComment: true },
    });
    w.linear.fail("createComment", "lose");
    await w.run();
    expect(delivery(w, linked, "evidence_comment").state).toBe("unknown");
    expect(reopen(w, linked)).toMatchObject({ ok: false, reason: "accepted" });
    expect(
      cancelImprovementEvidenceComment(w.db, delivery(w, linked, "evidence_comment").id),
    ).toBeNull();
    expect(listImprovementDeliveries(w.db, linked)).toHaveLength(2);
  });

  test("a target closed after acceptance needs a new review choice before link or evidence", async () => {
    const w = world();
    const withComment = acceptRetro(w, {
      key: "r1/a",
      intent: { kind: "link", issueId: "issue-open", addEvidenceComment: true },
    });
    w.linear.fail("findComment", { ok: false, failure: "rate_limited", message: "429" });
    await w.run();
    expect(delivery(w, withComment, "link_issue").state).toBe("succeeded");
    expect(delivery(w, withComment, "evidence_comment").state).toBe("failed");
    const pending = acceptRetro(w, {
      key: "r1/b",
      intent: { kind: "link", issueId: "issue-open" },
    });
    w.linear.issues.set("issue-open", { ...w.linear.issues.get("issue-open")!, state: "closed" });
    // Accepted while closed: the reviewer confirmed the closed target.
    const confirmed = acceptRetro(w, {
      key: "r1/c",
      intent: { kind: "link", issueId: "issue-open" },
    });
    w.advance(10 * MINUTE);
    await w.run();
    expect(delivery(w, withComment, "evidence_comment")).toMatchObject({
      state: "failed",
      blocked: "conflict",
    });
    expect(delivery(w, pending, "link_issue")).toMatchObject({
      state: "failed",
      blocked: "conflict",
    });
    expect(delivery(w, confirmed, "link_issue").state).toBe("succeeded");
    expect(w.linear.comments.size).toBe(0);
    expect(w.linear.calls.some((c) => c.method === "createComment")).toBe(false);

    expect(await recovery(w, pending, "link_issue")).toBe("reopen");
    expect(reopen(w, pending).ok).toBe(true);
    expect(await recovery(w, withComment, "evidence_comment")).toBe("cancel_comment");
    expect(reopen(w, withComment)).toMatchObject({ ok: false, reason: "accepted" });
    const comment = delivery(w, withComment, "evidence_comment");
    expect(cancelImprovementEvidenceComment(w.db, comment.id)).toMatchObject({
      reviewState: "accepted",
      evidenceComment: false,
    });
    expect(listImprovementDeliveries(w.db, withComment).map((d) => d.operation)).toEqual([
      "link_issue",
    ]);
    expect(getImprovement(w.db, withComment)!.issue!.id).toBe("issue-open");
  });

  test("link and add evidence posts one comment, reconciling an uncertain post", async () => {
    const w = world();
    const id = acceptRetro(w, {
      intent: { kind: "link", issueId: "issue-open", addEvidenceComment: true },
    });
    w.linear.fail("createComment", "lose");
    await w.run();
    expect(delivery(w, id, "link_issue").state).toBe("succeeded");
    const comment = delivery(w, id, "evidence_comment");
    expect(comment.state).toBe("unknown");
    expect(comment.remoteId).toBe(improvementCommentUuid("ws", id));
    w.advance(10 * MINUTE);
    await w.run();
    w.advance(10 * MINUTE);
    await w.run();
    expect(delivery(w, id, "evidence_comment").state).toBe("succeeded");
    expect(w.linear.comments.size).toBe(1);
    expect(w.linear.calls.filter((c) => c.method === "createComment")).toHaveLength(1);
    const body = w.linear.comments.get(improvementCommentUuid("ws", id))!.body;
    expect(body).toContain("weekly retro");
    expect(body).toContain("Linking does not mean this issue covers the new scope.");
    expect(getImprovement(w.db, id)!.issue!.id).toBe("issue-open");
  });

  test("the evidence comment waits for its link and a refused post is retried, not duplicated", async () => {
    const w = world();
    const id = acceptRetro(w, {
      intent: { kind: "link", issueId: "issue-open", addEvidenceComment: true },
    });
    w.linear.fail("findIssue", { ok: false, failure: "unavailable", message: "502" });
    await w.run();
    expect(delivery(w, id, "link_issue").state).toBe("failed");
    expect(delivery(w, id, "evidence_comment").attempts).toBe(0);
    w.linear.fail("createComment", { ok: false, failure: "rate_limited", message: "429" });
    w.advance(MINUTE);
    await w.run();
    expect(delivery(w, id, "evidence_comment")).toMatchObject({ state: "failed", blocked: null });
    w.advance(10 * MINUTE);
    await w.run();
    expect(delivery(w, id, "evidence_comment").state).toBe("succeeded");
    expect(w.linear.comments.size).toBe(1);
  });

  test("recurring evidence reuses the confirmed issue instead of filing another", async () => {
    const w = world();
    const id = acceptRetro(w);
    await w.run();
    recordImprovementProposal(w.db, {
      workspaceId: "ws",
      repository: REPO,
      source: { kind: "retro_item", key: "r2/issue" },
      proposal: proposal("issue", "Fix issue again"),
      attachTo: id,
      now: w.now(),
    });
    w.advance(MINUTE);
    await w.run();
    expect(w.linear.created).toHaveLength(1);
    expect(listImprovementDeliveries(w.db, id)).toHaveLength(1);
  });
});

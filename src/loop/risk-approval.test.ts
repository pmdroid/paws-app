import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixChangedPaths, samePatch } from "../closeout";
import { JOB_KIND, riskCarryOverReason } from "../core";
import {
  applyWorkItemEvent,
  ensureCloseoutProgress,
  finishCloseoutProgress,
  upsertCloseoutStep,
  beginImplementRun,
  enqueueJob,
  enqueueOutboxOnce,
  getLinkAsk,
  getRiskFix,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  migrate,
  recordReviewFindings,
  listReviewFindings,
  setReviewFindingStatus,
  openDatabase,
  saveCandidateRisk,
  saveCheckpoint,
} from "../db";
import { findOpenQuestion, LINK_ASK_REMINDER_MS } from "../questions";
import { saveSchedulingContext } from "../scheduler";
import { createFakeTracker } from "../linear";
import { deliverLinearOutbox } from "./dispatch";
import { decideLinkAsk, guideLinkAsk } from "./link-ask";
import { mergeable } from "../merge";
import { classifyPathsRisk } from "./candidate-risk";
import {
  askRiskApproval,
  riskApprovalFor,
  riskEligibilityFor,
  RISK_REPLY_NOTE,
  riskApprovals,
} from "./risk-approval";

const NOW = 1_700_000_000_000;
const PUBLIC_URL = "https://paws.example/";
const actor = { workspaceId: "ws", userId: "user-lead", name: "Lea" };

/** A repository with head S, the same patch rebased onto a newer main, and a changed patch. */
let repo = "";
const heads = {
  base: "",
  s: "",
  rebased: "",
  newMain: "",
  changed: "",
  ciFix: "",
  authFix: "",
  rebasedCiFix: "",
  both: "",
  mainWithTest: "",
  absorbed: "",
};

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function commit(file: string, content: string, message: string): string {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), content);
  git("add", ".");
  git("commit", "-qm", message);
  return git("rev-parse", "HEAD");
}

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), "paws-risk-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "paws-test@example.com");
  git("config", "user.name", "Paws Test");
  git("config", "commit.gpgsign", "false");
  heads.base = commit("README.md", "demo\n", "init");
  git("checkout", "-qb", "task");
  heads.s = commit("session.ts", "export const ttl = 60;\n", "rotate session tokens");
  git("checkout", "-q", "main");
  heads.newMain = commit("docs.md", "docs\n", "main moves");
  git("checkout", "-qb", "rebased");
  git("cherry-pick", heads.s);
  heads.rebased = git("rev-parse", "HEAD");
  heads.changed = commit("session.ts", "export const ttl = 5;\n", "shorter ttl");
  // Fixes Paws made on S after the approval: one for CI that only changes a test, one that
  // changes auth code, and the CI fix again on the newer main.
  git("checkout", "-qb", "ci-fix", heads.s);
  heads.ciFix = commit("test/x.test.ts", "test('ttl', () => {});\n", "fix the flaky test");
  git("checkout", "-qb", "auth-fix", heads.s);
  heads.authFix = commit("src/auth/session.ts", "export const rotate = true;\n", "rotate on read");
  git("checkout", "-qb", "rebased-ci-fix", heads.rebased);
  git("cherry-pick", heads.ciFix);
  heads.rebasedCiFix = git("rev-parse", "HEAD");
  // A patch that changes auth code and a test, and main taking the same test on its own: the
  // rebase drops the test from the patch, which is a changed patch, not a fix.
  git("checkout", "-qb", "both", heads.base);
  mkdirSync(path.join(repo, "test"), { recursive: true });
  writeFileSync(path.join(repo, "test/y.test.ts"), "test('token', () => {});\n");
  heads.both = commit("src/auth/token.ts", "export const token = 1;\n", "tokens and their test");
  git("checkout", "-qb", "main-with-test", heads.newMain);
  heads.mainWithTest = commit("test/y.test.ts", "test('token', () => {});\n", "main adds the test");
  git("checkout", "-qb", "absorbed", heads.mainWithTest);
  git("cherry-pick", heads.both);
  heads.absorbed = git("rev-parse", "HEAD");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

/** Closeout accepted high-risk head S, its pull request is open, and the lane holds it. */
function held(head = heads.s, base = heads.base) {
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, {
    id: "ENG-106",
    sessionKey: "ses_1",
    title: "Token rotation",
  });
  beginImplementRun(db, item.id, NOW - 10);
  applyWorkItemEvent(db, item.id, "turn_ended");
  applyWorkItemEvent(db, item.id, "closeout_accepted");
  saveCheckpoint(db, item.id, { phase: "merge_queue", baseSha: base, wipCommit: head });
  db.run("UPDATE work_item SET delegated_by = 'delegator' WHERE id = ?", [item.id]);
  saveSchedulingContext(db, { itemId: item.id, projectId: "project", projectLeadId: "lead" });
  db.run("INSERT INTO workspace (id, linear_organization_id, name, created_at) VALUES (?,?,?,?)", [
    "ws",
    "org",
    "Kyku",
    NOW,
  ]);
  db.run("INSERT INTO workspace_user (id, linear_user_id, name, email) VALUES (?,?,?,?)", [
    "user-lead",
    "lead",
    "Lea",
    "lea@example.com",
  ]);
  // The merge job that published the pull request, and its response in Linear.
  enqueueJob(db, { queue: JOB_KIND.merge, payload: { itemId: item.id }, now: NOW - 5 });
  enqueueOutboxOnce(db, {
    target: "linear",
    op: "activity",
    orderingKey: "ses_1",
    idempotencyKey: `pull-request-ready:${item.id}:0`,
    payload: { id: crypto.randomUUID(), sessionId: "ses_1", kind: "response", body: "Opened #1." },
    now: NOW - 4,
  });
  classify(db, head, base);
  return { db, itemId: item.id };
}

function classify(db: ReturnType<typeof openDatabase>, head: string, base: string) {
  saveCandidateRisk(db, {
    itemId: "ENG-106",
    head,
    base,
    tier: "high",
    paths: ["session.ts"],
    classifiedAt: NOW,
  });
}

function asked(head = heads.s) {
  const fixture = held(head);
  const outcome = askRiskApproval(fixture.db, {
    item: getWorkItem(fixture.db, fixture.itemId)!,
    head,
    publicUrl: PUBLIC_URL,
    now: NOW,
  });
  expect(outcome).toBe("asked");
  return { ...fixture, question: findOpenQuestion(fixture.db, "ses_1")! };
}

function approval(db: ReturnType<typeof openDatabase>, head: string) {
  return riskApprovalFor(db, {
    itemId: "ENG-106",
    head,
    publicUrl: PUBLIC_URL,
    samePatch: (approved, base) => samePatch(repo, approved, head, base),
  });
}

/** The repository's high-risk globs in Settings › Merging. */
const HIGH_RISK = ["session.ts", "src/auth/**"];

/** `riskApprovalFor` as the orchestrator wires it: the fix's own files, classified. */
function approvalWithFixes(
  db: ReturnType<typeof openDatabase>,
  head: string,
  globs: readonly string[] = HIGH_RISK,
) {
  return riskApprovalFor(db, {
    itemId: "ENG-106",
    head,
    publicUrl: PUBLIC_URL,
    samePatch: (approved, base) => samePatch(repo, approved, head, base),
    fixRisk: async (approvedHead, base) => {
      const changed = await fixChangedPaths(repo, approvedHead, head, base);
      if (changed === null) return null;
      const risk = await classifyPathsRisk({
        git: async (args) => git(...args),
        base,
        changed,
        settingsGlobs: globs,
      });
      return { changed, paths: risk.paths };
    },
    now: NOW + 500,
  });
}

/** A person approved S on the Risk card. */
function riskApproved() {
  const fixture = asked();
  decideLinkAsk(fixture.db, {
    questionId: fixture.question.id,
    decision: "approve",
    note: null,
    answeredBy: "delegator",
    actor,
    now: NOW + 100,
  });
  return fixture;
}

/** The fix at `head` passed Closeout and the lane holds it again. */
function fixAccepted(db: ReturnType<typeof openDatabase>, head: string, base: string) {
  if (getWorkItem(db, "ENG-106")?.state === "verifying")
    applyWorkItemEvent(db, "ENG-106", "closeout_accepted");
  saveCheckpoint(db, "ENG-106", { phase: "merge_queue", baseSha: base, wipCommit: head });
  saveCandidateRisk(db, {
    itemId: "ENG-106",
    head,
    base,
    tier: "high",
    paths: ["session.ts"],
    classifiedAt: NOW + 400,
  });
}

function activities(db: ReturnType<typeof openDatabase>) {
  return listOutbox(db)
    .filter((row) => row.op === "activity" && row.idempotencyKey.startsWith("risk-approval:"))
    .map((row) => {
      const payload = row.payload as { kind: string; body: string };
      return { key: row.idempotencyKey, kind: payload.kind, body: payload.body };
    });
}

function resumes(db: ReturnType<typeof openDatabase>) {
  return listJobs(db)
    .filter((job) => job.queue === JOB_KIND.resume)
    .map((job) => job.payload as { handoff: string; reason: string });
}

test("a high-risk head is asked with a link: Markdown, no options, the link on the session", async () => {
  const { db, itemId, question } = asked();
  expect(await approval(db, heads.s)).toBe("missing");
  expect(getWorkItem(db, itemId)?.state).toBe("awaiting_input");
  expect(question.kind).toBe("link");
  expect(getLinkAsk(db, question.id)).toMatchObject({
    kind: "risk",
    headCommit: heads.s,
    link: "https://paws.example/status/issues/ENG-106#risk",
    answerers: ["delegator", "lead"],
    detail: "High-risk paths changed: `session.ts`.",
  });
  const elicitations = listOutbox(db).filter((row) => row.op === "elicitation");
  expect(elicitations).toHaveLength(1);
  const payload = elicitations[0]!.payload as { options: unknown[]; body: string };
  expect(payload.options).toEqual([]);
  expect(payload.body).toContain(`High-risk changes in ${heads.s.slice(0, 7)} need your approval.`);
  expect(payload.body).toContain("High-risk paths changed: `session.ts`.");
  expect(payload.body).toContain("Decide in Paws: https://paws.example/status/issues/ENG-106#risk");
  expect(payload.body).toContain("A reply here cannot approve the risk.");
  expect(listJobs(db).find((job) => job.queue === JOB_KIND.linkAskReminder)?.runAt).toBe(
    NOW + LINK_ASK_REMINDER_MS,
  );
});

test("a normal-tier head, or a Paws without an https link, needs no approval", async () => {
  const { db } = held();
  saveCandidateRisk(db, {
    itemId: "ENG-106",
    head: heads.s,
    base: heads.base,
    tier: "normal",
    paths: [],
    classifiedAt: NOW,
  });
  expect(await approval(db, heads.s)).toBe("not_required");
  classify(db, heads.s, heads.base);
  const local = (publicUrl: string | null) =>
    riskApprovalFor(db, {
      itemId: "ENG-106",
      head: heads.s,
      publicUrl,
      samePatch: async () => false,
    });
  expect(await local(null)).toBe("not_required");
  expect(await local("http://127.0.0.1:8787")).toBe("not_required");
  expect(
    askRiskApproval(db, {
      item: getWorkItem(db, "ENG-106")!,
      head: heads.s,
      publicUrl: null,
      now: NOW,
    }),
  ).toBe("unavailable");
  // A head Paws could not classify is not read as normal.
  expect(await approval(db, heads.changed)).toBe("missing");
});

test("Approve on the Risk card binds to S and sends the item back to the merge queue", async () => {
  const { db, itemId, question } = asked();
  const outcome = decideLinkAsk(db, {
    questionId: question.id,
    decision: "approve",
    note: null,
    answeredBy: "delegator",
    actor,
    now: NOW + 100,
  });
  expect(outcome).toBe("answered");
  expect(await approval(db, heads.s)).toBe("approved");
  expect(getWorkItem(db, itemId)?.state).toBe("verifying");
  expect(
    listJobs(db)
      .filter((job) => job.queue === JOB_KIND.reverify)
      .map((job) => [job.jobKey, job.payload]),
  ).toEqual([[`risk-approved:${question.id}`, { itemId, decide: true }]]);
  expect(resumes(db)).toEqual([]);
  expect(activities(db)).toEqual([
    {
      key: `risk-approval:decided:${question.id}`,
      kind: "response",
      body: `Lea approved the high-risk changes in ${heads.s.slice(0, 7)} in Paws. The pull request joins the merge queue.`,
    },
  ]);
  // The link leaves the session once the approval is decided.
  expect(
    listOutbox(db).some((row) => row.idempotencyKey === `link-ask-url-removed:${question.id}`),
  ).toBe(true);
});

test("Request changes on the Risk card restarts the item with the note", async () => {
  const { db, itemId, question } = asked();
  decideLinkAsk(db, {
    questionId: question.id,
    decision: "changes",
    note: "Keep the old tokens valid for a day.",
    answeredBy: "lead",
    actor,
    now: NOW + 100,
  });
  expect(getWorkItem(db, itemId)?.state).toBe("queued");
  expect(resumes(db)).toEqual([
    expect.objectContaining({
      reason: "review",
      handoff: expect.stringContaining("Keep the old tokens valid for a day."),
    }),
  ]);
  expect(activities(db)).toMatchObject([{ kind: "thought" }]);
  expect(activities(db)[0]!.body).toContain("requested changes to");
  expect(await approval(db, heads.s)).toBe("missing");
});

test("a Linear reply requests changes and never approves, even when it says approve", async () => {
  const { db, itemId, question } = asked();
  expect(
    guideLinkAsk(db, {
      questionId: question.id,
      eventKey: "reply-1",
      body: "approve",
      answeredBy: "delegator",
      now: NOW + 100,
    }),
  ).toBe(true);
  expect(await approval(db, heads.s)).toBe("missing");
  expect(riskApprovals(db, itemId)).toEqual([]);
  expect(getLinkAsk(db, question.id)).toMatchObject({ decision: null, closedReason: "guidance" });
  expect(getWorkItem(db, itemId)?.state).toBe("queued");
  expect(resumes(db)).toEqual([
    expect.objectContaining({ reason: "review", handoff: expect.stringContaining("approve") }),
  ]);
  expect(activities(db)).toEqual([
    { key: `risk-approval:reply:${question.id}`, kind: "thought", body: RISK_REPLY_NOTE },
  ]);
});

test("Stop stops the item and leaves the pull request open", () => {
  const { db, itemId, question } = asked();
  const outcome = decideLinkAsk(db, {
    questionId: question.id,
    decision: "stop",
    note: null,
    answeredBy: "lead",
    actor,
    now: NOW + 100,
  });
  expect(outcome).toBe("answered");
  expect(getWorkItem(db, itemId)?.state).toBe("cancelled");
  expect(getLinkAsk(db, question.id)).toMatchObject({
    closedReason: "cancelled",
    decidedBy: "lead",
  });
  expect(listJobs(db).filter((job) => job.queue === JOB_KIND.closeStoppedPull)).toEqual([]);
  const stopped = listOutbox(db).find((row) => row.idempotencyKey.startsWith("command:stop:"));
  const payload = stopped?.payload as { kind: string; body: string } | undefined;
  expect(payload?.kind).toBe("response");
  expect(payload?.body).toContain("The pull request stays open.");
});

test("someone who is neither the delegator nor the lead cannot answer", async () => {
  const { db, itemId, question } = asked();
  for (const decision of ["approve", "changes", "stop"] as const)
    expect(
      decideLinkAsk(db, {
        questionId: question.id,
        decision,
        note: decision === "changes" ? "Rewrite it." : null,
        answeredBy: "someone",
        actor,
        now: NOW + 100,
      }),
    ).toBe("forbidden");
  expect(await approval(db, heads.s)).toBe("missing");
  expect(getWorkItem(db, itemId)?.state).toBe("awaiting_input");
  expect(getLinkAsk(db, question.id)?.closedAt).toBeNull();
});

test("Stop only fits a risk approval", () => {
  const { db, question } = asked();
  db.run("UPDATE link_ask SET kind = 'screenshots' WHERE question_id = ?", [question.id]);
  expect(
    decideLinkAsk(db, {
      questionId: question.id,
      decision: "stop",
      note: null,
      answeredBy: "lead",
      actor,
      now: NOW + 100,
    }),
  ).toBe("rejected");
});

test("a new head after the approval needs a new approval; a rebase onto main keeps it", async () => {
  const { db, question } = asked();
  decideLinkAsk(db, {
    questionId: question.id,
    decision: "approve",
    note: null,
    answeredBy: "delegator",
    actor,
    now: NOW + 100,
  });
  // The same patch on a newer main.
  classify(db, heads.rebased, heads.newMain);
  expect(await approval(db, heads.rebased)).toBe("approved");
  // Any change to the patch asks again.
  classify(db, heads.changed, heads.newMain);
  expect(await approval(db, heads.changed)).toBe("missing");
});

test("the ask, its link and the decision reach Linear after the pull request response", async () => {
  const { db, question } = asked();
  const tracker = createFakeTracker();
  const delivered = new Set<number>();
  const deliver = async () => {
    for (const row of listOutbox(db, "ses_1")) {
      if (delivered.has(row.id)) continue;
      delivered.add(row.id);
      await deliverLinearOutbox(row, tracker, async () => {}, undefined, db);
    }
  };
  await deliver();
  expect(tracker.questions).toHaveLength(1);
  expect(tracker.sessionUpdates).toContainEqual(
    expect.objectContaining({
      addedExternalUrls: [
        { label: "Review risk", url: "https://paws.example/status/issues/ENG-106#risk" },
      ],
    }),
  );
  decideLinkAsk(db, {
    questionId: question.id,
    decision: "changes",
    note: "Split it.",
    answeredBy: "lead",
    actor,
    now: NOW + 100,
  });
  // Ordinary progress stays quiet after the pull request response.
  enqueueOutboxOnce(db, {
    target: "linear",
    op: "activity",
    orderingKey: "ses_1",
    idempotencyKey: "progress:1",
    payload: { id: crypto.randomUUID(), sessionId: "ses_1", kind: "thought", body: "Reading." },
    now: NOW + 200,
  });
  await deliver();
  const bodies = tracker.progress.map((update) => update.body);
  expect(bodies.some((body) => body?.includes("requested changes to"))).toBe(true);
  expect(bodies).not.toContain("Reading.");
});

test("a CI fix that only changes a test keeps the approval and merges without a new ask", async () => {
  const { db, itemId } = riskApproved();
  fixAccepted(db, heads.ciFix, heads.base);
  const kept = await approvalWithFixes(db, heads.ciFix);
  expect(kept).toBe("approved");
  expect(
    mergeable({
      head: heads.ciFix,
      headMoved: false,
      accept: { head: heads.ciFix, policyDigest: "" },
      policyDigest: "",
      containsMain: true,
      ci: "green",
      unresolvedThreads: 0,
      protection: "satisfied",
      riskApproval: kept,
    }),
  ).toEqual({ ok: true });
  // The carry-over names the approved head and why.
  expect(getRiskFix(db, itemId, heads.ciFix)).toMatchObject({
    approvedHead: heads.s,
    changed: ["test/x.test.ts"],
    paths: [],
  });
  expect(riskCarryOverReason(heads.s, ["test/x.test.ts"])).toBe(
    `The approval of ${heads.s.slice(0, 7)} carried over: none of the files the fix changed since then is a high-risk path (\`test/x.test.ts\`).`,
  );
  // Nobody is asked again.
  expect(listOutbox(db).filter((row) => row.op === "elicitation")).toHaveLength(1);
  expect(getWorkItem(db, itemId)?.state).toBe("merge_queue");
});

test("a fix that changes a high-risk path asks again and lists only that change", async () => {
  const { db, itemId } = riskApproved();
  fixAccepted(db, heads.authFix, heads.base);
  expect(await approvalWithFixes(db, heads.authFix)).toBe("missing");
  expect(
    askRiskApproval(db, {
      item: getWorkItem(db, itemId)!,
      head: heads.authFix,
      publicUrl: PUBLIC_URL,
      now: NOW + 600,
    }),
  ).toBe("asked");
  const ask = findOpenQuestion(db, "ses_1")!;
  const detail = `High-risk paths the fix changed since the approved ${heads.s.slice(0, 7)}: \`src/auth/session.ts\`.`;
  expect(getLinkAsk(db, ask.id)).toMatchObject({
    kind: "risk",
    headCommit: heads.authFix,
    detail,
  });
  // The whole pull request also changes `session.ts`; the ask leaves it out.
  expect(getLinkAsk(db, ask.id)?.detail).not.toContain("`session.ts`");
  const elicitations = listOutbox(db).filter((row) => row.op === "elicitation");
  expect(elicitations).toHaveLength(2);
  expect((elicitations[1]!.payload as { body: string }).body).toContain(detail);
});

test("a CI fix on a rebased head counts only the fix's own files, not main's", async () => {
  const { db, itemId } = riskApproved();
  fixAccepted(db, heads.rebasedCiFix, heads.newMain);
  expect(await approvalWithFixes(db, heads.rebasedCiFix)).toBe("approved");
  expect(getRiskFix(db, itemId, heads.rebasedCiFix)?.changed).toEqual(["test/x.test.ts"]);
  // A rebase alone still follows samePatch and records no fix.
  fixAccepted(db, heads.rebased, heads.newMain);
  expect(await approvalWithFixes(db, heads.rebased)).toBe("approved");
  expect(getRiskFix(db, itemId, heads.rebased)).toBeNull();
});

test("without an approval, or when the fix cannot be read, a fix asks", async () => {
  const { db } = asked();
  fixAccepted(db, heads.ciFix, heads.base);
  expect(await approvalWithFixes(db, heads.ciFix)).toBe("missing");
  const fixture = riskApproved();
  fixAccepted(fixture.db, heads.ciFix, heads.base);
  expect(
    await riskApprovalFor(fixture.db, {
      itemId: "ENG-106",
      head: heads.ciFix,
      publicUrl: PUBLIC_URL,
      samePatch: async () => false,
      fixRisk: async () => null,
    }),
  ).toBe("missing");
});

test("a carried-over approval is checked again against the high-risk paths in force now", async () => {
  const { db, itemId } = riskApproved();
  fixAccepted(db, heads.ciFix, heads.base);
  expect(await approvalWithFixes(db, heads.ciFix)).toBe("approved");
  // Settings now lists the tests too: the same fix no longer keeps the approval.
  expect(await approvalWithFixes(db, heads.ciFix, [...HIGH_RISK, "test/**"])).toBe("missing");
  expect(getRiskFix(db, itemId, heads.ciFix)?.paths).toEqual(["test/x.test.ts"]);
  // A fix Paws can no longer read forgets the earlier carry-over instead of trusting it.
  expect(await approvalWithFixes(db, heads.ciFix)).toBe("approved");
  expect(
    await riskApprovalFor(db, {
      itemId: "ENG-106",
      head: heads.ciFix,
      publicUrl: PUBLIC_URL,
      samePatch: async () => false,
      fixRisk: async () => null,
    }),
  ).toBe("missing");
  expect(getRiskFix(db, itemId, heads.ciFix)).toBeNull();
});

test("a rebase that changed the patch asks again, even when the change is only a test", async () => {
  const { db, itemId } = asked(heads.both);
  const question = findOpenQuestion(db, "ses_1")!;
  decideLinkAsk(db, {
    questionId: question.id,
    decision: "approve",
    note: null,
    answeredBy: "delegator",
    actor,
    now: NOW + 100,
  });
  fixAccepted(db, heads.absorbed, heads.mainWithTest);
  // The rebased patch lost the test main already had: not samePatch, and no fix was made.
  expect(await samePatch(repo, heads.both, heads.absorbed, heads.mainWithTest)).toBe(false);
  expect(await fixChangedPaths(repo, heads.both, heads.absorbed, heads.mainWithTest)).toBeNull();
  expect(await approvalWithFixes(db, heads.absorbed)).toBe("missing");
  expect(getRiskFix(db, itemId, heads.absorbed)).toBeNull();
});

function cleanReviews(
  db: ReturnType<typeof openDatabase>,
  head = heads.s,
  options: {
    missing?: string;
    failedProbe?: boolean;
    skippedProbe?: string;
    base?: string;
    at?: number;
    attempt?: number;
  } = {},
) {
  const at = options.at ?? NOW;
  const identity = {
    taskId: "risk-task",
    base: options.base ?? heads.base,
    head,
    policyDigest: "digest",
    policyPath: null,
  };
  ensureCloseoutProgress(db, "ENG-106", identity, at, false);
  for (const id of ["security-review", "independent-review", "rule-probe"]) {
    if (id === options.missing) continue;
    upsertCloseoutStep(
      db,
      "ENG-106",
      identity,
      {
        id,
        kind: id === "rule-probe" ? "command" : "review",
        state:
          id === "rule-probe" && options.skippedProbe
            ? "skipped"
            : id === "rule-probe" && options.failedProbe
              ? "failed"
              : "passed",
        command: "",
        detail: id === "rule-probe" ? (options.skippedProbe ?? null) : null,
        attempt: options.attempt ?? 1,
        timeoutSeconds: null,
        startedAt: at,
        finishedAt: at,
        exitCode: 0,
        timedOut: false,
        timeoutReason: null,
        truncated: false,
        logPath: null,
        evidencePath: `${head}/${id}/${options.attempt ?? 1}.json`,
        findings: null,
        ordinal: 0,
      },
      at,
    );
  }
  finishCloseoutProgress(db, "ENG-106", identity, "accepted", at);
}

function automatic(
  db: ReturnType<typeof openDatabase>,
  options: {
    head?: string;
    attempt?: number;
    duplicateFirst?: boolean;
    samePatch?: boolean;
    fix?: { changed: string[]; paths: string[] };
    paths?: string[];
    severity?: string;
    missingRecord?: string;
    enabled?: boolean;
    policyPaths?: readonly string[] | null;
  } = {},
) {
  return riskApprovalFor(db, {
    itemId: "ENG-106",
    head: options.head ?? heads.s,
    publicUrl: PUBLIC_URL,
    now: NOW,
    samePatch: async () => options.samePatch ?? true,
    ...(options.fix ? { fixRisk: async () => options.fix! } : {}),
    automatic: {
      enabled: () => options.enabled ?? true,
      policyPaths: async () => (options.policyPaths === undefined ? [] : options.policyPaths),
      changedPaths: async () => options.paths ?? ["session.ts"],
      reviews: async () => {
        const records = ["security-review", "independent-review"]
          .filter((id) => id !== options.missingRecord)
          .map((itemId) => ({
            itemId,
            attempt: options.attempt ?? 1,
            findings: options.severity ? [{ severity: options.severity }] : [],
          }));
        if (options.duplicateFirst !== undefined) {
          const duplicate = {
            itemId: "security-review",
            attempt: options.attempt ?? 1,
            findings: [{ severity: "P1" }],
          };
          if (options.duplicateFirst) records.unshift(duplicate);
          else records.push(duplicate);
        }
        return records;
      },
    },
  });
}

test("clean review eligibility is read-only and posts no activity", async () => {
  const { db, itemId } = held();
  try {
    cleanReviews(db);
    expect(await automatic(db)).toBe("automatic");
    expect(getWorkItem(db, itemId)?.state).toBe("merge_queue");
    expect(findOpenQuestion(db, "ses_1")).toBeNull();
    expectNoAutomaticApproval(db);
    expect(await automatic(db)).toBe("automatic");
    expect(
      activities(db).filter((activity) => activity.body.includes("Passes automatically")),
    ).toHaveLength(0);
  } finally {
    db.close();
  }
});

for (const scenario of [
  { name: "P2 finding", severity: "P2" },
  { name: "P1 finding", severity: "P1" },
  { name: "P0 finding", severity: "P0" },
  { name: "missing security result", missing: "security-review" },
  { name: "missing independent evidence", missingRecord: "independent-review" },
  { name: "failed probe", failedProbe: true },
  { name: "probe skipped after setup failure", skippedProbe: "setup failed" },
  { name: "unknown skipped probe reason", skippedProbe: "could not run" },
  { name: "Paws policy changed", paths: ["session.ts", ".paws/reviewer.md"] },
  {
    name: "referenced skill outside .agents changed",
    paths: ["session.ts", "review/security.md"],
    policyPaths: ["review/security.md"],
  },
  { name: "unreadable trusted policy", policyPaths: null },
  { name: "risk list changed", paths: ["session.ts", ".paws/high-risk-paths"] },
  { name: "rules changed", paths: ["session.ts", ".agents/closeout.yaml"] },
  { name: "setting off", enabled: false },
])
  test(`${scenario.name} opens the risk question`, async () => {
    const { db, itemId } = held();
    try {
      cleanReviews(db, heads.s, scenario);
      expect(await automatic(db, scenario)).toBe("missing");
      expect(
        askRiskApproval(db, {
          item: getWorkItem(db, itemId)!,
          head: heads.s,
          publicUrl: PUBLIC_URL,
          now: NOW,
        }),
      ).toBe("asked");
      expect(findOpenQuestion(db, "ses_1")).not.toBeNull();
      expectNoAutomaticApproval(db);
    } finally {
      db.close();
    }
  });

test("automatic eligibility never carries to a new head, even with the same patch", async () => {
  const { db } = held();
  try {
    cleanReviews(db);
    expect(await automatic(db)).toBe("automatic");
    classify(db, heads.rebased, heads.base);
    expect(await automatic(db, { head: heads.rebased })).toBe("missing");
    cleanReviews(db, heads.rebased);
    expect(await automatic(db, { head: heads.rebased })).toBe("automatic");
    expectNoAutomaticApproval(db);
  } finally {
    db.close();
  }
});

test("turning automatic eligibility off makes a queued approved head ask a person", async () => {
  const { db, itemId } = held();
  try {
    cleanReviews(db);
    expect(await automatic(db)).toBe("automatic");
    expect(await automatic(db, { enabled: false })).toBe("missing");
    // No automatic authorization exists to revoke.
    expectNoAutomaticApproval(db);
    expect(
      askRiskApproval(db, {
        item: getWorkItem(db, itemId)!,
        head: heads.s,
        publicUrl: PUBLIC_URL,
        now: NOW,
      }),
    ).toBe("asked");
    expect(getWorkItem(db, itemId)?.state).toBe("awaiting_input");
    expect(findOpenQuestion(db, "ses_1")).not.toBeNull();
  } finally {
    db.close();
  }
});

test("normal heads and a disabled risk gate never read the automatic eligibility setting", async () => {
  const { db, itemId } = held();
  let reads = 0;
  const checks = {
    enabled() {
      reads++;
      throw new Error("config.toml is malformed");
    },
    policyPaths: async () => [],
    changedPaths: async () => [],
    reviews: async () => [],
  };
  const read = (publicUrl: string | null) =>
    riskApprovalFor(db, {
      itemId,
      head: heads.s,
      publicUrl,
      samePatch: async () => false,
      automatic: checks,
    });
  try {
    expect(await read(null)).toBe("not_required");
    saveCandidateRisk(db, {
      itemId,
      head: heads.s,
      base: heads.base,
      tier: "normal",
      paths: [],
      classifiedAt: NOW,
    });
    expect(await read(PUBLIC_URL)).toBe("not_required");
    expect(reads).toBe(0);
    classify(db, heads.s, heads.base);
    // Unreadable configuration fails closed for high-risk heads, including stored approvals.
    cleanReviews(db);
    expect(await automatic(db)).toBe("automatic");
    expect(await read(PUBLIC_URL)).toBe("missing");
    expect(reads).toBe(1);
  } finally {
    db.close();
  }
});

test("a rule skipped because no paths matched still permits clean automatic eligibility", async () => {
  const { db } = held();
  try {
    cleanReviews(db, heads.s, { skippedProbe: "no changed path matches" });
    expect(await automatic(db)).toBe("automatic");
  } finally {
    db.close();
  }
});

test("reviews and the protected-path diff must cover the same base", async () => {
  const { db, itemId } = held(heads.s, heads.newMain);
  try {
    // The accepted reviews cover heads.base, while risk classification used heads.newMain.
    cleanReviews(db);
    expect(await automatic(db)).toBe("missing");
    expectNoAutomaticApproval(db);
    expect(
      askRiskApproval(db, {
        item: getWorkItem(db, itemId)!,
        head: heads.s,
        publicUrl: PUBLIC_URL,
        now: NOW,
      }),
    ).toBe("asked");
    expect(findOpenQuestion(db, "ses_1")).not.toBeNull();
  } finally {
    db.close();
  }
});

test("automatic eligibility changes with the base and current evidence", async () => {
  const { db } = held();
  try {
    cleanReviews(db);
    expect(await automatic(db)).toBe("automatic");
    classify(db, heads.s, heads.newMain);
    expect(await automatic(db)).toBe("missing");
    cleanReviews(db, heads.s, { base: heads.newMain, at: NOW + 1, attempt: 2 });
    expect(await automatic(db, { attempt: 2, severity: "P2" })).toBe("missing");
    expect(await automatic(db, { attempt: 2 })).toBe("automatic");
    expectNoAutomaticApproval(db);
    cleanReviews(db, heads.s, { base: heads.newMain, at: NOW + 1, attempt: 2, failedProbe: true });
    expect(await automatic(db, { attempt: 2 })).toBe("missing");
  } finally {
    db.close();
  }
});

for (const duplicateFirst of [true, false])
  test(`ambiguous review attempts fail closed with dirty record first: ${duplicateFirst}`, async () => {
    const { db } = held();
    try {
      cleanReviews(db);
      expect(await automatic(db, { duplicateFirst })).toBe("missing");
      expectNoAutomaticApproval(db);
    } finally {
      db.close();
    }
  });

for (const patchMatches of [true, false])
  test(`manual carry-over takes precedence over automatic eligibility, same patch: ${patchMatches}`, async () => {
    const { db } = riskApproved();
    try {
      const head = patchMatches ? heads.rebased : heads.ciFix;
      fixAccepted(db, head, heads.base);
      cleanReviews(db, head);
      expect(
        await automatic(db, {
          head,
          samePatch: patchMatches,
          fix: { changed: ["test/x.test.ts"], paths: [] },
        }),
      ).toBe("approved");
      expectNoAutomaticApproval(db);
      expect(
        activities(db).filter((activity) => activity.body.includes("Passes automatically")),
      ).toHaveLength(0);
    } finally {
      db.close();
    }
  });

test("an open risk question keeps human ownership when reviews later become clean", async () => {
  const { db, itemId } = asked();
  try {
    const question = findOpenQuestion(db, "ses_1")!;
    cleanReviews(db);
    expect(await automatic(db)).toBe("missing");
    expect(findOpenQuestion(db, "ses_1")?.id).toBe(question.id);
    expect(getLinkAsk(db, question.id)?.decidedBy).toBeNull();
    expect(getWorkItem(db, itemId)?.state).toBe("awaiting_input");
    expect(listJobs(db).filter((job) => job.queue === JOB_KIND.reverify)).toHaveLength(0);
  } finally {
    db.close();
  }
});

test("a new or reopened finding drops automatic eligibility without invalidation", async () => {
  const { db, itemId } = held();
  try {
    cleanReviews(db);
    expect(await automatic(db)).toBe("automatic");
    expect(await automatic(db, { policyPaths: null })).toBe("missing");
    expect(await automatic(db)).toBe("automatic");
    recordReviewFindings(db, {
      itemId,
      repository: "test/repo",
      head: heads.s,
      seenAt: NOW + 1,
      findings: [
        {
          review: "security-review",
          severity: "P2",
          location: "session.ts:1",
          text: "New finding",
          bugClass: "authorization",
          why: "below failOn",
        },
      ],
      reviewed: [],
    });
    const finding = listReviewFindings(db)[0]!;
    expect(await automatic(db)).toBe("missing");
    setReviewFindingStatus(db, {
      id: finding.id,
      status: "dismissed",
      reason: "Reviewed",
      by: "user",
      now: NOW + 2,
    });
    expect(await automatic(db)).toBe("automatic");
    setReviewFindingStatus(db, { id: finding.id, status: "open", by: "user", now: NOW + 3 });
    expect(await automatic(db)).toBe("missing");
    expect(await automatic(db, { policyPaths: null })).toBe("missing");
    expectNoAutomaticApproval(db);
  } finally {
    db.close();
  }
});

function expectNoAutomaticApproval(db: import("bun:sqlite").Database): void {
  expect(
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'automatic_risk_approval'",
      )
      .get(),
  ).toBeNull();
}

test("status uses manual carry-over precedence without saving a fix comparison", async () => {
  const { db, itemId } = riskApproved();
  try {
    fixAccepted(db, heads.ciFix, heads.base);
    expect(
      (
        await riskEligibilityFor(db, {
          itemId,
          head: heads.ciFix,
          publicUrl: PUBLIC_URL,
          samePatch: async () => false,
          fixRisk: async () => ({ changed: ["test/x.test.ts"], paths: [] }),
        })
      ).approval,
    ).toBe("approved");
    expect(getRiskFix(db, itemId, heads.ciFix)).toBeNull();
  } finally {
    db.close();
  }
});

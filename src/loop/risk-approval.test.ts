import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixChangedPaths, samePatch } from "../closeout";
import { JOB_KIND, riskCarryOverReason } from "../core";
import {
  applyWorkItemEvent,
  recordReviewFindings,
  listReviewFindings,
  setReviewFindingStatus,
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
  openDatabase,
  saveCandidateRisk,
  saveCandidatePaths,
  getCandidatePaths,
  getCloseoutProgress,
  listCloseoutProgress,
  saveCheckpoint,
} from "../db";
import { findOpenQuestion, LINK_ASK_REMINDER_MS } from "../questions";
import { saveSchedulingContext } from "../scheduler";
import { createFakeTracker } from "../linear";
import { deliverLinearOutbox } from "./dispatch";
import { decideLinkAsk, guideLinkAsk } from "./link-ask";
import { mergeable } from "../merge";
import { classifyPathsRisk } from "./candidate-risk";
import { askRiskApproval, riskApprovalFor, RISK_REPLY_NOTE, riskApprovals } from "./risk-approval";

import { createDbCloseoutProgress } from "./closeout-progress";

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

/** Stored results, as reported through Closeout's real progress adapter. */
function cleanRiskFixture() {
  const fixture = held();
  const { db, itemId } = fixture;
  saveCandidatePaths(db, { itemId, head: heads.s, paths: ["session.ts"], recordedAt: NOW });
  const identity = {
    taskId: itemId,
    head: heads.s,
    base: heads.base,
    policyDigest: "policy",
    policyPath: null,
  };
  const progress = createDbCloseoutProgress(db, itemId, () => NOW);
  progress.begin(identity);
  const step = (
    id: string,
    findings: string | null = null,
    findingSeverities: ("P0" | "P1" | "P2" | "P3")[] | null = [],
    attempt = 1,
  ) =>
    progress.step(identity, {
      id,
      kind: "review",
      state: "passed",
      command: "",
      detail: "review passed",
      attempt,
      timeoutSeconds: null,
      startedAt: NOW - 2,
      finishedAt: NOW - 1,
      exitCode: null,
      timedOut: false,
      timeoutReason: null,
      truncated: false,
      logPath: null,
      evidencePath: `${id}.json`,
      findings,
      findingSeverities,
      ordinal: 0,
    });
  step("security-review");
  step("independent-review");
  progress.finish(identity, "accepted");
  const read = (overrides: Partial<Parameters<typeof riskApprovalFor>[1]> = {}) =>
    riskApprovalFor(db, {
      itemId,
      head: heads.s,
      publicUrl: PUBLIC_URL,
      autoApproveHighRisk: true,
      policyDigest: "policy",
      policyPaths: [".agents/closeout.yaml", "tools/rules.ts"],
      samePatch: async () => {
        throw new Error("automatic approval must not compare patches");
      },
      fixRisk: async () => {
        throw new Error("automatic approval must not compare fixes");
      },
      ...overrides,
    });
  const report = (
    review: string,
    severity: "P0" | "P1" | "P2" | "P3",
    text = "Review detail",
    at = NOW,
  ) => {
    recordReviewFindings(db, {
      itemId,
      repository: "acme/repo",
      head: heads.s,
      seenAt: at,
      findings: [
        {
          review,
          severity,
          location: "session.ts:12",
          text,
          bugClass: "review",
          why: "below failOn",
        },
      ],
      reviewed: [],
    });
  };
  return { ...fixture, identity, progress, step, read, report };
}

async function automaticMerge(f: ReturnType<typeof cleanRiskFixture>) {
  const riskApproval = await f.read();
  const verdict = mergeable({
    head: heads.s,
    headMoved: false,
    accept: { head: heads.s, policyDigest: "policy" },
    policyDigest: "policy",
    containsMain: true,
    ci: "green",
    unresolvedThreads: 0,
    protection: "satisfied",
    riskApproval,
  });
  if (!verdict.ok && verdict.block === "risk_approval") {
    expect(
      askRiskApproval(f.db, {
        item: getWorkItem(f.db, f.itemId)!,
        head: heads.s,
        publicUrl: PUBLIC_URL,
        now: NOW,
      }),
    ).toBe("asked");
    expect(findOpenQuestion(f.db, "ses_1")).not.toBeNull();
  }
  return verdict;
}

test("opt-in clean reviews at S pass mergeable without a question, writes or approval", async () => {
  const f = cleanRiskFixture();
  const before = f.db.query<{ total: number }, []>("SELECT total_changes() AS total").get()!.total;
  expect(await automaticMerge(f)).toEqual({ ok: true });
  expect(f.db.query<{ total: number }, []>("SELECT total_changes() AS total").get()!.total).toBe(
    before,
  );
  expect(riskApprovals(f.db, f.itemId)).toEqual([]);
  expect(findOpenQuestion(f.db, "ses_1")).toBeNull();
  f.db.close();
});

for (const review of ["security-review", "independent-review"]) {
  test(`a P2 finding in ${review} asks even when Closeout passed it`, async () => {
    const f = cleanRiskFixture();
    f.step(review, "Display text is not a severity source", ["P2"]);
    f.report(review, "P2");
    expect(await automaticMerge(f)).toEqual({ ok: false, block: "risk_approval" });
    f.db.close();
  });
  test(`missing ${review} asks`, async () => {
    const f = cleanRiskFixture();
    f.db.run("DELETE FROM closeout_step WHERE step_id = ?", [review]);
    expect(await automaticMerge(f)).toEqual({ ok: false, block: "risk_approval" });
    f.db.close();
  });
}

for (const policyPath of [
  ".paws/high-risk-paths",
  ".agents/closeout.yaml",
  ".agents/skills/review/SKILL.md",
  "AGENTS.md",
  "src/auth/AGENTS.md",
  "CLAUDE.md",
  "src/auth/CLAUDE.md",
  ".claude/rules/auth.md",
  "tools/rules.ts",
]) {
  test(`changing ${policyPath} always asks`, async () => {
    const f = cleanRiskFixture();
    // The policy file deliberately matches no high-risk glob. Only session.ts is in risk.paths.
    saveCandidatePaths(f.db, {
      itemId: f.itemId,
      head: heads.s,
      paths: ["session.ts", policyPath],
      recordedAt: NOW,
    });
    expect(await automaticMerge(f)).toEqual({ ok: false, block: "risk_approval" });
    f.db.close();
  });
}

test("a new head, policy, base or unfinished run loses automatic eligibility", async () => {
  const f = cleanRiskFixture();
  expect(await f.read()).toBe("approved");
  classify(f.db, heads.changed, heads.base);
  expect(await f.read({ head: heads.changed })).toBe("missing");
  expect(await f.read({ policyDigest: "new-policy" })).toBe("missing");
  expect(await f.read({ policyDigest: null })).toBe("missing");
  expect(await f.read({ policyPaths: null })).toBe("missing");
  saveCandidateRisk(f.db, {
    itemId: f.itemId,
    head: heads.s,
    base: heads.newMain,
    tier: "high",
    paths: ["session.ts"],
    classifiedAt: NOW,
  });
  expect(await f.read()).toBe("missing");
  classify(f.db, heads.s, heads.base);
  f.progress.begin(f.identity);
  expect(await f.read()).toBe("missing");
  f.db.close();
});

test("a failed rule probe asks even if the run was accepted", async () => {
  const f = cleanRiskFixture();
  f.step("rule-probe");
  f.db.run(
    "UPDATE closeout_step SET kind = 'command', state = 'failed' WHERE step_id = 'rule-probe'",
  );
  expect(await automaticMerge(f)).toEqual({ ok: false, block: "risk_approval" });
  f.db.close();
});

test("P3 snapshots pass before the shared finding import, regardless of display text", async () => {
  const f = cleanRiskFixture();
  f.step("security-review", "P3 session.ts:12: Notes\nP1 and P10 are terms in the explanation", [
    "P3",
  ]);
  expect(listReviewFindings(f.db)).toEqual([]);
  expect(await f.read()).toBe("approved");
  f.step("security-review", "A completely different display format", ["P3"]);
  expect(await f.read()).toBe("approved");
  f.db.close();
});

test("legacy, malformed and wrong-attempt review snapshots fail closed", async () => {
  const f = cleanRiskFixture();
  for (const findings of [
    null,
    "P3 legacy text",
    "{bad",
    JSON.stringify({ reviewSnapshot: 1, attempt: 2, text: null, severities: [] }),
  ]) {
    f.db.run("UPDATE closeout_step SET findings = ? WHERE step_id = 'security-review'", [findings]);
    expect(await f.read()).toBe("missing");
  }
  f.db.run("DROP TABLE closeout_step");
  expect(await automaticMerge(f)).toEqual({ ok: false, block: "risk_approval" });
  f.db.close();
});

test("a later clean attempt clears prior findings even without a running update", async () => {
  const f = cleanRiskFixture();
  f.step("security-review", "Old P2", ["P2"]);
  expect(await f.read()).toBe("missing");
  f.step("security-review", null, [], 2);
  expect(
    getCloseoutProgress(f.db, f.itemId, heads.s)?.steps.find((s) => s.id === "security-review"),
  ).toMatchObject({ attempt: 2, findings: null, findingSeverities: [] });
  expect(await f.read()).toBe("approved");
  f.db.close();
});

test("a cached review keeps only the snapshot of its unchanged attempt", async () => {
  const f = cleanRiskFixture();
  f.step("security-review", "P3 notes", ["P3"]);
  const cached = getCloseoutProgress(f.db, f.itemId, heads.s)!.steps.find(
    (s) => s.id === "security-review",
  )!;
  f.progress.begin(f.identity);
  f.progress.step(f.identity, {
    ...cached,
    state: "pending",
    attempt: 0,
    findings: null,
    findingSeverities: undefined,
  });
  expect(await f.read()).toBe("missing");
  f.progress.step(f.identity, { ...cached, findings: null, findingSeverities: undefined });
  f.progress.finish(f.identity, "accepted");
  expect(await f.read()).toBe("approved");
  f.progress.step(f.identity, {
    ...cached,
    attempt: 2,
    findings: null,
    findingSeverities: undefined,
  });
  expect(await f.read()).toBe("missing");
  f.db.close();
});

for (const severity of ["P2", "P3"] as const) {
  test(`another item's report cannot change this head's ${severity} review result`, async () => {
    const f = cleanRiskFixture();
    f.step("security-review", "Original report", [severity]);
    f.report("security-review", severity, "Same finding");
    insertQueuedItem(f.db, { id: "other-item", sessionKey: "other-session", title: "Other" });
    recordReviewFindings(f.db, {
      itemId: "other-item",
      repository: "acme/repo",
      head: heads.changed,
      seenAt: NOW + 1,
      findings: [
        {
          severity: severity === "P2" ? "P3" : "P2",
          review: "independent-review",
          location: "session.ts:12",
          text: "Same finding",
          bugClass: "review",
          why: "below failOn",
        },
      ],
      reviewed: [],
    });
    expect(listReviewFindings(f.db)[0]?.severity).toBe(severity === "P2" ? "P3" : "P2");
    expect(await f.read()).toBe(severity === "P2" ? "missing" : "approved");
    f.db.close();
  });
}

for (const severity of ["P0", "P1", "P2"] as const) {
  test(`structured ${severity} in a passed review blocks regardless of display format or dismissal`, async () => {
    const f = cleanRiskFixture();
    f.step("independent-review", "P3 misleading display text", [severity]);
    f.report("independent-review", severity);
    expect(await f.read()).toBe("missing");
    const finding = listReviewFindings(f.db)[0]!;
    setReviewFindingStatus(f.db, {
      id: finding.id,
      status: "dismissed",
      reason: "Acknowledged",
      by: "user-lead",
      now: NOW,
    });
    expect(await f.read()).toBe("missing");
    f.db.close();
  });
}

test("unknown or malformed candidate paths never reuse another head's path list", async () => {
  const f = cleanRiskFixture();
  f.db.run("DELETE FROM candidate_paths");
  saveCandidatePaths(f.db, {
    itemId: f.itemId,
    head: heads.changed,
    paths: ["session.ts"],
    recordedAt: NOW + 1,
  });
  expect(getCandidatePaths(f.db, f.itemId, heads.s)).toBeNull();
  expect(await f.read()).toBe("missing");
  saveCandidatePaths(f.db, {
    itemId: f.itemId,
    head: heads.s,
    paths: ["session.ts"],
    recordedAt: NOW,
  });
  f.db.run("UPDATE candidate_paths SET paths = '{}' WHERE head_sha = ?", [heads.s]);
  const lines: string[] = [];
  expect(await f.read({ journal: (line) => lines.push(line) })).toBe("missing");
  expect(lines.some((line) => line.includes("Invalid stored candidate paths"))).toBe(true);
  f.db.close();
});

test("a carried acceptance after rebase does not substitute for exact-head reviews", async () => {
  const f = cleanRiskFixture();
  classify(f.db, heads.rebased, heads.newMain);
  saveCandidatePaths(f.db, {
    itemId: f.itemId,
    head: heads.rebased,
    paths: ["session.ts"],
    recordedAt: NOW,
  });
  const riskApproval = await f.read({ head: heads.rebased, samePatch: async () => true });
  expect(riskApproval).toBe("missing");
  expect(
    mergeable({
      head: heads.rebased,
      headMoved: false,
      accept: { head: heads.rebased, policyDigest: "policy" },
      policyDigest: "policy",
      containsMain: true,
      ci: "green",
      unresolvedThreads: 0,
      protection: "satisfied",
      riskApproval,
    }),
  ).toEqual({ ok: false, block: "risk_approval" });
  f.db.close();
});

test("differently named reviews do not substitute for the two required reviews", async () => {
  const f = cleanRiskFixture();
  f.db.run("UPDATE closeout_step SET step_id = 'review' WHERE step_id = 'security-review'");
  expect(await f.read()).toBe("missing");
  f.db.close();
});

test("the exact-head progress reader selects the latest run and preserves the unfiltered reader", () => {
  const f = cleanRiskFixture();
  expect(getCloseoutProgress(f.db, f.itemId, heads.s)).toEqual(listCloseoutProgress(f.db)[0]!);
  expect(getCloseoutProgress(f.db, f.itemId, heads.rebased)).toBeNull();
  expect(getCloseoutProgress(f.db, "another-item", heads.s)).toBeNull();
  f.progress.begin({ ...f.identity, policyDigest: "other-policy" });
  f.db.run("UPDATE closeout_progress SET updated_at = ? WHERE policy_digest = 'other-policy'", [
    NOW + 1,
  ]);
  expect(getCloseoutProgress(f.db, f.itemId, heads.s)?.policyDigest).toBe("other-policy");
  f.db.close();
});

test("a new or reopened finding at S revokes automatic eligibility", async () => {
  const f = cleanRiskFixture();
  expect(await f.read()).toBe("approved");
  f.report("security-review", "P2", "Unsafe reuse");
  expect(await f.read()).toBe("missing");
  const finding = listReviewFindings(f.db)[0]!;
  setReviewFindingStatus(f.db, {
    id: finding.id,
    status: "dismissed",
    reason: "Reviewed",
    by: "user-lead",
    now: NOW,
  });
  expect(await f.read()).toBe("approved");
  setReviewFindingStatus(f.db, { id: finding.id, status: "open", by: "user-lead", now: NOW + 1 });
  expect(await automaticMerge(f)).toEqual({ ok: false, block: "risk_approval" });
  f.db.close();
});

for (const enabled of [undefined, false]) {
  test(`automatic approval ${enabled === undefined ? "defaults to off" : "off"} asks with clean evidence`, async () => {
    const f = cleanRiskFixture();
    expect(await f.read({ autoApproveHighRisk: enabled })).toBe("missing");
    expect(
      askRiskApproval(f.db, {
        item: getWorkItem(f.db, f.itemId)!,
        head: heads.s,
        publicUrl: PUBLIC_URL,
        now: NOW,
      }),
    ).toBe("asked");
    f.db.close();
  });
}

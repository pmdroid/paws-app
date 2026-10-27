import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixChangedPaths, samePatch } from "../closeout";
import { JOB_KIND, riskCarryOverReason } from "../core";
import {
  applyWorkItemEvent,
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
function approvalWithFixes(db: ReturnType<typeof openDatabase>, head: string) {
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
        settingsGlobs: HIGH_RISK,
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

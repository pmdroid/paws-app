import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { FakeClock, JOB_KIND } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listCloseoutRecoveries,
  saveCloseoutRecovery,
  migrate,
  openDatabase,
} from "../src/db";
import { createFakeGitHubComments, createGitHubCommentTracker } from "../src/ghcomments";
import { createGitHubCommentIngestor } from "../src/index";
import { attachOrchestrator, deliverLinearOutbox } from "../src/loop";
import { findOpenQuestion, getQuestion, openQuestion } from "../src/questions";

const ISSUE = "github:acme/app#787";

for (const timing of ["before restart", "after restart"] as const) {
  test(`a legacy question accepts the existing trusted answer ${timing}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "paws-question-recovery-"));
    const dbPath = join(root, "paws.db");
    let db = openDatabase(dbPath);
    try {
      migrate(db);
      const clock = new FakeClock(1_000_233);
      const item = insertQueuedItem(db, { sessionKey: ISSUE, now: clock.now() });
      db.run("UPDATE work_item SET linear_issue_id = ?, state = 'awaiting_input' WHERE id = ?", [
        ISSUE,
        item.id,
      ]);
      const question = openQuestion(db, {
        itemId: item.id,
        sessionId: ISSUE,
        body: "Which screen should I capture?",
        options: ["Dashboard", "Setup"],
        now: clock.now(),
      });
      const github = createFakeGitHubComments({ clock, selfLogin: "pascal" });
      const trackerOptions = {
        request: github.request,
        owner: "acme",
        repo: "app",
        selfLogin: "pascal",
        clock,
        labels: false,
      };
      const original = createGitHubCommentTracker(trackerOptions);
      await original.askQuestion({
        sessionId: ISSUE,
        body: question.body,
        options: question.options,
      });
      github.comments[0]!.createdAtMs = 1_000_000;
      clock.advance(1_000);
      github.post({ issueNumber: 787, login: "eve", association: "NONE", body: "2" });
      const answer = "> Paws: Question\n> Which screen should I capture?\n\n1";
      const postAnswer = () => github.post({ issueNumber: 787, login: "pascal", body: answer });
      if (timing === "before restart") postAnswer();
      db.close();
      db = openDatabase(dbPath);
      const restarted = createGitHubCommentTracker(trackerOptions);
      const jobs = new JobLoop(db, clock);
      const outbox = new OutboxDispatcher(db, clock);
      const orchestrator = attachOrchestrator({ db, jobs, outbox, pawsRoot: root, clock });
      const ingest = createGitHubCommentIngestor(
        db,
        restarted,
        (event) => orchestrator.onLinearEvent(event),
        () => undefined,
      );
      if (timing === "after restart") {
        await ingest(ISSUE);
        expect(getQuestion(db, question.id)?.status).toBe("open");
        clock.advance(1_000);
        postAnswer();
      }
      await ingest(ISSUE);
      expect(getQuestion(db, question.id)?.answer).toBe(answer);
      expect(getQuestion(db, question.id)?.answeredBy).toBe("pascal");
      expect(getWorkItem(db, item.id)?.state).toBe("running");
      const resumes = () => listJobs(db).filter((job) => job.queue === JOB_KIND.resume);
      expect(resumes()).toHaveLength(1);
      expect(resumes()[0]?.payload).toMatchObject({
        itemId: item.id,
        freshSession: true,
        reason: "answer",
      });
      await ingest(ISSUE);
      const restartedAgain = createGitHubCommentIngestor(
        db,
        createGitHubCommentTracker(trackerOptions),
        (event) => orchestrator.onLinearEvent(event),
        () => undefined,
      );
      await restartedAgain(ISSUE);
      expect(resumes()).toHaveLength(1);
      expect(github.commentCreates).toBe(1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("persisted question IDs distinguish repeated questions after restart", async () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    const clock = new FakeClock(1_000_000);
    const github = createFakeGitHubComments({ clock, selfLogin: "pascal" });
    const options = {
      request: github.request,
      owner: "acme",
      repo: "app",
      selfLogin: "pascal",
      clock,
      labels: false,
    };
    const tracker = createGitHubCommentTracker(options);
    await tracker.askQuestion({ sessionId: ISSUE, body: "Which screen?" });
    clock.advance(1);
    github.post({ issueNumber: 787, login: "pascal", body: "2" });
    const question = openQuestion(db, {
      itemId: "item",
      sessionId: ISSUE,
      body: "Which screen?",
      now: clock.now(),
    });
    await deliverLinearOutbox(
      {
        id: 1,
        target: "linear",
        op: "elicitation",
        payload: { sessionId: ISSUE, questionId: question.id, body: question.body },
        orderingKey: ISSUE,
        idempotencyKey: question.id,
        status: "pending",
        attempts: 0,
        priority: 5,
        notBefore: clock.now(),
        maxAttempts: 5,
        lockedBy: null,
        lockedUntil: null,
        error: null,
        createdAt: clock.now(),
        sentAt: null,
      },
      tracker,
      async () => undefined,
    );
    expect(github.comments.at(-1)?.body).toContain(`<!-- paws:q:${question.id} -->`);
    const restarted = createGitHubCommentTracker(options);
    restarted.bind({ itemId: "item", issueId: ISSUE });
    expect((await restarted.sync(ISSUE, question)).resumed).toEqual([]);
    clock.advance(1);
    github.post({ issueNumber: 787, login: "pascal", body: "1" });
    expect((await restarted.sync(ISSUE, question)).resumed).toEqual([
      { questionId: question.id, answeredBy: "pascal", answer: "1" },
    ]);
  } finally {
    db.close();
  }
});

for (const answer of [
  "/paws bypass test -- Approved for this candidate",
  "Create ok.txt and rerun the check",
  "/paws bypass test",
  "/paws bypass unrelated -- Wrong check",
]) {
  test(`a trusted Closeout reply survives restart: ${answer}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "paws-closeout-question-"));
    const dbPath = join(root, "paws.db");
    let db = openDatabase(dbPath);
    try {
      migrate(db);
      const clock = new FakeClock(1_000_000);
      const item = insertQueuedItem(db, { sessionKey: ISSUE, now: clock.now() });
      db.run("UPDATE work_item SET linear_issue_id = ?, state = 'awaiting_input' WHERE id = ?", [
        ISSUE,
        item.id,
      ]);
      const question = openQuestion(db, {
        itemId: item.id,
        sessionId: ISSUE,
        body: "Closeout needs help",
        now: clock.now(),
      });
      saveCloseoutRecovery(db, {
        questionId: question.id,
        itemId: item.id,
        taskId: "GH-787",
        base: "a".repeat(40),
        head: "b".repeat(40),
        policyDigest: "sha256:policy",
        failedChecks: ["test"],
        retryBaseline: ["old-attempt"],
        summary: "test exhausted",
      });
      const github = createFakeGitHubComments({ clock, selfLogin: "pascal" });
      const options = {
        request: github.request,
        owner: "acme",
        repo: "app",
        selfLogin: "pascal",
        clock,
        labels: false,
      };
      await createGitHubCommentTracker(options).askQuestion({
        sessionId: ISSUE,
        questionId: question.id,
        body: question.body,
      });
      db.close();
      db = openDatabase(dbPath);
      const jobs = new JobLoop(db, clock);
      const outbox = new OutboxDispatcher(db, clock);
      const orchestrator = attachOrchestrator({
        db,
        jobs,
        outbox,
        pawsRoot: root,
        clock,
        tracker: createGitHubCommentTracker(options),
      });
      const ingest = createGitHubCommentIngestor(
        db,
        createGitHubCommentTracker(options),
        (event) => orchestrator.onLinearEvent(event),
        () => undefined,
      );
      clock.advance(1_000);
      github.post({ issueNumber: 787, login: "eve", association: "NONE", body: answer });
      await ingest(ISSUE);
      expect(getQuestion(db, question.id)?.status).toBe("open");
      expect(listJobs(db)).toHaveLength(0);
      clock.advance(1_000);
      github.post({ issueNumber: 787, login: "pascal", body: answer });
      await ingest(ISSUE);
      await ingest(ISSUE);
      expect(getQuestion(db, question.id)?.answer).toBe(answer);
      expect(getQuestion(db, question.id)?.answeredBy).toBe("pascal");
      expect(listCloseoutRecoveries(db, item.id)[0]?.retryBaseline).toEqual(["old-attempt"]);
      if (answer.endsWith("Wrong check") || answer === "/paws bypass test") {
        expect(getWorkItem(db, item.id)?.state).toBe("awaiting_input");
        const next = findOpenQuestion(db, ISSUE)!;
        expect(next.id).not.toBe(question.id);
        expect(next.body).toContain("Use /paws bypass check-id -- your reason");
        await orchestrator.onLinearEvent({
          dedupeKey: "old-answer",
          deliveryId: null,
          source: "webhook",
          action: "prompted",
          sessionId: ISSUE,
          issueId: ISSUE,
          activityId: "old-comment",
          body: answer,
          signal: null,
          updatedAtMs: clock.now(),
          payload: JSON.stringify({ answeredBy: "pascal", questionId: question.id }),
        });
        expect(getQuestion(db, next.id)?.status).toBe("open");
        expect(listJobs(db)).toHaveLength(0);
      } else {
        const bypass = answer.startsWith("/paws bypass");
        expect(getWorkItem(db, item.id)?.state).toBe(bypass ? "verifying" : "running");
        expect(listJobs(db)).toHaveLength(1);
        expect(listJobs(db)[0]?.queue).toBe(bypass ? JOB_KIND.reverify : JOB_KIND.resume);
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

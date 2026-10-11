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
  migrate,
  openDatabase,
} from "../src/db";
import { createFakeGitHubComments, createGitHubCommentTracker } from "../src/ghcomments";
import { createGitHubCommentIngestor } from "../src/index";
import { attachOrchestrator } from "../src/loop";
import { getQuestion, openQuestion } from "../src/questions";

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

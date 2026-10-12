import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCommentMode, createFakeCommentBoard, type IssueComment } from "../../src/comments";
import { FakeClock } from "../../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  applyWorkItemEvent,
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  migrate,
  openDatabase,
} from "../../src/db";
import { attachOrchestrator } from "../../src/loop";
import { findOpenQuestion, getQuestion, openQuestion } from "../../src/questions";

const stage = process.argv[2]!;
const root = process.argv[3]!;
const db = openDatabase(join(root, "paws.db"));
migrate(db);
const clock = new FakeClock(stage === "ask" ? 1_000 : 2_000);
const board = createFakeCommentBoard({ clock, selfUserId: "human-owner" });
const mode = createCommentMode({ board, clock, selfUserId: "human-owner" });
const binding = { itemId: "item-1", linearIssueId: "issue-1", sessionId: "issue-1" };
mode.bind(binding);

if (stage === "ask") {
  insertQueuedItem(db, { id: binding.itemId, sessionKey: binding.sessionId, title: "Export rows" });
  beginImplementRun(db, binding.itemId, clock.now());
  applyWorkItemEvent(db, binding.itemId, "blocking_question");
  const question = openQuestion(db, {
    itemId: binding.itemId,
    sessionId: binding.sessionId,
    body: "Include archived rows?",
    now: clock.now(),
  });
  await mode.askQuestion({
    sessionId: binding.sessionId,
    questionId: question.id,
    body: question.body,
  });
  writeFileSync(join(root, "comments.json"), JSON.stringify(board.comments));
  writeFileSync(join(root, "ready.json"), JSON.stringify({ questionId: question.id }));
  await new Promise(() => setInterval(() => {}, 1_000));
} else {
  const saved = JSON.parse(readFileSync(join(root, "comments.json"), "utf8")) as IssueComment[];
  for (const comment of saved) board.post({ ...comment, createdAtMs: comment.createdAtMs });
  const pending = findOpenQuestion(db, binding.sessionId)!;
  board.post({
    issueId: binding.linearIssueId,
    parentId: saved[0]!.id,
    userId: "human-owner",
    body: "Yes, archived rows too",
  });
  const orchestrator = attachOrchestrator({
    db,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    tracker: null,
    channel: "comments",
    pawsRoot: root,
    clock,
  });
  const result = await mode.sync(binding.linearIssueId, pending);
  for (const answer of result.resumed) {
    await orchestrator.onLinearEvent({
      dedupeKey: `comment-answer:${answer.questionId}`,
      deliveryId: null,
      source: "poll",
      action: "prompted",
      sessionId: binding.sessionId,
      issueId: binding.linearIssueId,
      activityId: null,
      body: answer.answer,
      signal: null,
      updatedAtMs: clock.now(),
      payload: JSON.stringify({ answeredBy: answer.answeredBy, questionId: answer.questionId }),
    });
  }
  const duplicate = await mode.sync(binding.linearIssueId, findOpenQuestion(db, binding.sessionId));
  console.log(
    JSON.stringify({
      question: getQuestion(db, pending.id),
      item: getWorkItem(db, binding.itemId),
      jobs: listJobs(db),
      resumed: result.resumed,
      duplicates: duplicate.resumed,
    }),
  );
  db.close();
}

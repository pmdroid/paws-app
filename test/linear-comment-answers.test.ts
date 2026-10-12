import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/core";
import { createCommentMode, createFakeCommentBoard, questionMarker } from "../src/comments";
import { openQuestion } from "../src/questions";
import { tempDb } from "./helpers";
import { probeLinearQuestionRestart } from "./local/linear-question-restart";

test("a personal-token owner's answer resumes once after the parked process is terminated", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-linear-restart-"));
  try {
    const result = await probeLinearQuestionRestart(root);
    expect(result.stoppedExit).not.toBe(0);
    expect(result.question).toMatchObject({
      status: "answered",
      answeredBy: "human-owner",
      answer: "Yes, archived rows too",
    });
    expect(result.item.state).toBe("running");
    expect(result.jobs.filter((job) => job.queue === "run.resume")).toHaveLength(1);
    expect(result.jobs[0]?.payload.handoff).toContain("Include archived rows?");
    expect(result.resumed).toHaveLength(1);
    expect(result.duplicates).toHaveLength(0);
    expect(result.ignored).toHaveLength(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "the Linear personal-token owner can answer a threaded question with adapter restart=%s",
  async (restart) => {
    const clock = new FakeClock(1_000);
    const db = tempDb();
    const board = createFakeCommentBoard({ clock, selfUserId: "pascal" });
    const stored = openQuestion(db, {
      itemId: "item-1",
      sessionId: "ses-1",
      body: "Include archived rows?",
      now: clock.now(),
    });
    const options = { board, clock, selfUserId: "pascal" };
    let mode = createCommentMode(options);
    mode.bind({ itemId: "item-1", linearIssueId: "iss-1", sessionId: "ses-1" });
    await mode.askQuestion({ sessionId: "ses-1", questionId: stored.id, body: stored.body });
    const root = board.comments.find((comment) =>
      comment.body.includes(questionMarker(stored.id)),
    )!;
    if (restart) {
      mode = createCommentMode(options);
      mode.bind({ itemId: "item-1", linearIssueId: "iss-1", sessionId: "ses-1" });
    }
    clock.advance(1);
    board.post({
      issueId: "iss-1",
      parentId: root.id,
      userId: "pascal",
      body: "Paws: still working",
    });
    board.post({
      issueId: "iss-1",
      parentId: root.id,
      userId: "pascal",
      body: "ignored <!-- paws -->",
    });
    board.post({
      issueId: "iss-1",
      parentId: null,
      userId: "pascal",
      body: "unrelated issue comment",
    });
    expect((await mode.sync("iss-1", restart ? stored : null)).resumed).toEqual([]);
    clock.advance(1);
    board.post({
      issueId: "iss-1",
      parentId: root.id,
      userId: "pascal",
      body: "Yes, include them",
    });
    clock.advance(1);
    board.post({ issueId: "iss-1", parentId: root.id, userId: "teammate", body: "No" });
    expect((await mode.sync("iss-1")).resumed).toEqual([
      { questionId: stored.id, answer: "Yes, include them", answeredBy: "pascal" },
    ]);
    expect((await mode.sync("iss-1")).resumed).toEqual([]);
    db.close();
  },
);

test("a Paws bot reply remains excluded while a teammate can answer", async () => {
  const clock = new FakeClock(1_000);
  const board = createFakeCommentBoard({ clock, selfUserId: "pascal" });
  const mode = createCommentMode({ board, clock, selfUserId: "paws-bot" });
  mode.bind({ itemId: "item-1", linearIssueId: "iss-1" });
  const asked = await mode.ask({ itemId: "item-1", title: "Choose a format", body: "CSV?" });
  const root = board.comments.find((comment) =>
    comment.body.includes(questionMarker(asked.questionId)),
  )!;
  clock.advance(1);
  board.post({ issueId: "iss-1", parentId: root.id, userId: null, botId: "paws-bot", body: "Yes" });
  expect((await mode.sync("iss-1")).resumed).toEqual([]);
  clock.advance(1);
  board.post({ issueId: "iss-1", parentId: root.id, userId: "teammate", body: "Yes" });
  expect((await mode.sync("iss-1")).resumed).toEqual([
    { questionId: asked.questionId, answer: "Yes", answeredBy: "teammate" },
  ]);
});

test("repeated question text after restart only accepts a reply to the current question", async () => {
  const clock = new FakeClock(1000);
  const db = tempDb();
  const board = createFakeCommentBoard({ clock, selfUserId: "owner" });
  const options = { board, clock, selfUserId: "owner" };
  let mode = createCommentMode(options);
  mode.bind({ itemId: "item", linearIssueId: "issue", sessionId: "session" });
  await mode.askQuestion({ sessionId: "session", questionId: "previous", body: "Which screen?" });
  const previous = board.comments[0]!;
  clock.advance(1);
  board.post({ issueId: "issue", parentId: previous.id, userId: "human", body: "Old answer" });
  const current = openQuestion(db, {
    itemId: "item",
    sessionId: "session",
    body: "Which screen?",
    now: clock.now(),
  });
  await mode.askQuestion({ sessionId: "session", questionId: current.id, body: current.body });
  const currentRoot = board.comments.find((comment) =>
    comment.body.includes(questionMarker(current.id)),
  )!;
  mode = createCommentMode(options);
  mode.bind({ itemId: "item", linearIssueId: "issue", sessionId: "session" });
  expect((await mode.sync("issue", current)).resumed).toEqual([]);
  clock.advance(1);
  board.post({ issueId: "issue", parentId: previous.id, userId: "human", body: "Late old answer" });
  board.post({ issueId: "issue", userId: "human", body: "Unthreaded answer" });
  expect((await mode.sync("issue")).resumed).toEqual([]);
  board.post({
    issueId: "issue",
    parentId: currentRoot.id,
    userId: "human",
    body: "Current answer",
  });
  expect((await mode.sync("issue")).resumed).toEqual([
    { questionId: current.id, answer: "Current answer", answeredBy: "human" },
  ]);
  expect((await mode.sync("issue")).resumed).toEqual([]);
  db.close();
});

import { describe, expect, test } from "bun:test";
import { CommandBus, FakeClock } from "../core";
import { createFakeTracker } from "../linear";
import { questionMarker } from "./format";
import { createFakeCommentBoard } from "./fake";
import { STATUS_EDIT_INTERVAL_MS } from "./format";
import { createCommentMode, withCommentActivities } from "./mode";

describe("comment mode", () => {
  test("progress edits one comment and at most once every 5 seconds", async () => {
    const clock = new FakeClock(0);
    const board = createFakeCommentBoard({ clock, selfUserId: "paws" });
    const mode = createCommentMode({ board, clock, selfUserId: "paws" });
    mode.bind({ itemId: "item-1", linearIssueId: "iss-1", sessionId: "sess-1" });

    await mode.postProgress({ sessionId: "sess-1", kind: "thought", body: "one" });
    await mode.postProgress({ sessionId: "sess-1", kind: "action", body: "two" });
    clock.advance(STATUS_EDIT_INTERVAL_MS - 1);
    await mode.postProgress({ sessionId: "sess-1", kind: "thought", body: "three" });

    const status = statusComments(board.comments);
    expect(status).toHaveLength(1);
    expect(board.creates).toBe(1);
    expect(board.updates).toBe(0);
    expect(status[0]?.body).toBe("Paws: one");

    clock.advance(1);
    await mode.postProgress({ sessionId: "sess-1", kind: "thought", body: "four" });
    await mode.postProgress({ sessionId: "sess-1", kind: "thought", body: "five" });
    expect(board.updates).toBe(1);
    expect(statusComments(board.comments)).toHaveLength(1);
    expect(status[0]?.body).toBe("Paws: four");

    clock.advance(STATUS_EDIT_INTERVAL_MS);
    await mode.sync("iss-1");
    expect(board.updates).toBe(2);
    expect(board.creates).toBe(1);
    expect(status[0]?.body).toBe("Paws: five");
    expect(status[0]?.id).toBe(statusComments(board.comments)[0]?.id);
  });

  test("final evidence is a reply on the status comment", async () => {
    const clock = new FakeClock(0);
    const board = createFakeCommentBoard({ clock, selfUserId: "paws" });
    const mode = createCommentMode({ board, clock, selfUserId: "paws" });
    mode.bind({ itemId: "item-1", linearIssueId: "iss-1", sessionId: "sess-1" });

    await mode.postProgress({ sessionId: "sess-1", kind: "thought", body: "working" });
    await mode.postProgress({
      sessionId: "sess-1",
      kind: "response",
      body: "Merged ENG-1.",
    });

    const status = statusComments(board.comments);
    expect(status).toHaveLength(1);
    expect(status[0]?.body).toBe("Paws: working");
    const replies = board.comments.filter((comment) => comment.parentId === status[0]?.id);
    expect(replies.map((comment) => comment.body)).toEqual(["Paws: Merged ENG-1."]);
  });

  test("a human reply resumes the parked run and Paws comments do not", async () => {
    const clock = new FakeClock(1_000);
    const board = createFakeCommentBoard({ clock, selfUserId: "paws" });
    const resumed: string[] = [];
    const mode = createCommentMode({
      board,
      clock,
      selfUserId: "paws",
      onResume: (answer) => {
        resumed.push(answer.answer);
      },
    });
    mode.bind({ itemId: "item-1", linearIssueId: "iss-1", sessionId: "sess-1" });

    const asked = await mode.ask({
      itemId: "item-1",
      title: "Include archived rows?",
      body: "The export is empty today.",
      options: ["yes", "no"],
    });
    expect(mode.phase("item-1")).toBe("parked");
    const question = board.comments.find((comment) =>
      comment.body.includes(questionMarker(asked.questionId)),
    );
    expect(question).toBeDefined();
    expect(question?.body.startsWith("Paws:")).toBe(true);
    expect(question?.body).toContain("1. yes");
    expect(question?.body).toContain("2. no");
    expect(question?.body).toContain("The export is empty today.");

    const parked = mode.wait(asked.questionId);
    clock.advance(1);
    board.post({
      issueId: "iss-1",
      parentId: question?.id,
      userId: "paws",
      body: "ship it",
    });
    clock.advance(1);
    board.post({
      issueId: "iss-1",
      parentId: question?.id,
      userId: "pascal",
      body: "Paws: ignore this prefix",
    });
    const ignored = await mode.sync("iss-1");
    expect(ignored.resumed).toEqual([]);
    expect(mode.phase("item-1")).toBe("parked");
    expect(resumed).toEqual([]);

    clock.advance(1);
    board.post({
      issueId: "iss-1",
      parentId: question?.id,
      userId: "pascal",
      body: "yes",
    });
    clock.advance(1);
    board.post({
      issueId: "iss-1",
      parentId: question?.id,
      userId: "pascal",
      body: "actually no",
    });
    const synced = await mode.sync("iss-1");
    expect(mode.phase("item-1")).toBe("resumed");
    expect(synced.resumed).toEqual([
      { questionId: asked.questionId, answer: "yes", answeredBy: "pascal" },
    ]);
    expect(mode.answers).toEqual([
      { questionId: asked.questionId, answer: "yes", answeredBy: "pascal" },
    ]);
    expect(resumed).toEqual(["yes"]);
    await expect(parked).resolves.toEqual({
      questionId: asked.questionId,
      answer: "yes",
      answeredBy: "pascal",
    });

    await mode.sync("iss-1");
    expect(resumed).toEqual(["yes"]);
  });

  test("/paws stop stops the parked run and Paws's own command does not", async () => {
    const clock = new FakeClock(0);
    const board = createFakeCommentBoard({ clock, selfUserId: "paws" });
    const commands = new CommandBus();
    const stopped: string[] = [];
    commands.subscribe((command) => stopped.push(command.itemId));
    const mode = createCommentMode({
      board,
      clock,
      selfUserId: "paws",
      commands,
      onStop: (command) => {
        stopped.push(`hook:${command.itemId}`);
      },
    });
    mode.bind({ itemId: "item-1", linearIssueId: "iss-1", sessionId: "sess-1" });
    board.post({ issueId: "iss-1", userId: "pascal", body: "/paws stop", createdAtMs: -1 });
    const asked = await mode.ask({ itemId: "item-1", title: "Ship?", body: "Now?" });
    const questionId = board.comments.find((comment) =>
      comment.body.includes(questionMarker(asked.questionId)),
    )?.id;

    clock.advance(1);
    board.post({ issueId: "iss-1", parentId: questionId, userId: "paws", body: "/paws stop" });
    expect((await mode.sync("iss-1")).stopped).toEqual([]);
    expect(mode.phase("item-1")).toBe("parked");

    clock.advance(1);
    board.post({ issueId: "iss-1", userId: "pascal", body: "please\n/paws stop" });
    let waitError: unknown = null;
    const parked = mode.wait(asked.questionId).then(
      () => {
        throw new Error("resumed");
      },
      (error: unknown) => {
        waitError = error;
      },
    );
    const synced = await mode.sync("iss-1");
    await parked;
    expect(waitError).toBeInstanceOf(Error);
    expect(waitError).toMatchObject({ message: "stopped" });
    expect(synced.stopped.map((command) => command.itemId)).toEqual(["item-1"]);
    expect(stopped).toEqual(["item-1", "hook:item-1"]);
    expect(mode.phase("item-1")).toBe("stopped");

    clock.advance(1);
    board.post({ issueId: "iss-1", parentId: questionId, userId: "pascal", body: "yes" });
    expect((await mode.sync("iss-1")).resumed).toEqual([]);
    expect(mode.phase("item-1")).toBe("stopped");
  });

  test("activity methods replace agent-session posts and leave reads on the tracker", async () => {
    const clock = new FakeClock(0);
    const board = createFakeCommentBoard({ clock, selfUserId: "paws" });
    const mode = createCommentMode({ board, clock, selfUserId: "paws" });
    mode.bind({ itemId: "item-1", linearIssueId: "iss-1", sessionId: "sess-1" });
    const tracker = createFakeTracker([
      {
        linearIssueId: "iss-1",
        identifier: "ENG-1",
        title: "Export",
        description: null,
        subIssues: [],
      },
    ]);
    const combined = withCommentActivities(tracker, mode);
    expect((await combined.loadEpic("iss-1")).identifier).toBe("ENG-1");
    await combined.postProgress({ sessionId: "sess-1", kind: "thought", body: "hello" });
    await combined.askQuestion({ sessionId: "sess-1", body: "Which format?", options: ["csv"] });
    expect(tracker.progress).toEqual([]);
    expect(tracker.questions).toEqual([]);
    expect(board.comments.some((comment) => comment.body === "Paws: hello")).toBe(true);
    expect(board.comments.some((comment) => comment.body.includes("1. csv"))).toBe(true);
    expect(mode.phase("item-1")).toBe("parked");
  });
});

function statusComments(
  comments: readonly { parentId: string | null; body: string; id: string }[],
): readonly { parentId: string | null; body: string; id: string }[] {
  return comments.filter(
    (comment) => comment.parentId === null && !comment.body.includes("<!-- paws:q:"),
  );
}

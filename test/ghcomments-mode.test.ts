import { describe, expect, test } from "bun:test";
import { createCommentMode, createFakeCommentBoard, questionMarker } from "../src/comments";
import { FakeClock } from "../src/core";

const ISSUE = "iss-1";

describe("comment mode self-detection", () => {
  test("Linear thread matching excludes Paws bot messages", async () => {
    const clock = new FakeClock(1_000);
    const board = createFakeCommentBoard({ clock, selfUserId: "paws" });
    const mode = createCommentMode({
      board,
      clock,
      selfUserId: "paws",
      selfDetection: "user",
    });
    mode.bind({ itemId: "item-1", linearIssueId: ISSUE, sessionId: "sess-1" });
    const asked = await mode.ask({ itemId: "item-1", title: "Ship?", body: "Now?" });
    const questionId = board.comments.find((comment) =>
      comment.body.includes(questionMarker(asked.questionId)),
    )?.id;

    clock.advance(1);
    board.post({ issueId: ISSUE, parentId: questionId, userId: null, botId: "paws", body: "yes" });
    expect((await mode.sync(ISSUE)).resumed).toEqual([]);
    expect(mode.phase("item-1")).toBe("parked");

    clock.advance(1);
    board.post({ issueId: ISSUE, parentId: questionId, userId: "pascal", body: "yes" });
    const synced = await mode.sync(ISSUE);
    expect(synced.resumed).toEqual([
      { questionId: asked.questionId, answer: "yes", answeredBy: "pascal" },
    ]);
    expect(mode.phase("item-1")).toBe("resumed");
  });

  test("marker mode counts the developer's own unmarked reply", async () => {
    const clock = new FakeClock(1_000);
    const board = createFakeCommentBoard({ clock, selfUserId: "paws" });
    const mode = createCommentMode({
      board,
      clock,
      selfUserId: "paws",
      selfDetection: "marker",
    });
    mode.bind({ itemId: "item-1", linearIssueId: ISSUE, sessionId: "sess-1" });
    await mode.postProgress({ sessionId: "sess-1", kind: "thought", body: "working" });
    expect(board.comments[0]?.body).toBe("Paws: working\n\n<!-- paws -->");

    const asked = await mode.ask({
      itemId: "item-1",
      title: "Include archived rows?",
      body: "The export is empty today.",
      options: ["yes", "no"],
    });
    const question = board.comments.find((comment) =>
      comment.body.includes(questionMarker(asked.questionId)),
    );
    expect(question?.body).toContain("<!-- paws:q:");
    expect(question?.body.startsWith("Paws:")).toBe(true);

    clock.advance(1);
    board.post({ issueId: ISSUE, userId: "paws", body: "yes\n<!-- paws -->" });
    clock.advance(1);
    board.post({ issueId: ISSUE, userId: "paws", body: "Paws: still paws" });
    expect((await mode.sync(ISSUE)).resumed).toEqual([]);
    expect(mode.phase("item-1")).toBe("parked");

    clock.advance(1);
    board.post({ issueId: ISSUE, userId: "paws", body: "ship it" });
    const synced = await mode.sync(ISSUE);
    expect(synced.resumed).toEqual([
      { questionId: asked.questionId, answer: "ship it", answeredBy: "paws" },
    ]);
    expect(mode.phase("item-1")).toBe("resumed");
  });
});

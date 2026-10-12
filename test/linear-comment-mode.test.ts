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
});

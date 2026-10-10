import { describe, expect, test } from "bun:test";
import { createFakeGitHubComments, createGitHubCommentBoard } from "../src/ghcomments";
import type { GitHubCommentRequest } from "../src/ghcomments";

describe("GitHub comment board", () => {
  test("creates, edits, and lists issue comments", async () => {
    const github = createFakeGitHubComments({ selfLogin: "pascal" });
    const board = createGitHubCommentBoard({ request: github.request, owner: "acme", repo: "app" });

    const created = await board.create({
      issueId: "github:acme/app#7",
      parentId: null,
      body: "Paws: one\n\n<!-- paws -->",
    });
    expect(created.id).toBe("1");
    expect(created.userId).toBe("pascal");
    expect(github.calls[0]).toMatchObject({
      method: "POST",
      path: "/repos/acme/app/issues/7/comments",
      body: { body: "Paws: one\n\n<!-- paws -->" },
    });

    const updated = await board.update({ id: created.id, body: "Paws: two\n\n<!-- paws -->" });
    expect(updated.body).toBe("Paws: two\n\n<!-- paws -->");
    expect(github.calls[1]).toMatchObject({
      method: "PATCH",
      path: "/repos/acme/app/issues/comments/1",
    });

    github.post({ issueNumber: 7, body: "yes", login: "pascal", association: "OWNER" });
    const listed = await board.list("github:acme/app#7");
    expect(listed.map((comment) => comment.body)).toEqual(["Paws: two\n\n<!-- paws -->", "yes"]);
    expect(listed[1]?.userId).toBe("pascal");
    expect(github.commentCreates).toBe(1);
    expect(github.commentUpdates).toBe(1);
  });

  test("follows a paginated Link header", async () => {
    const github = createFakeGitHubComments({ selfLogin: "pascal", pageSize: 1 });
    const board = createGitHubCommentBoard({ request: github.request, owner: "acme", repo: "app" });
    await board.create({ issueId: "7", parentId: null, body: "first" });
    await board.create({ issueId: "7", parentId: null, body: "second" });

    const listed = await board.list("7");
    expect(listed.map((comment) => comment.body)).toEqual(["first", "second"]);
    const pages = github.calls.filter((call) => call.method === "GET").map((call) => call.path);
    expect(pages).toEqual([
      "/repos/acme/app/issues/7/comments?per_page=100",
      "/repos/acme/app/issues/7/comments?per_page=1&page=2",
    ]);
  });

  test("a failed write reports the status and not the response body", async () => {
    const request: GitHubCommentRequest = async () => ({
      status: 500,
      body: { message: "token ghs_secret leaked" },
    });
    const board = createGitHubCommentBoard({ request, owner: "acme", repo: "app" });
    await expect(
      board.create({ issueId: "github:acme/app#7", parentId: null, body: "hello" }),
    ).rejects.toThrow("creating a GitHub comment failed with status 500");
  });
});

import { describe, expect, test } from "bun:test";
import {
  createLinearCommentBoard,
  createPersonalLinearClient,
  fetchLinearViewerId,
} from "./linear";
import type { CommentQuery } from "./linear";

describe("linear comment board", () => {
  test("personal API key is sent as the raw Authorization value", async () => {
    const seen: string[] = [];
    const client = createPersonalLinearClient({
      apiKey: "lin_api_secret",
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers);
        seen.push(headers.get("authorization") ?? "");
        return Response.json({ data: { viewer: { id: "user-1" } } });
      },
    });
    expect(await fetchLinearViewerId(client)).toBe("user-1");
    expect(seen).toEqual(["lin_api_secret"]);
  });

  test("HTTP failures do not echo the API key", async () => {
    const client = createPersonalLinearClient({
      apiKey: "lin_api_secret",
      fetch: async () => new Response("no", { status: 401 }),
    });
    await expect(client.query("query Viewer { viewer { id } }")).rejects.toThrow(
      "Linear GraphQL HTTP 401",
    );
  });

  test("create, edit, and thread replies stay on comments", async () => {
    const calls: string[] = [];
    const client: CommentQuery = {
      async query(query, variables) {
        calls.push(query);
        const input = variables?.["input"];
        if (query.includes("commentCreate") && isRecord(input)) {
          return {
            commentCreate: {
              success: true,
              comment: {
                id: "cmt-1",
                body: input["body"],
                createdAt: "2026-01-01T00:00:00.000Z",
                parentId: null,
                user: { id: "user-1" },
                botActor: null,
              },
            },
          };
        }
        if (query.includes("commentUpdate")) {
          return {
            commentUpdate: {
              success: true,
              comment: {
                id: "cmt-1",
                body: "Paws: next",
                createdAt: "2026-01-01T00:00:00.000Z",
                parentId: null,
                user: { id: "user-1" },
                botActor: null,
              },
            },
          };
        }
        if (query.includes("IssueComments")) {
          return {
            issue: {
              comments: {
                nodes: [
                  {
                    id: "cmt-q",
                    body: "Paws: Question\n\n<!-- paws:q:q-1 -->",
                    createdAt: "2026-01-01T00:00:01.000Z",
                    parentId: null,
                    user: { id: "user-1" },
                    botActor: null,
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          };
        }
        return {
          comment: {
            children: {
              nodes: [
                {
                  id: "cmt-a",
                  body: "yes",
                  createdAt: "2026-01-01T00:00:02.000Z",
                  parentId: null,
                  user: { id: "pascal" },
                  botActor: null,
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      },
    };
    const board = createLinearCommentBoard(client);
    const created = await board.create({ issueId: "iss-1", parentId: null, body: "Paws: one" });
    expect(created.id).toBe("cmt-1");
    expect(created.userId).toBe("user-1");
    const updated = await board.update({ id: "cmt-1", body: "Paws: next" });
    expect(updated.body).toBe("Paws: next");
    const listed = await board.list("iss-1");
    expect(listed.map((comment) => comment.id)).toEqual(["cmt-q", "cmt-a"]);
    expect(listed[1]?.parentId).toBe("cmt-q");
    expect(listed[1]?.userId).toBe("pascal");
    expect(calls.some((query) => query.includes("agentActivityCreate"))).toBe(false);
    expect(calls.some((query) => query.includes("commentCreate"))).toBe(true);
    expect(calls.some((query) => query.includes("commentUpdate"))).toBe(true);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

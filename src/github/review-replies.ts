import { z } from "zod";
import { acquireOperationToken } from "./auth/provider";
import type { GitHubTokenProvider } from "./auth/types";
import { repoApiPath } from "./client";
import type { GitHubClient, GitHubResponse } from "./types";

type Access = {
  client: GitHubClient;
  owner: string;
  repo: string;
  tokenProvider?: GitHubTokenProvider;
  appId?: string;
  installationId?: string;
  privateKeyPem?: string;
};

/** Reply in the review thread that `commentId` (an inline review comment) belongs to. */
export async function replyToReviewComment(
  input: Access & { prNumber: number; commentId: number; body: string },
): Promise<void> {
  const token = await acquireOperationToken(input, "pr");
  const response = await input.client.request({
    method: "POST",
    path: repoApiPath(
      input.owner,
      input.repo,
      `/pulls/${input.prNumber}/comments/${input.commentId}/replies`,
    ),
    token,
    body: { body: input.body },
  });
  if (response.status !== 201)
    throw new Error(`GitHub review comment reply failed: status ${response.status}`);
}

/** Add a comment to the pull request's conversation. */
export async function commentOnPullRequest(
  input: Access & { prNumber: number; body: string },
): Promise<void> {
  const token = await acquireOperationToken(input, "pr");
  const response = await input.client.request({
    method: "POST",
    path: repoApiPath(input.owner, input.repo, `/issues/${input.prNumber}/comments`),
    token,
    body: { body: input.body },
  });
  if (response.status !== 201)
    throw new Error(`GitHub pull request comment failed: status ${response.status}`);
}

const resolveMutation = `mutation ResolveReviewThread($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } }
}`;

const resolvedSchema = z.object({
  data: z.object({
    resolveReviewThread: z.object({
      thread: z.object({ id: z.string(), isResolved: z.boolean() }),
    }),
  }),
});

/** Resolve the review thread with GraphQL node id `threadId`. */
export async function resolveReviewThread(input: Access & { threadId: string }): Promise<void> {
  const token = await acquireOperationToken(input, "pr");
  const response = await input.client.request({
    method: "POST",
    path: "/graphql",
    token,
    body: { query: resolveMutation, variables: { id: input.threadId } },
  });
  const parsed = resolvedSchema.safeParse(response.body);
  if (
    response.status !== 200 ||
    !parsed.success ||
    !parsed.data.data.resolveReviewThread.thread.isResolved
  )
    throw new Error(`GitHub review thread resolve failed: status ${response.status}`);
}

export type FakeReviewReplies = {
  /** Replies posted in review threads, by the comment they answer. */
  replies: { prNumber: number; commentId: number; body: string }[];
  /** Comments added to pull request conversations. */
  comments: { prNumber: number; body: string }[];
  /** Thread node ids resolved. */
  resolved: string[];
  respond(request: { method: string; path: string; body?: unknown }): GitHubResponse | null;
};

/**
 * Records review replies, conversation comments and thread resolutions. `respond` answers those
 * three requests and returns null for any other.
 */
export function createFakeReviewReplies(): FakeReviewReplies {
  const fake: FakeReviewReplies = {
    replies: [],
    comments: [],
    resolved: [],
    respond(request) {
      if (request.method !== "POST") return null;
      const body = (request.body ?? {}) as {
        body?: string;
        query?: string;
        variables?: Record<string, unknown>;
      };
      const reply = /\/pulls\/(\d+)\/comments\/(\d+)\/replies$/.exec(request.path);
      if (reply) {
        fake.replies.push({
          prNumber: Number(reply[1]),
          commentId: Number(reply[2]),
          body: body.body ?? "",
        });
        return { status: 201, body: {} };
      }
      const comment = /\/issues\/(\d+)\/comments$/.exec(request.path);
      if (comment) {
        fake.comments.push({ prNumber: Number(comment[1]), body: body.body ?? "" });
        return { status: 201, body: {} };
      }
      if (request.path === "/graphql" && body.query?.includes("mutation ResolveReviewThread")) {
        const id = String(body.variables?.id);
        fake.resolved.push(id);
        return {
          status: 200,
          body: { data: { resolveReviewThread: { thread: { id, isResolved: true } } } },
        };
      }
      return null;
    },
  };
  return fake;
}

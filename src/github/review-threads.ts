import { z } from "zod";
import { acquireOperationToken } from "./auth/provider";
import type { GitHubTokenProvider } from "./auth/types";
import type { GitHubClient } from "./types";

export type ReviewThreadComment = {
  author: string | null;
  body: string;
  /** The GitHub review id the comment was submitted with. */
  reviewId: number | null;
};

/** One unresolved review thread on a pull request, its comments oldest first. */
export type ReviewThread = {
  path: string | null;
  line: number | null;
  outdated: boolean;
  comments: ReviewThreadComment[];
};

const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });

const responseSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewThreads: z.object({
          pageInfo: pageInfoSchema,
          nodes: z.array(
            z.object({
              isResolved: z.boolean(),
              isOutdated: z.boolean().optional(),
              path: z.string().nullable().optional(),
              line: z.number().nullable().optional(),
              comments: z.object({
                nodes: z.array(
                  z.object({
                    body: z.string(),
                    author: z.object({ login: z.string() }).nullable().optional(),
                    pullRequestReview: z
                      .object({ databaseId: z.number().nullable() })
                      .nullable()
                      .optional(),
                  }),
                ),
              }),
            }),
          ),
        }),
      }),
    }),
  }),
});

const query = `query ReviewThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isOutdated
          path
          line
          comments(first: 50) {
            nodes { body author { login } pullRequestReview { databaseId } }
          }
        }
      }
    }
  }
}`;

const MAX_PAGES = 10;

/** The pull request's unresolved review threads. Throws when GitHub cannot be read. */
export async function readReviewThreads(input: {
  client: GitHubClient;
  owner: string;
  repo: string;
  prNumber: number;
  tokenProvider?: GitHubTokenProvider;
  appId?: string;
  installationId?: string;
  privateKeyPem?: string;
}): Promise<ReviewThread[]> {
  const token = await acquireOperationToken(input, "merge");
  const threads: ReviewThread[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await input.client.request({
      method: "POST",
      path: "/graphql",
      token,
      body: {
        query,
        variables: { owner: input.owner, repo: input.repo, number: input.prNumber, cursor },
      },
    });
    const parsed = responseSchema.safeParse(response.body);
    if (response.status !== 200 || !parsed.success)
      throw new Error(`GitHub review threads read failed: status ${response.status}`);
    const connection = parsed.data.data.repository.pullRequest.reviewThreads;
    for (const node of connection.nodes) {
      if (node.isResolved) continue;
      threads.push({
        path: node.path ?? null,
        line: node.line ?? null,
        outdated: node.isOutdated ?? false,
        comments: node.comments.nodes.map((comment) => ({
          author: comment.author?.login ?? null,
          body: comment.body,
          reviewId: comment.pullRequestReview?.databaseId ?? null,
        })),
      });
    }
    if (!connection.pageInfo.hasNextPage || connection.pageInfo.endCursor === null) return threads;
    cursor = connection.pageInfo.endCursor;
  }
  return threads;
}

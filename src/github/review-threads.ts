import { z } from "zod";
import { acquireOperationToken } from "./auth/provider";
import type { GitHubTokenProvider } from "./auth/types";
import type { GitHubClient } from "./types";

export type ReviewThreadComment = {
  author: string | null;
  body: string;
  /** The GitHub review id the comment was submitted with. */
  reviewId: number | null;
  /** The comment's page on GitHub, when GitHub returned it. */
  url?: string;
  /** The comment's REST id, which a reply names. */
  databaseId?: number;
};

/** One review thread on a pull request, its comments oldest first. */
export type ReviewThread = {
  /** The thread's GraphQL node id, which resolving it names. */
  id?: string;
  /** Set when the read included resolved threads. */
  resolved?: boolean;
  path: string | null;
  line: number | null;
  outdated: boolean;
  comments: ReviewThreadComment[];
};

const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });

const commentsSchema = z.object({
  pageInfo: pageInfoSchema,
  nodes: z.array(
    z.object({
      body: z.string(),
      author: z.object({ login: z.string() }).nullable().optional(),
      url: z.string().optional(),
      databaseId: z.number().nullable().optional(),
      pullRequestReview: z.object({ databaseId: z.number().nullable() }).nullable().optional(),
    }),
  ),
});

const responseSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewThreads: z.object({
          pageInfo: pageInfoSchema,
          nodes: z.array(
            z.object({
              id: z.string(),
              isResolved: z.boolean(),
              isOutdated: z.boolean().optional(),
              path: z.string().nullable().optional(),
              line: z.number().nullable().optional(),
              comments: commentsSchema,
            }),
          ),
        }),
      }),
    }),
  }),
});

const commentsResponseSchema = z.object({
  data: z.object({ node: z.object({ comments: commentsSchema }) }),
});

const COMMENT_FIELDS = `pageInfo { hasNextPage endCursor }
            nodes { databaseId body url author { login } pullRequestReview { databaseId } }`;

const query = `query ReviewThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 100) {
            ${COMMENT_FIELDS}
          }
        }
      }
    }
  }
}`;

const commentsQuery = `query ReviewThreadComments($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $cursor) {
            ${COMMENT_FIELDS}
      }
    }
  }
}`;

const MAX_PAGES = 10;

type Comments = z.infer<typeof commentsSchema>;

function threadComments(comments: Comments): ReviewThreadComment[] {
  return comments.nodes.map((comment) => ({
    author: comment.author?.login ?? null,
    body: comment.body,
    reviewId: comment.pullRequestReview?.databaseId ?? null,
    ...(comment.url ? { url: comment.url } : {}),
    ...(typeof comment.databaseId === "number" ? { databaseId: comment.databaseId } : {}),
  }));
}

/**
 * The pull request's unresolved review threads, or every thread with `includeResolved`.
 * Throws when GitHub cannot be read.
 */
export async function readReviewThreads(input: {
  client: GitHubClient;
  includeResolved?: boolean;
  owner: string;
  repo: string;
  prNumber: number;
  tokenProvider?: GitHubTokenProvider;
  appId?: string;
  installationId?: string;
  privateKeyPem?: string;
}): Promise<ReviewThread[]> {
  const token = await acquireOperationToken(input, "merge");
  const read = async <T>(
    body: { query: string; variables: Record<string, unknown> },
    schema: z.ZodType<T>,
  ): Promise<T> => {
    const response = await input.client.request({ method: "POST", path: "/graphql", token, body });
    const parsed = schema.safeParse(response.body);
    if (response.status !== 200 || !parsed.success)
      throw new Error(`GitHub review threads read failed: status ${response.status}`);
    return parsed.data;
  };
  const threads: ReviewThread[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const parsed: z.infer<typeof responseSchema> = await read(
      {
        query,
        variables: { owner: input.owner, repo: input.repo, number: input.prNumber, cursor },
      },
      responseSchema,
    );
    const connection = parsed.data.repository.pullRequest.reviewThreads;
    for (const node of connection.nodes) {
      if (node.isResolved && !input.includeResolved) continue;
      const comments = threadComments(node.comments);
      // A long thread continues past the first page; a review's comment can sit there.
      let more = node.comments.pageInfo;
      for (let next = 0; more.hasNextPage && more.endCursor !== null; next += 1) {
        if (next >= MAX_PAGES) throw new Error("GitHub review thread has too many comments");
        const rest: z.infer<typeof commentsResponseSchema> = await read(
          { query: commentsQuery, variables: { id: node.id, cursor: more.endCursor } },
          commentsResponseSchema,
        );
        comments.push(...threadComments(rest.data.node.comments));
        more = rest.data.node.comments.pageInfo;
      }
      threads.push({
        id: node.id,
        ...(input.includeResolved ? { resolved: node.isResolved } : {}),
        path: node.path ?? null,
        line: node.line ?? null,
        outdated: node.isOutdated ?? false,
        comments,
      });
    }
    if (!connection.pageInfo.hasNextPage || connection.pageInfo.endCursor === null) return threads;
    cursor = connection.pageInfo.endCursor;
  }
  throw new Error("GitHub pull request has too many review threads");
}

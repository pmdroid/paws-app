import { z } from "zod";
import { acquireOperationToken } from "./auth/provider";
import type { GitHubTokenProvider } from "./auth/types";
import type { GitHubClient } from "./types";

/**
 * `approved` and `none` (the base branch needs no review) are ready to merge. `required` waits for
 * a review, including an approval a branch update dismissed. `unreadable` keeps what was known.
 */
export type PullReview = "approved" | "none" | "required" | "changes_requested" | "unreadable";

const responseSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewDecision: z.enum(["APPROVED", "REVIEW_REQUIRED", "CHANGES_REQUESTED"]).nullish(),
      }),
    }),
  }),
});

const query = `query PullReview($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) { reviewDecision }
  }
}`;

export async function readPullReview(input: {
  client: GitHubClient;
  owner: string;
  repo: string;
  prNumber: number;
  tokenProvider?: GitHubTokenProvider;
  appId?: string;
  installationId?: string;
  privateKeyPem?: string;
}): Promise<PullReview> {
  try {
    const token = await acquireOperationToken(input, "merge");
    const response = await input.client.request({
      method: "POST",
      path: "/graphql",
      token,
      body: {
        query,
        variables: { owner: input.owner, repo: input.repo, number: input.prNumber },
      },
    });
    const parsed = responseSchema.safeParse(response.body);
    if (response.status !== 200 || !parsed.success) {
      console.error(`GitHub review read failed: status ${response.status}`);
      return "unreadable";
    }
    switch (parsed.data.data.repository.pullRequest.reviewDecision) {
      case "APPROVED":
        return "approved";
      case "REVIEW_REQUIRED":
        return "required";
      case "CHANGES_REQUESTED":
        return "changes_requested";
      default:
        return "none";
    }
  } catch (error) {
    console.error(
      `GitHub review read failed: ${
        error instanceof Error
          ? error.message
              .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "[redacted]")
              .slice(0, 300)
          : "unknown error"
      }`,
    );
    return "unreadable";
  }
}

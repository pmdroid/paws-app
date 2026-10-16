import { z } from "zod";
import type { GitHubClient } from "./types";

const responseSchema = z.object({
  errors: z.array(z.unknown()).optional(),
  data: z.object({
    repository: z.object({
      object: z.object({
        oid: z.string(),
        statusCheckRollup: z
          .object({
            state: z.enum(["ERROR", "EXPECTED", "FAILURE", "PENDING", "SUCCESS"]),
            contexts: z.object({
              checkRunCount: z.number().int().nonnegative(),
              statusContextCount: z.number().int().nonnegative(),
            }),
          })
          .nullable(),
      }),
      pullRequest: z.object({
        headRefOid: z.string(),
        state: z.enum(["OPEN", "CLOSED", "MERGED"]),
        reviewThreads: z.object({
          nodes: z.array(z.object({ isResolved: z.boolean() })),
          pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        }),
      }),
    }),
  }),
});

const query = `query MergeReadiness($owner: String!, $repo: String!, $number: Int!, $head: GitObjectID!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    object(oid: $head) {
      ... on Commit {
        oid
        statusCheckRollup {
          state
          contexts { checkRunCount statusContextCount }
        }
      }
    }
    pullRequest(number: $number) {
      headRefOid
      state
      reviewThreads(first: 100, after: $cursor) {
        nodes { isResolved }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

type Readiness = {
  outcome: "ready" | "pending" | "blocked" | "sha_moved";
  message: string;
};

type ReadinessInput = {
  client: GitHubClient;
  token: () => Promise<string>;
  owner: string;
  repo: string;
  prNumber: number;
  head: string;
  sleep?: (ms: number) => Promise<void>;
  isCancelled?: () => boolean;
  onWait?: (message: string) => Promise<void>;
  releaseWhilePending?: boolean;
};

export async function waitForMergeReadiness(input: ReadinessInput): Promise<Readiness> {
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let previous = "";
  let failedReads = 0;
  for (let attempt = 0; attempt < 270; attempt++) {
    if (input.isCancelled?.()) return { outcome: "blocked", message: "merge cancelled" };
    const result = await readReadiness(input);
    if (
      result.outcome === "blocked" &&
      result.message.startsWith("could not read") &&
      ++failedReads < 3
    ) {
      await sleep(10_000);
      continue;
    }
    if (result.outcome !== "pending") return result;
    if (result.message !== previous) {
      await input.onWait?.(result.message);
      previous = result.message;
    }
    if (input.releaseWhilePending) return result;
    if (attempt < 269) await sleep(10_000);
  }
  return { outcome: "blocked", message: `merge timed out waiting for GitHub: ${previous}` };
}

async function readReadiness(input: ReadinessInput): Promise<Readiness> {
  try {
    const token = await input.token();
    let cursor: string | null = null;
    const cursors = new Set<string>();
    let unresolved = 0;
    for (;;) {
      const response = await input.client.request({
        method: "POST",
        path: "/graphql",
        token,
        body: {
          query,
          variables: {
            owner: input.owner,
            repo: input.repo,
            number: input.prNumber,
            head: input.head,
            cursor,
          },
        },
      });
      const parsed = responseSchema.safeParse(response.body);
      if (response.status !== 200 || !parsed.success || parsed.data.errors?.length) {
        console.error(
          `GitHub readiness read failed: status ${response.status}${
            parsed.success && parsed.data.errors?.length
              ? `, ${JSON.stringify(parsed.data.errors).slice(0, 500)}`
              : parsed.success
                ? ""
                : ", unexpected response shape"
          }`,
        );
        return { outcome: "blocked", message: "could not read GitHub CI and review threads" };
      }
      const { object: commit, pullRequest: pull } = parsed.data.data.repository;
      if (commit.oid !== input.head || pull.headRefOid !== input.head) {
        return { outcome: "sha_moved", message: "pull request head changed before merge" };
      }
      if (pull.state !== "OPEN") {
        return { outcome: "blocked", message: "pull request is no longer open" };
      }
      const checks = commit.statusCheckRollup;
      if (checks?.state === "FAILURE" || checks?.state === "ERROR") {
        return { outcome: "blocked", message: "CI failed on the candidate commit" };
      }
      if (
        checks === null ||
        checks.contexts.checkRunCount + checks.contexts.statusContextCount === 0 ||
        checks.state !== "SUCCESS"
      ) {
        return { outcome: "pending", message: "Waiting for CI on the candidate commit." };
      }
      unresolved += pull.reviewThreads.nodes.filter((thread) => !thread.isResolved).length;
      const page = pull.reviewThreads.pageInfo;
      if (!page.hasNextPage) break;
      if (!page.endCursor || cursors.has(page.endCursor)) {
        return { outcome: "blocked", message: "could not read all GitHub review threads" };
      }
      cursors.add(page.endCursor);
      cursor = page.endCursor;
    }
    return unresolved > 0
      ? { outcome: "pending", message: `Waiting for ${unresolved} unresolved review thread(s).` }
      : { outcome: "ready", message: "CI passed and all review threads are resolved" };
  } catch (error) {
    console.error(
      `GitHub readiness read failed: ${error instanceof Error ? error.name : "unknown error"}`,
    );
    return { outcome: "blocked", message: "could not read GitHub CI and review threads" };
  }
}

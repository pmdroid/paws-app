import { z } from "zod";
import { createFetchGitHubClient, repoApiPath } from "./client";
import type { GitHubClient } from "./types";

const pullSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  merge_commit_sha: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable(),
  head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }),
  base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
});

export async function inspectPullRequestMerge(input: {
  repository: string;
  targetBranch: string;
  pullRequestNumber: number;
  token: string;
  signal?: AbortSignal;
  client?: GitHubClient;
}) {
  const [owner, repo] = input.repository.split("/");
  if (
    !owner ||
    !repo ||
    input.repository.split("/").length !== 2 ||
    !Number.isSafeInteger(input.pullRequestNumber) ||
    input.pullRequestNumber <= 0
  )
    throw new Error("A repository and pull request are required for merge evidence.");
  const signal = AbortSignal.any([
    AbortSignal.timeout(10_000),
    ...(input.signal ? [input.signal] : []),
  ]);
  signal.throwIfAborted();
  const response = await (input.client ?? createFetchGitHubClient()).request({
    method: "GET",
    path: repoApiPath(owner, repo, `/pulls/${input.pullRequestNumber}`),
    token: input.token,
    signal,
  });
  signal.throwIfAborted();
  if (response.status !== 200) throw new Error("GitHub could not verify the blocker pull request.");
  const pull = pullSchema.parse(response.body);
  return {
    merged: pull.merged && pull.state === "closed" && pull.merge_commit_sha !== null,
    repository: pull.base.repo.full_name,
    targetBranch: pull.base.ref,
    pullRequestNumber: pull.number,
    headSha: pull.head.sha,
    mergeSha: pull.merge_commit_sha,
  };
}

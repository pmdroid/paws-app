import { z } from "zod";
import { journalCaught } from "../journal";
import { acquireOperationToken, type GitHubTokenProvider } from "./auth";
import { repoApiPath } from "./client";
import { GitHubTokenError, type GitHubClient } from "./types";

export const CI_ALREADY_RERUN = "CI was already re-run for this commit";
export const CI_RERUN_PERMISSION_MISSING =
  "Paws can't re-run CI: the GitHub App lacks Actions write permission";
const CHECK_RUN_PAGES = 10;
const FAILED = new Set(["failure", "timed_out", "cancelled", "startup_failure"]);

const pullSchema = z.object({ state: z.string(), head: z.object({ sha: z.string() }) });

const checkRunsSchema = z.object({
  check_runs: z.array(
    z.object({
      status: z.string(),
      conclusion: z.string().nullable().optional(),
      html_url: z.string().nullable().optional(),
      details_url: z.string().nullable().optional(),
      app: z.object({ slug: z.string() }).nullable().optional(),
    }),
  ),
});

export type CiRerunInput = {
  client: GitHubClient;
  owner: string;
  repo: string;
  prNumber: number;
  alreadyRerun: (head: string) => boolean;
  tokenProvider?: GitHubTokenProvider;
  appId?: string;
  installationId?: string;
  privateKeyPem?: string;
  signal?: AbortSignal;
};

export type CiRerunResult = { answer: string; rerun?: { head: string; runIds: number[] } };

export async function rerunFailedCi(input: CiRerunInput): Promise<CiRerunResult> {
  try {
    return await rerunOnce(input);
  } catch (error) {
    journalCaught(error, "ci-rerun.rerunFailedCi", null);
    throw new Error("Paws could not re-run CI on GitHub. Try again later.", { cause: error });
  }
}

async function rerunOnce(input: CiRerunInput): Promise<CiRerunResult> {
  const token = await acquireOperationToken(input, "merge");
  const request = (method: "GET" | "POST", path: string, as = token) =>
    input.client.request({
      method,
      path: repoApiPath(input.owner, input.repo, path),
      token: as,
      signal: input.signal ?? AbortSignal.timeout(30_000),
    });
  const pullResponse = await request("GET", `/pulls/${input.prNumber}`);
  const pull = pullSchema.safeParse(pullResponse.body);
  if (pullResponse.status !== 200 || !pull.success)
    return { answer: `Paws could not read pull request #${input.prNumber}` };
  if (pull.data.state !== "open") return { answer: `Pull request #${input.prNumber} is not open` };
  const head = pull.data.head.sha;
  if (input.alreadyRerun(head)) return { answer: CI_ALREADY_RERUN };
  const runs: z.infer<typeof checkRunsSchema>["check_runs"] = [];
  for (let page = 1; page <= CHECK_RUN_PAGES; page++) {
    const response = await request("GET", `/commits/${head}/check-runs?per_page=100&page=${page}`);
    const parsed = checkRunsSchema.safeParse(response.body);
    if (response.status !== 200 || !parsed.success)
      return { answer: `Paws could not read the checks on ${head.slice(0, 7)}` };
    runs.push(...parsed.data.check_runs);
    if (parsed.data.check_runs.length < 100) break;
  }
  if (runs.some((run) => run.status !== "completed"))
    return {
      answer: `CI is still running on ${head.slice(0, 7)}. Wait until every check finished before calling rerun_ci.`,
    };
  const runIds = [
    ...new Set(
      runs
        .filter((run) => run.app?.slug === "github-actions" && FAILED.has(run.conclusion ?? ""))
        .flatMap((run) => {
          const id = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(run.html_url ?? run.details_url ?? "");
          return id ? [Number(id[1])] : [];
        }),
    ),
  ];
  if (runIds.length === 0)
    return {
      answer: `No GitHub Actions job failed on ${head.slice(0, 7)}, so there is nothing to re-run.`,
    };
  const rerunToken = await acquireOperationToken(input, "ci_rerun").catch((error: unknown) => {
    if (error instanceof GitHubTokenError && (error.status === 403 || error.status === 422))
      return null;
    throw error;
  });
  if (rerunToken === null) return { answer: CI_RERUN_PERMISSION_MISSING };
  const accepted: number[] = [];
  for (const runId of runIds) {
    const response = await request("POST", `/actions/runs/${runId}/rerun-failed-jobs`, rerunToken);
    if (response.status === 403 && accepted.length === 0)
      return { answer: CI_RERUN_PERMISSION_MISSING };
    if (response.status === 201) accepted.push(runId);
    else if (accepted.length === 0)
      throw new Error(`GitHub refused to re-run workflow run ${runId}: status ${response.status}`);
  }
  return {
    answer: `Re-running the failed jobs of workflow run ${accepted.join(", ")} on ${head.slice(0, 7)}. The merge lane waits for the new result.`,
    rerun: { head, runIds: accepted },
  };
}

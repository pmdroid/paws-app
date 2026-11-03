import { z } from "zod";
import { journalCaught } from "../journal";
import { acquireOperationToken, type GitHubTokenProvider } from "./auth";
import { repoApiPath } from "./client";
import { cleanLogLines } from "./readiness";
import type { GitHubClient } from "./types";

export const CI_LOG_CONTEXT_LINES = 30;
export const CI_LOG_MAX_BYTES = 24 * 1024;
const CHECK_RUN_PAGES = 10;
const FAILED = new Set(["failure", "timed_out", "cancelled", "startup_failure", "action_required"]);

const pullSchema = z.object({ state: z.string(), head: z.object({ sha: z.string() }) });

const checkRunsSchema = z.object({
  check_runs: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      conclusion: z.string().nullable().optional(),
      html_url: z.string().nullable().optional(),
      app: z.object({ slug: z.string() }).nullable().optional(),
    }),
  ),
});

type CheckRun = z.infer<typeof checkRunsSchema>["check_runs"][number];

export type CiLogInput = {
  client: GitHubClient;
  owner: string;
  repo: string;
  prNumber: number;
  job?: string | undefined;
  tokenProvider?: GitHubTokenProvider;
  appId?: string;
  installationId?: string;
  privateKeyPem?: string;
  signal?: AbortSignal;
};

class CiLogRefusal extends Error {}

export async function readCiLog(input: CiLogInput): Promise<string> {
  try {
    return await readCiLogOnce(input);
  } catch (error) {
    if (error instanceof CiLogRefusal) throw error;
    journalCaught(error, "ci-log.readCiLog", null);
    throw new Error("Paws could not read CI from GitHub. Try again later.", { cause: error });
  }
}

async function readCiLogOnce(input: CiLogInput): Promise<string> {
  const token = await acquireOperationToken(input, "merge");
  const request = (path: string, accept?: "text") =>
    input.client.request({
      method: "GET",
      path: repoApiPath(input.owner, input.repo, path),
      token,
      signal: input.signal ?? AbortSignal.timeout(30_000),
      ...(accept ? { accept } : {}),
    });
  const pullResponse = await request(`/pulls/${input.prNumber}`);
  const pull = pullSchema.safeParse(pullResponse.body);
  if (pullResponse.status !== 200 || !pull.success)
    throw new CiLogRefusal(`Paws could not read pull request #${input.prNumber}`);
  if (pull.data.state !== "open")
    throw new CiLogRefusal(`Pull request #${input.prNumber} is not open`);
  const head = pull.data.head.sha;
  const runs: CheckRun[] = [];
  for (let page = 1; page <= CHECK_RUN_PAGES; page++) {
    const response = await request(`/commits/${head}/check-runs?per_page=100&page=${page}`);
    const parsed = checkRunsSchema.safeParse(response.body);
    if (response.status !== 200 || !parsed.success)
      throw new CiLogRefusal(`Paws could not read the checks on ${head.slice(0, 7)}`);
    runs.push(...parsed.data.check_runs);
    if (parsed.data.check_runs.length < 100) break;
  }
  if (input.job === undefined) {
    const failed = runs.filter((run) => FAILED.has(run.conclusion ?? ""));
    return JSON.stringify({
      head,
      failed: failed.map((run) => ({
        name: run.name,
        conclusion: run.conclusion,
        job: run.id,
        url: publicUrl(run.html_url),
      })),
    });
  }
  const job = input.job.trim();
  const matches = runs.filter((run) =>
    /^\d+$/.test(job) ? String(run.id) === job : run.name === job,
  );
  const run = matches.find((match) => FAILED.has(match.conclusion ?? "")) ?? matches[0];
  if (!run)
    throw new CiLogRefusal(
      `Job ${JSON.stringify(job)} is not one of the checks on the pull request's head ${head.slice(0, 7)}. Call get_ci_log without job to list them.`,
    );
  if (run.app?.slug !== "github-actions")
    throw new CiLogRefusal(`${run.name} is not a GitHub Actions job, so it has no log to read.`);
  const response = await request(`/actions/jobs/${run.id}/logs`, "text");
  if (response.status !== 200 || typeof response.body !== "string")
    throw new CiLogRefusal(`Paws could not read the log of ${run.name}: status ${response.status}`);
  return `Log of ${run.name} (job ${run.id}, ${run.conclusion ?? "running"}) on ${head.slice(0, 7)}, reduced to its errors:\n\n${reduceCiLog(response.body)}`;
}

export function reduceCiLog(log: string): string {
  const lines = cleanLogLines(log);
  const errors = lines.flatMap((line, index) => (line.startsWith("##[error]") ? [index] : []));
  const kept: string[] = [];
  let end = -1;
  for (const index of errors) {
    const start = Math.max(end + 1, index - CI_LOG_CONTEXT_LINES);
    if (end >= 0 && start > end + 1) kept.push("…");
    kept.push(...lines.slice(start, index + 1));
    end = index;
  }
  const text = (errors.length === 0 ? lines : kept).join("\n").trim();
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= CI_LOG_MAX_BYTES) return text;
  return bytes
    .subarray(bytes.length - CI_LOG_MAX_BYTES)
    .toString("utf8")
    .replace(/^�+/, "");
}

function publicUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

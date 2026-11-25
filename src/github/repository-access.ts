import { GitHubHttpError } from "./types";
import type { FetchLike } from "./client";
import { defaultRecorder, type MetricsRecorder } from "../metrics";
import { observeGitHubCall, observeGitHubRemaining } from "./call-metrics";

type RepositoryAccessOptions = {
  owner: string;
  repo: string;
  token: string;
  app: boolean;
  signal: AbortSignal;
  fetch?: FetchLike;
  metrics?: MetricsRecorder;
};

export function checkRepositoryWriteAccess(options: RepositoryAccessOptions): Promise<boolean> {
  return checkRepositoryAccess(options, true);
}

export function checkRepositoryReadAccess(options: RepositoryAccessOptions): Promise<boolean> {
  return checkRepositoryAccess(options, false);
}

async function checkRepositoryAccess(
  options: RepositoryAccessOptions,
  write: boolean,
): Promise<boolean> {
  options.signal.throwIfAborted();
  const metrics = options.metrics ?? defaultRecorder;
  const started = performance.now();
  const response = await (options.fetch ?? fetch)(
    `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`,
    {
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(5_000)]),
      redirect: "error",
    },
  ).catch((error: unknown) => {
    if (!options.signal.aborted) observeGitHubCall(metrics, "repos", started, null, false);
    throw error;
  });
  observeGitHubRemaining(metrics, response.headers);
  observeGitHubCall(
    metrics,
    "repos",
    started,
    response.status,
    response.status === 429 ||
      (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0"),
  );
  options.signal.throwIfAborted();
  if (response.status === 404) return false;
  if (!response.ok)
    throw new GitHubHttpError(
      {
        status: response.status,
        body: await response.text(),
        retryAfterMs: /^\d+$/.test(response.headers.get("retry-after") ?? "")
          ? Number(response.headers.get("retry-after")) * 1000
          : undefined,
      },
      `GitHub repository access check failed (${response.status})`,
    );
  const data = (await response.json()) as { permissions?: { push?: boolean } };
  options.signal.throwIfAborted();
  if (options.app || !write) return true;
  if (typeof data?.permissions?.push !== "boolean")
    throw new Error("GitHub returned incomplete repository permissions");
  return data.permissions.push;
}

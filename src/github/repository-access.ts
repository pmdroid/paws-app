import { GitHubHttpError } from "./types";
import type { FetchLike } from "./client";

type RepositoryAccessOptions = {
  owner: string;
  repo: string;
  token: string;
  app: boolean;
  signal: AbortSignal;
  fetch?: FetchLike;
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
  );
  options.signal.throwIfAborted();
  if (response.status === 404) return false;
  if (!response.ok)
    throw new GitHubHttpError({
      status: response.status,
      body: await response.text(),
      retryAfterMs: /^\d+$/.test(response.headers.get("retry-after") ?? "")
        ? Number(response.headers.get("retry-after")) * 1000
        : undefined,
    });
  const data = (await response.json()) as { permissions?: { push?: boolean } };
  options.signal.throwIfAborted();
  if (options.app || !write) return true;
  if (typeof data?.permissions?.push !== "boolean")
    throw new Error("GitHub returned incomplete repository permissions");
  return data.permissions.push;
}

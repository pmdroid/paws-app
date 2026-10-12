import type { FetchLike } from "./client";

export async function checkRepositoryWriteAccess(options: {
  owner: string;
  repo: string;
  token: string;
  app: boolean;
  signal: AbortSignal;
  fetch?: FetchLike;
}): Promise<boolean> {
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
  if (!response.ok) throw new Error(`GitHub repository access check failed (${response.status})`);
  const data = (await response.json()) as { permissions?: { push?: boolean } };
  options.signal.throwIfAborted();
  if (options.app) return true;
  if (typeof data?.permissions?.push !== "boolean")
    throw new Error("GitHub returned incomplete repository permissions");
  return data.permissions.push;
}

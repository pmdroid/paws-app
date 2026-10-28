import { acquireOperationToken } from "./auth/provider";
import type { GitHubTokenProvider } from "./auth/types";
import { repoApiPath } from "./client";
import { GitHubHttpError, type GitHubClient } from "./types";

/** The Paws-owned branch a candidate whose rebase conflicted waits on for its conflict round. */
export function conflictBranchName(branch: string): string {
  return `${branch}-conflict`;
}

/** Deletes an item's conflict branch once the item ended. A branch that is gone already is fine. */
export async function deleteConflictBranch(input: {
  client: GitHubClient;
  owner: string;
  repo: string;
  branch: string;
  tokenProvider?: GitHubTokenProvider;
  appId?: string;
  installationId?: string;
  privateKeyPem?: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  input.signal?.throwIfAborted();
  const branch = conflictBranchName(input.branch);
  if (!/^paws\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch))
    throw new Error("Only a Paws conflict branch can be deleted");
  const token = await acquireOperationToken(input, "push");
  const response = await input.client.request({
    method: "DELETE",
    path: repoApiPath(
      input.owner,
      input.repo,
      `/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
    ),
    token,
    signal: input.signal,
  });
  if (response.status === 204) return true;
  if (response.status === 404 || response.status === 422) return false;
  throw new GitHubHttpError(response);
}

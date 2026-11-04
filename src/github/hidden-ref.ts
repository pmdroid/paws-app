import { acquireOperationToken } from "./auth/provider";
import type { GitHubTokenProvider } from "./auth/types";
import { repoApiPath } from "./client";
import type { GitHubClient } from "./types";

export async function deleteHiddenRef(input: {
  client: GitHubClient;
  owner: string;
  repo: string;
  ref: string;
  tokenProvider?: GitHubTokenProvider;
  appId?: string;
  installationId?: string;
  privateKeyPem?: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (!/^refs\/paws\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(input.ref) || input.ref.includes(".."))
    throw new Error("Only a hidden Paws ref can be deleted");
  input.signal?.throwIfAborted();
  const token = await acquireOperationToken(input, "push");
  const path = input.ref.slice("refs/".length).split("/").map(encodeURIComponent).join("/");
  const deleted = await input.client.request({
    method: "DELETE",
    path: repoApiPath(input.owner, input.repo, `/git/refs/${path}`),
    token,
    signal: input.signal,
  });
  if (deleted.status === 204) return true;
  if (deleted.status === 404 || deleted.status === 422) return false;
  throw new Error(`Deleting ${input.ref} failed with HTTP ${deleted.status}`);
}

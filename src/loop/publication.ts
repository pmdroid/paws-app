import { git, GitError } from "../acp";
import {
  createAppTokenProvider,
  GitCommandError,
  type GitExec,
  type GitHubBinding,
  type GitHubClient,
  type TokenPurpose,
} from "../github";
import type { RepositoryBinding } from "../core";

export function guardGitHubPublication(input: {
  github: GitHubBinding;
  repository: RepositoryBinding;
  signal: AbortSignal;
  gitExec?: GitExec;
  onCleanupFailure(): void;
  isCurrent(): boolean;
  assert(purpose?: TokenPurpose, merging?: boolean): Promise<void>;
}): GitHubBinding & { gitExec: GitExec } {
  const current = () => {
    input.signal.throwIfAborted();
    if (!input.isCurrent()) throw new Error("The Linear publication was superseded.");
  };
  const check = async (purpose?: TokenPurpose, merging = false) => {
    current();
    await input.assert(purpose, merging);
    current();
  };
  const client: GitHubClient = {
    async request(request) {
      if (request.method !== "GET") {
        const merging = mergesPullRequest(request);
        await check(merging ? "merge" : "pr", merging);
      }
      current();
      return input.github.client.request({
        ...request,
        signal: request.signal ? AbortSignal.any([input.signal, request.signal]) : input.signal,
      });
    },
  };
  const provider =
    input.github.tokenProvider ??
    createAppTokenProvider({
      client,
      appId: input.github.appId,
      installationId: input.github.installationId,
      privateKeyPem: input.github.privateKeyPem,
      owner: input.repository.owner,
      repo: input.repository.repo,
    });
  const ownedGitExec: GitExec =
    input.gitExec ??
    (async (args, options) => {
      try {
        return {
          stdout: await git(args, { ...options, onCleanupFailure: input.onCleanupFailure }),
          stderr: "",
        };
      } catch (error) {
        if (error instanceof GitError) throw new GitCommandError(args, error.stderr);
        throw error;
      }
    });
  return {
    ...input.github,
    client,
    async gitExec(args, options) {
      if (args.includes("push")) await check("push");
      current();
      return ownedGitExec(args, {
        ...options,
        signal: options.signal ? AbortSignal.any([input.signal, options.signal]) : input.signal,
      });
    },
    tokenProvider: {
      mode: provider.mode,
      async tokenFor(purpose) {
        await check(purpose);
        current();
        const token = await provider.tokenFor(purpose);
        await check(purpose);
        current();
        return token;
      },
    },
  };
}

function mergesPullRequest(request: Parameters<GitHubClient["request"]>[0]): boolean {
  if (request.method === "PUT") return request.path.endsWith("/merge");
  const query = (request.body as { query?: unknown } | undefined)?.query;
  return (
    request.path === "/graphql" &&
    typeof query === "string" &&
    query.trimStart().startsWith("mutation EnqueuePullRequest")
  );
}

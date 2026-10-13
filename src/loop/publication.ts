import { git, GitError } from "../acp";
import {
  createAppTokenProvider,
  GitCommandError,
  type GitExec,
  type GitHubClient,
  type TokenPurpose,
} from "../github";
import type { GitHubBinding, RepositoryBinding } from "./orchestrator";

export function guardGitHubPublication(input: {
  github: GitHubBinding;
  repository: RepositoryBinding;
  signal: AbortSignal;
  gitExec?: GitExec;
  onCleanupFailure(): void;
  isCurrent(): boolean;
  assert(purpose?: TokenPurpose): Promise<void>;
}): GitHubBinding & { gitExec: GitExec } {
  const current = () => {
    input.signal.throwIfAborted();
    if (!input.isCurrent()) throw new Error("The Linear publication was superseded.");
  };
  const check = async (purpose?: TokenPurpose) => {
    current();
    await input.assert(purpose);
    current();
  };
  const client: GitHubClient = {
    async request(request) {
      if (request.method !== "GET")
        await check(request.method === "PUT" && request.path.endsWith("/merge") ? "merge" : "pr");
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

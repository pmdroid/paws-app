import type { FetchLike } from "./client";
import { checkRepositoryReadAccess, checkRepositoryWriteAccess } from "./repository-access";

export type MemberGitHubIdentity = { id: number; login: string };
export interface MemberGitHubClient {
  identity(token: string, signal: AbortSignal): Promise<MemberGitHubIdentity>;
  repository(
    token: string,
    repository: string,
    permission: "read" | "push",
    signal: AbortSignal,
  ): Promise<boolean>;
}

export class MemberGitHubUnauthorizedError extends Error {
  constructor() {
    super("Reconnect your GitHub account.");
  }
}

export function createMemberGitHubClient(http: FetchLike = fetch): MemberGitHubClient {
  const checked: FetchLike = async (input, init) => {
    const response = await http(input, init);
    if (response.status === 401) throw new MemberGitHubUnauthorizedError();
    return response;
  };
  return {
    async identity(token, signal) {
      signal.throwIfAborted();
      const response = await checked("https://api.github.com/user", {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
        redirect: "error",
      });
      const user = (await response.json()) as { id?: unknown; login?: unknown; type?: unknown };
      signal.throwIfAborted();
      if (
        !response.ok ||
        user?.type !== "User" ||
        !Number.isSafeInteger(user.id) ||
        Number(user.id) <= 0 ||
        typeof user.login !== "string" ||
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(user.login)
      )
        throw new Error("A verified GitHub user is required.");
      return { id: Number(user.id), login: user.login };
    },
    repository(token, repository, permission, signal) {
      const parts = repository.split("/");
      if (
        parts.length !== 2 ||
        !parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..")
      )
        throw new Error("A GitHub owner/repository is required.");
      const check = permission === "push" ? checkRepositoryWriteAccess : checkRepositoryReadAccess;
      return check({
        owner: parts[0]!,
        repo: parts[1]!,
        token,
        app: false,
        signal,
        fetch: checked,
      });
    },
  };
}

export function createFakeMemberGitHubClient() {
  const calls: {
    operation: "identity" | "repository";
    repository?: string;
    permission?: "read" | "push";
  }[] = [];
  return {
    calls,
    account: { id: 123, login: "fixture-member" },
    allowed: true as boolean,
    unauthorized: false as boolean,
    async identity(_token: string, signal: AbortSignal) {
      signal.throwIfAborted();
      calls.push({ operation: "identity" });
      if (this.unauthorized) throw new MemberGitHubUnauthorizedError();
      return this.account;
    },
    async repository(
      _token: string,
      repository: string,
      permission: "read" | "push",
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      calls.push({ operation: "repository", repository, permission });
      if (this.unauthorized) throw new MemberGitHubUnauthorizedError();
      return this.allowed;
    },
  } satisfies MemberGitHubClient & {
    calls: typeof calls;
    account: MemberGitHubIdentity;
    allowed: boolean;
    unauthorized: boolean;
  };
}

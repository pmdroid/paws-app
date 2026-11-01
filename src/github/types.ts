import type { Readiness } from "./readiness";
export const MAX_TOKEN_TTL_MS = 60 * 60 * 1000;
export const TOKEN_TTL_SKEW_MS = 30 * 1000;

/** Permissions the Paws GitHub App installation token is allowed to hold. */
export const INSTALLATION_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  checks: "write",
  issues: "write",
} as const;

export const UPSTREAM_MAIN_REF = "refs/paws/upstream-main";

export type GitHubMethod = "GET" | "POST" | "PUT" | "PATCH";

export type GitHubResponse = {
  status: number;
  body: unknown;
  retryAfterMs?: number;
};

/**
 * REST client. Tests pass a fake. Production uses {@link createFetchGitHubClient}.
 * Callers must not log `token`.
 */
export interface GitHubClient {
  request(input: {
    method: GitHubMethod;
    path: string;
    token: string;
    body?: unknown;
    signal?: AbortSignal;
    /** `"text"` returns the body as a string and follows a redirect without the token (log downloads). */
    accept?: "text";
  }): Promise<GitHubResponse>;
}

export type CiCheckState = "passed" | "failed" | "running" | "skipped";

/** One check on a pull request's head commit, as Paws shows it and hands it to the agent. */
export type CiCheck = {
  name: string;
  state: CiCheckState;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** The end of a failing check's log, or null when it passed or nothing was readable. */
  logTail: string | null;
  /** `actions` for a GitHub Actions job log, `summary` for the check's summary text. */
  logSource: "actions" | "summary" | null;
};

export type GitExec = (
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

export type AppCredentials = {
  appId: string;
  installationId: string;
  privateKeyPem: string;
  owner: string;
  repo: string;
};

export class GitHubTokenError extends Error {
  readonly body?: unknown;
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(message: string, response?: GitHubResponse) {
    super(message);
    this.name = "GitHubTokenError";
    this.body = response?.body;
    this.status = response?.status;
    this.retryAfterMs = response?.retryAfterMs;
  }
}

/** HTTP and GraphQL failures retain the response for the shared retry classifier. */
export class GitHubHttpError extends Error {
  override readonly name = "GitHubHttpError";
  readonly status: number;
  readonly body: unknown;
  readonly retryAfterMs?: number;
  constructor(response: GitHubResponse, message?: string) {
    const detail = (response.body as { message?: unknown } | null)?.message;
    super(
      message ?? `GitHub HTTP ${response.status}${typeof detail === "string" ? `: ${detail}` : ""}`,
    );
    this.status = response.status;
    this.body = response.body;
    this.retryAfterMs = response.retryAfterMs;
  }
}

export class GitCommandError extends Error {
  readonly args: string[];
  readonly stderr: string;
  constructor(args: string[], stderr: string) {
    super(`git ${args.join(" ")} failed`);
    this.name = "GitCommandError";
    this.args = args;
    this.stderr = stderr;
  }
}

export type OpenedPull = {
  number: number;
  url: string | null;
  body: string;
};

export type PublishResult =
  | {
      published: true;
      branch: string;
      head: string;
      pull: OpenedPull;
    }
  | { published: false; reason: string };

export type SerialMergeResult = {
  merged: boolean;
  outcome:
    | "merged"
    | "waiting"
    | "rejected"
    | "blocked"
    | "invalid"
    | "exhausted"
    | "conflict"
    | "rebase_failed"
    | "push_rejected"
    | "sha_moved"
    | "merge_denied"
    | "unknown"
    | "dirty"
    | "fix_failed"
    | "ci_failed";
  branch: string;
  base?: string;
  head?: string;
  sha?: string;
  summary?: string;
  message?: string;
  failedChecks?: {
    name: string;
    url: string | null;
    logTail?: string | null;
    failsOnBase?: boolean;
  }[];
  /** The files a rebase conflict stopped on. */
  conflictFiles?: string[];
  /** Every check on the head when CI failed, with the failing checks' log tails. */
  checks?: CiCheck[];
  /** The readiness read just before the squash, set when it stopped the squash. */
  readiness?: Readiness;
};

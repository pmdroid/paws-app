export const MAX_TOKEN_TTL_MS = 60 * 60 * 1000;
export const TOKEN_TTL_SKEW_MS = 30 * 1000;
export const MAX_SHA_GUARD_CYCLES = 3;

/** Permissions the Quick MVP GitHub App token is allowed to hold. */
export const INSTALLATION_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  checks: "write",
  issues: "write",
  /** Reads GitHub Actions job logs for a failed CI check. */
  actions: "read",
} as const;

export const UPSTREAM_MAIN_REF = "refs/paws/upstream-main";

export type GitHubMethod = "GET" | "POST" | "PUT" | "PATCH";

export type GitHubResponse = {
  status: number;
  body: unknown;
  /** The raw body when it is not JSON, for example a job log. */
  text?: string;
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
  }): Promise<GitHubResponse>;
}

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
  constructor(message: string) {
    super(message);
    this.name = "GitHubTokenError";
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
    | "dirty"
    | "fix_failed"
    | "ci_failed";
  branch: string;
  base?: string;
  head?: string;
  sha?: string;
  summary?: string;
  cycle?: number;
  message?: string;
  failedChecks?: { name: string; url: string | null; logTail?: string | null }[];
  /** Every check on `head` at the last read, with log tails for the failed ones. */
  checks?: CiCheck[];
  ciOutcome?: CiOutcome;
};

/** CI on one head: a failed check, every expected check green, or still waiting. */
export type CiOutcome = "running" | "failed" | "passed";

export type CiCheckState = "passed" | "failed" | "running" | "skipped" | "neutral";

/** One check run or commit status on a pull request head, as the run page shows it. */
export type CiCheck = {
  name: string;
  state: CiCheckState;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** The last lines of the GitHub Actions job log, or the check's summary text. Failed checks only. */
  logTail: string | null;
  logSource: "actions" | "summary" | null;
};

export type ReverifyInput = {
  worktree: string;
  base: string;
  head: string;
  cycle: number;
};

export type ReverifyResult = {
  accepted: boolean;
  outcome: SerialMergeResult["outcome"];
  summary: string;
};

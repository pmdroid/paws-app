import type {
  GitHubApp,
  InstallationToken,
  MergePullRequest,
  MergeResult,
  MintTokenInput,
  OpenPullRequest,
  PullRequestRef,
  PullRequests,
} from "./app";
import type { GitHubResponse } from "./types";

export type FakeGitHub = GitHubApp &
  PullRequests & {
    minted: MintTokenInput[];
    opened: OpenPullRequest[];
    merged: MergePullRequest[];
  };

export type FakeCheckContext = {
  name?: string;
  databaseId?: number | null;
  status?: string | null;
  conclusion?: string | null;
  detailsUrl?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  summary?: string | null;
  checkSuite?: { app: { slug: string } | null } | null;
  context?: string;
  state?: string;
  targetUrl?: string | null;
  description?: string | null;
  createdAt?: string | null;
} | null;

/**
 * Answers `GET /actions/jobs/:id/logs` with the text in `logs` for that job id,
 * or 404. Returns null for other paths.
 */
export function fakeActionsLogs(
  request: { method: string; path: string },
  logs: Record<number, string>,
): GitHubResponse | null {
  const match = /\/actions\/jobs\/(\d+)\/logs$/.exec(request.path);
  if (request.method !== "GET" || !match) return null;
  const log = logs[Number(match[1])];
  return log === undefined
    ? { status: 404, body: '{"message":"Not Found"}' }
    : { status: 200, body: log };
}

function fakeContexts(nodes: FakeCheckContext[]) {
  return {
    nodes,
    pageInfo: { hasNextPage: false, endCursor: null as string | null },
  };
}

/**
 * GraphQL merge readiness body for `head`. The head has one green check run,
 * `ci`; the base branch head has none.
 */
export function fakeMergeReadiness(head: string) {
  return {
    data: {
      repository: {
        object: {
          oid: head,
          statusCheckRollup: {
            state: "SUCCESS",
            contexts: fakeContexts([{ name: "ci", conclusion: "SUCCESS", detailsUrl: null }]),
          },
        },
        pullRequest: {
          headRefOid: head,
          state: "OPEN",
          baseRefName: "main",
          baseRef: {
            target: {
              oid: "f".repeat(40),
              statusCheckRollup: { state: "SUCCESS", contexts: fakeContexts([]) },
            },
          },
          reviewThreads: {
            nodes: [] as { isResolved: boolean }[],
            pageInfo: { hasNextPage: false, endCursor: null as string | null },
          },
        },
      },
    },
  };
}

/**
 * Answers the base branch reads that merge readiness makes for required
 * checks: `GET /branches/:branch` (branch protection) and
 * `GET /rules/branches/:branch` (rulesets). Returns null for other paths.
 */
export function fakeRequiredChecks(
  request: { method: string; path: string },
  required: { protection?: string[]; rulesets?: string[] } = {},
): GitHubResponse | null {
  if (request.method !== "GET") return null;
  if (/\/rules\/branches\/[^?]+/.test(request.path)) {
    const checks = required.rulesets ?? [];
    return {
      status: 200,
      body:
        checks.length === 0 || !request.path.includes("page=1")
          ? []
          : [
              {
                type: "required_status_checks",
                parameters: {
                  required_status_checks: checks.map((context) => ({ context })),
                },
              },
            ],
    };
  }
  if (/\/branches\/[^/?]+$/.test(request.path)) {
    const contexts = required.protection ?? [];
    return {
      status: 200,
      body: {
        name: "main",
        protected: contexts.length > 0,
        protection: {
          enabled: contexts.length > 0,
          required_status_checks: {
            enforcement_level: contexts.length > 0 ? "non_admins" : "off",
            contexts,
            checks: contexts.map((context) => ({ context, app_id: null })),
          },
        },
      },
    };
  }
  return null;
}

export function createFakeGitHub(): FakeGitHub {
  const minted: MintTokenInput[] = [];
  const opened: OpenPullRequest[] = [];
  const merged: MergePullRequest[] = [];
  let nextNumber = 1;
  return {
    minted,
    opened,
    merged,
    async mintInstallationToken(input) {
      minted.push(input);
      const token: InstallationToken = {
        token: "fake-installation-token",
        expiresAt: Date.now() + 60 * 60 * 1000,
        repository: input.repository,
      };
      return token;
    },
    async open(input) {
      opened.push(input);
      const number = nextNumber;
      nextNumber += 1;
      const ref: PullRequestRef = {
        number,
        url: `https://github.com/${input.repository}/pull/${number}`,
      };
      return ref;
    },
    async merge(input) {
      merged.push(input);
      const result: MergeResult = { merged: true, sha: `fake-merge-${input.expectedHeadSha}` };
      return result;
    },
  };
}

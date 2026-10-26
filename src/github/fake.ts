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
  conclusion?: string | null;
  detailsUrl?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  databaseId?: number | null;
  summary?: string | null;
  checkSuite?: { app: { slug: string } | null } | null;
  context?: string;
  state?: string;
  targetUrl?: string | null;
} | null;

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

export type FakeReviewThread = {
  resolved?: boolean;
  outdated?: boolean;
  path?: string | null;
  line?: number | null;
  comments: { author?: string | null; body: string; reviewId?: number | null }[];
};

/**
 * Pull request review threads as GitHub's `reviewThreads` GraphQL connection. `respond` answers
 * the `ReviewThreads` query, and the `ReviewThreadComments` query for the comments past each
 * thread's first page of `commentsPerPage`; it returns null for any other request. `reads` counts
 * the queries.
 */
export function createFakeReviewThreads(
  threads: FakeReviewThread[] = [],
  options: { commentsPerPage?: number } = {},
): {
  threads: FakeReviewThread[];
  reads: number;
  respond(request: { method: string; path: string; body?: unknown }): GitHubResponse | null;
} {
  const perPage = options.commentsPerPage ?? 100;
  const comments = (thread: FakeReviewThread, offset: number) => {
    const page = thread.comments.slice(offset, offset + perPage);
    const next = offset + page.length;
    return {
      pageInfo: {
        hasNextPage: next < thread.comments.length,
        endCursor: next < thread.comments.length ? String(next) : null,
      },
      nodes: page.map((comment) => ({
        body: comment.body,
        author: comment.author ? { login: comment.author } : null,
        pullRequestReview: comment.reviewId == null ? null : { databaseId: comment.reviewId },
      })),
    };
  };
  const fake = {
    threads,
    reads: 0,
    respond(request: { method: string; path: string; body?: unknown }): GitHubResponse | null {
      const body = request.body as
        | { query?: string; variables?: Record<string, unknown> }
        | undefined;
      if (request.method !== "POST" || request.path !== "/graphql") return null;
      if (body?.query?.includes("query ReviewThreadComments")) {
        fake.reads += 1;
        const thread = fake.threads[Number(String(body.variables?.id).replace("RT_", ""))];
        if (!thread) return { status: 200, body: { errors: [{ message: "Could not resolve" }] } };
        return {
          status: 200,
          body: { data: { node: { comments: comments(thread, Number(body.variables?.cursor)) } } },
        };
      }
      if (!body?.query?.includes("query ReviewThreads")) return null;
      fake.reads += 1;
      return {
        status: 200,
        body: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: fake.threads.map((thread, index) => ({
                    id: `RT_${index}`,
                    isResolved: thread.resolved ?? false,
                    isOutdated: thread.outdated ?? false,
                    path: thread.path ?? null,
                    line: thread.line ?? null,
                    comments: comments(thread, 0),
                  })),
                },
              },
            },
          },
        },
      };
    },
  };
  return fake;
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

type FakeQueuedPull = {
  id: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  head: string | null;
  mergeSha: string | null;
  entry: { position: number; state: string } | null;
  lastEvent: { type: "added" } | { type: "removed"; reason: string; actor: string | null } | null;
};

export type FakeMergeQueue = {
  /** Base branches that have a merge queue. */
  branches: Set<string>;
  /** Every `enqueuePullRequest` call. */
  enqueued: { pullRequestId: string; head: string }[];
  /** Each merge queue GraphQL read and write (`exists`, `entry`, `enqueue`, `dequeue`), in order. */
  calls: string[];
  /** Answer a merge queue GraphQL request, or null for any other request. */
  respond(request: {
    method: string;
    path: string;
    body?: unknown;
  }): Promise<GitHubResponse | null>;
  /** GitHub merged the queued pull request. */
  merge(number: number, sha?: string): void;
  /** GitHub, or a person when `actor` is a login, removed the pull request from the queue. */
  remove(number: number, reason: string, actor?: string | null): void;
  /** Move a queued pull request to a position and entry state. */
  move(number: number, position: number, state?: string): void;
  isQueued(number: number): boolean;
};

/**
 * GitHub's merge queue for one repository: `repository.mergeQueue(branch:)`, the pull request's
 * `mergeQueueEntry` and last queue event, and `enqueuePullRequest`. `headOf` gives the pull
 * request head GitHub would report.
 */
export function createFakeMergeQueue(
  options: {
    branches?: string[];
    headOf?: (number: number) => string | Promise<string>;
    /** Pull requests ahead of an enqueued one. */
    ahead?: number;
  } = {},
): FakeMergeQueue {
  const pulls = new Map<number, FakeQueuedPull>();
  const enqueued: FakeMergeQueue["enqueued"] = [];
  const calls: string[] = [];
  const branches = new Set(options.branches ?? ["main"]);
  const pull = (number: number): FakeQueuedPull => {
    let found = pulls.get(number);
    if (!found) {
      found = {
        id: `PR_${number}`,
        state: "OPEN",
        head: null,
        mergeSha: null,
        entry: null,
        lastEvent: null,
      };
      pulls.set(number, found);
    }
    return found;
  };
  const byId = (id: string) => [...pulls.entries()].find(([, value]) => value.id === id);
  return {
    branches,
    enqueued,
    calls,
    async respond(request) {
      if (request.method !== "POST" || request.path !== "/graphql") return null;
      const body = request.body as { query?: string; variables?: Record<string, unknown> };
      const query = body?.query ?? "";
      const variables = body?.variables ?? {};
      if (query.includes("query MergeQueueExists")) {
        calls.push("exists");
        const branch = String(variables.branch ?? "");
        return {
          status: 200,
          body: {
            data: {
              repository: { mergeQueue: branches.has(branch) ? { id: `MQ_${branch}` } : null },
            },
          },
        };
      }
      if (query.includes("query MergeQueueEntry")) {
        calls.push("entry");
        const number = Number(variables.number);
        const value = pull(number);
        if (options.headOf) value.head = await options.headOf(number);
        const last = value.lastEvent;
        return {
          status: 200,
          body: {
            data: {
              repository: {
                pullRequest: {
                  id: value.id,
                  state: value.state,
                  headRefOid: value.head ?? "0".repeat(40),
                  baseRefName: "main",
                  mergeCommit: value.mergeSha ? { oid: value.mergeSha } : null,
                  mergeQueueEntry: value.entry,
                  timelineItems: {
                    nodes:
                      last === null
                        ? []
                        : last.type === "added"
                          ? [{ kind: "AddedToMergeQueueEvent" }]
                          : [
                              {
                                kind: "RemovedFromMergeQueueEvent",
                                reason: last.reason,
                                actor: last.actor
                                  ? { login: last.actor }
                                  : { login: "github-merge-queue" },
                              },
                            ],
                  },
                },
              },
            },
          },
        };
      }
      if (query.includes("mutation DequeuePullRequest")) {
        calls.push("dequeue");
        const found = byId(String(variables.id));
        if (!found?.[1].entry)
          return { status: 200, body: { errors: [{ message: "Not in the merge queue" }] } };
        found[1].entry = null;
        found[1].lastEvent = { type: "removed", reason: "", actor: "paws" };
        return { status: 200, body: { data: { dequeuePullRequest: { clientMutationId: null } } } };
      }
      if (query.includes("mutation EnqueuePullRequest")) {
        calls.push("enqueue");
        const id = String(variables.id);
        const head = String(variables.head);
        enqueued.push({ pullRequestId: id, head });
        const found = byId(id);
        if (!found) return { status: 200, body: { errors: [{ message: "Could not resolve" }] } };
        const [, value] = found;
        if (value.head !== null && value.head !== head)
          return { status: 200, body: { errors: [{ message: "Head ref is out of date" }] } };
        value.entry = { position: (options.ahead ?? 0) + 1, state: "QUEUED" };
        value.lastEvent = { type: "added" };
        return {
          status: 200,
          body: { data: { enqueuePullRequest: { mergeQueueEntry: value.entry } } },
        };
      }
      return null;
    },
    merge(number, sha = `queue-merge-${number}`) {
      const value = pull(number);
      value.state = "MERGED";
      value.mergeSha = sha;
      value.entry = null;
    },
    remove(number, reason, actor = null) {
      const value = pull(number);
      value.entry = null;
      value.lastEvent = { type: "removed", reason, actor };
    },
    move(number, position, state = "AWAITING_CHECKS") {
      const value = pull(number);
      value.entry = { position, state };
    },
    isQueued(number) {
      return pulls.get(number)?.entry != null;
    },
  };
}

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
          pushedAt: null as string | null,
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
  comments: {
    author?: string | null;
    body: string;
    reviewId?: number | null;
    url?: string;
    databaseId?: number;
  }[];
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
        ...(comment.url ? { url: comment.url } : {}),
        ...(comment.databaseId === undefined ? {} : { databaseId: comment.databaseId }),
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

export type FakeCheckRun = {
  name: string;
  app: string | null;
  status: "queued" | "in_progress" | "completed";
};

export function createFakeCheckRuns(runs: Record<string, FakeCheckRun[]> = {}): {
  runs: Record<string, FakeCheckRun[]>;
  pushedAt: Record<string, number>;
  failing: boolean;
  reads: number;
  respond(request: { method: string; path: string }): GitHubResponse | null;
} {
  const fake = {
    runs,
    pushedAt: {} as Record<string, number>,
    failing: false,
    reads: 0,
    respond(request: { method: string; path: string }): GitHubResponse | null {
      const match = /\/commits\/([^/]+)\/(check-runs|check-suites)/.exec(request.path);
      if (request.method !== "GET" || !match) return null;
      if (fake.failing) return { status: 502, body: null };
      const head = match[1]!;
      if (match[2] === "check-suites") {
        const pushed = fake.pushedAt[head];
        return {
          status: 200,
          body: {
            check_suites:
              pushed === undefined ? [] : [{ created_at: new Date(pushed).toISOString() }],
          },
        };
      }
      fake.reads += 1;
      const list = fake.runs[head] ?? [];
      return {
        status: 200,
        body: {
          total_count: list.length,
          check_runs: list.map((run) => ({
            name: run.name,
            status: run.status,
            app: run.app === null ? null : { slug: run.app },
          })),
        },
      };
    },
  };
  return fake;
}

export type FakeGitData = {
  tip: string | null;
  trees: Map<string, string[]>;
  commits: Map<string, { tree: string; parents: string[]; message: string }>;
  blobs: string[];
  refWrites: { method: string; body: unknown }[];
  rejectRefWrites: number;
  failPath: string | null;
  respond(request: { method: string; path: string; body?: unknown }): GitHubResponse | null;
};

export function createFakeGitData(options: { files?: string[] } = {}): FakeGitData {
  let next = 0;
  const sha = (kind: string) => `${kind}${String(++next).padStart(40 - kind.length, "0")}`;
  const data: FakeGitData = {
    tip: null,
    trees: new Map(),
    commits: new Map(),
    blobs: [],
    refWrites: [],
    rejectRefWrites: 0,
    failPath: null,
    respond(request) {
      const match = /^\/repos\/[^/]+\/[^/]+\/git\/(.+)$/.exec(request.path);
      if (!match) return null;
      const path = match[1]!;
      if (data.failPath !== null && path.startsWith(data.failPath))
        return { status: 500, body: { message: "synthetic failure" } };
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (request.method === "GET" && path === "ref/paws/evidence")
        return data.tip === null
          ? { status: 404, body: { message: "Not Found" } }
          : { status: 200, body: { ref: "refs/paws/evidence", object: { sha: data.tip } } };
      const commit = /^commits\/(\w+)$/.exec(path);
      if (request.method === "GET" && commit) {
        const found = data.commits.get(commit[1]!);
        return found ? { status: 200, body: { sha: commit[1], tree: { sha: found.tree } } } : null;
      }
      const tree = /^trees\/(\w+)$/.exec(path);
      if (request.method === "GET" && tree) {
        const paths = data.trees.get(tree[1]!) ?? [];
        return { status: 200, body: { tree: paths.map((p) => ({ path: p, type: "blob" })) } };
      }
      if (request.method === "POST" && path === "blobs") {
        data.blobs.push(String(body.content));
        return { status: 201, body: { sha: sha("b") } };
      }
      if (request.method === "POST" && path === "trees") {
        const base =
          typeof body.base_tree === "string" ? (data.trees.get(body.base_tree) ?? []) : [];
        const added = (body.tree as { path: string }[]).map((entry) => entry.path);
        const id = sha("t");
        data.trees.set(id, [...new Set([...base, ...added])]);
        return { status: 201, body: { sha: id } };
      }
      if (request.method === "POST" && path === "commits") {
        const id = sha("c");
        data.commits.set(id, {
          tree: String(body.tree),
          parents: body.parents as string[],
          message: String(body.message),
        });
        return { status: 201, body: { sha: id } };
      }
      if (
        (request.method === "POST" && path === "refs") ||
        (request.method === "PATCH" && path === "refs/paws/evidence")
      ) {
        data.refWrites.push({ method: request.method, body: request.body });
        if (data.rejectRefWrites > 0) {
          data.rejectRefWrites--;
          const moved = sha("c");
          const tip = data.tip === null ? null : data.commits.get(data.tip)!;
          const treeId = sha("t");
          data.trees.set(treeId, tip ? [...data.trees.get(tip.tree)!] : []);
          data.commits.set(moved, {
            tree: treeId,
            parents: data.tip === null ? [] : [data.tip],
            message: "another publication",
          });
          data.tip = moved;
          return { status: 422, body: { message: "Update is not a fast forward" } };
        }
        data.tip = String(body.sha);
        return {
          status: request.method === "POST" ? 201 : 200,
          body: { object: { sha: body.sha } },
        };
      }
      return null;
    },
  };
  if (options.files) {
    const treeId = sha("t");
    const commitId = sha("c");
    data.trees.set(treeId, options.files);
    data.commits.set(commitId, { tree: treeId, parents: [], message: "existing" });
    data.tip = commitId;
  }
  return data;
}

import { createHash } from "node:crypto";

export type FakeIssue = {
  number: number;
  title: string;
  body?: string | null;
  user?: { login: string; id: number } | null;
  authorAssociation?: string;
  labels?: readonly string[];
  updatedAt?: string;
  pullRequest?: boolean;
  owner?: string;
  repo?: string;
};

export type FakeComment = {
  id: number;
  issueNumber: number;
  body: string;
  user?: { login: string; id: number } | null;
  authorAssociation?: string;
  updatedAt?: string;
  pullRequest?: boolean;
};

export type FakeObservedRequest = {
  method: string;
  path: string;
  search: string;
  ifNoneMatch: string | null;
  authorization: string | null;
  status: number;
};

export type PostedComment = {
  owner: string;
  repo: string;
  number: number;
  body: string;
};

type Failure = {
  status: number;
  retryAfter?: string;
  remaining?: string;
  reset?: string;
};

export type FakeGitHubRest = {
  origin: string;
  requests: FakeObservedRequest[];
  commentsPosted: PostedComment[];
  addIssue(owner: string, repo: string, issue: FakeIssue): void;
  addComment(owner: string, repo: string, comment: FakeComment): void;
  setSubIssues(owner: string, repo: string, number: number, issues: readonly FakeIssue[]): void;
  setBlockedBy(owner: string, repo: string, number: number, issues: readonly FakeIssue[]): void;
  failNext(failure: Failure): void;
  setRate(remaining: number, resetMs: number): void;
  stop(): Promise<void>;
};

/**
 * In-memory GitHub REST. Conditional requests 304 when `If-None-Match` equals
 * the ETag of the current body, and the 304 body is poison so a client that
 * parses it would schedule work.
 */
export function startFakeGitHubRest(): FakeGitHubRest {
  const issues = new Map<string, FakeIssue[]>();
  const comments = new Map<string, FakeComment[]>();
  const subIssues = new Map<string, FakeIssue[]>();
  const blockedBy = new Map<string, FakeIssue[]>();
  const failures: Failure[] = [];
  const requests: FakeObservedRequest[] = [];
  const commentsPosted: PostedComment[] = [];
  let remaining = 5_000;
  let resetMs = Date.now() + 3_600_000;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const authorization = request.headers.get("authorization");
      const ifNoneMatch = request.headers.get("if-none-match");
      const finish = (
        status: number,
        body: string,
        extra: Record<string, string> = {},
      ): Response => {
        requests.push({
          method: request.method,
          path: url.pathname,
          search: url.search,
          ifNoneMatch,
          authorization,
          status,
        });
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "x-ratelimit-remaining": String(remaining),
          "x-ratelimit-reset": String(Math.floor(resetMs / 1000)),
          ...extra,
        };
        return new Response(body, { status, headers });
      };

      if (authorization === null || !authorization.startsWith("Bearer ")) {
        return finish(401, JSON.stringify({ message: "Requires authentication" }));
      }
      const failure = failures.shift();
      if (failure !== undefined) {
        const headers: Record<string, string> = {};
        if (failure.retryAfter !== undefined) headers["retry-after"] = failure.retryAfter;
        if (failure.remaining !== undefined) headers["x-ratelimit-remaining"] = failure.remaining;
        if (failure.reset !== undefined) headers["x-ratelimit-reset"] = failure.reset;
        return finish(failure.status, JSON.stringify({ message: "rate limit exceeded" }), headers);
      }

      const posted = await routePost(request, url);
      if (posted !== null) {
        commentsPosted.push(posted.record);
        return finish(201, JSON.stringify({ id: commentsPosted.length, body: posted.record.body }));
      }

      const payload = routeGet(url);
      if (payload === null) return finish(404, JSON.stringify({ message: "Not Found" }));
      const body = JSON.stringify(payload);
      const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
      if (ifNoneMatch === etag) return finish(304, poison(url.pathname), { etag });
      return finish(200, body, { etag });
    },
  });

  function routePost(
    request: Request,
    url: URL,
  ): Promise<{ record: PostedComment } | null> | { record: PostedComment } | null {
    const match = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(url.pathname);
    if (match === null || request.method !== "POST") return null;
    const owner = decode(match[1] ?? "");
    const repo = decode(match[2] ?? "");
    const number = Number(match[3]);
    return request.json().then((parsed: unknown) => {
      const body =
        parsed !== null &&
        typeof parsed === "object" &&
        "body" in parsed &&
        typeof parsed.body === "string"
          ? parsed.body
          : "";
      return { record: { owner, repo, number, body } };
    });
  }

  function routeGet(url: URL): unknown {
    const sub = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/sub_issues$/.exec(url.pathname);
    if (sub !== null) {
      const key = issueKey(sub[1], sub[2], sub[3]);
      return (subIssues.get(key) ?? []).map((issue) =>
        serializeIssue(issue, decode(sub[1] ?? ""), decode(sub[2] ?? "")),
      );
    }
    const blocked = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/dependencies\/blocked_by$/.exec(
      url.pathname,
    );
    if (blocked !== null) {
      const key = issueKey(blocked[1], blocked[2], blocked[3]);
      return (blockedBy.get(key) ?? []).map((issue) =>
        serializeIssue(issue, decode(blocked[1] ?? ""), decode(blocked[2] ?? "")),
      );
    }
    const commentsPath = /^\/repos\/([^/]+)\/([^/]+)\/issues\/comments$/.exec(url.pathname);
    if (commentsPath !== null) {
      const owner = decode(commentsPath[1] ?? "");
      const repo = decode(commentsPath[2] ?? "");
      return filterSince(comments.get(`${owner}/${repo}`) ?? [], url).map((comment) =>
        serializeComment(comment, owner, repo),
      );
    }
    const one = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(url.pathname);
    if (one !== null) {
      const owner = decode(one[1] ?? "");
      const repo = decode(one[2] ?? "");
      const number = Number(one[3]);
      const found = (issues.get(`${owner}/${repo}`) ?? []).find((issue) => issue.number === number);
      if (found === undefined) return null;
      return serializeIssue(found, owner, repo);
    }
    const list = /^\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(url.pathname);
    if (list !== null) {
      const owner = decode(list[1] ?? "");
      const repo = decode(list[2] ?? "");
      return filterSince(issues.get(`${owner}/${repo}`) ?? [], url).map((issue) =>
        serializeIssue(issue, owner, repo),
      );
    }
    return null;
  }

  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    commentsPosted,
    addIssue(owner, repo, issue) {
      const key = `${owner}/${repo}`;
      const list = issues.get(key) ?? [];
      const index = list.findIndex((item) => item.number === issue.number);
      if (index >= 0) list[index] = issue;
      else list.push(issue);
      issues.set(key, list);
    },
    addComment(owner, repo, comment) {
      const key = `${owner}/${repo}`;
      const list = comments.get(key) ?? [];
      list.push(comment);
      comments.set(key, list);
    },
    setSubIssues(owner, repo, number, list) {
      subIssues.set(`${owner}/${repo}#${number}`, [...list]);
    },
    setBlockedBy(owner, repo, number, list) {
      blockedBy.set(`${owner}/${repo}#${number}`, [...list]);
    },
    failNext(failure) {
      failures.push(failure);
    },
    setRate(nextRemaining, nextResetMs) {
      remaining = nextRemaining;
      resetMs = nextResetMs;
    },
    stop() {
      return server.stop(true);
    },
  };
}

function issueKey(
  owner: string | undefined,
  repo: string | undefined,
  number: string | undefined,
): string {
  return `${decode(owner ?? "")}/${decode(repo ?? "")}#${number ?? ""}`;
}

function filterSince<T extends { updatedAt?: string }>(items: readonly T[], url: URL): T[] {
  const since = url.searchParams.get("since");
  if (since === null) return [...items];
  const sinceMs = Date.parse(since);
  if (Number.isNaN(sinceMs)) return [...items];
  return items.filter((item) => {
    const updated = item.updatedAt === undefined ? 0 : Date.parse(item.updatedAt);
    return !Number.isNaN(updated) && updated >= sinceMs;
  });
}

function serializeIssue(issue: FakeIssue, owner: string, repo: string): Record<string, unknown> {
  const issueOwner = issue.owner ?? owner;
  const issueRepo = issue.repo ?? repo;
  const pull = issue.pullRequest === true;
  const body: Record<string, unknown> = {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    state: "open",
    user: issue.user === undefined ? { login: "octocat", id: 1 } : issue.user,
    author_association: issue.authorAssociation ?? "OWNER",
    labels: (issue.labels ?? []).map((name) => ({ name })),
    updated_at: issue.updatedAt ?? new Date(0).toISOString(),
    html_url: pull
      ? `https://github.com/${issueOwner}/${issueRepo}/pull/${issue.number}`
      : `https://github.com/${issueOwner}/${issueRepo}/issues/${issue.number}`,
    repository_url: `https://api.github.com/repos/${issueOwner}/${issueRepo}`,
    repository: {
      name: issueRepo,
      full_name: `${issueOwner}/${issueRepo}`,
      owner: { login: issueOwner },
    },
  };
  if (pull) {
    body["pull_request"] = {
      url: `https://api.github.com/repos/${issueOwner}/${issueRepo}/pulls/${issue.number}`,
    };
  }
  return body;
}

function serializeComment(
  comment: FakeComment,
  owner: string,
  repo: string,
): Record<string, unknown> {
  const pull = comment.pullRequest === true;
  const html = pull
    ? `https://github.com/${owner}/${repo}/pull/${comment.issueNumber}#issuecomment-${comment.id}`
    : `https://github.com/${owner}/${repo}/issues/${comment.issueNumber}#issuecomment-${comment.id}`;
  return {
    id: comment.id,
    body: comment.body,
    user: comment.user === undefined ? { login: "octocat", id: 1 } : comment.user,
    author_association: comment.authorAssociation ?? "OWNER",
    created_at: comment.updatedAt ?? new Date(0).toISOString(),
    updated_at: comment.updatedAt ?? new Date(0).toISOString(),
    issue_url: `https://api.github.com/repos/${owner}/${repo}/issues/${comment.issueNumber}`,
    html_url: html,
  };
}

function poison(pathname: string): string {
  if (pathname.endsWith("/comments")) {
    return JSON.stringify([
      {
        id: 99_999,
        body: "@paws",
        user: { login: "octocat", id: 1 },
        author_association: "OWNER",
        updated_at: "2020-01-01T00:00:00Z",
        issue_url: "https://api.github.com/repos/acme/widgets/issues/1",
        html_url: "https://github.com/acme/widgets/issues/1#issuecomment-99999",
      },
    ]);
  }
  if (pathname.endsWith("/issues")) {
    return JSON.stringify([
      {
        number: 99_999,
        title: "poison",
        body: "@paws",
        user: { login: "octocat", id: 1 },
        author_association: "OWNER",
        labels: [{ name: "paws" }],
        updated_at: "2020-01-01T00:00:00Z",
        html_url: "https://github.com/acme/widgets/issues/99999",
      },
    ]);
  }
  return "[]";
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

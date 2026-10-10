import { systemClock, type Clock } from "../core";
import type { GitHubCommentMethod, GitHubCommentRequest, GitHubCommentResponse } from "./board";

export type FakeGitHubComment = {
  id: number;
  issueNumber: number;
  body: string;
  login: string;
  association: string;
  createdAtMs: number;
};

export type FakeGitHubCommentPost = {
  issueNumber: number;
  body: string;
  login: string;
  association?: string;
  createdAtMs?: number;
};

export type FakeGitHubCall = {
  method: GitHubCommentMethod;
  path: string;
  body?: unknown;
};

export type FakeGitHubComments = {
  request: GitHubCommentRequest;
  comments: FakeGitHubComment[];
  calls: FakeGitHubCall[];
  /** A comment the authenticated user did not write. */
  post(input: FakeGitHubCommentPost): FakeGitHubComment;
  labelsOn(issueNumber: number): readonly string[];
  readonly commentCreates: number;
  readonly commentUpdates: number;
};

/**
 * In-memory GitHub issue-comment API. `pageSize` caps each list page and
 * emits a `Link` header so the board's pagination can be exercised.
 */
export function createFakeGitHubComments(options?: {
  clock?: Clock;
  /** Login stamped on comments Paws creates through `request`. */
  selfLogin?: string;
  pageSize?: number;
}): FakeGitHubComments {
  const clock = options?.clock ?? systemClock;
  const selfLogin = options?.selfLogin ?? "paws";
  const comments: FakeGitHubComment[] = [];
  const calls: FakeGitHubCall[] = [];
  const labels = new Map<number, string[]>();
  const counts = { creates: 0, updates: 0 };
  let nextId = 1;

  function insert(input: {
    issueNumber: number;
    body: string;
    login: string;
    association: string;
    createdAtMs: number;
  }): FakeGitHubComment {
    const comment: FakeGitHubComment = {
      id: nextId,
      issueNumber: input.issueNumber,
      body: input.body,
      login: input.login,
      association: input.association,
      createdAtMs: input.createdAtMs,
    };
    nextId += 1;
    comments.push(comment);
    return comment;
  }

  function toJson(comment: FakeGitHubComment): Record<string, unknown> {
    return {
      id: comment.id,
      body: comment.body,
      user: { login: comment.login, id: comment.id },
      created_at: new Date(comment.createdAtMs).toISOString(),
      updated_at: new Date(comment.createdAtMs).toISOString(),
      author_association: comment.association,
    };
  }

  function issueComments(issueNumber: number): FakeGitHubComment[] {
    return comments
      .filter((comment) => comment.issueNumber === issueNumber)
      .sort((left, right) => left.createdAtMs - right.createdAtMs || left.id - right.id);
  }

  const request: GitHubCommentRequest = async (input) => {
    calls.push(
      input.body === undefined
        ? { method: input.method, path: input.path }
        : { method: input.method, path: input.path, body: input.body },
    );
    const url = new URL(input.path, "https://api.github.com");
    const parts = url.pathname.split("/").filter((part) => part.length > 0);
    const decoded = parts.map((part) => decodeURIComponent(part));
    return handle({
      method: input.method,
      parts: decoded,
      search: url.searchParams,
      body: input.body,
    });
  };

  function handle(input: {
    method: GitHubCommentMethod;
    parts: string[];
    search: URLSearchParams;
    body: unknown;
  }): GitHubCommentResponse {
    const [, owner, repo, kind] = input.parts;
    if (owner === undefined || repo === undefined || (kind !== "issues" && kind !== "labels")) {
      return { status: 404, body: { message: "not found" } };
    }
    if (kind === "labels" && input.method === "POST") {
      return { status: 201, body: { name: readName(input.body) } };
    }
    const issuePart = input.parts[4];
    if (input.parts[3] !== "issues" || issuePart === undefined) {
      return { status: 404, body: { message: "not found" } };
    }
    if (issuePart === "comments" && input.method === "PATCH") {
      const id = Number(input.parts[5]);
      const found = comments.find((comment) => comment.id === id);
      if (found === undefined) return { status: 404, body: { message: "not found" } };
      const body = readBody(input.body);
      if (body === null) return { status: 422, body: { message: "body is required" } };
      found.body = body;
      counts.updates += 1;
      return { status: 200, body: toJson(found), link: null };
    }
    const issueNumber = Number(issuePart);
    if (!Number.isInteger(issueNumber) || issueNumber < 1) {
      return { status: 404, body: { message: "not found" } };
    }
    const tail = input.parts[5];
    if (tail === "comments" && input.method === "POST") {
      const body = readBody(input.body);
      if (body === null) return { status: 422, body: { message: "body is required" } };
      counts.creates += 1;
      const created = insert({
        issueNumber,
        body,
        login: selfLogin,
        association: "OWNER",
        createdAtMs: clock.now(),
      });
      return { status: 201, body: toJson(created), link: null };
    }
    if (tail === "comments" && input.method === "GET") {
      const all = issueComments(issueNumber);
      const page = positive(input.search.get("page"), 1);
      const requested = positive(input.search.get("per_page"), 100);
      const perPage = Math.min(requested, options?.pageSize ?? requested);
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const more = start + perPage < all.length;
      const link = more
        ? `<https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${perPage}&page=${page + 1}>; rel="next"`
        : null;
      return { status: 200, body: slice.map(toJson), link };
    }
    if (tail === "labels" && input.method === "POST") {
      const names = readLabels(input.body);
      const current = labels.get(issueNumber) ?? [];
      for (const name of names) {
        if (!current.includes(name)) current.push(name);
      }
      labels.set(issueNumber, current);
      return { status: 200, body: current.map((name) => ({ name })), link: null };
    }
    if (tail === "labels" && input.method === "DELETE") {
      const name = input.parts[6];
      if (name === undefined) return { status: 404, body: { message: "not found" } };
      const current = labels.get(issueNumber) ?? [];
      if (!current.includes(name))
        return { status: 404, body: { message: "not found" }, link: null };
      labels.set(
        issueNumber,
        current.filter((label) => label !== name),
      );
      return { status: 200, body: {}, link: null };
    }
    return { status: 404, body: { message: "not found" } };
  }

  return {
    request,
    comments,
    calls,
    post(input) {
      return insert({
        issueNumber: input.issueNumber,
        body: input.body,
        login: input.login,
        association: input.association ?? "NONE",
        createdAtMs: input.createdAtMs ?? clock.now(),
      });
    },
    labelsOn(issueNumber) {
      return [...(labels.get(issueNumber) ?? [])];
    },
    get commentCreates() {
      return counts.creates;
    },
    get commentUpdates() {
      return counts.updates;
    },
  };
}

function positive(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

function readBody(value: unknown): string | null {
  if (!isRecord(value) || typeof value["body"] !== "string") return null;
  return value["body"];
}

function readName(value: unknown): string | null {
  if (!isRecord(value) || typeof value["name"] !== "string") return null;
  return value["name"];
}

function readLabels(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value["labels"])) return [];
  return value["labels"].filter((label): label is string => typeof label === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

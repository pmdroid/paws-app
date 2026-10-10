import type { CommentBoard, CommentWrite, IssueComment } from "../comments";
import { repoPath, resolveGitHubIssue, type GitHubIssueRef } from "./issue";

export type GitHubCommentMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type GitHubCommentResponse = {
  status: number;
  body: unknown;
  /** Raw `Link` header. Pagination follows `rel="next"` until it is absent. */
  link?: string | null;
};

/** Authenticated GitHub REST call. The board does not see the token. */
export type GitHubCommentRequest = (input: {
  method: GitHubCommentMethod;
  path: string;
  body?: unknown;
}) => Promise<GitHubCommentResponse>;

export type GitHubCommentBoardOptions = {
  request: GitHubCommentRequest;
  owner: string;
  repo: string;
};

export type GitHubIssueComment = IssueComment & {
  authorLogin: string | null;
  authorAssociation: string | null;
};

const LIST_PAGE_CAP = 50;

/**
 * Issue comments for one repository.
 * Create is `POST /repos/{owner}/{repo}/issues/{n}/comments`.
 * Edit is `PATCH /repos/{owner}/{repo}/issues/comments/{id}`.
 * List follows GitHub's `Link` header.
 */
export function createGitHubCommentBoard(options: GitHubCommentBoardOptions): CommentBoard {
  const fallback = { owner: options.owner, repo: options.repo };
  const located = new Map<string, GitHubIssueRef>();

  function locate(issueId: string): GitHubIssueRef {
    return resolveGitHubIssue(issueId, fallback);
  }

  function remember(comment: GitHubIssueComment, target: GitHubIssueRef): GitHubIssueComment {
    located.set(comment.id, target);
    return comment;
  }

  return {
    async create(input: CommentWrite) {
      const target = locate(input.issueId);
      const response = await options.request({
        method: "POST",
        path: repoPath(target.owner, target.repo, `/issues/${target.number}/comments`),
        body: { body: input.body },
      });
      if (response.status !== 201 && response.status !== 200) {
        throw new Error(`creating a GitHub comment failed with status ${response.status}`);
      }
      const comment = readComment(response.body, input.issueId, 0);
      if (comment === null) throw new Error("GitHub comment create returned no comment");
      return remember(comment, target);
    },
    async update(input) {
      const target = located.get(input.id) ?? repoRef(fallback);
      const response = await options.request({
        method: "PATCH",
        path: repoPath(
          target.owner,
          target.repo,
          `/issues/comments/${encodeURIComponent(input.id)}`,
        ),
        body: { body: input.body },
      });
      if (response.status !== 200) {
        throw new Error(`updating a GitHub comment failed with status ${response.status}`);
      }
      const comment = readComment(response.body, "", 0);
      if (comment === null) throw new Error("GitHub comment update returned no comment");
      comment.body = input.body;
      return remember(comment, target);
    },
    async list(issueId) {
      const target = locate(issueId);
      const found: GitHubIssueComment[] = [];
      const seenIds = new Set<string>();
      const seenPaths = new Set<string>();
      let path: string | null =
        `${repoPath(target.owner, target.repo, `/issues/${target.number}/comments`)}?per_page=100`;
      for (let page = 0; page < LIST_PAGE_CAP && path !== null; page++) {
        if (seenPaths.has(path)) break;
        seenPaths.add(path);
        const response = await options.request({ method: "GET", path });
        if (response.status !== 200) {
          throw new Error(`listing GitHub comments failed with status ${response.status}`);
        }
        if (!Array.isArray(response.body)) throw new Error("GitHub comment list was not an array");
        for (const node of response.body) {
          const comment = readComment(node, issueId, found.length + 1);
          if (comment === null || seenIds.has(comment.id)) continue;
          seenIds.add(comment.id);
          found.push(remember(comment, target));
        }
        path = nextLink(response.link);
      }
      found.sort(compareComments);
      for (let index = 0; index < found.length; index++) {
        const comment = found[index];
        if (comment !== undefined) comment.seq = index + 1;
      }
      return found;
    },
  };
}

function repoRef(fallback: { owner: string; repo: string }): GitHubIssueRef {
  return resolveGitHubIssue(`github:${fallback.owner}/${fallback.repo}#1`, fallback);
}

function nextLink(link: string | null | undefined): string | null {
  if (link === undefined || link === null || link.length === 0) return null;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    const href = match?.[1];
    if (href === undefined) continue;
    if (href.startsWith("https://") || href.startsWith("http://")) {
      const url = new URL(href);
      return `${url.pathname}${url.search}`;
    }
    return href;
  }
  return null;
}

function readComment(value: unknown, issueId: string, seq: number): GitHubIssueComment | null {
  if (!isRecord(value)) return null;
  const id = readId(value["id"]);
  if (id === null) return null;
  const user = isRecord(value["user"]) ? value["user"] : null;
  const login = user === null ? null : readString(user, "login");
  const createdAt = readString(value, "created_at");
  const createdAtMs = createdAt === null ? 0 : Date.parse(createdAt);
  return {
    id,
    issueId,
    parentId: null,
    body: typeof value["body"] === "string" ? value["body"] : "",
    userId: login,
    botId: null,
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
    seq,
    authorLogin: login,
    authorAssociation: readString(value, "author_association"),
  };
}

function readId(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  return null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function compareComments(left: IssueComment, right: IssueComment): number {
  if (left.createdAtMs !== right.createdAtMs) return left.createdAtMs - right.createdAtMs;
  if (left.seq !== right.seq) return left.seq - right.seq;
  return left.id.localeCompare(right.id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

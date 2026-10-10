import type { GitHubTokenProvider } from "../auth";
import type {
  GitHubComment,
  GitHubIssue,
  GitHubList,
  GitHubRateSnapshot,
  GitHubRepoRef,
  GitHubTrackerConfig,
} from "./types";
import { githubTrackerConfig } from "./types";

export type { GitHubTokenProvider };

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const API_VERSION = "2022-11-28";
const MAX_PAGES = 20;

export class GitHubRateLimitError extends Error {
  readonly retryAfterMs: number;
  readonly remaining: number | null;
  readonly resetMs: number | null;

  constructor(retryAfterMs: number, rate: GitHubRateSnapshot) {
    super("GitHub rate limit");
    this.name = "GitHubRateLimitError";
    this.retryAfterMs = Math.max(0, retryAfterMs);
    this.remaining = rate.remaining;
    this.resetMs = rate.resetMs;
  }
}

export class GitHubRequestError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string) {
    super(`GitHub ${status} ${path}`);
    this.name = "GitHubRequestError";
    this.status = status;
    this.path = path;
  }
}

export type GitHubIssuesClient = {
  readonly config: GitHubTrackerConfig;
  user(): Promise<{ login: string; id: number }>;
  listOpenIssues(
    repo: GitHubRepoRef,
    sinceIso: string,
    etag: string | null,
  ): Promise<GitHubList<GitHubIssue>>;
  listIssueComments(
    repo: GitHubRepoRef,
    sinceIso: string,
    etag: string | null,
  ): Promise<GitHubList<GitHubComment>>;
  getIssue(repo: GitHubRepoRef, number: number): Promise<GitHubIssue>;
  listSubIssues(repo: GitHubRepoRef, number: number): Promise<readonly GitHubIssue[]>;
  listBlockedBy(repo: GitHubRepoRef, number: number): Promise<readonly GitHubIssue[]>;
  postComment(repo: GitHubRepoRef, number: number, body: string): Promise<void>;
};

type RawPage = {
  url: string;
  status: number;
  etag: string | null;
  rate: GitHubRateSnapshot;
  body: unknown;
  next: string | null;
};

export function createGitHubIssuesClient(options: {
  provider: GitHubTokenProvider;
  config?: GitHubTrackerConfig;
  fetch?: FetchLike;
  baseUrl?: string;
}): GitHubIssuesClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const config = options.config ?? githubTrackerConfig();
  let cachedUser: { login: string; id: number } | null = null;

  async function user(): Promise<{ login: string; id: number }> {
    if (cachedUser !== null) return cachedUser;
    cachedUser = await options.provider.user();
    return cachedUser;
  }

  function issueUrl(repo: GitHubRepoRef, suffix: string): string {
    return `${baseUrl}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}${suffix}`;
  }

  async function send(
    url: string,
    etag: string | null,
    method: "GET" | "POST",
    jsonBody?: unknown,
  ): Promise<RawPage> {
    const token = await options.provider.token();
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "paws",
      "X-GitHub-Api-Version": API_VERSION,
    };
    if (etag !== null && etag.length > 0) headers["If-None-Match"] = etag;
    if (jsonBody !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetchImpl(url, {
      method,
      headers,
      body: jsonBody === undefined ? undefined : JSON.stringify(jsonBody),
    });
    const rate = rateFrom(response.headers);
    const path = safePath(url);
    if (response.status === 304) {
      await response.arrayBuffer().catch(() => undefined);
      return {
        url,
        status: 304,
        etag: response.headers.get("etag") ?? etag,
        rate,
        body: null,
        next: null,
      };
    }
    if (response.status === 403 || response.status === 429) {
      const retryAfterMs = retryAfter(response.headers);
      const limited = response.status === 429 || retryAfterMs !== null || rate.remaining === 0;
      if (limited) {
        await response.arrayBuffer().catch(() => undefined);
        const wait =
          retryAfterMs ?? (rate.resetMs === null ? 15_000 : Math.max(0, rate.resetMs - Date.now()));
        throw new GitHubRateLimitError(wait, rate);
      }
    }
    const text = await response.text();
    let body: unknown = null;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (response.status < 200 || response.status >= 300) {
      throw new GitHubRequestError(response.status, path);
    }
    return {
      url,
      status: response.status,
      etag: response.headers.get("etag"),
      rate,
      body,
      next: nextLink(response.headers.get("link"), baseUrl),
    };
  }

  async function listIssues(
    repo: GitHubRepoRef,
    sinceIso: string,
    etag: string | null,
  ): Promise<GitHubList<GitHubIssue>> {
    const url =
      `${issueUrl(repo, "/issues")}?state=open&since=${encodeURIComponent(sinceIso)}` +
      `&sort=updated&direction=asc&per_page=100`;
    return collectList(url, etag, (value) => parseIssue(value, repo));
  }

  async function listComments(
    repo: GitHubRepoRef,
    sinceIso: string,
    etag: string | null,
  ): Promise<GitHubList<GitHubComment>> {
    const url =
      `${issueUrl(repo, "/issues/comments")}?since=${encodeURIComponent(sinceIso)}` +
      `&sort=updated&direction=asc&per_page=100`;
    return collectList(url, etag, (value) => parseComment(value, repo));
  }

  async function collectList<T>(
    url: string,
    etag: string | null,
    parse: (value: unknown) => T | null,
  ): Promise<GitHubList<T>> {
    const first = await send(url, etag, "GET");
    if (first.status === 304) {
      return { url, etag: first.etag, notModified: true, items: [], rate: first.rate };
    }
    const items = parseArray(first.body, parse, url);
    let next = first.next;
    let pages = 1;
    const seen = new Set<string>([url]);
    while (next !== null && pages < MAX_PAGES) {
      if (seen.has(next)) break;
      seen.add(next);
      pages += 1;
      const page = await send(next, null, "GET");
      if (page.status === 304) break;
      items.push(...parseArray(page.body, parse, next));
      next = page.next;
    }
    return { url, etag: first.etag, notModified: false, items, rate: first.rate };
  }

  return {
    config,
    user,
    listOpenIssues: listIssues,
    listIssueComments: listComments,
    async getIssue(repo, number) {
      const url = issueUrl(repo, `/issues/${number}`);
      const page = await send(url, null, "GET");
      const issue = parseIssue(page.body, repo);
      if (issue === null) throw new GitHubRequestError(page.status, safePath(url));
      return issue;
    },
    async listSubIssues(repo, number) {
      try {
        const page = await collectList(
          issueUrl(repo, `/issues/${number}/sub_issues?per_page=100`),
          null,
          (value) => parseIssue(value, repo),
        );
        return page.items;
      } catch (error) {
        if (error instanceof GitHubRequestError && error.status === 404) return [];
        throw error;
      }
    },
    async listBlockedBy(repo, number) {
      try {
        const page = await collectList(
          issueUrl(repo, `/issues/${number}/dependencies/blocked_by?per_page=100`),
          null,
          (value) => parseIssue(value, repo),
        );
        return page.items;
      } catch (error) {
        if (error instanceof GitHubRequestError && error.status === 404) return [];
        throw error;
      }
    },
    async postComment(repo, number, body) {
      await send(issueUrl(repo, `/issues/${number}/comments`), null, "POST", { body });
    },
  };
}

/** How long the next tick should wait when the budget is already spent. */
export function rateHoldMs(rate: GitHubRateSnapshot, now: number): number {
  if (rate.remaining !== 0 || rate.resetMs === null) return 0;
  return Math.max(0, rate.resetMs - now);
}

function parseArray<T>(body: unknown, parse: (value: unknown) => T | null, url: string): T[] {
  if (!Array.isArray(body)) throw new GitHubRequestError(200, safePath(url));
  const items: T[] = [];
  for (const entry of body) {
    const parsed = parse(entry);
    if (parsed !== null) items.push(parsed);
  }
  return items;
}

function parseIssue(value: unknown, fallback: GitHubRepoRef): GitHubIssue | null {
  if (!isRecord(value)) return null;
  const number = value["number"];
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) return null;
  const repo = repoOf(value, fallback);
  const user = person(value["user"]);
  return {
    owner: repo.owner,
    repo: repo.repo,
    number,
    title: typeof value["title"] === "string" ? value["title"] : "",
    body: typeof value["body"] === "string" ? value["body"] : null,
    authorLogin: user.login,
    authorId: user.id,
    authorAssociation: association(value["author_association"]),
    labels: labelsOf(value["labels"]),
    updatedAtMs: timeMs(value["updated_at"]),
    pullRequest: value["pull_request"] !== undefined && value["pull_request"] !== null,
  };
}

function parseComment(value: unknown, fallback: GitHubRepoRef): GitHubComment | null {
  if (!isRecord(value)) return null;
  const id = value["id"];
  if (typeof id !== "number" || !Number.isInteger(id)) return null;
  const html = typeof value["html_url"] === "string" ? value["html_url"] : "";
  const issueUrl = typeof value["issue_url"] === "string" ? value["issue_url"] : "";
  const number = numberFromUrl(html) ?? numberFromUrl(issueUrl);
  if (number === null) return null;
  const repo = repoOf(value, repoFromUrl(issueUrl) ?? repoFromUrl(html) ?? fallback);
  const user = person(value["user"]);
  return {
    id,
    owner: repo.owner,
    repo: repo.repo,
    number,
    body: typeof value["body"] === "string" ? value["body"] : "",
    authorLogin: user.login,
    authorId: user.id,
    authorAssociation: association(value["author_association"]),
    updatedAtMs: timeMs(value["updated_at"]),
    pullRequest: html.includes("/pull/"),
  };
}

function labelsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0) {
      names.push(entry);
      continue;
    }
    if (!isRecord(entry)) continue;
    const name = entry["name"];
    if (typeof name === "string" && name.length > 0) names.push(name);
  }
  return names;
}

function person(value: unknown): { login: string | null; id: number | null } {
  if (!isRecord(value)) return { login: null, id: null };
  const login = value["login"];
  const id = value["id"];
  return {
    login: typeof login === "string" && login.length > 0 ? login : null,
    id: typeof id === "number" ? id : null,
  };
}

function association(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "NONE";
}

function repoOf(value: Record<string, unknown>, fallback: GitHubRepoRef): GitHubRepoRef {
  const repository = isRecord(value["repository"]) ? value["repository"] : null;
  if (repository !== null) {
    const full = repository["full_name"];
    if (typeof full === "string") {
      const parsed = parseSlug(full);
      if (parsed !== null) return parsed;
    }
    const owner = isRecord(repository["owner"]) ? repository["owner"]["login"] : null;
    const name = repository["name"];
    if (
      typeof owner === "string" &&
      typeof name === "string" &&
      owner.length > 0 &&
      name.length > 0
    ) {
      return { owner, repo: name };
    }
  }
  return repoFromUrl(value["repository_url"]) ?? repoFromUrl(value["html_url"]) ?? fallback;
}

function repoFromUrl(value: unknown): GitHubRepoRef | null {
  if (typeof value !== "string") return null;
  const repos = /\/repos\/([^/]+)\/([^/#?]+)/.exec(value);
  if (repos?.[1] !== undefined && repos[2] !== undefined) {
    return { owner: decode(repos[1]), repo: decode(repos[2]) };
  }
  const web = /github\.com\/([^/]+)\/([^/#?]+)/.exec(value);
  if (web?.[1] !== undefined && web[2] !== undefined) {
    return { owner: decode(web[1]), repo: decode(web[2]) };
  }
  return null;
}

function numberFromUrl(value: string): number | null {
  const match = /\/(?:issues|pull)\/(\d+)/.exec(value);
  if (match?.[1] === undefined) return null;
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function parseSlug(value: string): GitHubRepoRef | null {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(value.trim());
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { owner: match[1], repo: match[2] };
}

function timeMs(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function rateFrom(headers: Headers): GitHubRateSnapshot {
  return {
    remaining: headerInt(headers, "x-ratelimit-remaining"),
    resetMs: resetMs(headers.get("x-ratelimit-reset")),
  };
}

function headerInt(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim().length === 0) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function resetMs(raw: string | null): number | null {
  if (raw === null || raw.trim().length === 0) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  if (value > 1_000_000_000_000) return value;
  return value * 1000;
}

function retryAfter(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (raw === null || raw.trim().length === 0) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

function nextLink(header: string | null, baseUrl: string): string | null {
  if (header === null) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>;\s*rel="?next"?/i.exec(part.trim());
    const link = match?.[1];
    if (link === undefined) continue;
    if (link.startsWith("http://") || link.startsWith("https://")) return link;
    if (link.startsWith("/")) return `${baseUrl}${link}`;
    return `${baseUrl}/${link}`;
  }
  return null;
}

function safePath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

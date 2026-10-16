import { signAppJwt } from "./jwt";
import { GitHubTokenError, MAX_TOKEN_TTL_MS, TOKEN_TTL_SKEW_MS, type GitHubClient } from "./types";

export type CatalogRepository = {
  owner: string;
  repo: string;
  remoteUrl: string;
  defaultBranch: string;
};

const PAGE_SIZE = 100;
const USER_REPOS = "/user/repos?affiliation=owner,collaborator,organization_member";

export async function listAppRepositories(input: {
  client: GitHubClient;
  appId: string;
  installationId: string;
  privateKeyPem: string;
  now?: Date;
  signal?: AbortSignal;
}): Promise<CatalogRepository[]> {
  if (!/^\d+$/.test(input.installationId))
    throw new GitHubTokenError("installation id must be numeric");
  const now = input.now ?? new Date();
  const response = await input.client.request({
    method: "POST",
    path: `/app/installations/${input.installationId}/access_tokens`,
    token: signAppJwt(input.appId, input.privateKeyPem, now),
    body: { permissions: { metadata: "read" } },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (response.status !== 201)
    throw new GitHubTokenError(
      `repository list token request failed with status ${response.status}`,
    );
  const token = assertListToken(response.body, now);
  return pages(
    input.client,
    "/installation/repositories?",
    token,
    input.signal,
    (body) => (isRecord(body) && Array.isArray(body.repositories) ? body.repositories : null),
    false,
  );
}

export async function listUserRepositories(input: {
  client: GitHubClient;
  token: string;
  signal?: AbortSignal;
}): Promise<CatalogRepository[]> {
  return pages(
    input.client,
    `${USER_REPOS}&`,
    input.token,
    input.signal,
    (body) => (Array.isArray(body) ? body : null),
    true,
  );
}

async function pages(
  client: GitHubClient,
  prefix: string,
  token: string,
  signal: AbortSignal | undefined,
  items: (body: unknown) => unknown[] | null,
  pushableOnly: boolean,
): Promise<CatalogRepository[]> {
  const listed: CatalogRepository[] = [];
  for (let page = 1; ; page += 1) {
    const response = await client.request({
      method: "GET",
      path: `${prefix}per_page=${PAGE_SIZE}&page=${page}`,
      token,
      ...(signal ? { signal } : {}),
    });
    const entries = response.status === 200 ? items(response.body) : null;
    if (entries === null)
      throw new Error(`GitHub repositories could not be read (status ${response.status})`);
    for (const entry of entries) {
      const repository = catalogEntry(entry, pushableOnly);
      if (repository) listed.push(repository);
    }
    if (entries.length < PAGE_SIZE) return listed;
  }
}

function catalogEntry(entry: unknown, pushableOnly: boolean): CatalogRepository | null {
  if (!isRecord(entry) || entry.archived === true) return null;
  if (pushableOnly && isRecord(entry.permissions) && entry.permissions.push === false) return null;
  const owner = isRecord(entry.owner) ? entry.owner.login : null;
  if (
    typeof owner !== "string" ||
    typeof entry.name !== "string" ||
    typeof entry.clone_url !== "string" ||
    typeof entry.default_branch !== "string"
  )
    return null;
  return {
    owner,
    repo: entry.name,
    remoteUrl: entry.clone_url,
    defaultBranch: entry.default_branch,
  };
}

function assertListToken(body: unknown, now: Date): string {
  if (!isRecord(body) || typeof body.token !== "string" || body.token.length === 0)
    throw new GitHubTokenError("repository list token is missing");
  const ttl =
    typeof body.expires_at === "string" ? Date.parse(body.expires_at) - now.getTime() : NaN;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_TOKEN_TTL_MS + TOKEN_TTL_SKEW_MS)
    throw new GitHubTokenError("repository list token must expire within 1 hour");
  if (
    !isRecord(body.permissions) ||
    Object.entries(body.permissions).some(([key, value]) => key !== "metadata" || value !== "read")
  )
    throw new GitHubTokenError("repository list token grants unexpected permissions");
  return body.token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

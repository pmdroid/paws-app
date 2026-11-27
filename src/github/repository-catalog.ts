import { signAppJwt } from "./jwt";
import { GitHubTokenError, MAX_TOKEN_TTL_MS, TOKEN_TTL_SKEW_MS, type GitHubClient } from "./types";

export type CatalogRepository = {
  owner: string;
  repo: string;
  remoteUrl: string;
  defaultBranch: string;
  private?: true;
};

const PAGE_SIZE = 100;

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
  return pages(input.client, token, input.signal);
}

async function pages(
  client: GitHubClient,
  token: string,
  signal: AbortSignal | undefined,
): Promise<CatalogRepository[]> {
  const listed: CatalogRepository[] = [];
  for (let page = 1; ; page += 1) {
    const response = await client.request({
      method: "GET",
      path: `/installation/repositories?per_page=${PAGE_SIZE}&page=${page}`,
      token,
      ...(signal ? { signal } : {}),
    });
    const entries =
      response.status === 200 &&
      isRecord(response.body) &&
      Array.isArray(response.body.repositories)
        ? response.body.repositories
        : null;
    if (entries === null)
      throw new Error(`GitHub repositories could not be read (status ${response.status})`);
    for (const entry of entries) {
      const repository = catalogEntry(entry);
      if (repository) listed.push(repository);
    }
    if (entries.length < PAGE_SIZE) return listed;
  }
}

function catalogEntry(entry: unknown): CatalogRepository | null {
  if (!isRecord(entry) || entry.archived === true || entry.disabled === true) return null;
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
    ...(entry.private === true ? { private: true as const } : {}),
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

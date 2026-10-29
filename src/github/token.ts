import { isTransient } from "../core";
import type { GitHubApp, InstallationToken, MintTokenInput } from "./app";
import { signAppJwt } from "./jwt";
import {
  INSTALLATION_PERMISSIONS,
  MAX_TOKEN_TTL_MS,
  TOKEN_TTL_SKEW_MS,
  GitHubTokenError,
  type GitHubClient,
  type GitHubResponse,
} from "./types";

const ALLOWED_PERMISSIONS = new Set([
  "contents",
  "pull_requests",
  "checks",
  "issues",
  "metadata",
  "workflows",
]);
const withoutWorkflows = new Set<string>();

export type MintedToken = {
  token: string;
  expiresAt: Date;
};

/**
 * Mint a fresh installation token for one repository.
 * Call this for each push and each merge. Do not cache the result.
 */
export async function mintInstallationToken(input: {
  client: GitHubClient;
  appId: string;
  installationId: string;
  privateKeyPem: string;
  owner: string;
  repo: string;
  access?: "read" | "write";
  now?: Date;
}): Promise<MintedToken> {
  if (!/^\d+$/.test(input.installationId)) {
    throw new GitHubTokenError("installation id must be numeric");
  }
  assertName(input.owner, "owner");
  assertName(input.repo, "repo");
  const now = input.now ?? new Date();
  const jwt = signAppJwt(input.appId, input.privateKeyPem, now);
  const request = (permissions: Record<string, string>) =>
    input.client.request({
      method: "POST",
      path: `/app/installations/${input.installationId}/access_tokens`,
      token: jwt,
      body: { repositories: [input.repo], permissions },
    });
  let response: GitHubResponse;
  if (input.access === "read") response = await request({ contents: "read", metadata: "read" });
  else if (withoutWorkflows.has(input.installationId))
    response = await request(INSTALLATION_PERMISSIONS);
  else {
    response = await request({ ...INSTALLATION_PERMISSIONS, workflows: "write" });
    if (response.status === 422 || response.status === 403) {
      withoutWorkflows.add(input.installationId);
      response = await request(INSTALLATION_PERMISSIONS);
    }
  }
  if (response.status !== 201) throw mintFailure(response);
  return assertScopedToken(response.body, input.owner, input.repo, now, input.access);
}

function mintFailure(response: GitHubResponse): GitHubTokenError {
  const error = new GitHubTokenError(
    `installation token request failed with status ${response.status}`,
    response,
  );
  if (response.status < 500 && isTransient(error))
    error.message = `installation token request was rate limited by GitHub (status ${response.status})`;
  return error;
}

export function assertScopedToken(
  body: unknown,
  owner: string,
  repo: string,
  now: Date,
  access: "read" | "write" = "write",
): MintedToken {
  if (!isRecord(body)) throw new GitHubTokenError("installation token response is not an object");
  if (typeof body.token !== "string" || body.token.length === 0 || /\s/.test(body.token)) {
    throw new GitHubTokenError("installation token is missing");
  }
  if (typeof body.expires_at !== "string")
    throw new GitHubTokenError("installation token has no expiry");
  const expiresAt = new Date(body.expires_at);
  const ttl = expiresAt.getTime() - now.getTime();
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_TOKEN_TTL_MS + TOKEN_TTL_SKEW_MS) {
    throw new GitHubTokenError("installation token must expire within 1 hour");
  }
  if (body.repository_selection !== "selected") {
    throw new GitHubTokenError("installation token must be limited to selected repositories");
  }
  if (!Array.isArray(body.repositories) || body.repositories.length !== 1) {
    throw new GitHubTokenError("installation token must cover exactly one repository");
  }
  const only = body.repositories[0];
  // GitHub owner and repository names are case-insensitive.
  if (
    !isRecord(only) ||
    typeof only.name !== "string" ||
    typeof only.full_name !== "string" ||
    only.name.toLowerCase() !== repo.toLowerCase() ||
    only.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()
  ) {
    throw new GitHubTokenError("installation token repository does not match the configured repo");
  }
  if (!isRecord(body.permissions))
    throw new GitHubTokenError("installation token permissions are missing");
  for (const [key, value] of Object.entries(body.permissions)) {
    if (!ALLOWED_PERMISSIONS.has(key)) {
      throw new GitHubTokenError(`installation token grants unexpected permission ${key}`);
    }
    if (key === "metadata" && value !== "read") {
      throw new GitHubTokenError("metadata permission must be read");
    }
  }
  if (access === "read") {
    if (
      body.permissions.contents !== "read" ||
      Object.entries(body.permissions).some(
        ([key, value]) => !["contents", "metadata"].includes(key) || value !== "read",
      )
    )
      throw new GitHubTokenError("repository read token grants unexpected permissions");
    return { token: body.token, expiresAt };
  }
  if (body.permissions.contents !== "write")
    throw new GitHubTokenError("contents permission must be write");
  if (body.permissions.pull_requests !== "write") {
    throw new GitHubTokenError("pull_requests permission must be write");
  }
  if (body.permissions.checks !== "write")
    throw new GitHubTokenError("checks permission must be write");
  if (body.permissions.issues !== "write")
    throw new GitHubTokenError("issues permission must be write");
  return { token: body.token, expiresAt };
}

export type GitHubAppOptions = {
  client: GitHubClient;
  appId: string;
  privateKeyPem: string;
  now?: () => Date;
};

/** Foundation seam. Every call mints a fresh one-repository token. */
export function createGitHubApp(options: GitHubAppOptions): GitHubApp {
  return {
    async mintInstallationToken(input: MintTokenInput): Promise<InstallationToken> {
      const { owner, repo } = splitRepository(input.repository);
      const minted = await mintInstallationToken({
        client: options.client,
        appId: options.appId,
        installationId: input.installationId,
        privateKeyPem: options.privateKeyPem,
        owner,
        repo,
        ...(input.access ? { access: input.access } : {}),
        ...(options.now ? { now: options.now() } : {}),
      });
      return {
        token: minted.token,
        expiresAt: minted.expiresAt.getTime(),
        repository: `${owner}/${repo}`,
      };
    },
  };
}

export function splitRepository(repository: string): { owner: string; repo: string } {
  const slash = repository.indexOf("/");
  const owner = slash === -1 ? "" : repository.slice(0, slash);
  const repo = slash === -1 ? "" : repository.slice(slash + 1);
  if (owner === "" || repo === "" || repo.includes("/")) {
    throw new GitHubTokenError("repository must be owner/repo");
  }
  return { owner, repo };
}

function assertName(value: string, label: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new GitHubTokenError(`${label} is invalid`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import type { GitHubApp, InstallationToken, MintTokenInput } from "./app";
import { signAppJwt } from "./jwt";
import {
  INSTALLATION_PERMISSIONS,
  MAX_TOKEN_TTL_MS,
  TOKEN_TTL_SKEW_MS,
  GitHubTokenError,
  type GitHubClient,
} from "./types";

const ALLOWED_PERMISSIONS = new Set([
  "contents",
  "pull_requests",
  "checks",
  "issues",
  "actions",
  "metadata",
]);

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
  const response = await input.client.request({
    method: "POST",
    path: `/app/installations/${input.installationId}/access_tokens`,
    token: jwt,
    body: {
      repositories: [input.repo],
      permissions:
        input.access === "read" ? { contents: "read", metadata: "read" } : INSTALLATION_PERMISSIONS,
    },
  });
  if (response.status !== 201) {
    throw new GitHubTokenError(`installation token request failed with status ${response.status}`);
  }
  return assertScopedToken(response.body, input.owner, input.repo, now, input.access);
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
  if (!isRecord(only) || only.name !== repo || only.full_name !== `${owner}/${repo}`) {
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
  if (body.permissions.actions !== "read")
    throw new GitHubTokenError("actions permission must be read");
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

import {
  DEVICE_ACCESS_DENIED_MESSAGE,
  DEVICE_CODE_EXPIRED_MESSAGE,
  DEVICE_SCOPE,
  DEVICE_SCOPE_MESSAGE,
  GITHUB_REAUTH_MESSAGE,
  WORKFLOW_SCOPE_NOTE,
} from "./messages";

export const DEVICE_CODE_URL = "https://github.com/login/device/code";
export const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_USER_URL = "https://api.github.com/user";

export type DeviceFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type DeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

export type DeviceGrant = {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  scope: string;
};

export type GitHubAccount = {
  login: string;
  id: number;
  scopes: string;
};

export class DeviceFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceFlowError";
  }
}

/**
 * GitHub's device flow.
 * The OAuth client id is public. No client secret is sent.
 * `workflow` is not part of {@link DEVICE_SCOPE}; see {@link WORKFLOW_SCOPE_NOTE}.
 */
export async function requestDeviceCode(input: {
  clientId: string;
  fetch: DeviceFetch;
  scope?: string;
}): Promise<DeviceCode> {
  const scope = input.scope ?? DEVICE_SCOPE;
  if (scope.split(/\s+/).includes("workflow")) {
    throw new DeviceFlowError(WORKFLOW_SCOPE_NOTE);
  }
  const response = await postForm(input.fetch, DEVICE_CODE_URL, {
    client_id: input.clientId,
    scope,
  });
  const body = await readJson(response);
  const deviceCode = readString(body, "device_code");
  const userCode = readString(body, "user_code");
  const verificationUri = readString(body, "verification_uri");
  if (deviceCode === null || userCode === null || verificationUri === null) {
    throw new DeviceFlowError(`GitHub did not return a device code. ${GITHUB_REAUTH_MESSAGE}.`);
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresIn: readPositive(body, "expires_in") ?? 900,
    interval: readPositive(body, "interval") ?? 5,
  };
}

export async function pollDeviceToken(input: {
  clientId: string;
  deviceCode: string;
  fetch: DeviceFetch;
  intervalSeconds: number;
  expiresInSeconds: number;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<DeviceGrant> {
  const now = input.now ?? Date.now;
  let interval = Math.max(0, input.intervalSeconds);
  const deadline = now() + input.expiresInSeconds * 1000;
  for (;;) {
    await input.sleep(interval * 1000);
    if (now() > deadline) throw new DeviceFlowError(DEVICE_CODE_EXPIRED_MESSAGE);
    const response = await postForm(input.fetch, ACCESS_TOKEN_URL, {
      client_id: input.clientId,
      device_code: input.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (response.status === 401) throw new DeviceFlowError(GITHUB_REAUTH_MESSAGE);
    const body = await readJson(response);
    const error = readString(body, "error");
    if (error === null) return grantFrom(body);
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval += 5;
      continue;
    }
    if (error === "expired_token") throw new DeviceFlowError(DEVICE_CODE_EXPIRED_MESSAGE);
    if (error === "access_denied") throw new DeviceFlowError(DEVICE_ACCESS_DENIED_MESSAGE);
    throw new DeviceFlowError(`GitHub sign-in failed (${error}). ${GITHUB_REAUTH_MESSAGE}.`);
  }
}

export async function refreshDeviceToken(input: {
  clientId: string;
  refreshToken: string;
  fetch: DeviceFetch;
}): Promise<DeviceGrant> {
  const response = await postForm(input.fetch, ACCESS_TOKEN_URL, {
    client_id: input.clientId,
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });
  if (response.status === 401) throw new DeviceFlowError(GITHUB_REAUTH_MESSAGE);
  const body = await readJson(response);
  const error = readString(body, "error");
  if (error !== null) {
    if (response.status === 401) throw new DeviceFlowError(GITHUB_REAUTH_MESSAGE);
    throw new DeviceFlowError(`GitHub token refresh failed (${error}). ${GITHUB_REAUTH_MESSAGE}.`);
  }
  if (response.status === 401) throw new DeviceFlowError(GITHUB_REAUTH_MESSAGE);
  return grantFrom(body);
}

/** `GET /user` plus `X-OAuth-Scopes`. Requires `repo` and `read:org`. */
export async function fetchGitHubAccount(input: {
  token: string;
  fetch: DeviceFetch;
}): Promise<GitHubAccount> {
  const response = await input.fetch(GITHUB_USER_URL, {
    method: "GET",
    headers: githubHeaders(input.token),
  });
  if (response.status === 401) throw new DeviceFlowError(GITHUB_REAUTH_MESSAGE);
  if (!response.ok) {
    throw new DeviceFlowError(
      `GitHub user lookup failed (${response.status}). ${GITHUB_REAUTH_MESSAGE}.`,
    );
  }
  const scopes = response.headers.get("x-oauth-scopes") ?? "";
  if (!scopesGrantRepoAndOrg(scopes)) throw new DeviceFlowError(DEVICE_SCOPE_MESSAGE);
  const body = await readJson(response);
  const login = readString(body, "login");
  const id = readPositive(body, "id");
  if (login === null || id === null) {
    throw new DeviceFlowError(`GitHub user lookup was incomplete. ${GITHUB_REAUTH_MESSAGE}.`);
  }
  return { login, id, scopes };
}

export function scopesGrantRepoAndOrg(header: string): boolean {
  const scopes = new Set(
    header
      .split(",")
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0),
  );
  return scopes.has("repo") && scopes.has("read:org");
}

export async function openVerificationPage(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const proc = Bun.spawn([command, url], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const timer = setTimeout(() => {
      proc.kill();
    }, 500);
    await proc.exited;
    clearTimeout(timer);
  } catch {
    // A missing browser is fine. The user code is already printed.
  }
}

async function postForm(
  fetchImpl: DeviceFetch,
  url: string,
  fields: Record<string, string>,
): Promise<Response> {
  const body = new URLSearchParams(fields);
  return fetchImpl(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
}

function grantFrom(body: unknown): DeviceGrant {
  const accessToken = readString(body, "access_token");
  if (accessToken === null || /\s/.test(accessToken)) {
    throw new DeviceFlowError(`GitHub did not return an access token. ${GITHUB_REAUTH_MESSAGE}.`);
  }
  const scope = readString(body, "scope") ?? "";
  if (!scopesGrantRepoAndOrg(scope.replaceAll(" ", ","))) {
    throw new DeviceFlowError(DEVICE_SCOPE_MESSAGE);
  }
  return {
    accessToken,
    refreshToken: readString(body, "refresh_token"),
    expiresIn: readPositive(body, "expires_in"),
    scope,
  };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "paws",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function readString(body: unknown, key: string): string | null {
  if (!isRecord(body)) return null;
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readPositive(body: unknown, key: string): number | null {
  if (!isRecord(body)) return null;
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return null;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
